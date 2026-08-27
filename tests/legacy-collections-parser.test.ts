import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { describe, expect, it } from 'vitest';
import { parseLegacyCollectionsDatabase, LegacyDatabaseError } from '../src/backup/legacy-collections-parser';
import type { PageItem } from '../src/domain/types';

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

// 使用本地 node_modules 中的 WASM 初始化 SQL.js，不访问网络资源。
const loadSqlJs = async (): Promise<SqlJsStatic> => {
  sqlJsPromise ??= initSqlJs({
    locateFile: (fileName: string) => `${process.cwd()}/node_modules/sql.js/dist/${fileName}`,
  });
  return sqlJsPromise;
};

// 创建脱敏的真实 Edge Collections 结构，覆盖正常、删除、未知和坏 source 记录。
const createFixture = (sqlJs: SqlJsStatic): Uint8Array => {
  const database = new sqlJs.Database();
  database.run(`
    CREATE TABLE collections (
      id TEXT PRIMARY KEY,
      date_created INTEGER,
      date_modified INTEGER,
      title TEXT,
      position INTEGER,
      is_marked_for_deletion INTEGER
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      title TEXT,
      source BLOB,
      favicon_url TEXT,
      canonical_image_data BLOB,
      text_content TEXT,
      html_content TEXT,
      type TEXT,
      date_created INTEGER,
      date_modified INTEGER,
      is_marked_for_deletion INTEGER
    );
    CREATE TABLE collections_items_relationship (
      item_id TEXT,
      parent_id TEXT,
      position INTEGER,
      is_marked_for_deletion INTEGER
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      text TEXT,
      properties TEXT,
      is_marked_for_deletion INTEGER
    );
  `);
  const jsonBlob = (value: Record<string, unknown>): Uint8Array => (
    new TextEncoder().encode(JSON.stringify(value))
  );
  database.run(
    'INSERT INTO collections VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
    [
      'c1', 1_700_000_000, 1_700_000_001, '第一集合', 5, 0,
      'c2', 1_700_000_002_000, 1_700_000_003_000, '第二集合', 0, 0,
      'c-deleted', 1_700_000_000, 1_700_000_000, '已删除', 9, 1,
    ],
  );
  database.run(
    'INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'i1', '网页一', jsonBlob({
      url: 'https://example.com/a/',
      title: '网页一',
      websiteName: '备用名称',
      }), 'https://example.com/favicon.ico', jsonBlob({ image: 'data:image/png;base64,AA==' }), null, null, 'website', 1_700_000_010, 1_700_000_011_000, 0,
      'i2', '网页二', jsonBlob({
        url: 'https://example.com/b',
        websiteName: '网页二',
      }), 'javascript:bad', JSON.stringify({ data: 'data:image/jpeg;base64,/9j/' }), null, null, 'website', 1_700_000_012_000, 1_700_000_013_000, 0,
      'i3', '旧便笺', null, null, null, '旧版正文', '<p>不应优先使用 HTML</p>', 'annotation', 1_700_000_014, 1_700_000_015, 0,
      'i4', '未知', jsonBlob({ title: '未知' }), null, null, null, null, 'unknown', 1_700_000_000, 1_700_000_000, 0,
      'i5', '坏记录', new TextEncoder().encode('{坏 source'), null, null, null, null, 'website', 1_700_000_000, 1_700_000_000, 0,
      'i6', '已删除网页', jsonBlob({ url: 'https://example.com/deleted' }), null, null, null, null, 'website', 1_700_000_000, 1_700_000_000, 1,
    ],
  );
  database.run(
    'INSERT INTO collections_items_relationship VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
    ['i1', 'c1', 5, 0, 'i3', 'c1', 1, 0, 'i2', 'c2', 0, 0],
  );
  database.run('INSERT INTO comments VALUES (?, ?, ?, ?, ?)', ['comment-1', 'i1', '网页备注', '{}', 0]);
  const bytes = database.export();
  database.close();
  return bytes;
};

describe('parseLegacyCollectionsDatabase', () => {
  it('解析脱敏 SQLite，恢复关系位置、备注、缩略图和时间单位', async () => {
    const sqlJs = await loadSqlJs();
    const result = parseLegacyCollectionsDatabase(createFixture(sqlJs), sqlJs, { fallbackNow: 1_700_000_100_000 });

    expect(result.collections).toHaveLength(2);
    expect(result.collections.map((collection) => collection.name)).toEqual(['第二集合', '第一集合']);
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.position)).toEqual([0, 1, 0]);
    const page = result.items.find((item): item is PageItem => item.type === 'page' && item.legacySourceId === 'i1');
    expect(page).toMatchObject({
      url: 'https://example.com/a',
      title: '网页一',
      note: '网页备注',
      thumbnailDataUrl: 'data:image/png;base64,AA==',
      createdAt: 1_700_000_010_000,
      updatedAt: 1_700_000_011_000,
    });
    expect(page?.faviconUrl).toBe('https://example.com/favicon.ico');
    const secondPage = result.items.find((item): item is PageItem => item.type === 'page' && item.legacySourceId === 'i2');
    expect(secondPage?.thumbnailDataUrl).toBe('data:image/jpeg;base64,/9j/');
    expect(result.items.find((item) => item.type === 'legacy-note')).toMatchObject({
      title: '旧便笺',
      content: '旧版正文',
      legacySourceId: 'i3',
    });
    expect(result.warnings.some((warning) => warning.includes('已标记删除'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('类型未知'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('source JSON 无效'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('favicon_url'))).toBe(true);

    const repeated = parseLegacyCollectionsDatabase(createFixture(sqlJs), sqlJs, { fallbackNow: 1_700_000_100_000 });
    expect(repeated.collections).toEqual(result.collections);
    expect(repeated.items).toEqual(result.items);
  });

  it('损坏数据库和缺表时返回明确错误', async () => {
    const sqlJs = await loadSqlJs();
    expect(() => parseLegacyCollectionsDatabase(new Uint8Array([1, 2, 3]), sqlJs)).toThrow(LegacyDatabaseError);
    const database = new sqlJs.Database();
    database.run('CREATE TABLE collections (id TEXT, source BLOB)');
    const bytes = database.export();
    database.close();
    expect(() => parseLegacyCollectionsDatabase(bytes, sqlJs)).toThrow(/缺少必需表/u);
  });
});
