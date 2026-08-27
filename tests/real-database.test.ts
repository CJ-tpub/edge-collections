import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { describe, expect, it } from 'vitest';
import { parseLegacyCollectionsDatabase } from '../src/backup/legacy-collections-parser';
import type { PageItem } from '../src/domain/types';

const databasePath = process.env.EDGE_COLLECTIONS_DB_PATH?.trim();
const expectedCollections = process.env.EDGE_COLLECTIONS_EXPECTED_COLLECTIONS === undefined
  ? undefined
  : Number(process.env.EDGE_COLLECTIONS_EXPECTED_COLLECTIONS);
const expectedItems = process.env.EDGE_COLLECTIONS_EXPECTED_ITEMS === undefined
  ? undefined
  : Number(process.env.EDGE_COLLECTIONS_EXPECTED_ITEMS);
const expectedPageNotes = process.env.EDGE_COLLECTIONS_EXPECTED_PAGE_NOTES === undefined
  ? undefined
  : Number(process.env.EDGE_COLLECTIONS_EXPECTED_PAGE_NOTES);
const expectedLegacyNotes = process.env.EDGE_COLLECTIONS_EXPECTED_LEGACY_NOTES === undefined
  ? undefined
  : Number(process.env.EDGE_COLLECTIONS_EXPECTED_LEGACY_NOTES);
const expectedThumbnails = process.env.EDGE_COLLECTIONS_EXPECTED_THUMBNAILS === undefined
  ? undefined
  : Number(process.env.EDGE_COLLECTIONS_EXPECTED_THUMBNAILS);

// 只有显式提供路径时才读取真实数据库，默认始终跳过并避免泄露本机内容。
describe('真实 Edge Collections SQLite（条件式）', () => {
  it.skipIf(databasePath === undefined)('按环境变量预期计数验证真实数据库', async () => {
    if (databasePath === undefined) return;
    const sqlJs: SqlJsStatic = await initSqlJs({
      locateFile: (fileName: string) => resolve(process.cwd(), 'node_modules/sql.js/dist', fileName),
    });
    const bytes = new Uint8Array(await readFile(databasePath));
    const result = parseLegacyCollectionsDatabase(bytes, sqlJs);
    if (expectedCollections !== undefined && Number.isFinite(expectedCollections)) {
      expect(result.collections).toHaveLength(expectedCollections);
    }
    if (expectedItems !== undefined && Number.isFinite(expectedItems)) {
      expect(result.items).toHaveLength(expectedItems);
    }
    const pageNotes = result.items.filter((item): item is PageItem => (
      item.type === 'page' && item.note !== undefined && item.note.length > 0
    )).length;
    if (expectedPageNotes !== undefined && Number.isFinite(expectedPageNotes)) {
      expect(pageNotes).toBe(expectedPageNotes);
    }
    const legacyNotes = result.items.filter((item) => item.type === 'legacy-note').length;
    if (expectedLegacyNotes !== undefined && Number.isFinite(expectedLegacyNotes)) {
      expect(legacyNotes).toBe(expectedLegacyNotes);
    }
    const thumbnails = result.items.filter((item): item is PageItem => (
      item.type === 'page' && item.thumbnailDataUrl !== undefined
    )).length;
    if (expectedThumbnails !== undefined && Number.isFinite(expectedThumbnails)) {
      expect(thumbnails).toBe(expectedThumbnails);
    }
  }, 30_000);
});
