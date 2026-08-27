import type { SqlJsStatic, SqlValue } from 'sql.js';
import {
  normalizeRequiredText,
  normalizeThumbnailDataUrl,
  normalizeTitle,
  normalizeWebUrl,
} from '../domain/logic';
import { normalizePositions } from '../domain/logic';
import type { Collection, CollectionItem, LegacyNoteItem, PageItem } from '../domain/types';

type SqlJsDatabase = InstanceType<SqlJsStatic['Database']>;

// SQL 行按列名保存，所有值仍保持 SQL.js 的受限联合类型。
type SqlRow = Record<string, SqlValue>;

// 解析器返回的中文警告，后续 UI 可逐条展示给用户。
export interface LegacyParseResult {
  collections: Collection[];
  items: CollectionItem[];
  warnings: string[];
}

// 数据库无法打开或缺少必需表时使用此错误。
export class LegacyDatabaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LegacyDatabaseError';
  }
}

// 解析选项允许测试使用稳定的时间兜底值。
export interface LegacyParseOptions {
  fallbackNow?: number;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface LegacyItemRecord {
  sourceId: string;
  kind: 'website' | 'annotation';
  title: string;
  url?: string;
  faviconUrl?: string;
  thumbnailDataUrl?: string;
  content?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

interface RelationshipRecord {
  collectionSourceId: string;
  itemSourceId: string;
  position: number;
  identity: string;
  rowIndex: number;
}

interface ParseContext {
  warnings: string[];
  fallbackNow: number;
}

const REQUIRED_TABLES = [
  'collections',
  'items',
  'collections_items_relationship',
  'comments',
] as const;

const MIN_TIMESTAMP = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP = Date.UTC(2100, 0, 1);
const MAX_TEXT_LENGTH = 100_000;
// canonical_image_data 可能是包含缩略图 data URL 的 SQLite BLOB，先限制 JSON 大小。
const MAX_CANONICAL_IMAGE_JSON_LENGTH = 4_000_000;

// 统一列名比较，兼容下划线、驼峰和大小写差异。
const normalizeKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/gu, '');

// JSON.parse 返回 unknown，只有普通对象才能作为 source 使用。
const isJsonRecord = (value: unknown): value is JsonRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

// 对固定表名加引号，避免 SQL 关键字和大小写造成查询失败。
const quoteIdentifier = (value: string): string => `"${value.replace(/"/gu, '""')}"`;

// 将 SQL 查询行转换为可按列名访问的记录。
const readRows = (database: SqlJsDatabase, tableName: string): SqlRow[] => {
  const results = database.exec(`SELECT * FROM ${quoteIdentifier(tableName)}`);
  const result = results[0];
  if (result === undefined) {
    return [];
  }

  return result.values.map((values) => {
    const row: SqlRow = {};
    result.columns.forEach((column, index) => {
      const value = values[index];
      row[column] = value === undefined ? null : value;
    });
    return row;
  });
};

// 从行或 JSON 对象中按候选列名读取第一个值。
const readValue = (record: SqlRow | JsonRecord, aliases: readonly string[]): unknown => {
  const aliasKeys = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(record)) {
    if (aliasKeys.has(normalizeKey(key))) {
      return value;
    }
  }
  return undefined;
};

// 将 BLOB、数字和文本转换为安全字符串；二进制 ID 使用十六进制表示。
const valueToText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    const decoded = new TextDecoder().decode(value);
    return decoded.includes('\uFFFD') ? Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('') : decoded;
  }
  return undefined;
};

// 解析 source BLOB 中的 JSON 对象，坏数据只影响当前记录。
const parseSource = (value: unknown, context: ParseContext, tableName: string, rowIndex: number): JsonRecord | undefined => {
  const text = valueToText(value)?.trim();
  if (text === undefined || text.length === 0) {
    context.warnings.push(`${tableName} 第 ${rowIndex + 1} 行 source 为空，已跳过。`);
    return undefined;
  }

  try {
    let parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    if (!isJsonRecord(parsed)) {
      throw new Error('JSON 不是对象。');
    }
    return parsed;
  } catch {
    context.warnings.push(`${tableName} 第 ${rowIndex + 1} 行 source JSON 无效，已跳过。`);
    return undefined;
  }
};

// 提取非空文本并限制长度，避免坏数据库制造超大字符串。
const readText = (record: SqlRow | JsonRecord, aliases: readonly string[], context: ParseContext, label: string): string | undefined => {
  const text = valueToText(readValue(record, aliases))?.trim();
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    context.warnings.push(`${label}过长，已跳过当前记录。`);
    return undefined;
  }
  return text;
};

// 解析原始 ID，缺失时使用稳定的行号兜底。
const readLegacyId = (row: SqlRow, source: JsonRecord, aliases: readonly string[], rowIndex: number): string => (
  valueToText(readValue(row, aliases))?.trim()
    ?? valueToText(readValue(source, aliases))?.trim()
    ?? `row-${rowIndex + 1}`
);

// 识别删除标记，兼容布尔、数字和字符串存储形式。
const isMarkedForDeletion = (record: SqlRow | JsonRecord): boolean => {
  const value = readValue(record, ['is_marked_for_deletion', 'isMarkedForDeletion', 'marked_for_deletion']);
  if (typeof value === 'number') return value !== 0;
  const text = valueToText(value)?.trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
};

// 将秒、毫秒或微秒时间统一为毫秒，并对异常值使用合理兜底。
const normalizeTimestamp = (value: unknown, context: ParseContext, label: string): number => {
  if (value === undefined || value === null || valueToText(value)?.trim().length === 0) {
    return context.fallbackNow;
  }
  let numberValue: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    numberValue = value;
  } else {
    const text = valueToText(value)?.trim();
    if (text !== undefined && text.length > 0) {
      const parsedNumber = Number(text);
      numberValue = Number.isFinite(parsedNumber) ? parsedNumber : Date.parse(text);
    }
  }

  if (numberValue !== undefined && Number.isFinite(numberValue)) {
    let milliseconds = numberValue;
    if (Math.abs(milliseconds) < 100_000_000_000) milliseconds *= 1_000;
    else if (Math.abs(milliseconds) > 100_000_000_000_000) milliseconds /= 1_000;
    milliseconds = Math.trunc(milliseconds);
    if (milliseconds >= MIN_TIMESTAMP && milliseconds <= MAX_TIMESTAMP) {
      return milliseconds;
    }
  }

  context.warnings.push(`${label}时间无效，已使用兜底时间。`);
  return context.fallbackNow;
};

// 读取创建/更新时间字段，兼容 Edge 不同版本的列名和 source 键名。
const readTimestamp = (
  row: SqlRow,
  source: JsonRecord,
  aliases: readonly string[],
  context: ParseContext,
  label: string,
): number => normalizeTimestamp(readValue(row, aliases) ?? readValue(source, aliases), context, label);

// 解析网页 URL，只接受 HTTP/HTTPS；失败时让当前记录跳过。
const readSafeUrl = (
  row: SqlRow,
  source: JsonRecord,
  aliases: readonly string[],
  context: ParseContext,
  label: string,
): string | undefined => {
  const raw = valueToText(readValue(source, aliases) ?? readValue(row, aliases));
  if (raw === undefined) {
    context.warnings.push(`${label}缺少 URL，已跳过当前记录。`);
    return undefined;
  }
  try {
    return normalizeWebUrl(raw);
  } catch {
    // Edge 某些旧版本把可访问网页包装为 read:https://...，只解包其中的安全网页协议。
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    const unwrapped = lower.startsWith('read://https_')
      ? `https://${trimmed.slice(13)}`
      : lower.startsWith('read://http_')
        ? `http://${trimmed.slice(12)}`
        : lower.startsWith('read://')
          ? trimmed.slice(7)
      : lower.startsWith('read:')
        ? trimmed.slice(5)
        : undefined;
    if (unwrapped !== undefined) {
      try {
        return normalizeWebUrl(unwrapped);
      } catch {
        // 继续走统一的安全警告。
      }
    }
    context.warnings.push(`${label} URL 不安全或格式无效，已跳过当前记录。`);
    return undefined;
  }
};

// favicon 只保留安全网页协议；异常 favicon 不影响网页卡片主体。
const readOptionalFavicon = (row: SqlRow, source: JsonRecord, context: ParseContext, label: string): string | undefined => {
  const raw = valueToText(readValue(source, ['favicon_url', 'faviconUrl']) ?? readValue(row, ['favicon_url', 'faviconUrl']));
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    return normalizeWebUrl(raw);
  } catch {
    context.warnings.push(`${label} favicon_url 非 HTTP/HTTPS，已忽略。`);
    return undefined;
  }
};

// 深度有限地查找 canonical_image_data 中的候选 data URL。
const findImageDataUrl = (value: unknown, depth = 0): string | undefined => {
  if (depth > 4) return undefined;
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > MAX_CANONICAL_IMAGE_JSON_LENGTH) return undefined;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(value).trim();
      if (text.length === 0 || text.length > MAX_CANONICAL_IMAGE_JSON_LENGTH) return undefined;
      return findImageDataUrl(JSON.parse(text) as unknown, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'string') {
    if (value.length > MAX_CANONICAL_IMAGE_JSON_LENGTH) return undefined;
    const trimmed = value.trim();
    if (trimmed.startsWith('data:image/')) return trimmed;
    try {
      return findImageDataUrl(JSON.parse(trimmed), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (!isJsonRecord(value)) return undefined;
  const record = value;
  for (const key of ['data', 'dataUrl', 'url', 'canonical_image_data', 'image_data', 'image']) {
    const nested = readValue(record, [key]);
    const result = findImageDataUrl(nested, depth + 1);
    if (result !== undefined) return result;
  }
  return undefined;
};

// 恢复安全缩略图，拒绝 SVG、非 Base64 和超大内容。
const readOptionalThumbnail = (row: SqlRow, source: JsonRecord, context: ParseContext, label: string): string | undefined => {
  const raw = readValue(source, ['canonical_image_data']) ?? readValue(row, ['canonical_image_data']);
  if (raw === undefined || raw === null) return undefined;
  const candidate = findImageDataUrl(raw);
  if (candidate === undefined) {
    context.warnings.push(`${label} canonical_image_data 不是安全图片 data URL，已忽略。`);
    return undefined;
  }
  try {
    return normalizeThumbnailDataUrl(candidate);
  } catch {
    context.warnings.push(`${label} 缩略图 MIME、Base64 或大小无效，已忽略。`);
    return undefined;
  }
};

// FNV-1a 64 位哈希为导入记录生成不含原文的确定性 ID。
const stableHash = (value: string): string => {
  let hash = 14695981039346656037n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
};

// 集合 ID 只依赖原始集合 ID，跨重复解析保持一致。
const makeCollectionId = (sourceId: string): string => `legacy-collection-${stableHash(sourceId)}`;

// 卡片 ID 依赖 collection relationship，允许同一网页属于多个集合。
const makeItemId = (relationship: RelationshipRecord): string => (
  `legacy-item-${stableHash([
    relationship.collectionSourceId,
    relationship.itemSourceId,
    relationship.identity,
  ].join('\u001f'))}`
);

// 提取 comments 内容，支持简单列和 JSON source 两种形态。
const readCommentText = (row: SqlRow, context: ParseContext, rowIndex: number): string | undefined => {
  const direct = readText(row, ['comment', 'content', 'text', 'body', 'note', 'value'], context, `comments 第 ${rowIndex + 1} 行`);
  if (direct !== undefined) return direct;
  const properties = readValue(row, ['properties']);
  const propertyText = valueToText(properties)?.trim();
  if (propertyText !== undefined && propertyText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(propertyText);
      if (isJsonRecord(parsed)) {
        const fromProperties = readText(parsed, ['comment', 'content', 'text', 'body', 'note', 'value'], context, `comments 第 ${rowIndex + 1} 行`);
        if (fromProperties !== undefined) return fromProperties;
      }
    } catch {
      // properties 不是 JSON 时继续尝试兼容旧版 source。
    }
  }
  const sourceValue = readValue(row, ['source']);
  if (sourceValue === undefined || sourceValue === null) return undefined;
  const source = parseSource(sourceValue, context, 'comments', rowIndex);
  return source === undefined ? undefined : readText(source, ['comment', 'content', 'text', 'body', 'note', 'value'], context, `comments 第 ${rowIndex + 1} 行`);
};

// 旧版 annotation 的 html_content 仅作为纯文本兜底，避免把 HTML 当作可执行内容恢复。
const htmlToPlainText = (value: string): string => value
  .replace(/<[^>]*>/gu, ' ')
  .replace(/&nbsp;/giu, ' ')
  .replace(/&amp;/giu, '&')
  .replace(/&lt;/giu, '<')
  .replace(/&gt;/giu, '>')
  .replace(/\s+/gu, ' ')
  .trim();

// 将旧版 SQLite 数据解析成当前领域模型；数据库连接始终在 finally 中关闭。
export function parseLegacyCollectionsDatabase(
  bytes: Uint8Array,
  sqlJs: SqlJsStatic,
  options: LegacyParseOptions = {},
): LegacyParseResult {
  const fallbackCandidate = options.fallbackNow ?? Date.now();
  const fallbackNow = Number.isFinite(fallbackCandidate)
    ? Math.min(MAX_TIMESTAMP, Math.max(MIN_TIMESTAMP, Math.trunc(fallbackCandidate)))
    : Date.now();
  const context: ParseContext = { warnings: [], fallbackNow };
  let database: SqlJsDatabase | undefined;

  try {
    try {
      database = new sqlJs.Database(bytes);
    } catch {
      throw new LegacyDatabaseError('无法打开 Collections SQLite 数据库。');
    }

    let tableNames: Set<string>;
    try {
      const tableResult = database.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0];
      tableNames = new Set((tableResult?.values ?? []).map((row) => valueToText(row[0])?.toLowerCase()).filter((name): name is string => name !== undefined));
    } catch {
      throw new LegacyDatabaseError('无法读取 Collections SQLite 表结构。');
    }
    const missingTables = REQUIRED_TABLES.filter((tableName) => !tableNames.has(tableName));
    if (missingTables.length > 0) {
      throw new LegacyDatabaseError(`Collections SQLite 缺少必需表：${missingTables.join('、')}。`);
    }

    let collectionRows: SqlRow[];
    let itemRows: SqlRow[];
    let relationshipRows: SqlRow[];
    let commentRows: SqlRow[];
    try {
      collectionRows = readRows(database, 'collections');
      itemRows = readRows(database, 'items');
      relationshipRows = readRows(database, 'collections_items_relationship');
      commentRows = readRows(database, 'comments');
    } catch {
      throw new LegacyDatabaseError('无法读取 Collections SQLite 数据。');
    }

    const collectionMap = new Map<string, Collection>();
    const parsedCollections: Array<Collection & { sourceOrder: number }> = [];
    collectionRows.forEach((row, rowIndex) => {
      if (isMarkedForDeletion(row)) {
        context.warnings.push(`collections 第 ${rowIndex + 1} 行已标记删除，已跳过。`);
        return;
      }
      const sourceValue = readValue(row, ['source']);
      const source = sourceValue === undefined || sourceValue === null
        ? {}
        : parseSource(sourceValue, context, 'collections', rowIndex);
      if (source === undefined) return;
      const sourceId = readLegacyId(row, source, ['id', 'collection_id', 'collectionId', 'guid'], rowIndex);
      if (collectionMap.has(sourceId)) {
        context.warnings.push(`collections 第 ${rowIndex + 1} 行 source ID 重复，已跳过。`);
        return;
      }
      const rawName = readText(row, ['name', 'title'], context, `collections 第 ${rowIndex + 1} 行`)
        ?? readText(source, ['name', 'title'], context, `collections 第 ${rowIndex + 1} 行`);
      if (rawName === undefined) {
        context.warnings.push(`collections 第 ${rowIndex + 1} 行缺少名称，已跳过。`);
        return;
      }
      const timestamp = readTimestamp(row, source, ['created_at', 'createdAt', 'creation_time', 'creationTime', 'date_created', 'created'], context, `collections 第 ${rowIndex + 1} 行创建`);
      const updatedAt = readTimestamp(row, source, ['updated_at', 'updatedAt', 'last_modified_time', 'lastModifiedTime', 'modified_at', 'date_modified', 'dateModified', 'modified'], context, `collections 第 ${rowIndex + 1} 行修改`);
      const rawPosition = readValue(row, ['position', 'sort_index', 'index', 'order']);
      const parsedPosition = typeof rawPosition === 'number' && Number.isFinite(rawPosition) ? Math.trunc(rawPosition) : rowIndex;
      const collection: Collection & { sourceOrder: number } = {
        id: makeCollectionId(sourceId),
        name: normalizeRequiredText(rawName, '集合名称'),
        position: parsedPosition,
        createdAt: timestamp,
        updatedAt,
        legacySourceId: sourceId,
        sourceOrder: rowIndex,
      };
      collectionMap.set(sourceId, collection);
      parsedCollections.push(collection);
    });

    const commentMap = new Map<string, string[]>();
    commentRows.forEach((row, rowIndex) => {
      if (isMarkedForDeletion(row)) {
        context.warnings.push(`comments 第 ${rowIndex + 1} 行已标记删除，已跳过。`);
        return;
      }
      const itemSourceId = valueToText(readValue(row, ['item_id', 'itemId', 'item', 'source_item_id', 'parent_id', 'parentId']))?.trim();
      const text = readCommentText(row, context, rowIndex);
      if (itemSourceId === undefined || text === undefined) {
        context.warnings.push(`comments 第 ${rowIndex + 1} 行缺少条目或正文，已跳过。`);
        return;
      }
      const comments = commentMap.get(itemSourceId) ?? [];
      comments.push(text);
      commentMap.set(itemSourceId, comments);
    });

    const itemMap = new Map<string, LegacyItemRecord>();
    itemRows.forEach((row, rowIndex) => {
      if (isMarkedForDeletion(row)) {
        context.warnings.push(`items 第 ${rowIndex + 1} 行已标记删除，已跳过。`);
        return;
      }
      const sourceValue = readValue(row, ['source']);
      const source = sourceValue === undefined || sourceValue === null
        ? {}
        : parseSource(sourceValue, context, 'items', rowIndex);
      if (source === undefined) return;
      const sourceId = readLegacyId(row, source, ['id', 'item_id', 'itemId', 'guid'], rowIndex);
      if (itemMap.has(sourceId)) {
        context.warnings.push(`items 第 ${rowIndex + 1} 行 source ID 重复，已跳过。`);
        return;
      }
      const rawType = valueToText(readValue(row, ['type', 'item_type', 'itemType']) ?? readValue(source, ['type', 'item_type', 'itemType']))?.trim().toLowerCase();
      const kind = rawType === 'website' ? 'website' : rawType === 'annotation' ? 'annotation' : undefined;
      if (kind === undefined) {
        context.warnings.push(`items 第 ${rowIndex + 1} 行类型未知，已跳过。`);
        return;
      }
      const timestamp = readTimestamp(row, source, ['created_at', 'createdAt', 'creation_time', 'creationTime', 'date_created', 'created'], context, `items 第 ${rowIndex + 1} 行创建`);
      const updatedAt = readTimestamp(row, source, ['updated_at', 'updatedAt', 'last_modified_time', 'lastModifiedTime', 'modified_at', 'date_modified', 'dateModified', 'modified'], context, `items 第 ${rowIndex + 1} 行修改`);
      const titleValue = readText(row, ['title', 'websiteName', 'name'], context, `items 第 ${rowIndex + 1} 行标题`)
        ?? readText(source, ['title', 'websiteName', 'name'], context, `items 第 ${rowIndex + 1} 行标题`);

      if (kind === 'website') {
        const url = readSafeUrl(row, source, ['url', 'href', 'web_url'], context, `items 第 ${rowIndex + 1} 行网页`);
        if (url === undefined) return;
        const page: LegacyItemRecord = {
          sourceId,
          kind,
          title: normalizeTitle(titleValue, url),
          url,
          faviconUrl: readOptionalFavicon(row, source, context, `items 第 ${rowIndex + 1} 行网页`),
          thumbnailDataUrl: readOptionalThumbnail(row, source, context, `items 第 ${rowIndex + 1} 行网页`),
          createdAt: timestamp,
          updatedAt,
        };
        const comments = commentMap.get(sourceId);
        if (comments !== undefined && comments.length > 0) page.note = comments.join('\n\n');
        itemMap.set(sourceId, page);
        return;
      }

      const textContent = readText(row, ['text_content', 'textContent'], context, `items 第 ${rowIndex + 1} 行便笺`);
      const htmlContent = readText(row, ['html_content', 'htmlContent'], context, `items 第 ${rowIndex + 1} 行便笺`);
      const plainHtmlContent = htmlContent === undefined ? undefined : htmlToPlainText(htmlContent);
      const content = textContent
        ?? (plainHtmlContent === undefined || plainHtmlContent.length === 0 ? undefined : plainHtmlContent)
        ?? readText(source, ['content', 'text', 'body', 'note', 'annotation'], context, `items 第 ${rowIndex + 1} 行便笺`)
        ?? '';
      itemMap.set(sourceId, {
        sourceId,
        kind,
        title: normalizeTitle(titleValue, '便笺'),
        content,
        createdAt: timestamp,
        updatedAt,
      });
    });

    const relationships: RelationshipRecord[] = [];
    const relationshipKeys = new Set<string>();
    relationshipRows.forEach((row, rowIndex) => {
      if (isMarkedForDeletion(row)) {
        context.warnings.push(`collections_items_relationship 第 ${rowIndex + 1} 行已标记删除，已跳过。`);
        return;
      }
      const collectionSourceId = valueToText(readValue(row, ['parent_id', 'parentId', 'collection_id', 'collectionId', 'collection']))?.trim();
      const itemSourceId = valueToText(readValue(row, ['item_id', 'itemId', 'item']))?.trim();
      if (collectionSourceId === undefined || itemSourceId === undefined) {
        context.warnings.push(`collections_items_relationship 第 ${rowIndex + 1} 行关联不完整，已跳过。`);
        return;
      }
      const missingCollection = !collectionMap.has(collectionSourceId);
      const missingItem = !itemMap.has(itemSourceId);
      if (missingCollection || missingItem) {
        context.warnings.push(`collections_items_relationship 第 ${rowIndex + 1} 行引用未知记录（集合${missingCollection ? '缺失' : '存在'}、条目${missingItem ? '缺失' : '存在'}），已跳过。`);
        return;
      }
      const rawPosition = readValue(row, ['position', 'item_position', 'sort_index', 'index', 'order']);
      const positionNumber = typeof rawPosition === 'number' ? rawPosition : Number(valueToText(rawPosition));
      const position = Number.isFinite(positionNumber) ? Math.trunc(positionNumber) : rowIndex;
      const relationshipId = valueToText(readValue(row, ['id', 'relationship_id', 'collection_item_id']))?.trim();
      const identity = relationshipId ?? `${itemSourceId}:${position}`;
      const key = `${collectionSourceId}\u001f${itemSourceId}\u001f${identity}`;
      if (relationshipKeys.has(key)) {
        context.warnings.push(`collections_items_relationship 第 ${rowIndex + 1} 行关联重复，已跳过。`);
        return;
      }
      relationshipKeys.add(key);
      relationships.push({ collectionSourceId, itemSourceId, position, identity, rowIndex });
    });

    const groupedRelationships = new Map<string, RelationshipRecord[]>();
    for (const relationship of relationships) {
      const group = groupedRelationships.get(relationship.collectionSourceId) ?? [];
      group.push(relationship);
      groupedRelationships.set(relationship.collectionSourceId, group);
    }

    const parsedItems: CollectionItem[] = [];
    for (const collection of parsedCollections) {
      const collectionSourceId = collection.legacySourceId;
      if (collectionSourceId === undefined) continue;
      const group = groupedRelationships.get(collectionSourceId) ?? [];
      group.sort((left, right) => left.position - right.position || left.rowIndex - right.rowIndex);
      group.forEach((relationship, position) => {
        const legacy = itemMap.get(relationship.itemSourceId);
        if (legacy === undefined) return;
        const id = makeItemId(relationship);
        if (legacy.kind === 'website' && legacy.url !== undefined) {
          const item: PageItem = {
            id,
            type: 'page',
            collectionId: collection.id,
            title: legacy.title,
            url: legacy.url,
            normalizedUrl: legacy.url,
            position,
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt,
            legacySourceId: legacy.sourceId,
          };
          if (legacy.faviconUrl !== undefined) item.faviconUrl = legacy.faviconUrl;
          if (legacy.thumbnailDataUrl !== undefined) item.thumbnailDataUrl = legacy.thumbnailDataUrl;
          if (legacy.note !== undefined) item.note = legacy.note;
          parsedItems.push(item);
        } else {
          const item: LegacyNoteItem = {
            id,
            type: 'legacy-note',
            collectionId: collection.id,
            title: legacy.title,
            content: legacy.content ?? '',
            position,
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt,
            legacySourceId: legacy.sourceId,
          };
          parsedItems.push(item);
        }
      });
    }

    const collections = normalizePositions(parsedCollections.map(({ sourceOrder: _sourceOrder, ...collection }) => collection));
    return { collections, items: parsedItems, warnings: context.warnings };
  } finally {
    database?.close();
  }
}
