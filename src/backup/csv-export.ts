import type { Collection, CollectionItem } from '../domain/types';

// CSV 列顺序固定，便于后续导入工具和用户查看。
const CSV_HEADER = ['Collection', 'Title', 'URL', 'Note', 'CreatedAt'];

// 统一 CSV 字段转义：双引号加倍，并始终使用双引号包围字段。
const escapeCsvCell = (value: string): string => `"${value.replace(/"/gu, '""')}"`;

// 将集合和卡片编码为带 UTF-8 BOM 的 Uint8Array，供后续下载 UI 使用。
export function exportCollectionsCsv(
  collections: readonly Collection[],
  items: readonly CollectionItem[],
): Uint8Array {
  const collectionNames = new Map(collections.map((collection) => [collection.id, collection.name]));
  const rows: string[] = [CSV_HEADER.join(',')];
  for (const item of items) {
    const url = item.type === 'page' ? item.url : '';
    const note = item.type === 'page' ? item.note ?? '' : item.content;
    const row = [
      collectionNames.get(item.collectionId) ?? '',
      item.title,
      url,
      note,
      new Date(item.createdAt).toISOString(),
    ].map(escapeCsvCell).join(',');
    rows.push(row);
  }

  const body = `${rows.join('\r\n')}\r\n`;
  const encoded = new TextEncoder().encode(body);
  const result = new Uint8Array(encoded.length + 3);
  result.set([0xEF, 0xBB, 0xBF]);
  result.set(encoded, 3);
  return result;
}

// 为单元测试和非浏览器调用提供去 BOM 的文本构造结果。
export function decodeCollectionsCsv(bytes: Uint8Array): string {
  const start = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0;
  return new TextDecoder().decode(bytes.slice(start));
}
