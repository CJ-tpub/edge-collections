import { normalizeTitle, normalizeWebUrl } from '../domain/logic';

// 当前页快照只携带保存卡片所需的信息，不把完整 tabs.Tab 传入数据层。
export interface PageCapture {
  title: string;
  url: string;
  faviconUrl?: string;
  capturedAt: number;
}

// 后台与侧栏共用的待处理快照键名；主体数据仍只存 IndexedDB。
export const PENDING_CAPTURE_STORAGE_KEY = 'pendingPageCapture';

// 侧栏和后台都使用这个最小标签快照，便于纯逻辑测试且不依赖浏览器对象。
export interface TabSnapshot {
  title?: string;
  url?: string;
  favIconUrl?: string;
}

// 比较待处理快照的稳定身份，避免旧对话框误删后来写入的新网页。
export function arePageCapturesEqual(left: PageCapture | undefined, right: PageCapture | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.capturedAt === right.capturedAt
    && left.url === right.url;
}

const MAX_CAPTURE_TITLE_LENGTH = 10_000;

// 运行时对象守卫，拒绝把未知消息直接断言成捕获数据。
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

// favicon 是可选装饰信息，协议不安全时直接忽略而不影响网页主体保存。
const safeFavicon = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  try {
    return normalizeWebUrl(value);
  } catch {
    return undefined;
  }
};

// 从标签快照生成当前页捕获；网页 URL 只允许 HTTP/HTTPS。
export function createPageCapture(tab: TabSnapshot, now = Date.now()): PageCapture {
  if (typeof tab.url !== 'string') {
    throw new Error('当前标签页没有可保存的网页地址。');
  }
  const url = normalizeWebUrl(tab.url);
  const rawTitle = typeof tab.title === 'string' && tab.title.length <= MAX_CAPTURE_TITLE_LENGTH
    ? tab.title
    : undefined;
  const capture: PageCapture = {
    title: normalizeTitle(rawTitle, url),
    url,
    capturedAt: Number.isFinite(now) ? Math.trunc(now) : Date.now(),
  };
  const faviconUrl = safeFavicon(tab.favIconUrl);
  if (faviconUrl !== undefined) capture.faviconUrl = faviconUrl;
  return capture;
}

// 读取 storage.session 或后台消息中的未知值，返回经过同样安全校验的快照。
export function validatePageCapture(value: unknown): PageCapture {
  if (!isRecord(value)) {
    throw new Error('待保存网页数据格式无效。');
  }
  const title = typeof value.title === 'string' && value.title.length <= MAX_CAPTURE_TITLE_LENGTH
    ? value.title
    : undefined;
  const url = typeof value.url === 'string' ? normalizeWebUrl(value.url) : (() => {
    throw new Error('待保存网页地址无效。');
  })();
  const capturedAt = typeof value.capturedAt === 'number' && Number.isFinite(value.capturedAt)
    ? Math.trunc(value.capturedAt)
    : Date.now();
  const capture: PageCapture = {
    title: normalizeTitle(title, url),
    url,
    capturedAt,
  };
  const faviconUrl = safeFavicon(value.faviconUrl);
  if (faviconUrl !== undefined) capture.faviconUrl = faviconUrl;
  return capture;
}
