import {
  DuplicateUrlError,
  NotFoundError,
  ValidationError,
  getSearchText,
  normalizePositions,
  normalizeRequiredText,
  normalizeTitle,
  normalizeWebUrl,
  reorderPositions,
} from '../domain/logic';
import { validateBackupV1, type ImportReport } from '../backup/backup-service';
import type {
  BackupV1,
  Collection,
  CollectionItem,
  CreateCollectionInput,
  CreateLegacyNoteInput,
  CreatePageItemInput,
  LegacyNoteItem,
  LegacyNotePatch,
  PageItem,
  PageItemPatch,
} from '../domain/types';

// IndexedDB 数据库和对象仓库名称集中定义，避免后续版本升级时出现拼写漂移。
export const COLLECTION_DATABASE_NAME = 'edge-collections';
export const COLLECTION_DATABASE_VERSION = 1;
export const COLLECTION_STORE_NAME = 'collections';
export const ITEM_STORE_NAME = 'items';

type StoreName = typeof COLLECTION_STORE_NAME | typeof ITEM_STORE_NAME;

// 便于测试注入独立数据库、时钟和 ID 生成器。
export interface CollectionRepositoryOptions {
  databaseName?: string;
  now?: () => number;
  idFactory?: () => string;
}

// 集合更新的最小输入。
export interface CollectionPatch {
  name?: string;
}

// 搜索结果区分集合标题命中和卡片命中，供侧边栏展示不同的操作菜单。
export type CollectionSearchResult =
  | { kind: 'collection'; collection: Collection }
  | { kind: 'item'; collection: Collection; item: CollectionItem };

// 读取 IndexedDB 请求结果，并将错误统一转换为 Promise 拒绝。
const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败。'));
});

// 将可选网页 URL 进行同样的安全校验；null 由修改方法单独处理为清空。
const normalizeOptionalWebUrl = (value: string | undefined): string | undefined => (
  value === undefined ? undefined : normalizeWebUrl(value)
);

// 确保重排目标是有限整数，避免 NaN 让数组 splice 产生隐式位置。
const normalizeTargetPosition = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new ValidationError('目标位置必须是有限数字。');
  }
  return Math.trunc(value);
};

// 这些错误通常表示 IndexedDB 连接已失效，重开连接后可以安全重试一次。
const isRetryableIndexedDbError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError'
    || error.name === 'InvalidStateError'
    || error.name === 'TransactionInactiveError'
    || error.name === 'UnknownError';
};

// 原生 IndexedDB 集锦仓库，集合和卡片分别存放并通过 collectionId 关联。
export class IndexedDbCollectionRepository {
  private readonly databaseName: string;

  private readonly now: () => number;

  private readonly idFactory: () => string;

  private databasePromise: Promise<IDBDatabase> | undefined;

  public constructor(options: CollectionRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? COLLECTION_DATABASE_NAME;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => {
      const cryptoApi = globalThis.crypto;
      if (cryptoApi?.randomUUID !== undefined) {
        return cryptoApi.randomUUID();
      }
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    });
  }

  // 打开数据库并在首次创建时建立必要的对象仓库和索引。
  private async open(): Promise<IDBDatabase> {
    if (this.databasePromise !== undefined) {
      const cachedPromise = this.databasePromise;
      // 旧连接的失败不能永久缓存，否则后续刷新只会继续显示空状态。
      return cachedPromise.catch((error: unknown) => {
        if (this.databasePromise === cachedPromise) {
          this.databasePromise = undefined;
        }
        throw error;
      });
    }

    const pendingPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, COLLECTION_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const upgradeTransaction = request.transaction;
        if (upgradeTransaction === null) {
          reject(new Error('无法取得 IndexedDB 升级事务。'));
          return;
        }

        const collections = database.objectStoreNames.contains(COLLECTION_STORE_NAME)
          ? upgradeTransaction.objectStore(COLLECTION_STORE_NAME)
          : database.createObjectStore(COLLECTION_STORE_NAME, { keyPath: 'id' });
        if (!collections.indexNames.contains('position')) {
          collections.createIndex('position', 'position', { unique: false });
        }

        const items = database.objectStoreNames.contains(ITEM_STORE_NAME)
          ? upgradeTransaction.objectStore(ITEM_STORE_NAME)
          : database.createObjectStore(ITEM_STORE_NAME, { keyPath: 'id' });
        if (!items.indexNames.contains('collectionId')) {
          items.createIndex('collectionId', 'collectionId', { unique: false });
        }
        if (!items.indexNames.contains('collectionId_position')) {
          items.createIndex('collectionId_position', ['collectionId', 'position'], { unique: false });
        }
        if (!items.indexNames.contains('collectionId_normalizedUrl')) {
          items.createIndex('collectionId_normalizedUrl', ['collectionId', 'normalizedUrl'], { unique: false });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          if (this.databasePromise === trackedPromise) {
            this.databasePromise = undefined;
          }
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB 数据库。'));
      request.onblocked = () => reject(new Error('IndexedDB 数据库仍被其他页面占用。'));
    });

    const trackedPromise = pendingPromise.catch((error: unknown) => {
      if (this.databasePromise === trackedPromise) {
        this.databasePromise = undefined;
      }
      throw error;
    });
    this.databasePromise = trackedPromise;
    return trackedPromise;
  }

  // 统一等待事务提交，保证每个写操作都在事务完成后才向调用方返回。
  private async runTransaction<T>(
    stores: readonly StoreName[],
    mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let transaction: IDBTransaction | undefined;
      let completed: Promise<void> | undefined;
      try {
        const database = await this.open();
        const activeTransaction = database.transaction([...stores], mode);
        transaction = activeTransaction;
        completed = new Promise<void>((resolve, reject) => {
          activeTransaction.addEventListener('complete', () => resolve(), { once: true });
          activeTransaction.addEventListener('abort', () => reject(activeTransaction.error ?? new Error('IndexedDB 事务已中止。')), { once: true });
        });

        const result = await operation(activeTransaction);
        await completed;
        return result;
      } catch (error: unknown) {
        try {
          transaction?.abort();
        } catch {
          // 事务已完成或已中止时无需重复处理。
        }
        await completed?.catch(() => undefined);
        if (attempt === 0 && isRetryableIndexedDbError(error)) {
          // 连接失效时关闭旧句柄并重新打开，避免把空状态误认为数据已丢失。
          await this.close();
          continue;
        }
        throw error;
      }
    }

    throw new Error('IndexedDB 读取失败。');
  }

  // 关闭当前连接，让测试或未来的数据库升级可以安全地重新打开。
  public async close(): Promise<void> {
    const cachedPromise = this.databasePromise;
    this.databasePromise = undefined;
    if (cachedPromise === undefined) {
      return;
    }
    try {
      const database = await cachedPromise;
      database.close();
    } catch {
      // 打开失败时没有可关闭的数据库句柄。
    }
  }

  // 读取全部集合，并按位置返回副本；读取操作不会隐式修改数据库。
  public async listCollections(): Promise<Collection[]> {
    return this.runTransaction([COLLECTION_STORE_NAME], 'readonly', async (transaction) => {
      const store = transaction.objectStore(COLLECTION_STORE_NAME);
      const records = await requestResult<Collection[]>(
        store.getAll() as IDBRequest<Collection[]>,
      );
      return normalizePositions(records);
    });
  }

  // 获取单个集合，不存在时返回 undefined，方便侧边栏刷新状态。
  public async getCollection(collectionId: string): Promise<Collection | undefined> {
    return this.runTransaction([COLLECTION_STORE_NAME], 'readonly', async (transaction) => {
      const store = transaction.objectStore(COLLECTION_STORE_NAME);
      return requestResult<Collection | undefined>(
        store.get(collectionId) as IDBRequest<Collection | undefined>,
      );
    });
  }

  // 新建集合并将其追加到归一化后的位置末尾。
  public async createCollection(input: CreateCollectionInput | string): Promise<Collection> {
    const payload: CreateCollectionInput = typeof input === 'string'
      ? { name: input }
      : input;
    const name = normalizeRequiredText(payload.name, '集合名称');

    return this.runTransaction([COLLECTION_STORE_NAME], 'readwrite', async (transaction) => {
      const store = transaction.objectStore(COLLECTION_STORE_NAME);
      const records = await requestResult<Collection[]>(
        store.getAll() as IDBRequest<Collection[]>,
      );
      const normalizedRecords = normalizePositions(records);
      const timestamp = this.now();
      const collection: Collection = {
        id: this.idFactory(),
        name,
        position: normalizedRecords.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      for (const record of normalizedRecords) {
        await requestResult<IDBValidKey>(store.put(record));
      }
      await requestResult<IDBValidKey>(store.put(collection));
      return collection;
    });
  }

  // 修改集合名称或集合级便笺。
  public async updateCollection(collectionId: string, patch: CollectionPatch): Promise<Collection> {
    return this.runTransaction([COLLECTION_STORE_NAME], 'readwrite', async (transaction) => {
      const store = transaction.objectStore(COLLECTION_STORE_NAME);
      const existing = await requestResult<Collection | undefined>(
        store.get(collectionId) as IDBRequest<Collection | undefined>,
      );
      if (existing === undefined) {
        throw new NotFoundError(`找不到集合：${collectionId}`);
      }

      const updated: Collection = { ...existing, updatedAt: this.now() };
      if (patch.name !== undefined) {
        updated.name = normalizeRequiredText(patch.name, '集合名称');
      }
      await requestResult<IDBValidKey>(store.put(updated));
      return updated;
    });
  }

  // 提供语义明确的重命名入口。
  public async renameCollection(collectionId: string, name: string): Promise<Collection> {
    return this.updateCollection(collectionId, { name });
  }

  // 删除集合及其全部卡片，并归一化剩余集合的位置。
  public async deleteCollection(collectionId: string): Promise<void> {
    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      const existing = await requestResult<Collection | undefined>(
        collectionStore.get(collectionId) as IDBRequest<Collection | undefined>,
      );
      if (existing === undefined) {
        throw new NotFoundError(`找不到集合：${collectionId}`);
      }

      const items = await requestResult<CollectionItem[]>(
        itemStore.index('collectionId').getAll(collectionId) as IDBRequest<CollectionItem[]>,
      );
      for (const item of items) {
        await requestResult<undefined>(itemStore.delete(item.id) as IDBRequest<undefined>);
      }
      await requestResult<undefined>(collectionStore.delete(collectionId) as IDBRequest<undefined>);

      const remaining = normalizePositions(await requestResult<Collection[]>(
        collectionStore.getAll() as IDBRequest<Collection[]>,
      ));
      for (const collection of remaining) {
        await requestResult<IDBValidKey>(collectionStore.put(collection));
      }
    });
  }

  // 重新排列集合并在同一事务中写回所有位置。
  public async reorderCollections(collectionId: string, targetPosition: number): Promise<Collection[]> {
    const safeTarget = normalizeTargetPosition(targetPosition);
    return this.runTransaction([COLLECTION_STORE_NAME], 'readwrite', async (transaction) => {
      const store = transaction.objectStore(COLLECTION_STORE_NAME);
      const records = await requestResult<Collection[]>(
        store.getAll() as IDBRequest<Collection[]>,
      );
      const reordered = reorderPositions(records, collectionId, safeTarget);
      for (const record of reordered) {
        await requestResult<IDBValidKey>(store.put(record));
      }
      return reordered;
    });
  }

  // 按集合读取卡片，读取时进行内存位置归一化但不产生写事务。
  public async listItems(collectionId: string): Promise<CollectionItem[]> {
    return this.runTransaction([ITEM_STORE_NAME], 'readonly', async (transaction) => {
      const store = transaction.objectStore(ITEM_STORE_NAME);
      const records = await requestResult<CollectionItem[]>(
        store.index('collectionId').getAll(collectionId) as IDBRequest<CollectionItem[]>,
      );
      return normalizePositions(records);
    });
  }

  // 获取单个卡片。
  public async getItem(itemId: string): Promise<CollectionItem | undefined> {
    return this.runTransaction([ITEM_STORE_NAME], 'readonly', async (transaction) => {
      const store = transaction.objectStore(ITEM_STORE_NAME);
      return requestResult<CollectionItem | undefined>(
        store.get(itemId) as IDBRequest<CollectionItem | undefined>,
      );
    });
  }

  // 新建网页卡片；同一集合内相同规范化 URL 直接抛出明确重复错误。
  public async createPageItem(input: CreatePageItemInput): Promise<PageItem> {
    const normalizedUrl = normalizeWebUrl(input.url);
    const faviconUrl = normalizeOptionalWebUrl(input.faviconUrl);
    const thumbnailDataUrl = input.thumbnailDataUrl;

    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      const collection = await requestResult<Collection | undefined>(
        collectionStore.get(input.collectionId) as IDBRequest<Collection | undefined>,
      );
      if (collection === undefined) {
        throw new NotFoundError(`找不到集合：${input.collectionId}`);
      }

      const existingItems = await requestResult<CollectionItem[]>(
        itemStore.index('collectionId').getAll(input.collectionId) as IDBRequest<CollectionItem[]>,
      );
      const duplicate = existingItems.find((item): item is PageItem => (
        item.type === 'page' && item.normalizedUrl === normalizedUrl
      ));
      if (duplicate !== undefined) {
        throw new DuplicateUrlError('同一集合中已经存在相同网页。');
      }

      const normalizedItems = normalizePositions(existingItems);
      const timestamp = this.now();
      const item: PageItem = {
        id: this.idFactory(),
        type: 'page',
        collectionId: input.collectionId,
        title: normalizeTitle(input.title, normalizedUrl),
        url: normalizedUrl,
        normalizedUrl,
        position: normalizedItems.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (faviconUrl !== undefined) item.faviconUrl = faviconUrl;
      if (thumbnailDataUrl !== undefined) item.thumbnailDataUrl = thumbnailDataUrl;
      if (input.note !== undefined) item.note = input.note;

      await requestResult<IDBValidKey>(itemStore.put(item));
      return item;
    });
  }

  // 修改网页卡片，URL 变化时重新规范化并检查同集合重复。
  public async updatePageItem(itemId: string, patch: PageItemPatch): Promise<PageItem> {
    return this.runTransaction([ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const store = transaction.objectStore(ITEM_STORE_NAME);
      const existing = await requestResult<CollectionItem | undefined>(
        store.get(itemId) as IDBRequest<CollectionItem | undefined>,
      );
      if (existing === undefined || existing.type !== 'page') {
        throw new NotFoundError(`找不到网页卡片：${itemId}`);
      }

      const updated: PageItem = { ...existing, updatedAt: this.now() };
      if (patch.url !== undefined) {
        updated.url = normalizeWebUrl(patch.url);
        updated.normalizedUrl = updated.url;
      }
      if (patch.title !== undefined) {
        updated.title = normalizeTitle(patch.title, updated.url);
      }
      if (patch.faviconUrl !== undefined) {
        if (patch.faviconUrl === null) delete updated.faviconUrl;
        else updated.faviconUrl = normalizeWebUrl(patch.faviconUrl);
      }
      if (patch.thumbnailDataUrl !== undefined) {
        if (patch.thumbnailDataUrl === null) delete updated.thumbnailDataUrl;
        else updated.thumbnailDataUrl = patch.thumbnailDataUrl;
      }
      if (patch.note !== undefined) {
        if (patch.note === null) delete updated.note;
        else updated.note = patch.note;
      }

      if (updated.normalizedUrl !== existing.normalizedUrl) {
        const siblings = await requestResult<CollectionItem[]>(
          store.index('collectionId').getAll(existing.collectionId) as IDBRequest<CollectionItem[]>,
        );
        const duplicate = siblings.find((item): item is PageItem => (
          item.id !== itemId
            && item.type === 'page'
            && item.normalizedUrl === updated.normalizedUrl
        ));
        if (duplicate !== undefined) {
          throw new DuplicateUrlError('同一集合中已经存在相同网页。');
        }
      }

      await requestResult<IDBValidKey>(store.put(updated));
      return updated;
    });
  }

  // 新建兼容旧版 Collections 的便笺卡片。
  public async createLegacyNote(input: CreateLegacyNoteInput): Promise<LegacyNoteItem> {
    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      const collection = await requestResult<Collection | undefined>(
        collectionStore.get(input.collectionId) as IDBRequest<Collection | undefined>,
      );
      if (collection === undefined) {
        throw new NotFoundError(`找不到集合：${input.collectionId}`);
      }

      const existingItems = await requestResult<CollectionItem[]>(
        itemStore.index('collectionId').getAll(input.collectionId) as IDBRequest<CollectionItem[]>,
      );
      const timestamp = this.now();
      const item: LegacyNoteItem = {
        id: this.idFactory(),
        type: 'legacy-note',
        collectionId: input.collectionId,
        title: normalizeTitle(input.title, '便笺'),
        content: input.content ?? '',
        position: normalizePositions(existingItems).length,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await requestResult<IDBValidKey>(itemStore.put(item));
      return item;
    });
  }

  // 修改旧便笺的标题和正文。
  public async updateLegacyNote(itemId: string, patch: LegacyNotePatch): Promise<LegacyNoteItem> {
    return this.runTransaction([ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const store = transaction.objectStore(ITEM_STORE_NAME);
      const existing = await requestResult<CollectionItem | undefined>(
        store.get(itemId) as IDBRequest<CollectionItem | undefined>,
      );
      if (existing === undefined || existing.type !== 'legacy-note') {
        throw new NotFoundError(`找不到旧便笺：${itemId}`);
      }

      const updated: LegacyNoteItem = { ...existing, updatedAt: this.now() };
      if (patch.title !== undefined) updated.title = normalizeTitle(patch.title, '便笺');
      if (patch.content !== undefined) updated.content = patch.content;
      await requestResult<IDBValidKey>(store.put(updated));
      return updated;
    });
  }

  // 删除单个卡片并归一化其原集合的位置。
  public async deleteItem(itemId: string): Promise<void> {
    return this.runTransaction([ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const store = transaction.objectStore(ITEM_STORE_NAME);
      const existing = await requestResult<CollectionItem | undefined>(
        store.get(itemId) as IDBRequest<CollectionItem | undefined>,
      );
      if (existing === undefined) {
        throw new NotFoundError(`找不到卡片：${itemId}`);
      }

      await requestResult<undefined>(store.delete(itemId) as IDBRequest<undefined>);
      const remaining = normalizePositions(await requestResult<CollectionItem[]>(
        store.index('collectionId').getAll(existing.collectionId) as IDBRequest<CollectionItem[]>,
      ));
      for (const item of remaining) {
        await requestResult<IDBValidKey>(store.put(item));
      }
    });
  }

  // 移动卡片到另一个集合或在同集合中改变位置，两个集合的位置一次性归一化。
  public async moveItem(
    itemId: string,
    targetCollectionId: string,
    targetPosition?: number,
  ): Promise<CollectionItem> {
    const safeTarget = targetPosition === undefined ? undefined : normalizeTargetPosition(targetPosition);
    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      const targetCollection = await requestResult<Collection | undefined>(
        collectionStore.get(targetCollectionId) as IDBRequest<Collection | undefined>,
      );
      if (targetCollection === undefined) {
        throw new NotFoundError(`找不到目标集合：${targetCollectionId}`);
      }

      const existing = await requestResult<CollectionItem | undefined>(
        itemStore.get(itemId) as IDBRequest<CollectionItem | undefined>,
      );
      if (existing === undefined) {
        throw new NotFoundError(`找不到卡片：${itemId}`);
      }

      const sourceItems = await requestResult<CollectionItem[]>(
        itemStore.index('collectionId').getAll(existing.collectionId) as IDBRequest<CollectionItem[]>,
      );
      if (existing.collectionId === targetCollectionId) {
        const target = safeTarget ?? Math.max(0, sourceItems.length - 1);
        const reordered = reorderPositions(sourceItems, itemId, target);
        for (const item of reordered) {
          await requestResult<IDBValidKey>(itemStore.put(item));
        }
        const moved = reordered.find((item) => item.id === itemId);
        if (moved === undefined) {
          throw new NotFoundError(`找不到卡片：${itemId}`);
        }
        return moved;
      }

      const targetItems = await requestResult<CollectionItem[]>(
        itemStore.index('collectionId').getAll(targetCollectionId) as IDBRequest<CollectionItem[]>,
      );
      if (existing.type === 'page') {
        const duplicate = targetItems.find((item): item is PageItem => (
          item.type === 'page' && item.normalizedUrl === existing.normalizedUrl
        ));
        if (duplicate !== undefined) {
          throw new DuplicateUrlError('目标集合中已经存在相同网页。');
        }
      }
      const sourceRemaining = normalizePositions(sourceItems.filter((item) => item.id !== itemId));
      const moved: CollectionItem = {
        ...existing,
        collectionId: targetCollectionId,
        updatedAt: this.now(),
        position: 0,
      };
      const targetWithMoved = normalizePositions(targetItems);
      const insertAt = safeTarget ?? targetWithMoved.length;
      targetWithMoved.splice(Math.max(0, Math.min(targetWithMoved.length, insertAt)), 0, moved);
      const normalizedTarget = targetWithMoved.map((item, position) => ({ ...item, position }));
      const updatedMoved = normalizedTarget.find((item) => item.id === itemId);
      if (updatedMoved === undefined) {
        throw new NotFoundError(`找不到移动后的卡片：${itemId}`);
      }

      await requestResult<undefined>(itemStore.delete(itemId) as IDBRequest<undefined>);
      for (const item of sourceRemaining) {
        await requestResult<IDBValidKey>(itemStore.put(item));
      }
      for (const item of normalizedTarget) {
        await requestResult<IDBValidKey>(itemStore.put(item));
      }
      return updatedMoved;
    });
  }

  // 在同一集合中重排卡片，并写回连续位置。
  public async reorderItems(
    collectionId: string,
    itemId: string,
    targetPosition: number,
  ): Promise<CollectionItem[]> {
    const safeTarget = normalizeTargetPosition(targetPosition);
    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      const collection = await requestResult<Collection | undefined>(
        collectionStore.get(collectionId) as IDBRequest<Collection | undefined>,
      );
      if (collection === undefined) {
        throw new NotFoundError(`找不到集合：${collectionId}`);
      }
      const records = await requestResult<CollectionItem[]>(
        itemStore.index('collectionId').getAll(collectionId) as IDBRequest<CollectionItem[]>,
      );
      const reordered = reorderPositions(records, itemId, safeTarget);
      for (const item of reordered) {
        await requestResult<IDBValidKey>(itemStore.put(item));
      }
      return reordered;
    });
  }

  // 将经过运行时验证的备份追加到现有数据；恢复按稳定卡片 ID 去重，不按 URL 去重。
  public async mergeImport(input: unknown): Promise<ImportReport> {
    const backup: BackupV1 = validateBackupV1(input);
    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      const existingCollections = normalizePositions(await requestResult<Collection[]>(
        collectionStore.getAll() as IDBRequest<Collection[]>,
      ));
      const existingItems = await requestResult<CollectionItem[]>(
        itemStore.getAll() as IDBRequest<CollectionItem[]>,
      );
      const report: ImportReport = {
        insertedCollections: 0,
        insertedItems: 0,
        skippedCollections: 0,
        skippedItems: 0,
        warnings: [],
      };
      const collectionIds = new Set(existingCollections.map((collection) => collection.id));
      let nextCollectionPosition = existingCollections.length;
      for (const collection of existingCollections) {
        await requestResult<IDBValidKey>(collectionStore.put(collection));
      }
      for (const collection of backup.collections) {
        if (collectionIds.has(collection.id)) {
          report.skippedCollections += 1;
          report.warnings.push(`集合 ID ${collection.id} 已存在，已跳过。`);
          continue;
        }
        const imported = { ...collection, position: nextCollectionPosition };
        nextCollectionPosition += 1;
        collectionIds.add(imported.id);
        await requestResult<IDBValidKey>(collectionStore.put(imported));
        report.insertedCollections += 1;
      }

      const normalizedExistingItems = new Map<string, CollectionItem[]>();
      const nextItemPositions = new Map<string, number>();
      for (const item of existingItems) {
        const group = normalizedExistingItems.get(item.collectionId) ?? [];
        group.push(item);
        normalizedExistingItems.set(item.collectionId, group);
      }
      for (const [collectionId, items] of normalizedExistingItems) {
        const normalized = normalizePositions(items);
        nextItemPositions.set(collectionId, normalized.length);
        for (const item of normalized) {
          await requestResult<IDBValidKey>(itemStore.put(item));
        }
      }

      const existingItemIds = new Set(existingItems.map((item) => item.id));
      for (const item of backup.items) {
        if (existingItemIds.has(item.id)) {
          report.skippedItems += 1;
          report.warnings.push(`卡片 ID ${item.id} 已存在，已跳过。`);
          continue;
        }
        const position = nextItemPositions.get(item.collectionId) ?? 0;
        nextItemPositions.set(item.collectionId, position + 1);
        await requestResult<IDBValidKey>(itemStore.put({ ...item, position }));
        existingItemIds.add(item.id);
        report.insertedItems += 1;
      }
      return report;
    });
  }

  // 用备份一次性替换现有数据；恢复保留同集合中不同 ID 的重复 URL 卡片。
  public async replaceImport(input: unknown): Promise<ImportReport> {
    const backup: BackupV1 = validateBackupV1(input);
    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readwrite', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      await requestResult<undefined>(collectionStore.clear() as IDBRequest<undefined>);
      await requestResult<undefined>(itemStore.clear() as IDBRequest<undefined>);

      const collections = normalizePositions(backup.collections);
      for (const collection of collections) {
        await requestResult<IDBValidKey>(collectionStore.put(collection));
      }
      const groupedItems = new Map<string, CollectionItem[]>();
      for (const item of backup.items) {
        const group = groupedItems.get(item.collectionId) ?? [];
        group.push(item);
        groupedItems.set(item.collectionId, group);
      }
      for (const items of groupedItems.values()) {
        const normalized = normalizePositions(items);
        for (const item of normalized) {
          await requestResult<IDBValidKey>(itemStore.put(item));
        }
      }
      return {
        insertedCollections: collections.length,
        insertedItems: backup.items.length,
        skippedCollections: 0,
        skippedItems: 0,
        warnings: [],
      };
    });
  }

  // 搜索必须一次性读取全部集合和卡片，支持集合标题、卡片标题、URL 和备注查询。
  public async search(query: string): Promise<CollectionSearchResult[]> {
    const needle = query.trim().toLocaleLowerCase();
    return this.runTransaction([COLLECTION_STORE_NAME, ITEM_STORE_NAME], 'readonly', async (transaction) => {
      const collectionStore = transaction.objectStore(COLLECTION_STORE_NAME);
      const itemStore = transaction.objectStore(ITEM_STORE_NAME);
      const collectionsRequest = requestResult<Collection[]>(
        collectionStore.getAll() as IDBRequest<Collection[]>,
      );
      const itemsRequest = requestResult<CollectionItem[]>(
        itemStore.getAll() as IDBRequest<CollectionItem[]>,
      );
      const [collections, items] = await Promise.all([collectionsRequest, itemsRequest]);
      const orderedCollections = normalizePositions(collections);
      const collectionMap = new Map(orderedCollections.map((collection) => [collection.id, collection]));
      const collectionOrder = new Map(orderedCollections.map((collection, index) => [collection.id, index]));
      const orderedItems = [...items].sort((left, right) => (
        (collectionOrder.get(left.collectionId) ?? Number.MAX_SAFE_INTEGER)
          - (collectionOrder.get(right.collectionId) ?? Number.MAX_SAFE_INTEGER)
          || left.position - right.position
      ));

      const collectionResults: CollectionSearchResult[] = needle.length === 0
        ? []
        : orderedCollections
          .filter((collection) => collection.name.toLocaleLowerCase().includes(needle))
          .map((collection) => ({ kind: 'collection', collection }));
      const itemResults = orderedItems.flatMap((item): CollectionSearchResult[] => {
        const collection = collectionMap.get(item.collectionId);
        if (collection === undefined) {
          return [];
        }
        if (needle.length === 0) {
          return [{ kind: 'item', collection, item }];
        }
        const searchable = `${collection.name}\n${getSearchText(item)}`.toLocaleLowerCase();
        return searchable.includes(needle) ? [{ kind: 'item', collection, item }] : [];
      });
      return [...collectionResults, ...itemResults];
    });
  }
}
