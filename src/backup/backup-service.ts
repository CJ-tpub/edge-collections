import {
  MAX_THUMBNAIL_DATA_URL_LENGTH,
  normalizeThumbnailDataUrl,
  normalizeWebUrl,
} from '../domain/logic';
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
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../settings/settings-store';

// 备份验证的统一上限，避免恶意 JSON 占满扩展内存。
export const MAX_BACKUP_TEXT_LENGTH = 100_000;
export const MAX_BACKUP_ID_LENGTH = 256;
export const MAX_BACKUP_URL_LENGTH = 8_192;
export const MAX_BACKUP_RECORDS = 100_000;
export const MIN_BACKUP_TIMESTAMP = 0;
export const MAX_BACKUP_TIMESTAMP = Date.UTC(2100, 0, 1);

// 未知 JSON 不符合 BackupV1 契约时使用此错误。
export class BackupValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

// 运行时导入摘要，重复 ID 会在 warnings 中明确列出。
export interface ImportReport {
  insertedCollections: number;
  insertedItems: number;
  skippedCollections: number;
  skippedItems: number;
  warnings: string[];
}

// JSON 对象必须经过此守卫后才能访问字段。
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

// 校验并保留非空 ID，拒绝控制字符和超长值。
const readId = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BACKUP_ID_LENGTH || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new BackupValidationError(`${label} ID 无效。`);
  }
  return value;
};

// 校验文本长度；标题额外要求去除空白后仍有内容。
const readText = (value: unknown, label: string, required: boolean): string => {
  if (typeof value !== 'string' || value.length > MAX_BACKUP_TEXT_LENGTH) {
    throw new BackupValidationError(`${label}长度或类型无效。`);
  }
  if (required && value.trim().length === 0) {
    throw new BackupValidationError(`${label}不能为空。`);
  }
  return value;
};

// 校验非负整数位置。
const readPosition = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_BACKUP_RECORDS) {
    throw new BackupValidationError(`${label}位置无效。`);
  }
  return value;
};

// 校验合理时间戳。
const readTimestamp = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_BACKUP_TIMESTAMP || value > MAX_BACKUP_TIMESTAMP) {
    throw new BackupValidationError(`${label}时间无效。`);
  }
  return value;
};

// 读取可选字符串并检查长度，不把未知值强制转换成字符串。
const readOptionalText = (record: Record<string, unknown>, key: string, label: string, maxLength = MAX_BACKUP_TEXT_LENGTH): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new BackupValidationError(`${label}类型或长度无效。`);
  }
  return value;
};

// 校验主题设置。
const readTheme = (value: unknown): ThemeMode => {
  if (value !== 'system' && value !== 'light' && value !== 'dark') {
    throw new BackupValidationError('备份主题设置无效。');
  }
  return value;
};

// 校验排序设置。
const readSort = (value: unknown): SortMode => {
  if (value !== 'manual' && value !== 'name' && value !== 'createdAt') {
    throw new BackupValidationError('备份排序设置无效。');
  }
  return value;
};

// 运行时验证并重建 Collection，避免保留输入中的未知字段。
const validateCollection = (value: unknown, index: number): Collection => {
  if (!isRecord(value)) throw new BackupValidationError(`第 ${index + 1} 个集合不是对象。`);
  const collection: Collection = {
    id: readId(value.id, `第 ${index + 1} 个集合`),
    name: readText(value.name, `第 ${index + 1} 个集合名称`, true),
    position: readPosition(value.position, `第 ${index + 1} 个集合`),
    createdAt: readTimestamp(value.createdAt, `第 ${index + 1} 个集合创建`),
    updatedAt: readTimestamp(value.updatedAt, `第 ${index + 1} 个集合修改`),
  };
  const legacySourceId = readOptionalText(value, 'legacySourceId', `第 ${index + 1} 个集合来源 ID`, MAX_BACKUP_ID_LENGTH);
  if (legacySourceId !== undefined) collection.legacySourceId = readId(legacySourceId, `第 ${index + 1} 个集合来源`);
  return collection;
};

// 运行时验证并重建 PageItem，严格保持 normalizedUrl 与 URL 一致。
const validatePageItem = (value: Record<string, unknown>, index: number): PageItem => {
  const item: PageItem = {
    id: readId(value.id, `第 ${index + 1} 个网页卡片`),
    type: 'page',
    collectionId: readId(value.collectionId, `第 ${index + 1} 个网页卡片集合`),
    title: readText(value.title, `第 ${index + 1} 个网页卡片标题`, true),
    url: '',
    normalizedUrl: '',
    position: readPosition(value.position, `第 ${index + 1} 个网页卡片`),
    createdAt: readTimestamp(value.createdAt, `第 ${index + 1} 个网页卡片创建`),
    updatedAt: readTimestamp(value.updatedAt, `第 ${index + 1} 个网页卡片修改`),
  };
  if (typeof value.url !== 'string' || value.url.length > MAX_BACKUP_URL_LENGTH) {
    throw new BackupValidationError(`第 ${index + 1} 个网页卡片 URL 无效。`);
  }
  if (typeof value.normalizedUrl !== 'string' || value.normalizedUrl.length > MAX_BACKUP_URL_LENGTH) {
    throw new BackupValidationError(`第 ${index + 1} 个网页卡片规范化 URL 无效。`);
  }
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeWebUrl(value.url);
  } catch (error: unknown) {
    throw new BackupValidationError(`第 ${index + 1} 个网页卡片 URL 不安全。`);
  }
  if (normalizedUrl !== value.normalizedUrl) {
    throw new BackupValidationError(`第 ${index + 1} 个网页卡片规范化 URL 不匹配。`);
  }
  item.url = normalizedUrl;
  item.normalizedUrl = normalizedUrl;

  const legacySourceId = readOptionalText(value, 'legacySourceId', `第 ${index + 1} 个网页卡片来源 ID`, MAX_BACKUP_ID_LENGTH);
  if (legacySourceId !== undefined) item.legacySourceId = readId(legacySourceId, `第 ${index + 1} 个网页卡片来源`);
  const faviconUrl = readOptionalText(value, 'faviconUrl', `第 ${index + 1} 个网页卡片 favicon`, MAX_BACKUP_URL_LENGTH);
  if (faviconUrl !== undefined) {
    try {
      item.faviconUrl = normalizeWebUrl(faviconUrl);
    } catch (error: unknown) {
      throw new BackupValidationError(`第 ${index + 1} 个网页卡片 favicon_url 不安全。`);
    }
  }
  const thumbnailDataUrl = readOptionalText(
    value,
    'thumbnailDataUrl',
    `第 ${index + 1} 个网页卡片缩略图`,
    MAX_THUMBNAIL_DATA_URL_LENGTH,
  );
  if (thumbnailDataUrl !== undefined) {
    try {
      item.thumbnailDataUrl = normalizeThumbnailDataUrl(thumbnailDataUrl);
    } catch (error: unknown) {
      throw new BackupValidationError(`第 ${index + 1} 个网页卡片缩略图无效。`);
    }
  }
  const note = readOptionalText(value, 'note', `第 ${index + 1} 个网页卡片备注`);
  if (note !== undefined) item.note = note;
  return item;
};

// 运行时验证并重建 LegacyNoteItem。
const validateLegacyNoteItem = (value: Record<string, unknown>, index: number): LegacyNoteItem => {
  const item: LegacyNoteItem = {
    id: readId(value.id, `第 ${index + 1} 个旧便笺`),
    type: 'legacy-note',
    collectionId: readId(value.collectionId, `第 ${index + 1} 个旧便笺集合`),
    title: readText(value.title, `第 ${index + 1} 个旧便笺标题`, true),
    content: readText(value.content, `第 ${index + 1} 个旧便笺正文`, false),
    position: readPosition(value.position, `第 ${index + 1} 个旧便笺`),
    createdAt: readTimestamp(value.createdAt, `第 ${index + 1} 个旧便笺创建`),
    updatedAt: readTimestamp(value.updatedAt, `第 ${index + 1} 个旧便笺修改`),
  };
  const legacySourceId = readOptionalText(value, 'legacySourceId', `第 ${index + 1} 个旧便笺来源 ID`, MAX_BACKUP_ID_LENGTH);
  if (legacySourceId !== undefined) item.legacySourceId = readId(legacySourceId, `第 ${index + 1} 个旧便笺来源`);
  return item;
};

// 校验设置对象并重建为当前版本类型。
const validateSettings = (value: unknown, collectionIds: ReadonlySet<string>): CollectionSettings => {
  if (!isRecord(value)) throw new BackupValidationError('备份设置不是对象。');
  const recentValue = value.recentCollectionId;
  if (recentValue !== null && recentValue !== undefined && typeof recentValue !== 'string') {
    throw new BackupValidationError('最近集合 ID 无效。');
  }
  const recentCollectionId = recentValue === undefined || recentValue === null ? null : readId(recentValue, '最近集合');
  if (recentCollectionId !== null && !collectionIds.has(recentCollectionId)) {
    throw new BackupValidationError('最近集合不存在。');
  }
  return {
    theme: readTheme(value.theme),
    sort: readSort(value.sort),
    sortDescending: typeof value.sortDescending === 'boolean' ? value.sortDescending : false,
    fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize)
      ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value.fontSize)))
      : DEFAULT_FONT_SIZE,
    recentCollectionId,
  };
};

// 从 unknown 验证 BackupV1，并拒绝重复 ID、孤立条目和不安全字段。
export function validateBackupV1(value: unknown): BackupV1 {
  if (!isRecord(value)) throw new BackupValidationError('备份根对象无效。');
  if (value.format !== 'edge-collections-backup' || value.version !== 1) {
    throw new BackupValidationError('只支持 edge-collections-backup v1。');
  }
  const exportedAt = readTimestamp(value.exportedAt, '备份导出');
  if (!Array.isArray(value.collections) || value.collections.length > MAX_BACKUP_RECORDS) {
    throw new BackupValidationError('备份集合列表无效或过大。');
  }
  if (!Array.isArray(value.items) || value.items.length > MAX_BACKUP_RECORDS) {
    throw new BackupValidationError('备份卡片列表无效或过大。');
  }

  const collections = value.collections.map(validateCollection);
  const collectionIds = new Set<string>();
  const allIds = new Set<string>();
  for (const collection of collections) {
    if (collectionIds.has(collection.id) || allIds.has(collection.id)) throw new BackupValidationError(`集合 ID 重复：${collection.id}`);
    collectionIds.add(collection.id);
    allIds.add(collection.id);
  }

  const items: CollectionItem[] = value.items.map((rawItem, index) => {
    if (!isRecord(rawItem)) throw new BackupValidationError(`第 ${index + 1} 个卡片不是对象。`);
    if (rawItem.type === 'page') return validatePageItem(rawItem, index);
    if (rawItem.type === 'legacy-note') return validateLegacyNoteItem(rawItem, index);
    throw new BackupValidationError(`第 ${index + 1} 个卡片类型未知。`);
  });
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id) || allIds.has(item.id)) throw new BackupValidationError(`卡片 ID 重复：${item.id}`);
    if (!collectionIds.has(item.collectionId)) throw new BackupValidationError(`卡片 ${item.id} 关联了不存在的集合。`);
    itemIds.add(item.id);
    allIds.add(item.id);
  }

  const backup: BackupV1 = {
    format: 'edge-collections-backup',
    version: 1,
    exportedAt,
    collections,
    items,
  };
  if (value.settings !== undefined) backup.settings = validateSettings(value.settings, collectionIds);
  return backup;
}

// 解析并验证未知 JSON 文本，统一把 JSON 语法错误转换为中文验证错误。
export function parseBackupJson(json: string): BackupV1 {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new BackupValidationError('备份 JSON 语法无效。');
  }
  return validateBackupV1(value);
}

// 创建当前版本备份，出口处再次运行严格验证以防调用方传入脏数据。
export function createBackupV1(
  collections: readonly Collection[],
  items: readonly CollectionItem[],
  settings?: CollectionSettings,
  exportedAt = Date.now(),
): BackupV1 {
  const value: Record<string, unknown> = {
    format: 'edge-collections-backup',
    version: 1,
    exportedAt,
    collections: [...collections],
    items: [...items],
  };
  if (settings !== undefined) value.settings = settings;
  return validateBackupV1(value);
}

// 使用稳定缩进生成可保存的 UTF-8 JSON 文本。
export function stringifyBackupV1(backup: BackupV1): string {
  return JSON.stringify(validateBackupV1(backup), null, 2);
}
