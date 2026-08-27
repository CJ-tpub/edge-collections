import {
  createPageCapture,
  PENDING_CAPTURE_PICKER_STORAGE_KEY,
  PENDING_CAPTURE_STORAGE_KEY,
} from './capture/capture';

const CONTEXT_MENU_ID = 'add-page-to-collection';
const x: unknown = 1;
const CAPTURE_PICKER_PATH = 'capture-picker.html';
const CAPTURE_PICKER_WIDTH = 380;
const CAPTURE_PICKER_HEIGHT = 460;
let capturePickerWindowId: number | undefined;
let contextMenuRefreshQueue: Promise<void> = Promise.resolve();

// 创建菜单项并读取 lastError，避免 Edge 在菜单更新竞态时留下未处理错误。
const createContextMenuItem = (properties: chrome.contextMenus.CreateProperties): Promise<void> => new Promise<void>((resolve, reject) => {
  try {
    chrome.contextMenus.create(properties, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError !== undefined) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  } catch (error: unknown) {
    reject(error);
  }
});

// 右键只保留一个顶层菜单，具体集锦在独立弹出窗口中选择。
const refreshContextMenu = async (): Promise<void> => {
  try {
    await chrome.contextMenus.removeAll();
    await createContextMenuItem({
      id: CONTEXT_MENU_ID,
      title: '添加当前页到集锦',
      contexts: ['page'],
    });
  } catch {
    // 菜单更新失败时不影响侧栏和数据读写，下一次启动或安装时会再次尝试。
  }
};

// 串行更新菜单，避免浏览器恢复扩展状态时 removeAll/create 互相覆盖。
const scheduleContextMenuRefresh = (): void => {
  contextMenuRefreshQueue = contextMenuRefreshQueue
    .then(refreshContextMenu)
    .catch(() => undefined);
};

// 打开独立的小型窗口选择目标集锦；窗口已存在时只聚焦并复用它。
const openCapturePicker = async (
  capture: ReturnType<typeof createPageCapture>,
  windowId: number,
): Promise<void> => {
  await chrome.storage.session.set({
    [PENDING_CAPTURE_PICKER_STORAGE_KEY]: capture,
  });

  if (capturePickerWindowId !== undefined) {
    try {
      const existing = await chrome.windows.get(capturePickerWindowId);
      if (existing.id !== undefined) {
        await chrome.windows.update(capturePickerWindowId, { focused: true });
        return;
      }
    } catch {
      capturePickerWindowId = undefined;
    }
  }

  const pickerUrl = chrome.runtime.getURL(CAPTURE_PICKER_PATH)
    + '?windowId=' + String(windowId);
  const popup = await chrome.windows.create({
    url: pickerUrl,
    type: 'popup',
    width: CAPTURE_PICKER_WIDTH,
    height: CAPTURE_PICKER_HEIGHT,
    focused: true,
  });
  capturePickerWindowId = popup.id;
};

// 弹出窗口不可用时，回退到侧栏已有选择对话框，确保右键功能仍可用。
const stagePendingCapture = async (
  capture: ReturnType<typeof createPageCapture>,
  windowId: number,
): Promise<void> => {
  try {
    await openCapturePicker(capture, windowId);
  } catch {
    try {
      await chrome.storage.session.remove(PENDING_CAPTURE_PICKER_STORAGE_KEY);
      await chrome.storage.session.set({ [PENDING_CAPTURE_STORAGE_KEY]: capture });
      await chrome.sidePanel.open({ windowId });
    } catch {
      // 菜单可能出现在 edge:// 等不可保存页面，静默忽略并保持扩展可用。
    }
  }
};

// 安装或更新扩展时，让工具栏按钮默认打开侧栏并创建页面右键菜单。
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  scheduleContextMenuRefresh();
});

// 浏览器启动后再次设置行为，兼容浏览器恢复扩展状态的场景。
chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  scheduleContextMenuRefresh();
});

// 弹出窗口关闭后清理窗口 ID，下一次右键操作会重新创建窗口。
chrome.windows.onRemoved.addListener((windowId) => {
  if (capturePickerWindowId !== windowId) return;
  capturePickerWindowId = undefined;
  void chrome.storage.session.remove(PENDING_CAPTURE_PICKER_STORAGE_KEY).catch(() => undefined);
});

// 页面菜单点击后读取当前标签页快照，再交给弹出窗口选择保存目标。
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || tab?.windowId === undefined) return;
  try {
    const capture = createPageCapture({
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
    });
    void stagePendingCapture(capture, tab.windowId);
  } catch {
    // 菜单可能出现在 edge:// 等不可保存页面，静默忽略并保持扩展可用。
  }
});

// 快捷键由用户主动触发，因此可以打开当前窗口的侧边栏。
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-collections') {
    return;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (activeTab?.windowId === undefined) {
    return;
  }

  await chrome.sidePanel.open({ windowId: activeTab.windowId });
});

// Service Worker 重新加载时主动确保菜单存在；安装/启动事件仍负责后续重试。
scheduleContextMenuRefresh();
