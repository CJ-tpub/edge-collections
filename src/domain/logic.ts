import type { CollectionItem } from './types';

// 缩略图采用有限大小的常见栅格图片 data URL，避免注入可执行 SVG 或超大数据。
export const MAX_THUMBNAIL_DATA_URL_LENGTH = 2_000_000;

// 允许导入和持久化的缩略图 MIME 类型。
const SAFE_THUMBNAIL_PATTERN = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+={0,2}$/u;

// 输入数据不符合集合业务约束时抛出此错误。
export class ValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// 访问不存在的集合或卡片时抛出此错误。
export class NotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// 同一集合中出现规范化 URL 重复时抛出此错误。
export class DuplicateUrlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DuplicateUrlError';
  }
}

// 仅接受网页协议，避免把 javascript/data 等危险值持久化后直接渲染或打开。
export function normalizeWebUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (value.length === 0) {
    throw new ValidationError('网页 URL 不能为空。');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError('网页 URL 格式无效。');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('只允许保存 HTTP 或 HTTPS 网页。');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ValidationError('网页 URL 不允许包含账号或密码。');
  }

  // 去掉片段和非根路径末尾斜杠，使常见的同页 URL 可以去重。
  parsed.hash = '';
  const normalizedPath = parsed.pathname === '/'
    ? ''
    : parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.origin}${normalizedPath}${parsed.search}`;
}

// 统一集合名称和卡片标题的空白，禁止创建空集合。
export function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ValidationError(`${fieldName}不能为空。`);
  }
  return normalized;
}

// 空标题使用 URL 或默认便笺名称，保证卡片在列表中始终可识别。
export function normalizeTitle(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : fallback;
}

// 校验缩略图 data URL 的 MIME、Base64 形态和大小。
export function normalizeThumbnailDataUrl(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length === 0 || value.length > MAX_THUMBNAIL_DATA_URL_LENGTH || !SAFE_THUMBNAIL_PATTERN.test(value)) {
    throw new ValidationError('缩略图必须是大小合适的 PNG、JPEG、GIF、WebP、BMP 或 AVIF data URL。');
  }
  const payload = value.slice(value.indexOf(',') + 1);
  if (payload.length % 4 === 1) {
    throw new ValidationError('缩略图 Base64 数据无效。');
  }
  return value;
}

// 统一对象仓库中的位置，结果从 0 开始且不会改变同位置记录的原始相对顺序。
export function normalizePositions<T extends { position: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.position - right.item.position || left.index - right.index)
    .map(({ item }, position) => ({ ...item, position }));
}

// 将指定记录移动到目标位置，并返回位置已归一化的新数组。
export function reorderPositions<T extends { id: string; position: number }>(
  items: readonly T[],
  itemId: string,
  targetPosition: number,
): T[] {
  if (!Number.isFinite(targetPosition)) {
    throw new ValidationError('目标位置必须是有限数字。');
  }
  const ordered = normalizePositions(items);
  const currentIndex = ordered.findIndex((item) => item.id === itemId);
  if (currentIndex < 0) {
    throw new NotFoundError(`找不到需要重排的记录：${itemId}`);
  }

  const [moved] = ordered.splice(currentIndex, 1);
  if (moved === undefined) {
    throw new NotFoundError(`找不到需要重排的记录：${itemId}`);
  }

  const safeTarget = Math.max(0, Math.min(ordered.length, Math.trunc(targetPosition)));
  ordered.splice(safeTarget, 0, moved);
  return ordered.map((item, position) => ({ ...item, position }));
}

// 生成搜索文本时只读取已知字段，避免把内部 ID 误作为用户可搜索内容。
export function getSearchText(item: CollectionItem): string {
  if (item.type === 'page') {
    return [item.title, item.url, item.note]
      .filter((value): value is string => value !== undefined).join('\n');
  }

  return [item.title, item.content].join('\n');
}
