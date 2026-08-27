import './style.css';
import { DuplicateUrlError } from '../domain/logic';
import { IndexedDbCollectionRepository } from '../data/collection-repository';
import {
  arePageCapturesEqual,
  PENDING_CAPTURE_PICKER_STORAGE_KEY,
  validatePageCapture,
  type PageCapture,
} from '../capture/capture';
import type { Collection, CollectionItem } from '../domain/types';

const app = document.querySelector<HTMLElement>('#app');
if (app === null) {
  throw new Error('找不到添加到集锦窗口的根节点。');
}

const repository = new IndexedDbCollectionRepository();
const sourceWindowId = (() => {
  const rawValue = new URLSearchParams(window.location.search).get('windowId');
  const value = rawValue === null ? Number.NaN : Number(rawValue);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
})();

let capture: PageCapture | undefined;
let collections: Collection[] = [];
const itemCounts = new Map<string, number>();
let loading = true;
let busy = false;
let errorMessage: string | undefined;
let successMessage: string | undefined;
let closeTimer: number | undefined;

// 统一创建安全 DOM 节点，网页标题和网址只通过 textContent 写入。
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

// 所有窗口操作统一捕获异常，并在弹出窗口内显示中文错误。
const runAction = async (action: () => void | Promise<void>): Promise<void> => {
  try {
    await action();
  } catch (error: unknown) {
    busy = false;
    errorMessage = error instanceof Error ? error.message : '操作失败，请稍后重试。';
    render();
  }
};

// 弹出窗口按钮统一补充原生 tooltip 和可访问名称。
const actionButton = (
  label: string,
  onClick: () => void | Promise<void>,
  className: string,
  accessibleLabel: string,
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

// 只在 storage 中仍是同一捕获时清除，避免覆盖用户随后发起的另一次右键添加。
const removeCurrentPendingCapture = async (expected: PageCapture): Promise<void> => {
  const rawValue = (await chrome.storage.session.get(PENDING_CAPTURE_PICKER_STORAGE_KEY))[
    PENDING_CAPTURE_PICKER_STORAGE_KEY
  ];
  if (rawValue === undefined) return;
  let current: PageCapture;
  try {
    current = validatePageCapture(rawValue);
  } catch {
    return;
  }
  if (arePageCapturesEqual(current, expected)) {
    await chrome.storage.session.remove(PENDING_CAPTURE_PICKER_STORAGE_KEY);
  }
};

// 关闭当前弹出窗口；窗口由扩展后台创建，因此可由页面主动关闭。
const closeWindow = (): void => {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer);
  window.close();
};

// 将当前网页保存到用户点击的集锦，并保留重复 URL 的可重试状态。
const addToCollection = async (collectionId: string): Promise<void> => {
  if (busy || capture === undefined) return;
  const captureForSave = capture;
  const collection = collections.find((candidate) => candidate.id === collectionId);
  if (collection === undefined) return;

  busy = true;
  errorMessage = undefined;
  successMessage = undefined;
  render();
  try {
    await repository.createPageItem({
      collectionId,
      title: captureForSave.title,
      url: captureForSave.url,
      faviconUrl: captureForSave.faviconUrl,
    });
    await removeCurrentPendingCapture(captureForSave);
    // 右键弹窗保存后通知已打开的侧栏刷新列表。
    void chrome.runtime.sendMessage({ type: 'collection-page-added' }).catch(() => undefined);
    busy = false;
    successMessage = '已添加到“' + collection.name + '”。';
    render();
    closeTimer = window.setTimeout(closeWindow, 520);
  } catch (error: unknown) {
    busy = false;
    errorMessage = error instanceof DuplicateUrlError
      ? '该集锦中已经有相同网页，请选择其他集锦。'
      : error instanceof Error ? error.message : '保存失败，请稍后重试。';
    render();
  }
};

// 没有集锦时，从原页面窗口打开侧栏，方便先创建集锦再回到添加流程。
const openSidebar = async (): Promise<void> => {
  if (sourceWindowId === undefined) {
    closeWindow();
    return;
  }
  await chrome.sidePanel.open({ windowId: sourceWindowId });
  closeWindow();
};

// 渲染当前捕获、集锦列表和状态提示；所有用户数据都使用安全文本节点。
const render = (): void => {
  app.replaceChildren();
  const shell = element('main', 'picker-shell');
  const header = element('header', 'picker-header');
  header.append(element('h1', undefined, '添加到集锦'));
  header.append(actionButton('×', closeWindow, 'close-button', '关闭'));
  shell.append(header);

  if (loading) {
    shell.append(element('p', 'picker-message', '正在读取集锦…'));
    app.append(shell);
    return;
  }

  if (capture === undefined) {
    shell.append(element('p', 'picker-message', errorMessage ?? '没有待保存的网页。'));
    shell.append(actionButton('关闭', closeWindow, 'secondary-button', '关闭添加窗口'));
    app.append(shell);
    return;
  }

  const preview = element('section', 'capture-card');
  const previewTitle = element('h2', 'capture-title', capture.title);
  previewTitle.title = capture.title;
  const previewUrl = element('p', 'capture-url', capture.url);
  previewUrl.title = capture.url;
  preview.append(previewTitle, previewUrl);
  shell.append(preview);

  if (successMessage !== undefined) {
    const success = element('p', 'picker-status picker-success', successMessage);
    success.setAttribute('role', 'status');
    shell.append(success);
  }
  if (errorMessage !== undefined) {
    const error = element('p', 'picker-status picker-error', errorMessage);
    error.setAttribute('role', 'alert');
    shell.append(error);
  }

  const heading = element('h2', 'section-title', '选择目标集锦');
  shell.append(heading);
  if (collections.length === 0) {
    shell.append(element('p', 'picker-message', '还没有集锦，请先在侧栏新建一个集锦。'));
    if (sourceWindowId !== undefined) {
      shell.append(actionButton('打开集锦侧栏', openSidebar, 'primary-button', '打开集锦侧栏'));
    }
  } else {
    const list = element('div', 'collection-choice-list');
    for (const collection of collections) {
      const choice = actionButton(
        '',
        () => addToCollection(collection.id),
        'collection-choice',
        '保存到集锦：' + collection.name,
      );
      const name = element('span', 'collection-choice-name', collection.name);
      const count = element(
        'span',
        'collection-choice-count',
        String(itemCounts.get(collection.id) ?? 0) + ' 个项目',
      );
      choice.append(name, count);
      choice.disabled = busy;
      list.append(choice);
    }
    shell.append(list);
  }
  app.append(shell);
};

// 读取待保存网页和集锦数量；弹出窗口复用时会在 storage 变化后再次调用。
const load = async (): Promise<void> => {
  loading = true;
  errorMessage = undefined;
  successMessage = undefined;
  render();
  try {
    const rawValue = (await chrome.storage.session.get(PENDING_CAPTURE_PICKER_STORAGE_KEY))[
      PENDING_CAPTURE_PICKER_STORAGE_KEY
    ];
    if (rawValue === undefined) {
      capture = undefined;
      collections = [];
      itemCounts.clear();
      return;
    }
    capture = validatePageCapture(rawValue);
    collections = await repository.listCollections();
    itemCounts.clear();
    const counts = await Promise.all(collections.map(async (collection) => {
      const items: CollectionItem[] = await repository.listItems(collection.id);
      return [collection.id, items.length] as const;
    }));
    for (const [collectionId, count] of counts) itemCounts.set(collectionId, count);
  } catch (error: unknown) {
    capture = undefined;
    errorMessage = error instanceof Error ? error.message : '读取待保存网页失败。';
    await chrome.storage.session.remove(PENDING_CAPTURE_PICKER_STORAGE_KEY).catch(() => undefined);
  } finally {
    loading = false;
    busy = false;
    render();
  }
};

// 后台复用弹出窗口时，新的右键捕获会触发刷新而不必创建第二个窗口。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session' || changes[PENDING_CAPTURE_PICKER_STORAGE_KEY] === undefined) return;
  void load();
});

void load();
