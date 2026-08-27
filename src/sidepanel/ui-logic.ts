import type { Collection, CollectionItem, SortMode } from '../domain/types';

// 统一文件大小上限，避免文件读取阶段占满侧栏内存。
export const MAX_IMPORT_FILE_SIZE = 128 * 1024 * 1024;

// 以当前排序设置复制并稳定排序集合列表。
export function sortCollectionsForDisplay(collections: readonly Collection[], sort: SortMode, descending = false): Collection[] {
  const direction = descending ? -1 : 1;
  const sorted = collections
    .map((collection, index) => ({ collection, index }))
    .sort((left, right) => {
      const primary = sort === 'name'
        ? left.collection.name.localeCompare(right.collection.name, 'zh-CN')
        : sort === 'createdAt'
          ? left.collection.createdAt - right.collection.createdAt
          : left.collection.position - right.collection.position;
      return primary * direction || left.index - right.index;
    })
    .map(({ collection }) => collection);
  return sorted;
}

// 以当前排序设置复制并稳定排序同一集合中的卡片。
export function sortItemsForDisplay(items: readonly CollectionItem[], sort: SortMode, descending = false): CollectionItem[] {
  const direction = descending ? -1 : 1;
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const primary = sort === 'name'
        ? left.item.title.localeCompare(right.item.title, 'zh-CN')
        : sort === 'createdAt'
          ? left.item.createdAt - right.item.createdAt
          : left.item.position - right.item.position;
      return primary * direction || left.index - right.index;
    })
    .map(({ item }) => item);
  return sorted;
}

// 将“目标行上边缘”换算为重排数组的最终位置，修正源行在目标行之前时的索引偏移。
export function getReorderTargetPosition(
  sourceIndex: number,
  targetIndex: number,
  total: number,
  descending = false,
): number {
  const count = Math.max(0, Math.trunc(total));
  if (count === 0) return 0;
  const source = Math.max(0, Math.min(count - 1, Math.trunc(sourceIndex)));
  const target = Math.max(0, Math.min(count - 1, Math.trunc(targetIndex)));
  const displayPosition = source < target ? target - 1 : target;
  return descending ? count - 1 - displayPosition : displayPosition;
}

// 只显示已验证网页的主机名；异常值不会回退成可点击内容。
export function domainFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '未知网站';
    return parsed.hostname || '未知网站';
  } catch {
    return '未知网站';
  }
}

// 文件读取前先检查长度；浏览器 File.size 是可靠的字节数。
export function isImportFileSizeAllowed(size: number, limit = MAX_IMPORT_FILE_SIZE): boolean {
  return Number.isFinite(size) && size >= 0 && size <= limit;
}

// 下载文件名只保留用户可读字符和安全分隔符，避免路径穿越或非法 Windows 名称。
export function makeDownloadFileName(prefix: string, extension: string, timestamp = Date.now()): string {
  const safePrefix = prefix.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/gu, '-').replace(/-+/gu, '-').slice(0, 80) || '集锦备份';
  const safeExtension = extension.trim().replace(/[^a-z0-9]/giu, '').toLowerCase() || 'dat';
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  const datePart = Number.isNaN(date.getTime())
    ? '未知日期'
    : date.toISOString().slice(0, 10).replace(/-/gu, '');
  return `${safePrefix}-${datePart}.${safeExtension}`;
}
