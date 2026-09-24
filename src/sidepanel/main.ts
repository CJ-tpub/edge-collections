import './style.css';
import { DuplicateUrlError, normalizeThumbnailDataUrl, normalizeWebUrl } from '../domain/logic';
import type {
  BackupV1,
  Collection,
  CollectionItem,
  CollectionSettings,
  LegacyNoteItem,
  PageItem,
  SortMode,
  ThemeMode,
} from '../domain/types';
import {
  IndexedDbCollectionRepository,
  type CollectionSearchResult,
} from '../data/collection-repository';
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  SettingsStore,
} from '../settings/settings-store';
import {
  createBackupV1,
  parseBackupJson,
  stringifyBackupV1,
} from '../backup/backup-service';
import { exportCollectionsCsv } from '../backup/csv-export';
import { initializeSqlJs } from '../backup/sqljs-runtime';
import { parseLegacyCollectionsDatabase } from '../backup/legacy-collections-parser';
import {
  arePageCapturesEqual,
  createPageCapture,
  PENDING_CAPTURE_STORAGE_KEY,
  validatePageCapture,
  type PageCapture,
} from '../capture/capture';
import {
  domainFromUrl,
  isImportFileSizeAllowed,
  makeDownloadFileName,
  getReorderTargetPosition,
  MAX_IMPORT_FILE_SIZE,
  sortCollectionsForDisplay,
  sortItemsForDisplay,
} from './ui-logic';
import type { SqlJsStatic } from 'sql.js';

const app = document.querySelector<HTMLElement>('#app');
if (app === null) {
  throw new Error('找不到集锦侧栏根节点。');
}

// 拖放数据同时携带显示索引，用于把目标行上边缘换算为最终插入位置。
const COLLECTION_DRAG_INDEX_TYPE = 'application/x-edge-collection-index';
const ITEM_DRAG_INDEX_TYPE = 'application/x-edge-item-index';

const repository = new IndexedDbCollectionRepository();
const settingsStore = new SettingsStore();

// 右键弹窗保存后刷新已打开的侧栏，保持列表与 IndexedDB 一致。
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== 'object' || message === null || Array.isArray(message) || !('type' in message)) {
    return;
  }
  if (message.type === 'collection-page-added') void loadData();
});

type ViewState =
  | { kind: 'overview' }
  | { kind: 'detail'; collectionId: string }
  | { kind: 'search' };

interface AppState {
  collections: Collection[];
  itemsByCollection: Map<string, CollectionItem[]>;
  searchResults: CollectionSearchResult[];
  settings: CollectionSettings;
  view: ViewState;
  searchQuery: string;
  highlightItemId: string | null;
  loading: boolean;
  loadError: string | null;
  importing: boolean;
  pendingCapture?: PageCapture;
  pendingDialogOpen: boolean;
}

const state: AppState = {
  collections: [],
  itemsByCollection: new Map<string, CollectionItem[]>(),
  searchResults: [],
  settings: { theme: 'system', sort: 'manual', sortDescending: false, fontSize: 16, recentCollectionId: null },
  view: { kind: 'overview' },
  searchQuery: '',
  highlightItemId: null,
  loading: true,
  loadError: null,
  importing: false,
  pendingDialogOpen: false,
};

let renderVersion = 0;
let searchVersion = 0;
let sqlJsPromise: Promise<SqlJsStatic> | undefined;
let toastTimer: number | undefined;
let pendingDialog: HTMLDialogElement | undefined;

type ScrollAnchor = {
  kind: 'collection' | 'item';
  id: string;
  top: number;
  scrollTop: number;
};

let dragScrollFrame: number | undefined;
let dragScrollDirection = 0;

// 读取文档滚动位置，兼容侧栏使用 document.scrollingElement 或 window 的情况。
const getScrollTop = (): number => document.scrollingElement?.scrollTop ?? window.scrollY;

// 统一创建安全 DOM 节点，用户数据只通过 textContent、value 和 setAttribute 写入。
const element = <K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tagName);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// 按钮统一补充中文可访问名称和原生 tooltip。
const button = (
  label: string,
  onClick: () => void | Promise<void>,
  className = 'icon-button',
  accessibleLabel = label,
): HTMLButtonElement => {
  const node = element('button', className, label);
  node.type = 'button';
  node.setAttribute('aria-label', accessibleLabel);
  node.title = accessibleLabel;
  node.addEventListener('click', () => {
    void runAction(onClick);
  });
  return node;
};

// 所有用户操作统一转成中文 toast，避免未处理 Promise 破坏侧栏状态。
const runAction = async (action: () => void | Promise<void>): Promise<void> => {
  try {
    await action();
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : '操作失败，请稍后重试。', 'error');
  }
};

// 短时状态提示只渲染纯文本，不拼接 HTML。
const showToast = (message: string, tone: 'info' | 'error' = 'info'): void => {
  const existing = document.querySelector<HTMLElement>('.toast');
  existing?.remove();
  const toast = element('div', `toast toast-${tone}`, message);
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  document.body.append(toast);
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.remove(), 3_200);
};

// 关闭所有浮层菜单，保证同一时刻只保留一个菜单并避免点击穿透到列表行。
const closeAllMenus = (): void => {
  document.querySelectorAll<HTMLElement>('.collection-menu, .item-menu, .more-menu').forEach((menu) => {
    menu.parentElement?.classList.remove('has-open-menu');
    menu.remove();
  });
};

// 点击菜单外部时收起菜单；菜单内部和菜单触发按钮保留给自身事件处理。
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    closeAllMenus();
    return;
  }
  if (target.closest('.collection-menu, .item-menu, .more-menu, .collection-more, .item-more, [aria-label="更多设置与文件操作"]') === null) {
    closeAllMenus();
  }
});

// 拖拽靠近侧栏上下边缘时持续滚动，集合和卡片共用同一套逻辑。
const updateDragAutoScroll = (event: DragEvent): void => {
  const types = event.dataTransfer === null ? [] : Array.from(event.dataTransfer.types);
  if (!types.includes('application/x-edge-collection') && !types.includes('application/x-edge-item')) return;
  const edgeSize = 72;
  const viewportHeight = window.innerHeight;
  const direction = event.clientY < edgeSize
    ? -1
    : event.clientY > viewportHeight - edgeSize
      ? 1
      : 0;
  if (direction === 0) {
    stopDragAutoScroll();
    return;
  }
  dragScrollDirection = direction;
  const scroll = (): void => {
    if (dragScrollDirection === 0) {
      dragScrollFrame = undefined;
      return;
    }
    window.scrollBy(0, dragScrollDirection * 12);
    dragScrollFrame = window.requestAnimationFrame(scroll);
  };
  if (dragScrollFrame === undefined) dragScrollFrame = window.requestAnimationFrame(scroll);
};

const stopDragAutoScroll = (): void => {
  dragScrollDirection = 0;
  if (dragScrollFrame !== undefined) {
    window.cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = undefined;
  }
};

document.addEventListener('dragover', updateDragAutoScroll);
document.addEventListener('drop', stopDragAutoScroll);
document.addEventListener('dragend', stopDragAutoScroll);

// 只保留原始滚动像素位置，用于排序切换和表单保存等不应改变视口的操作。
const captureScrollPositionAnchor = (): ScrollAnchor => ({
  kind: 'collection',
  id: '',
  top: 0,
  scrollTop: getScrollTop(),
});

// 记录当前视口最上方可见的集合或卡片，重渲染后用同一条记录恢复位置。
const captureScrollAnchor = (): ScrollAnchor | undefined => {
  const scrollTop = getScrollTop();
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-collection-id], [data-item-id]'));
  const visible = rows.find((row) => {
    const rectangle = row.getBoundingClientRect();
    return rectangle.bottom > 0 && rectangle.top < window.innerHeight;
  });
  if (visible === undefined) return { kind: 'collection', id: '', top: 0, scrollTop };
  const kind = visible.dataset.collectionId !== undefined ? 'collection' : 'item';
  const id = kind === 'collection' ? visible.dataset.collectionId : visible.dataset.itemId;
  if (id === undefined) return { kind: 'collection', id: '', top: 0, scrollTop };
  return { kind, id, top: visible.getBoundingClientRect().top, scrollTop };
};

// 将锚点行恢复到重排前的视口位置；找不到时退回原始滚动像素值。
const restoreScrollAnchor = (anchor: ScrollAnchor | undefined, resetScroll: boolean): void => {
  if (resetScroll) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (anchor === undefined) return;
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-collection-id], [data-item-id]'));
  const target = anchor.id.length === 0
    ? undefined
    : rows.find((row) => (
      anchor.kind === 'collection'
        ? row.dataset.collectionId === anchor.id
        : row.dataset.itemId === anchor.id
    ));
  if (target === undefined) {
    window.scrollTo({ top: anchor.scrollTop, behavior: 'auto' });
    return;
  }
  const delta = target.getBoundingClientRect().top - anchor.top;
  window.scrollTo({ top: Math.max(0, anchor.scrollTop + delta), behavior: 'auto' });
};

// 数据变更后重新读取当前搜索结果，避免编辑或删除后仍显示旧卡片。
const refreshSearchResults = async (anchorOverride?: ScrollAnchor): Promise<void> => {
  if (state.view.kind !== 'search') return;
  const query = state.searchQuery.trim();
  if (query.length === 0) return;
  const currentVersion = ++searchVersion;
  try {
    const results = await repository.search(query);
    if (currentVersion !== searchVersion || state.view.kind !== 'search') return;
    state.searchResults = results;
    render(false, anchorOverride);
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : '搜索失败。', 'error');
  }
};

// 搜索重绘会替换输入框节点，因此每次重绘后主动恢复焦点和光标位置。
const focusSearchInput = (): void => {
  const searchInput = document.querySelector<HTMLInputElement>('[data-search-input]');
  searchInput?.focus();
  searchInput?.setSelectionRange(searchInput.value.length, searchInput.value.length);
};

// 根据设置把可调字号写入根节点，正文和菜单通过 CSS 变量同步放大。
const applyFontSize = (): void => {
  document.documentElement.style.setProperty('--ui-font-size', `${state.settings.fontSize}px`);
};

// 按当前设置应用系统、浅色或深色主题。
const applyTheme = (): void => {
  if (state.settings.theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = state.settings.theme;
  }
};

// 读取全部主体数据，保留空集合并按集合建立卡片索引。
const loadData = async (anchorOverride?: ScrollAnchor): Promise<void> => {
  const currentVersion = ++renderVersion;
  const scrollAnchor = anchorOverride ?? captureScrollAnchor();
  state.loading = true;
  render(false, scrollAnchor);
  try {
    const collections = await repository.listCollections();
    const itemGroups = await Promise.all(collections.map(async (collection) => (
      [collection.id, await repository.listItems(collection.id)] as const
    )));
    if (currentVersion !== renderVersion) return;
    state.collections = collections;
    state.itemsByCollection = new Map(itemGroups);
    state.loading = false;
    state.loadError = null;
    const detailCollectionId = state.view.kind === 'detail' ? state.view.collectionId : undefined;
    if (detailCollectionId !== undefined && !collections.some((collection) => collection.id === detailCollectionId)) {
      state.view = { kind: 'overview' };
    }
    applyTheme();
    render(false, scrollAnchor);
    await refreshSearchResults(scrollAnchor);
  } catch (error: unknown) {
    state.loading = false;
    state.loadError = error instanceof Error ? error.message : '读取集锦失败。';
    render(false, scrollAnchor);
    showToast(`读取集锦失败，数据未被清空：${state.loadError}`, 'error');
  }
};

// 搜索读取全量索引，并在结果中保留所属集合以便定位。
const search = async (): Promise<void> => {
  const query = state.searchQuery.trim();
  const currentVersion = ++searchVersion;
  const scrollAnchor = captureScrollPositionAnchor();
  if (query.length === 0) {
    state.searchResults = [];
    state.view = { kind: 'overview' };
    render(false, scrollAnchor);
    focusSearchInput();
    return;
  }
  state.view = { kind: 'search' };
  render(false, scrollAnchor);
  try {
    const results = await repository.search(query);
    if (currentVersion !== searchVersion) return;
    state.searchResults = results;
    render(false, scrollAnchor);
    focusSearchInput();
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : '搜索失败。', 'error');
  }
};

// 生成当前数据的严格 BackupV1，导出和替换前都读取最新数据。
const createCurrentBackup = async (): Promise<BackupV1> => {
  const collections = await repository.listCollections();
  const groups = await Promise.all(collections.map(async (collection) => repository.listItems(collection.id)));
  const recentCollectionId = state.settings.recentCollectionId !== null
    && collections.some((collection) => collection.id === state.settings.recentCollectionId)
    ? state.settings.recentCollectionId
    : null;
  return createBackupV1(collections, groups.flat(), { ...state.settings, recentCollectionId });
};

// 使用 Blob 和临时 a 下载，不需要 downloads 权限。
const downloadBytes = (bytes: Uint8Array, mimeType: string, fileName: string): void => {
  const ownedBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ownedBuffer).set(bytes);
  const blob = new Blob([ownedBuffer], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = element('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
};

// 读取文件前统一执行 128 MiB 上限检查。
const assertImportFileSize = (file: File): void => {
  if (!isImportFileSizeAllowed(file.size, MAX_IMPORT_FILE_SIZE)) {
    throw new Error('导入文件超过 128 MiB 大小上限。');
  }
};

// 运行导入事务并显示简短进度状态。
const applyMerge = async (backup: BackupV1, sourceLabel: string): Promise<void> => {
  if (state.importing) return;
  state.importing = true;
  showToast(`正在合并${sourceLabel}…`);
  try {
    const report = await repository.mergeImport(backup);
    await loadData();
    showToast(`合并完成：新增 ${report.insertedCollections} 个集合、${report.insertedItems} 个卡片。`);
  } finally {
    state.importing = false;
  }
};

// 替换恢复前自动下载当前备份，下载成功后才清空并写入新数据。
const applyReplace = async (backup: BackupV1): Promise<void> => {
  if (state.importing) return;
  state.importing = true;
  showToast('正在下载当前备份并替换数据…');
  try {
    const current = await createCurrentBackup();
    const json = new TextEncoder().encode(stringifyBackupV1(current));
    downloadBytes(json, 'application/json;charset=utf-8', makeDownloadFileName('集锦-替换前备份', 'json'));
    const report = await repository.replaceImport(backup);
    await loadData();
    showToast(`替换完成：恢复 ${report.insertedCollections} 个集合、${report.insertedItems} 个卡片。`);
  } finally {
    state.importing = false;
  }
};

// 当前页只通过 tabs active + lastFocusedWindow 读取，并再次执行 HTTP/HTTPS 校验。
const captureActiveTab = async (): Promise<PageCapture> => {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (tab === undefined) throw new Error('没有找到当前标签页。');
  return createPageCapture({ title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
};

// 在当前集合追加当前网页，重复规范化 URL 由仓库抛出明确错误。
const addCurrentPage = async (collectionId: string): Promise<void> => {
  const capture = await captureActiveTab();
  await repository.createPageItem({
    collectionId,
    title: capture.title,
    url: capture.url,
    faviconUrl: capture.faviconUrl,
  });
  await loadData();
  showToast('已添加当前网页。');
};

// 打开网页前再次验证协议；逐个创建普通标签页，不创建 tab group。
const openPage = async (item: PageItem): Promise<void> => {
  const safeUrl = normalizeWebUrl(item.url);
  await chrome.tabs.create({ url: safeUrl });
};

// 打开全部网页前需要明确确认，旧便笺不参与打开。
const openAllPages = (collection: Collection): void => {
  const items = sortItemsForDisplay(state.itemsByCollection.get(collection.id) ?? [], state.settings.sort, state.settings.sortDescending);
  const pages = items.filter((item): item is PageItem => item.type === 'page');
  if (pages.length === 0) {
    showToast('当前集合没有网页卡片。');
    return;
  }
  showConfirmDialog('打开全部网页', `确定打开 ${pages.length} 个网页标签页吗？`, '打开', async () => {
    for (const item of pages) await openPage(item);
  }, 'primary-button');
};

// 打开原生表单对话框；提交按钮会在异步处理期间禁用，防止重复写入。
const showFormDialog = (
  title: string,
  confirmLabel: string,
  createSubmit: (body: HTMLElement, setError: (message: string) => void) => (() => Promise<boolean | void>),
  confirmClassName = 'primary-button',
): HTMLDialogElement => {
  const dialog = element('dialog', 'form-dialog');
  const form = element('form', 'dialog-form');
  form.method = 'dialog';
  const heading = element('h2', 'dialog-title', title);
  const body = element('div', 'dialog-body');
  const error = element('p', 'dialog-error');
  error.hidden = true;
  const actions = element('div', 'dialog-actions');
  const cancel = button('取消', () => dialog.close(), 'secondary-button');
  const submit = button(confirmLabel, () => undefined, confirmClassName);
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(heading, body, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  const setError = (message: string): void => {
    error.textContent = message;
    error.hidden = message.length === 0;
  };
  const submitAction = createSubmit(body, setError);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = '处理中…';
    void submitAction().then((shouldClose) => {
      if (shouldClose !== false) dialog.close();
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : '操作失败，请重试。');
      submit.disabled = false;
      submit.textContent = confirmLabel;
    });
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.showModal();
  return dialog;
};

// 使用扩展自己的确认对话框，避免 window.confirm 带来的浏览器级“阻止此页面创建其他对话”选项。
const showConfirmDialog = (
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => Promise<void>,
  confirmClassName = 'primary-button danger-button',
): void => {
  showFormDialog(title, confirmLabel, (body) => {
    body.append(element('p', 'confirm-message', message));
    return async () => {
      await onConfirm();
    };
  }, confirmClassName);
};

// 新建集合；不开放新建旧便笺入口。
const openCreateCollectionDialog = (): void => {
  showFormDialog('新建集锦', '创建', (body) => {
    const label = element('label', 'field-label', '集锦名称');
    const input = element('input', 'text-input');
    input.type = 'text';
    input.required = true;
    input.maxLength = 200;
    input.placeholder = '例如：旅行计划';
    label.append(input);
    body.append(label);
    input.focus();
    return async () => {
      const collection = await repository.createCollection(input.value);
      state.settings = await settingsStore.update({ recentCollectionId: collection.id });
      await loadData();
      state.view = { kind: 'detail', collectionId: collection.id };
      render(true);
      if (state.pendingCapture !== undefined) {
        // 新建第一个集合后保留并重新提示尚未保存的页面捕获。
        window.setTimeout(() => openPendingCaptureDialog(), 0);
      }
    };
  });
};

// 编辑网页标题与备注；备注以 textarea 纯文本保存。
const openPageEditDialog = (item: PageItem): void => {
  const scrollAnchor = captureScrollPositionAnchor();
  showFormDialog('编辑网页卡片', '保存', (body) => {
    const titleLabel = element('label', 'field-label', '标题');
    const title = element('input', 'text-input');
    title.type = 'text';
    title.maxLength = 10_000;
    title.value = item.title;
    titleLabel.append(title);
    const noteLabel = element('label', 'field-label', '备注 / 批注');
    const note = element('textarea', 'text-area note-editor');
    note.maxLength = 100_000;
    note.placeholder = '写下这张网页卡片的说明…';
    note.value = item.note ?? '';
    noteLabel.append(note);
    body.append(titleLabel, noteLabel);
    title.focus();
    return async () => {
      await repository.updatePageItem(item.id, {
        title: title.value,
        note: note.value.length === 0 ? null : note.value,
      });
      await loadData(scrollAnchor);
      showToast('网页卡片已更新。');
    };
  });
};

// 旧版便笺允许编辑已有标题和正文，但不提供新建入口。
const openLegacyNoteEditDialog = (item: LegacyNoteItem): void => {
  const scrollAnchor = captureScrollPositionAnchor();
  showFormDialog('编辑旧便笺', '保存', (body) => {
    const titleLabel = element('label', 'field-label', '标题');
    const title = element('input', 'text-input');
    title.type = 'text';
    title.maxLength = 10_000;
    title.value = item.title;
    titleLabel.append(title);
    const contentLabel = element('label', 'field-label', '正文');
    const content = element('textarea', 'text-area note-editor');
    content.maxLength = 100_000;
    content.value = item.content;
    contentLabel.append(content);
    body.append(titleLabel, contentLabel);
    title.focus();
    return async () => {
      await repository.updateLegacyNote(item.id, { title: title.value, content: content.value });
      await loadData(scrollAnchor);
      showToast('旧便笺已更新。');
    };
  });
};

// 移动卡片时只展示现有集合，并保留仓库的跨集合重复 URL 校验。
const openMoveDialog = (item: CollectionItem, currentCollectionId: string): void => {
  showFormDialog('移动卡片', '移动', (body) => {
    const label = element('label', 'field-label', '目标集锦');
    const select = element('select', 'select-input');
    for (const collection of state.collections) {
      const option = element('option');
      option.value = collection.id;
      option.textContent = collection.name;
      option.selected = collection.id === currentCollectionId;
      select.append(option);
    }
    label.append(select);
    body.append(label);
    return async () => {
      if (select.value === currentCollectionId) return;
      await repository.moveItem(item.id, select.value);
      state.settings = await settingsStore.update({ recentCollectionId: select.value });
      await loadData();
      showToast('卡片已移动。');
    };
  });
};

// 编辑集合名称的单行对话框用于总览列表，详情页另提供内联输入。
const openRenameCollectionDialog = (collection: Collection): void => {
  const scrollAnchor = captureScrollPositionAnchor();
  showFormDialog('重命名集锦', '保存', (body) => {
    const input = element('input', 'text-input');
    input.type = 'text';
    input.maxLength = 200;
    input.value = collection.name;
    body.append(input);
    input.focus();
    input.select();
    return async () => {
      await repository.renameCollection(collection.id, input.value);
      await loadData(scrollAnchor);
      showToast('集锦名称已更新。');
    };
  });
};

// 读取当前集合中的卡片数量，不把计数写进集合主体。
const itemCount = (collectionId: string): number => state.itemsByCollection.get(collectionId)?.length ?? 0;

// 集合行拖拽仅接受扩展自定义类型，外部链接和图片不会触发排序。
const enableCollectionDrag = (row: HTMLElement, collection: Collection, displayIndex: number): void => {
  const manual = state.settings.sort === 'manual';
  row.draggable = manual;
  if (!manual) return;
  row.addEventListener('dragstart', (event) => {
    const transfer = event.dataTransfer;
    if (transfer === null) return;
    transfer.effectAllowed = 'move';
    transfer.setData('application/x-edge-collection', collection.id);
    transfer.setData(COLLECTION_DRAG_INDEX_TYPE, String(displayIndex));
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('is-dragging');
    stopDragAutoScroll();
  });
  row.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('application/x-edge-collection')) return;
    event.preventDefault();
    updateDragAutoScroll(event);
    row.classList.add('is-drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-drag-over'));
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    row.classList.remove('is-drag-over');
    const sourceId = event.dataTransfer?.getData('application/x-edge-collection');
    if (sourceId === undefined || sourceId.length === 0 || sourceId === collection.id) return;
    const sourceIndex = Number(event.dataTransfer?.getData(COLLECTION_DRAG_INDEX_TYPE));
    if (!Number.isInteger(sourceIndex)) return;
    const total = state.collections.length;
    const targetPosition = getReorderTargetPosition(sourceIndex, displayIndex, total, state.settings.sortDescending);
    const sourcePosition = state.settings.sortDescending ? total - 1 - sourceIndex : sourceIndex;
    if (targetPosition === sourcePosition) return;
    const scrollAnchor = captureScrollPositionAnchor();
    void runAction(async () => {
      await repository.reorderCollections(sourceId, targetPosition);
      await loadData(scrollAnchor);
      showToast('集锦顺序已更新。');
    });
  });
};

// 卡片拖拽只在同一集合且手动排序时启用，绝不读取外部 URL 或文件数据。
const enableItemDrag = (row: HTMLElement, item: CollectionItem, collection: Collection, displayIndex: number): void => {
  const manual = state.settings.sort === 'manual';
  row.draggable = manual;
  if (!manual) return;
  row.addEventListener('dragstart', (event) => {
    const transfer = event.dataTransfer;
    if (transfer === null) return;
    transfer.effectAllowed = 'move';
    transfer.setData('application/x-edge-item', item.id);
    transfer.setData(ITEM_DRAG_INDEX_TYPE, String(displayIndex));
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('is-dragging');
    stopDragAutoScroll();
  });
  row.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('application/x-edge-item')) return;
    event.preventDefault();
    updateDragAutoScroll(event);
    row.classList.add('is-drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-drag-over'));
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    row.classList.remove('is-drag-over');
    const sourceId = event.dataTransfer?.getData('application/x-edge-item');
    if (sourceId === undefined || sourceId.length === 0 || sourceId === item.id) return;
    const sourceIndex = Number(event.dataTransfer?.getData(ITEM_DRAG_INDEX_TYPE));
    if (!Number.isInteger(sourceIndex)) return;
    const total = state.itemsByCollection.get(collection.id)?.length ?? 0;
    const targetPosition = getReorderTargetPosition(sourceIndex, displayIndex, total, state.settings.sortDescending);
    const sourcePosition = state.settings.sortDescending ? total - 1 - sourceIndex : sourceIndex;
    if (targetPosition === sourcePosition) return;
    const scrollAnchor = captureScrollPositionAnchor();
    void runAction(async () => {
      await repository.reorderItems(collection.id, sourceId, targetPosition);
      await loadData(scrollAnchor);
      showToast('卡片顺序已更新。');
    });
  });
};

// 安全渲染图片：即使数据库损坏，也不把任意值写入 src。
const appendSafeImage = (parent: HTMLElement, source: string | undefined, className: string, alt: string): boolean => {
  if (source === undefined) return false;
  try {
    const safeSource = className === 'item-thumbnail' ? normalizeThumbnailDataUrl(source) : normalizeWebUrl(source);
    const image = element('img', className);
    image.src = safeSource;
    image.alt = alt;
    image.loading = 'lazy';
    image.addEventListener('error', () => image.remove(), { once: true });
    parent.append(image);
    return true;
  } catch {
    return false;
  }
};

// 卡片菜单提供编辑、移动、删除和手动上下移；搜索结果隐藏与列表顺序有关的入口。
const openItemMenu = (
  row: HTMLElement,
  item: CollectionItem,
  collection: Collection,
  displayIndex: number,
  includeReorder = true,
): void => {
  const existing = row.querySelector<HTMLElement>('.item-menu');
  if (existing !== null) {
    row.classList.remove('has-open-menu');
    existing.remove();
    return;
  }
  closeAllMenus();
  const menu = element('div', 'item-menu');
  row.classList.add('has-open-menu');
  menu.addEventListener('click', (event) => event.stopPropagation());
  const close = (): void => {
    row.classList.remove('has-open-menu');
    menu.remove();
  };
  const edit = button('编辑', () => {
    close();
    if (item.type === 'page') openPageEditDialog(item);
    else openLegacyNoteEditDialog(item);
  }, 'menu-button');
  const move = button('移动到…', () => {
    close();
    openMoveDialog(item, collection.id);
  }, 'menu-button');
  const up = button('上移', () => {
    close();
    const total = state.itemsByCollection.get(collection.id)?.length ?? 0;
    const targetPosition = getReorderTargetPosition(displayIndex, displayIndex - 1, total, state.settings.sortDescending);
    const scrollAnchor = captureScrollPositionAnchor();
    void runAction(async () => {
      await repository.reorderItems(collection.id, item.id, targetPosition);
      await loadData(scrollAnchor);
    });
  }, 'menu-button');
  const down = button('下移', () => {
    close();
    const total = state.itemsByCollection.get(collection.id)?.length ?? 0;
    const targetPosition = getReorderTargetPosition(displayIndex, displayIndex + 1, total, state.settings.sortDescending);
    const scrollAnchor = captureScrollPositionAnchor();
    void runAction(async () => {
      await repository.reorderItems(collection.id, item.id, targetPosition);
      await loadData(scrollAnchor);
    });
  }, 'menu-button');
  up.disabled = state.settings.sort !== 'manual' || displayIndex === 0;
  down.disabled = state.settings.sort !== 'manual' || displayIndex >= (state.itemsByCollection.get(collection.id)?.length ?? 1) - 1;
  const remove = button('删除', () => {
    close();
    showConfirmDialog('删除卡片', '确定删除这张卡片吗？', '删除', async () => {
      await repository.deleteItem(item.id);
      await loadData();
      showToast('卡片已删除。');
    });
  }, 'menu-button danger-button');
  if (includeReorder) menu.append(edit, move, up, down, remove);
  else menu.append(edit, move, remove);
  row.append(menu);
};

// 网页卡片行同时展示缩略图、favicon、标题、域名和备注摘要。
const buildItemRow = (item: CollectionItem, collection: Collection, displayIndex: number): HTMLElement => {
  const row = element('article', 'item-row');
  row.dataset.itemId = item.id;
  if (state.highlightItemId === item.id) {
    row.classList.add('is-highlighted');
    window.setTimeout(() => row.classList.remove('is-highlighted'), 1_600);
  }
  const media = element('div', 'item-media');
  let hasImage = false;
  if (item.type === 'page') {
    hasImage = appendSafeImage(media, item.thumbnailDataUrl, 'item-thumbnail', '网页缩略图');
    if (!hasImage) hasImage = appendSafeImage(media, item.faviconUrl, 'item-favicon', '网站图标');
  }
  if (!hasImage) media.append(element('span', 'item-placeholder', item.type === 'page' ? '↗' : '✎'));
  const content = element('div', 'item-content');
  const title = element('h3', 'item-title', item.title);
  // 标题过长时仍保留省略号，但悬停标题可查看完整文本。
  title.title = item.title;
  const meta = element('p', 'item-meta');
  meta.textContent = item.type === 'page' ? domainFromUrl(item.url) : '旧版便笺';
  content.append(title, meta);
  if (item.type === 'page' && item.note !== undefined && item.note.trim().length > 0) {
    content.append(element('p', 'item-note', item.note.trim()));
  }
  if (item.type === 'legacy-note' && item.content.trim().length > 0) {
    content.append(element('p', 'item-note', item.content.trim()));
  }
  const actions = element('div', 'item-actions');
  const menuButton = button('⋯', () => openItemMenu(row, item, collection, displayIndex), 'icon-button item-more', '卡片操作');
  actions.append(menuButton);
  row.append(media, content, actions);
  row.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    if (item.type === 'page') void runAction(() => openPage(item));
    else openLegacyNoteEditDialog(item);
  });
  enableItemDrag(row, item, collection, displayIndex);
  return row;
};

// 集合菜单提供重命名和删除；搜索结果复用此菜单但不提供排序入口。
const openCollectionMenu = (row: HTMLElement, collection: Collection): void => {
  const existing = row.querySelector<HTMLElement>('.collection-menu');
  if (existing !== null) {
    row.classList.remove('has-open-menu');
    existing.remove();
    return;
  }
  closeAllMenus();
  const menu = element('div', 'collection-menu');
  row.classList.add('has-open-menu');
  menu.addEventListener('click', (event) => event.stopPropagation());
  const close = (): void => {
    row.classList.remove('has-open-menu');
    menu.remove();
  };
  menu.append(
    button('重命名', () => {
      close();
      openRenameCollectionDialog(collection);
    }, 'menu-button'),
    button('删除', () => {
      close();
      showConfirmDialog('删除集锦', `确定删除“${collection.name}”及其中的全部卡片吗？`, '删除', async () => {
        await repository.deleteCollection(collection.id);
        if (state.settings.recentCollectionId === collection.id) {
          state.settings = await settingsStore.update({ recentCollectionId: null });
        }
        await loadData();
        showToast('集锦已删除。');
      });
    }, 'menu-button danger-button'),
  );
  row.append(menu);
};

// 集合列表行提供数量、更多菜单和手动拖拽。
const buildCollectionRow = (collection: Collection, displayIndex: number): HTMLElement => {
  const row = element('article', 'collection-row');
  row.dataset.collectionId = collection.id;
  const quickAdd = button(
    '',
    () => addCurrentPage(collection.id),
    'collection-quick-add',
    "将当前网页添加到集锦：" + collection.name,
  );
  const quickAddIcon = element('span', 'collection-quick-add-icon');
  const quickAddSymbol = element('span', 'collection-quick-add-symbol');
  quickAddSymbol.setAttribute('aria-hidden', 'true');
  quickAddIcon.append(quickAddSymbol);
  quickAdd.append(quickAddIcon);
  const main = button('', () => {
    state.view = { kind: 'detail', collectionId: collection.id };
    state.settings = { ...state.settings, recentCollectionId: collection.id };
    void settingsStore.update({ recentCollectionId: collection.id });
    render(true);
  }, 'collection-main', `打开集锦：${collection.name}`);
  const icon = element('span', 'collection-icon', '▤');
  const text = element('span', 'collection-row-text');
  text.append(element('strong', 'collection-name', collection.name));
  text.append(element('span', 'collection-count', `${itemCount(collection.id)} 个项目`));
  main.append(icon, text);
  const actions = element('div', 'collection-actions');
  const menuButton = button('⋯', () => openCollectionMenu(row, collection), 'icon-button collection-more', '集锦操作');
  actions.append(menuButton);
  row.append(quickAdd, main, actions);
  enableCollectionDrag(row, collection, displayIndex);
  return row;
};

// 详情页名称支持 Enter 保存和失焦保存，形成轻量内联重命名。
const buildDetailTitle = (collection: Collection): HTMLElement => {
  const title = element('input', 'detail-title');
  title.type = 'text';
  title.maxLength = 200;
  title.value = collection.name;
  title.setAttribute('aria-label', '集锦名称');
  title.title = '编辑集锦名称';
  let savedValue = collection.name;
  const save = (): void => {
    if (title.value.trim() === savedValue || title.value.trim().length === 0) {
      title.value = savedValue;
      return;
    }
    const scrollAnchor = captureScrollPositionAnchor();
    void runAction(async () => {
      const updated = await repository.renameCollection(collection.id, title.value);
      savedValue = updated.name;
      title.value = savedValue;
      await loadData(scrollAnchor);
      showToast('集锦名称已更新。');
    });
  };
  title.addEventListener('blur', save);
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      title.blur();
    }
  });
  return title;
};

// 通用导入预览对话框；警告列表只作为纯文本节点插入。
const showImportPreview = (
  title: string,
  backup: BackupV1,
  warnings: readonly string[],
  allowReplace: boolean,
  sourceLabel: string,
): void => {
  showFormDialog(title, allowReplace ? '开始恢复' : '合并恢复', (body, setError) => {
    const summary = element('p', 'preview-summary', `发现 ${backup.collections.length} 个集合、${backup.items.length} 个卡片。`);
    body.append(summary);
    if (warnings.length > 0) {
      const warningHeading = element('h3', 'preview-heading', `警告（${warnings.length} 条）`);
      const list = element('ul', 'warning-list');
      warnings.slice(0, 80).forEach((warning) => list.append(element('li', undefined, warning)));
      if (warnings.length > 80) list.append(element('li', undefined, `其余 ${warnings.length - 80} 条警告已省略。`));
      body.append(warningHeading, list);
    } else {
      body.append(element('p', 'preview-ok', '未发现需要跳过的记录。'));
    }
    let mode: 'merge' | 'replace' = 'merge';
    if (allowReplace) {
      const label = element('label', 'field-label', '恢复模式');
      const select = element('select', 'select-input');
      const merge = element('option');
      merge.value = 'merge';
      merge.textContent = '合并到现有数据（默认）';
      const replace = element('option');
      replace.value = 'replace';
      replace.textContent = '替换现有数据（先自动下载备份）';
      select.append(merge, replace);
      select.addEventListener('change', () => {
        mode = select.value === 'replace' ? 'replace' : 'merge';
      });
      label.append(select);
      body.append(label);
    }
    return async () => {
      try {
        if (mode === 'replace') await applyReplace(backup);
        else await applyMerge(backup, sourceLabel);
        return true;
      } catch (error: unknown) {
        setError(error instanceof Error ? error.message : '恢复失败，请检查备份文件。');
        return false;
      }
    };
  });
};

// 将 SQLite 字节在本地 sql.js 中解析，解析过程不上传文件。
const importSqliteBytes = async (bytes: Uint8Array): Promise<void> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_FILE_SIZE) {
    throw new Error('导入文件不能为空或超过 128 MiB。');
  }
  state.importing = true;
  showToast('正在解析旧版 Edge 数据库…');
  try {
    sqlJsPromise ??= initializeSqlJs();
    const sqlJs = await sqlJsPromise;
    const parsed = parseLegacyCollectionsDatabase(bytes, sqlJs);
    const backup = createBackupV1(parsed.collections, parsed.items);
    showImportPreview('旧版 Edge 数据库预览', backup, parsed.warnings, false, '旧版数据库');
  } finally {
    state.importing = false;
  }
};

// 普通文件选择器不使用 File System Access API，因此可以选择 Local AppData 中的文件。
const importSqliteFile = async (file: File): Promise<void> => {
  assertImportFileSize(file);
  await importSqliteBytes(new Uint8Array(await file.arrayBuffer()));
};

// 选择 JSON 文件并严格解析，默认合并；替换模式在预览中显式选择。
const importJsonFile = async (file: File): Promise<void> => {
  assertImportFileSize(file);
  state.importing = true;
  showToast('正在读取 JSON 备份…');
  try {
    const backup = parseBackupJson(await file.text());
    showImportPreview('JSON 备份预览', backup, [], true, 'JSON 备份');
  } finally {
    state.importing = false;
  }
};

// 创建临时文件选择器，选择完成后立即释放 DOM 引用。
const chooseFile = (accept: string | undefined, handler: (file: File) => Promise<void>): void => {
  if (state.importing) {
    showToast('已有导入正在处理，请稍候。');
    return;
  }
  const input = element('input');
  input.type = 'file';
  if (accept !== undefined && accept.length > 0) input.accept = accept;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file !== undefined) void runAction(() => handler(file));
  }, { once: true });
  input.click();
};

// 设置菜单同时承载导入导出和主题/排序选项，保持主界面单一工作面。
const openMoreMenu = (anchor: HTMLElement): void => {
  const existing = anchor.parentElement?.querySelector<HTMLElement>('.more-menu');
  if (existing !== null && existing !== undefined) {
    existing.remove();
    return;
  }
  closeAllMenus();
  const menu = element('div', 'more-menu');
  const importSqlite = button('从旧版 Edge 数据库恢复…', () => {
    menu.remove();
    chooseFile(undefined, importSqliteFile);
  }, 'menu-button');
  const legacyPathHint = element(
    'p',
    'menu-hint',
    '选择 Edge User Data\\Default 或 Profile 数字目录下的 Collections\\collectionsSQLite 文件。',
  );
  const importJson = button('导入 JSON 备份…', () => {
    menu.remove();
    chooseFile('.json,application/json', importJsonFile);
  }, 'menu-button');
  importSqlite.disabled = state.importing;
  importJson.disabled = state.importing;
  const exportJson = button('导出 JSON 备份', () => {
    menu.remove();
    void runAction(async () => {
      const backup = await createCurrentBackup();
      downloadBytes(new TextEncoder().encode(stringifyBackupV1(backup)), 'application/json;charset=utf-8', makeDownloadFileName('集锦备份', 'json'));
      showToast('JSON 备份已下载。');
    });
  }, 'menu-button');
  const exportCsv = button('导出 CSV', () => {
    menu.remove();
    void runAction(async () => {
      const collections = await repository.listCollections();
      const groups = await Promise.all(collections.map(async (collection) => repository.listItems(collection.id)));
      downloadBytes(exportCollectionsCsv(collections, groups.flat()), 'text/csv;charset=utf-8', makeDownloadFileName('集锦卡片', 'csv'));
      showToast('CSV 已下载。');
    });
  }, 'menu-button');
  const divider = element('div', 'menu-divider');
  const themeLabel = element('label', 'menu-field', '主题');
  const theme = element('select', 'menu-select');
  for (const optionData of [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const) {
    const option = element('option');
    option.value = optionData[0];
    option.textContent = optionData[1];
    option.selected = state.settings.theme === optionData[0];
    theme.append(option);
  }
  theme.addEventListener('change', () => {
    const nextTheme: ThemeMode = theme.value === 'light' || theme.value === 'dark' ? theme.value : 'system';
    void runAction(async () => {
      state.settings = await settingsStore.update({ theme: nextTheme });
      applyTheme();
      render();
    });
  });
  themeLabel.append(theme);
  const sortLabel = element('label', 'menu-field', '排序');
  const sort = element('select', 'menu-select');
  for (const optionData of [['manual', '手动'], ['name', '名称'], ['createdAt', '创建时间']] as const) {
    const option = element('option');
    option.value = optionData[0];
    option.textContent = optionData[1];
    option.selected = state.settings.sort === optionData[0];
    sort.append(option);
  }
  sort.addEventListener('change', () => {
    const nextSort: SortMode = sort.value === 'name' || sort.value === 'createdAt' ? sort.value : 'manual';
    const scrollAnchor = captureScrollPositionAnchor();
    void runAction(async () => {
      state.settings = await settingsStore.update({ sort: nextSort });
      render(false, scrollAnchor);
    });
  });
  sortLabel.append(sort);
  const fontSizeLabel = element('label', 'menu-field', '字号');
  const fontSize = element('input', 'menu-number');
  fontSize.type = 'number';
  fontSize.min = String(MIN_FONT_SIZE);
  fontSize.max = String(MAX_FONT_SIZE);
  fontSize.step = '1';
  fontSize.value = String(state.settings.fontSize);
  fontSize.setAttribute('aria-label', '字号（像素）');
  fontSize.title = '字号范围 12–24 像素';
  fontSize.addEventListener('change', () => {
    const nextFontSize = Number(fontSize.value);
    if (!Number.isFinite(nextFontSize)) {
      fontSize.value = String(state.settings.fontSize);
      return;
    }
    void runAction(async () => {
      state.settings = await settingsStore.update({ fontSize: nextFontSize });
      render();
    });
  });
  fontSizeLabel.append(fontSize);
  menu.append(importSqlite, legacyPathHint, importJson, exportJson, exportCsv, divider, themeLabel, sortLabel, fontSizeLabel);
  anchor.parentElement?.append(menu);
};

// 关闭旧的待处理对话框；最新捕获会在下一个事件循环中重新打开。
const closePendingDialog = (): void => {
  const dialog = pendingDialog;
  pendingDialog = undefined;
  state.pendingDialogOpen = false;
  dialog?.close();
};

// 待处理捕获选择集合后才写入 IndexedDB，重复 URL 会保留待处理状态供用户改选。
const openPendingCaptureDialog = (): void => {
  const capture = state.pendingCapture;
  if (capture === undefined) return;
  if (pendingDialog !== undefined) closePendingDialog();
  state.pendingDialogOpen = true;
  const captureForDialog = capture;
  const dialog = showFormDialog('添加到集锦', '保存网页', (body, setError) => {
    const preview = element('p', 'capture-preview', captureForDialog.title);
    const url = element('p', 'capture-url', captureForDialog.url);
    const label = element('label', 'field-label', '选择集锦');
    const select = element('select', 'select-input');
    for (const collection of state.collections) {
      const option = element('option');
      option.value = collection.id;
      option.textContent = collection.name;
      option.selected = collection.id === state.settings.recentCollectionId;
      select.append(option);
    }
    label.append(select);
    body.append(preview, url, label);
    if (state.collections.length === 0) {
      body.append(element('p', 'dialog-hint', '还没有集锦，请先取消并新建一个集锦。'));
    }
    return async () => {
      if (select.value.length === 0) {
        setError('请先创建并选择一个集锦。');
        return false;
      }
      try {
        await repository.createPageItem({
          collectionId: select.value,
          title: captureForDialog.title,
          url: captureForDialog.url,
          faviconUrl: captureForDialog.faviconUrl,
        });
        // 删除前确认 storage 和当前状态仍指向同一捕获，落实 last-write-wins。
        const currentStateCapture = state.pendingCapture;
        const storedValue = (await chrome.storage.session.get(PENDING_CAPTURE_STORAGE_KEY))[PENDING_CAPTURE_STORAGE_KEY];
        const storedCapture = storedValue === undefined ? undefined : validatePageCapture(storedValue);
        if (!arePageCapturesEqual(currentStateCapture, captureForDialog)
          || !arePageCapturesEqual(storedCapture, captureForDialog)) {
          return true;
        }
        await chrome.storage.session.remove(PENDING_CAPTURE_STORAGE_KEY);
        state.pendingCapture = undefined;
        state.settings = await settingsStore.update({ recentCollectionId: select.value });
        await loadData();
        showToast('已从右键菜单添加网页。');
        return true;
      } catch (error: unknown) {
        if (error instanceof DuplicateUrlError) {
          setError('该集锦中已经有相同网页，请选择其他集锦。');
          return false;
        }
        throw error;
      }
    };
  });
  pendingDialog = dialog;
  dialog.addEventListener('close', () => {
    if (pendingDialog === dialog) {
      pendingDialog = undefined;
      state.pendingDialogOpen = false;
    }
  }, { once: true });
};

// 启动和 storage.session 变更都读取待处理捕获，兼容侧栏晚于后台打开的情况。
const readPendingCapture = async (rawValue?: unknown): Promise<void> => {
  try {
    const raw = rawValue === undefined
      ? (await chrome.storage.session.get(PENDING_CAPTURE_STORAGE_KEY))[PENDING_CAPTURE_STORAGE_KEY]
      : rawValue;
    if (raw === undefined) {
      state.pendingCapture = undefined;
      closePendingDialog();
      return;
    }
    state.pendingCapture = validatePageCapture(raw);
    openPendingCaptureDialog();
  } catch {
    state.pendingCapture = undefined;
    closePendingDialog();
    await chrome.storage.session.remove(PENDING_CAPTURE_STORAGE_KEY).catch(() => undefined);
    showToast('待保存网页数据无效，已忽略。', 'error');
  }
};

// 顶部搜索、创建和更多入口。
const buildHeader = (): HTMLElement => {
  const header = element('header', 'app-header');
  const brand = element('div', 'brand');
  brand.append(element('span', 'brand-mark', '▦'), element('h1', undefined, '集锦'));
  const actions = element('div', 'header-actions');
  actions.append(button('+', openCreateCollectionDialog, 'primary-button compact-button', '新建集锦'));
  const more = button('⋯', () => openMoreMenu(more), 'icon-button', '更多设置与文件操作');
  actions.append(more);
  const searchShell = element('label', 'search-shell');
  searchShell.setAttribute('aria-label', '搜索集锦');
  searchShell.append(element('span', 'search-icon', '⌕'));
  const searchInput = element('input', 'search-input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索标题、网址或备注';
  searchInput.value = state.searchQuery;
  searchInput.setAttribute('data-search-input', 'true');
  let searchComposing = false;
  let compositionSearchPending = false;
  let compositionSearchTimer: number | undefined;
  // 中文输入法组合期间不能重绘输入框，否则候选词状态会被 DOM 替换打断。
  searchInput.addEventListener('compositionstart', () => {
    searchComposing = true;
    compositionSearchPending = false;
    if (compositionSearchTimer !== undefined) {
      window.clearTimeout(compositionSearchTimer);
      compositionSearchTimer = undefined;
    }
  });
  searchInput.addEventListener('compositionend', () => {
    searchComposing = false;
    compositionSearchPending = true;
    // 不在 compositionend 的当前事件中重绘，等待浏览器提交最终 input 值。
    compositionSearchTimer = window.setTimeout(() => {
      compositionSearchTimer = undefined;
      if (!compositionSearchPending) return;
      compositionSearchPending = false;
      state.searchQuery = searchInput.value;
      void search();
    }, 0);
  });
  searchInput.addEventListener('input', (event) => {
    state.searchQuery = searchInput.value;
    const inputEvent = event as InputEvent;
    if (searchComposing || inputEvent.isComposing) return;
    if (compositionSearchPending) compositionSearchPending = false;
    void search();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || searchComposing || event.isComposing) return;
    event.preventDefault();
    if (compositionSearchPending) compositionSearchPending = false;
    if (compositionSearchTimer !== undefined) {
      window.clearTimeout(compositionSearchTimer);
      compositionSearchTimer = undefined;
    }
    state.searchQuery = searchInput.value;
    void search();
  });
  searchShell.append(searchInput);
  header.append(brand, searchShell, actions);
  return header;
};

// 总览内容使用紧凑列表，不堆叠 dashboard 卡片。
const renderOverview = (main: HTMLElement): void => {
  const intro = element('div', 'view-intro');
  const introText = element('div', 'view-intro-text');
  introText.append(element('div', 'eyebrow', '所有集锦'), element('p', 'view-subtitle', `${state.collections.length} 个集锦`));
  const direction = state.settings.sortDescending ? '↓' : '↑';
  const directionButton = button(
    direction,
    () => {
      const scrollAnchor = captureScrollPositionAnchor();
      void runAction(async () => {
        state.settings = await settingsStore.update({ sortDescending: !state.settings.sortDescending });
        render(false, scrollAnchor);
      });
    },
    'icon-button sort-direction',
    state.settings.sortDescending ? '切换为正序' : '切换为反序',
  );
  directionButton.title = state.settings.sortDescending ? '当前反序，点击切换为正序' : '当前正序，点击切换为反序';
  intro.append(introText, directionButton);
  main.append(intro);
  if (state.loadError !== null) {
    const errorState = element('section', 'empty-state compact-empty');
    errorState.append(
      element('h2', undefined, '暂时无法读取集锦'),
      element('p', undefined, `数据未被清空。错误：${state.loadError}`),
      button('重新读取', () => void loadData(), 'primary-button'),
    );
    main.append(errorState);
    if (state.collections.length === 0) return;
  }
  if (state.collections.length === 0) {
    const empty = element('section', 'empty-state');
    empty.append(element('div', 'empty-icon', '▤'), element('h2', undefined, '从一个集锦开始'), element('p', undefined, '把网页、备注和想法集中到一个安静的列表里。'), button('新建集锦', openCreateCollectionDialog, 'primary-button'));
    main.append(empty);
    return;
  }
  const list = element('div', 'collection-list');
  sortCollectionsForDisplay(state.collections, state.settings.sort, state.settings.sortDescending).forEach((collection, index) => list.append(buildCollectionRow(collection, index)));
  main.append(list);
};

// 搜索结果中的集合行可直接进入详情，并复用集合的重命名/删除菜单。
const buildSearchCollectionRow = (collection: Collection): HTMLElement => {
  const row = element('article', 'search-result-row search-result-collection');
  row.dataset.collectionId = collection.id;
  const main = button('', () => {
    state.view = { kind: 'detail', collectionId: collection.id };
    state.settings = { ...state.settings, recentCollectionId: collection.id };
    void settingsStore.update({ recentCollectionId: collection.id });
    render(true);
  }, 'search-result-main', `打开集锦：${collection.name}`);
  main.append(
    element('strong', 'search-result-title', collection.name),
    element('span', 'search-result-location', `集锦 · ${itemCount(collection.id)} 个项目`),
  );
  const actions = element('div', 'search-result-actions');
  actions.append(button('⋯', () => openCollectionMenu(row, collection), 'icon-button collection-more', '集锦操作'));
  row.append(main, actions);
  return row;
};

// 搜索结果中的卡片保留原有编辑、移动和删除入口，但隐藏上下移排序入口。
const buildSearchItemRow = (collection: Collection, item: CollectionItem): HTMLElement => {
  const row = element('article', 'search-result-row search-result-item');
  row.dataset.itemId = item.id;
  const main = button('', () => {
    state.view = { kind: 'detail', collectionId: collection.id };
    state.highlightItemId = item.id;
    render(true);
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 40);
  }, 'search-result-main', `定位到网页：${item.title}`);
  main.append(
    element('strong', 'search-result-title', item.title),
    element('span', 'search-result-location', `${collection.name} · ${item.type === 'page' ? domainFromUrl(item.url) : '旧版便笺'}`),
  );
  const note = item.type === 'page' ? item.note?.trim() : item.content.trim();
  if (note !== undefined && note.length > 0) {
    main.append(element('span', 'search-result-note', `${item.type === 'page' ? '备注 / 批注' : '便笺'}：${note}`));
  }
  const actions = element('div', 'search-result-actions');
  actions.append(button('⋯', () => openItemMenu(row, item, collection, 0, false), 'icon-button item-more', '卡片操作'));
  row.append(main, actions);
  return row;
};

// 搜索结果先显示命中的集合，再显示命中的网页或旧版便笺。
const renderSearch = (main: HTMLElement): void => {
  const intro = element('div', 'view-intro');
  intro.append(element('div', 'eyebrow', '搜索结果'), element('p', 'view-subtitle', `${state.searchResults.length} 个匹配结果`));
  main.append(intro);
  if (state.searchResults.length === 0) {
    main.append(element('section', 'empty-state compact-empty', '没有找到匹配内容。'));
    return;
  }
  const list = element('div', 'search-results');
  state.searchResults.forEach((result) => {
    if (result.kind === 'collection') list.append(buildSearchCollectionRow(result.collection));
    else list.append(buildSearchItemRow(result.collection, result.item));
  });
  main.append(list);
};

// 详情页包含返回、内联重命名、添加当前页、打开全部和删除。
const renderDetail = (main: HTMLElement, collection: Collection): void => {
  const detailHeader = element('div', 'detail-header');
  const back = button('‹', () => {
    state.view = { kind: 'overview' };
    state.highlightItemId = null;
    render(true);
  }, 'icon-button back-button', '返回集锦列表');
  const titleWrap = element('div', 'detail-title-wrap');
  titleWrap.append(buildDetailTitle(collection), element('p', 'detail-count', `${itemCount(collection.id)} 个项目`));
  const actions = element('div', 'detail-actions');
  actions.append(
    button('添加当前页', () => addCurrentPage(collection.id), 'secondary-button'),
    button('打开全部', () => openAllPages(collection), 'secondary-button'),
    button('删除', () => {
      showConfirmDialog('删除集锦', `确定删除“${collection.name}”及其中的全部卡片吗？`, '删除', async () => {
        await repository.deleteCollection(collection.id);
        if (state.settings.recentCollectionId === collection.id) {
          state.settings = await settingsStore.update({ recentCollectionId: null });
        }
        state.view = { kind: 'overview' };
        await loadData();
        render(true);
        showToast('集锦已删除。');
      });
    }, 'secondary-button danger-button'),
  );
  detailHeader.append(back, titleWrap, actions);
  main.append(detailHeader);
  if (state.settings.sort !== 'manual') {
    main.append(element('p', 'sort-hint', `当前按${state.settings.sort === 'name' ? '名称' : '创建时间'}${state.settings.sortDescending ? '反序' : '正序'}排序，拖拽已停用。`));
  }
  const items = sortItemsForDisplay(state.itemsByCollection.get(collection.id) ?? [], state.settings.sort, state.settings.sortDescending);
  if (items.length === 0) {
    main.append(element('section', 'empty-state compact-empty', '这个集锦还没有卡片。点击“添加当前页”开始收集。'));
    return;
  }
  const list = element('div', 'item-list');
  items.forEach((item, index) => list.append(buildItemRow(item, collection, index)));
  main.append(list);
};

// 渲染三层视图；普通刷新保留首个可见条目，明确导航时才回到顶部。
const render = (resetScroll = false, anchorOverride?: ScrollAnchor): void => {
  const scrollAnchor = anchorOverride ?? captureScrollAnchor();
  applyTheme();
  applyFontSize();
  app.replaceChildren();
  app.append(buildHeader());
  const main = element('main', 'app-main');
  if (state.loading) {
    main.append(element('div', 'loading-state', '正在读取集锦…'));
  } else if (state.view.kind === 'overview') {
    renderOverview(main);
  } else if (state.view.kind === 'search') {
    renderSearch(main);
  } else {
    const detailCollectionId = state.view.kind === 'detail' ? state.view.collectionId : undefined;
    const collection = detailCollectionId === undefined
      ? undefined
      : state.collections.find((candidate) => candidate.id === detailCollectionId);
    if (collection === undefined) renderOverview(main);
    else renderDetail(main, collection);
  }
  app.append(main);
  window.requestAnimationFrame(() => restoreScrollAnchor(scrollAnchor, resetScroll));
};

// 启动侧栏并监听后台写入的待处理页面。
const start = async (): Promise<void> => {
  state.settings = await settingsStore.get();
  await loadData();
  await readPendingCapture();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') return;
    const change = changes[PENDING_CAPTURE_STORAGE_KEY];
    if (change !== undefined && change.newValue !== undefined) void readPendingCapture(change.newValue);
  });
};

void start().catch((error: unknown) => showToast(error instanceof Error ? error.message : '侧栏启动失败。', 'error'));
