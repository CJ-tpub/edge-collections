import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { exportCollectionsCsv, decodeCollectionsCsv } from '../src/backup/csv-export';
import {
  BackupValidationError,
  createBackupV1,
  parseBackupJson,
  stringifyBackupV1,
} from '../src/backup/backup-service';
import { IndexedDbCollectionRepository } from '../src/data/collection-repository';
import type { BackupV1, PageItem } from '../src/domain/types';

let testNumber = 0;
const repositories: IndexedDbCollectionRepository[] = [];

// 为恢复测试创建独立的 IndexedDB 数据库。
const createRepository = (): IndexedDbCollectionRepository => {
  testNumber += 1;
  let idNumber = 0;
  const repository = new IndexedDbCollectionRepository({
    databaseName: `edge-collections-backup-test-${Date.now()}-${testNumber}`,
    idFactory: () => {
      idNumber += 1;
      return `backup-id-${idNumber}`;
    },
    now: (() => {
      let timestamp = 1_700_000_000_000;
      return () => {
        timestamp += 1;
        return timestamp;
      };
    })(),
  });
  repositories.push(repository);
  return repository;
};

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await repository.close();
  }
});

// 生成包含网页和旧便笺的合法 v1 备份。
const createValidBackup = async (repository: IndexedDbCollectionRepository): Promise<BackupV1> => {
  const collection = await repository.createCollection('备份集合');
  await repository.createPageItem({
    collectionId: collection.id,
    title: '备份网页',
    url: 'https://example.com/backup',
    note: '备份备注',
  });
  await repository.createLegacyNote({
    collectionId: collection.id,
    title: '备份便笺',
    content: '便笺正文',
  });
  return createBackupV1(
    [collection],
    await repository.listItems(collection.id),
    { theme: 'dark', sort: 'createdAt', sortDescending: false, fontSize: 16, recentCollectionId: collection.id },
    1_700_000_100_000,
  );
};

describe('BackupV1 和 CSV', () => {
  it('支持 BackupV1 JSON 往返和运行时安全校验', async () => {
    const repository = createRepository();
    const backup = await createValidBackup(repository);
    const roundTrip = parseBackupJson(stringifyBackupV1(backup));
    expect(roundTrip).toEqual(backup);

    const page = backup.items.find((item): item is PageItem => item.type === 'page');
    expect(page).toBeDefined();
    if (page === undefined) return;
    expect(() => parseBackupJson(JSON.stringify({
      ...backup,
      items: [{ ...page, url: 'javascript:alert(1)', normalizedUrl: 'javascript:alert(1)' }],
    }))).toThrow(BackupValidationError);
    expect(() => parseBackupJson(JSON.stringify({
      ...backup,
      items: [{ ...page, note: '超大字段'.repeat(100_001) }],
    }))).toThrow(BackupValidationError);
    expect(() => parseBackupJson(JSON.stringify({
      ...backup,
      items: [{ ...page, thumbnailDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    }))).toThrow(BackupValidationError);
    expect(() => parseBackupJson(JSON.stringify({
      ...backup,
      items: [{ ...page }, { ...page }],
    }))).toThrow(/ID 重复/u);

    const legacySettingsBackup = JSON.parse(stringifyBackupV1(backup)) as { settings?: Record<string, unknown> };
    if (legacySettingsBackup.settings !== undefined) {
      delete legacySettingsBackup.settings.fontSize;
      delete legacySettingsBackup.settings.sortDescending;
    }
    expect(parseBackupJson(JSON.stringify(legacySettingsBackup)).settings).toMatchObject({
      fontSize: 16,
      sortDescending: false,
    });
  });

  it('mergeImport 首次写入，重复 ID 再次导入时跳过并报告', async () => {
    const source = createRepository();
    const backup = await createValidBackup(source);
    const target = createRepository();
    const firstReport = await target.mergeImport(backup);
    const secondReport = await target.mergeImport(backup);

    expect(firstReport).toMatchObject({ insertedCollections: 1, insertedItems: 2, skippedCollections: 0, skippedItems: 0 });
    expect(secondReport).toMatchObject({ insertedCollections: 0, insertedItems: 0, skippedCollections: 1, skippedItems: 2 });
    expect(secondReport.warnings.some((warning) => warning.includes('已存在'))).toBe(true);
    expect((await target.listCollections())).toHaveLength(1);
    expect((await target.search('')).flatMap((match) => match.kind === 'item' ? [match.item.title] : [])).toEqual(['备份网页', '备份便笺']);
  });

  it('恢复通道按 ID 去重，并保留同集合不同 ID 的重复 URL', async () => {
    const source = createRepository();
    const collection = await source.createCollection('重复 URL 恢复');
    const page = await source.createPageItem({
      collectionId: collection.id,
      title: '第一条网页',
      url: 'https://example.com/same',
    });
    const duplicatePage: PageItem = {
      ...page,
      id: 'backup-page-different-id',
      title: '第二条网页',
      position: 1,
    };
    const backup = createBackupV1([collection], [page, duplicatePage], undefined, 1_700_000_100_000);
    const target = createRepository();

    const firstMerge = await target.mergeImport(backup);
    expect(firstMerge).toMatchObject({ insertedCollections: 1, insertedItems: 2, skippedCollections: 0, skippedItems: 0 });
    expect(await target.listItems(collection.id)).toHaveLength(2);

    const secondMerge = await target.mergeImport(backup);
    expect(secondMerge).toMatchObject({ insertedCollections: 0, insertedItems: 0, skippedCollections: 1, skippedItems: 2 });
    expect(await target.listItems(collection.id)).toHaveLength(2);

    const replaceReport = await target.replaceImport(backup);
    expect(replaceReport).toMatchObject({ insertedCollections: 1, insertedItems: 2, skippedCollections: 0, skippedItems: 0 });
    const replacedItems = await target.listItems(collection.id);
    expect(replacedItems).toHaveLength(2);
    expect(replacedItems.filter((item): item is PageItem => item.type === 'page').map((item) => item.normalizedUrl)).toEqual([
      'https://example.com/same',
      'https://example.com/same',
    ]);
  });

  it('replaceImport 写入成功并完整保留备份卡片', async () => {
    const repository = createRepository();
    const oldCollection = await repository.createCollection('原有集合');
    const oldPage = await repository.createPageItem({
      collectionId: oldCollection.id,
      title: '原有网页',
      url: 'https://example.com/old',
    });
    const backup = await createValidBackup(repository);
    const report = await repository.replaceImport(backup);
    expect(report).toMatchObject({ insertedCollections: 1, insertedItems: 2 });
    expect(await repository.getItem(oldPage.id)).toBeUndefined();

    const page = backup.items.find((item): item is PageItem => item.type === 'page');
    expect(page).toBeDefined();
    if (page === undefined) return;
    const duplicateBackup = createBackupV1(
      backup.collections,
      [page, { ...page, id: `${page.id}-duplicate`, title: '重复网页' }],
      undefined,
      backup.exportedAt,
    );
    const duplicateReport = await repository.replaceImport(duplicateBackup);
    expect(duplicateReport).toMatchObject({ insertedCollections: 1, insertedItems: 2 });
    expect((await repository.listCollections()).map((collection) => collection.name)).toEqual(['备份集合']);
    expect((await repository.listItems(backup.collections[0]?.id ?? '')).map((item) => item.title)).toEqual(['备份网页', '重复网页']);
  });

  it('CSV 带 UTF-8 BOM，并正确转义逗号、引号和换行', () => {
    const collections = [{
      id: 'c1',
      name: '集合,一',
      position: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }];
    const items: PageItem[] = [{
      id: 'p1',
      type: 'page',
      collectionId: 'c1',
      title: '标题"一',
      url: 'https://example.com/a,b',
      normalizedUrl: 'https://example.com/a,b',
      note: '第一行\n第二行',
      position: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }];
    const bytes = exportCollectionsCsv(collections, items);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xEF, 0xBB, 0xBF]);
    const csv = decodeCollectionsCsv(bytes);
    expect(csv.startsWith('Collection,Title,URL,Note,CreatedAt\r\n')).toBe(true);
    expect(csv).toContain('"集合,一","标题""一","https://example.com/a,b","第一行\n第二行"');
  });
});
