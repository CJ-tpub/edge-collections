import { createPageCapture, PENDING_CAPTURE_STORAGE_KEY } from './capture/capture';

const CONTEXT_MENU_ID = 'add-page-to-collection';

// 只创建一个页面右键菜单，不接收选区、链接或图片上下文。
const createContextMenu = (): void => {
  chrome.contextMenus.removeAll(() => {
    void chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: '添加当前页到集锦',
      contexts: ['page'],
    });
  });
};

// 安装或更新扩展时，让工具栏按钮默认打开侧边栏并创建唯一菜单。
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  createContextMenu();
});

// 浏览器启动后再次设置行为，兼容浏览器恢复扩展状态的场景。
chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  createContextMenu();
});

// 页面菜单只保存安全的当前页快照，真正写入 IndexedDB 由侧栏完成。
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || tab === undefined || tab.windowId === undefined) {
    return;
  }
  try {
    const capture = createPageCapture({
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
    });
    void chrome.storage.session.set({ [PENDING_CAPTURE_STORAGE_KEY]: capture })
      .then(() => chrome.sidePanel.open({ windowId: tab.windowId }));
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
