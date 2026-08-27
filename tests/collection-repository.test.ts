import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbCollectionRepository } from '../src/data/collection-repository';
import { DuplicateUrlError, ValidationError, normalizePositions, normalizeWebUrl } from '../src/domain/logic';

let testNumber = 0;
const repositories: IndexedDbCollectionRepository[] = [];

// 为每个测试创建独立数据库，避免测试间共享状态。
const createRepository = (): IndexedDbCollectionRepository => {
  testNumber += 1;
  let idNumber = 0;
  const repository = new IndexedDbCollectionRepository({
    databaseName: `edge-collections-test-${Date.now()}-${testNumber}`,
    idFactory: () => {
      idNumber += 1;
      return `test-id-${idNumber}`;
    },
    now: (() => {
      let timestamp = 1_000;
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

describe('IndexedDbCollectionRepository', () => {
  it('支持集合 CRUD、重命名、删除和位置归一化', async () => {
    const repository = createRepository();
    const first = await repository.createCollection('  阅读  ');
    const second = await repository.createCollection('稍后处理');
    const deletedPage = await repository.createPageItem({
      collectionId: second.id,
      title: '待删除网页',
      url: 'https://example.com/deleted',
    });
    const deletedNote = await repository.createLegacyNote({
      collectionId: second.id,
      title: '待删除便笺',
      content: '随集合删除',
    });

    expect((await repository.listCollections()).map((item) => item.name)).toEqual(['阅读', '稍后处理']);
    await repository.renameCollection(first.id, '已阅读');
    await repository.reorderCollections(second.id, 0);
    expect((await repository.listCollections()).map((item) => item.name)).toEqual(['稍后处理', '已阅读']);
    await repository.reorderCollections(first.id, -10);
    expect((await repository.listCollections()).map((item) => item.name)).toEqual(['已阅读', '稍后处理']);
    await repository.reorderCollections(first.id, 999);
    expect((await repository.listCollections()).map((item) => item.name)).toEqual(['稍后处理', '已阅读']);

    await repository.deleteCollection(second.id);
    const remaining = await repository.listCollections();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.position).toBe(0);
    expect(await repository.getCollection(second.id)).toBeUndefined();
    expect(await repository.getItem(deletedPage.id)).toBeUndefined();
    expect(await repository.getItem(deletedNote.id)).toBeUndefined();
    expect(await repository.listItems(second.id)).toEqual([]);
  });

  it('支持网页和旧便笺 CRUD、同集合移动与重排', async () => {
    const repository = createRepository();
    const source = await repository.createCollection('来源');
    const target = await repository.createCollection('目标');
    const first = await repository.createPageItem({
      collectionId: source.id,
      title: '第一篇',
      url: 'https://example.com/first',
    });
    const second = await repository.createPageItem({
      collectionId: source.id,
      title: '第二篇',
      url: 'https://example.com/second',
    });
    const note = await repository.createLegacyNote({
      collectionId: source.id,
      title: '旧便笺',
      content: '待整理',
    });

    await repository.updatePageItem(first.id, { note: '网页备注' });
    await repository.updateLegacyNote(note.id, { content: '已整理' });
    await repository.reorderItems(source.id, note.id, 0);
    expect((await repository.listItems(source.id)).map((item) => item.id)).toEqual([note.id, first.id, second.id]);
    await repository.reorderItems(source.id, note.id, 999);
    expect((await repository.listItems(source.id)).map((item) => item.id)).toEqual([first.id, second.id, note.id]);
    await repository.reorderItems(source.id, note.id, -10);
    expect((await repository.listItems(source.id)).map((item) => item.id)).toEqual([note.id, first.id, second.id]);

    await repository.moveItem(first.id, target.id, 0);
    const sourceItems = await repository.listItems(source.id);
    const targetItems = await repository.listItems(target.id);
    expect(sourceItems.map((item) => item.id)).toEqual([note.id, second.id]);
    expect(targetItems.map((item) => item.id)).toEqual([first.id]);
    expect(targetItems[0]?.collectionId).toBe(target.id);
    expect((await repository.getItem(first.id))?.type).toBe('page');

    await repository.deleteItem(second.id);
    expect(await repository.listItems(source.id)).toHaveLength(1);
    await repository.deleteItem(note.id);
    expect(await repository.listItems(source.id)).toEqual([]);
  });

  it('在同一集合按规范化 URL 去重，不同集合允许同 URL', async () => {
    const repository = createRepository();
    const firstCollection = await repository.createCollection('第一组');
    const secondCollection = await repository.createCollection('第二组');
    const first = await repository.createPageItem({
      collectionId: firstCollection.id,
      url: ' HTTPS://Example.com/article/#段落 ',
    });
    await expect(repository.createPageItem({
      collectionId: firstCollection.id,
      url: 'https://example.com/article/',
    })).rejects.toThrow(DuplicateUrlError);
    const otherCollectionItem = await repository.createPageItem({
      collectionId: secondCollection.id,
      url: 'https://example.com/article',
    });

    expect((await repository.listItems(firstCollection.id)).filter((item) => item.type === 'page')).toHaveLength(1);
    expect(otherCollectionItem.id).not.toBe(first.id);
  });

  it('网页 URL 修改遇到重复时回滚整个事务', async () => {
    const repository = createRepository();
    const collection = await repository.createCollection('修改回滚');
    const first = await repository.createPageItem({
      collectionId: collection.id,
      title: '原网页',
      url: 'https://example.com/first',
    });
    const second = await repository.createPageItem({
      collectionId: collection.id,
      title: '目标网页',
      url: 'https://example.com/second',
    });

    await expect(repository.updatePageItem(first.id, {
      title: '不应保存',
      url: `${second.url}/#片段`,
    })).rejects.toThrow(DuplicateUrlError);
    expect(await repository.getItem(first.id)).toEqual(first);
    expect(await repository.getItem(second.id)).toEqual(second);
  });

  it('跨集合移动网页遇到目标重复时回滚源集合和目标集合', async () => {
    const repository = createRepository();
    const source = await repository.createCollection('移动源');
    const target = await repository.createCollection('移动目标');
    const moving = await repository.createPageItem({
      collectionId: source.id,
      title: '待移动',
      url: 'https://example.com/same',
    });
    await repository.createLegacyNote({
      collectionId: source.id,
      title: '源便笺',
      content: '保持原位置',
    });
    const targetPage = await repository.createPageItem({
      collectionId: target.id,
      title: '目标重复网页',
      url: 'https://example.com/same/#不同片段',
    });
    await repository.createLegacyNote({
      collectionId: target.id,
      title: '目标便笺',
      content: '保持原位置',
    });
    const sourceBefore = await repository.listItems(source.id);
    const targetBefore = await repository.listItems(target.id);

    await expect(repository.moveItem(moving.id, target.id, 0)).rejects.toThrow(DuplicateUrlError);
    expect(await repository.listItems(source.id)).toEqual(sourceBefore);
    expect(await repository.listItems(target.id)).toEqual(targetBefore);
    expect((await repository.getItem(moving.id))?.collectionId).toBe(source.id);
    expect((await repository.getItem(targetPage.id))?.collectionId).toBe(target.id);
  });

  it('拒绝危险 URL，并支持纯逻辑位置归一化', async () => {
    expect(normalizeWebUrl('https://Example.com/a/#top')).toBe('https://example.com/a');
    expect(() => normalizeWebUrl('javascript:alert(1)')).toThrow(ValidationError);
    expect(() => normalizeWebUrl('data:text/html,危险内容')).toThrow(ValidationError);
    expect(normalizePositions([
      { id: 'b', position: 9 },
      { id: 'a', position: 2 },
    ])).toEqual([
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
    ]);

    const repository = createRepository();
    const collection = await repository.createCollection('安全测试');
    await expect(repository.createPageItem({
      collectionId: collection.id,
      url: 'javascript:alert(1)',
    })).rejects.toThrow(ValidationError);
  });

  it('全量读取集合和卡片执行搜索，并返回所属集合', async () => {
    const repository = createRepository();
    const collection = await repository.createCollection('研究资料');
    await repository.createPageItem({
      collectionId: collection.id,
      title: 'IndexedDB 设计',
      url: 'https://example.com/database',
      note: '事务和配额',
    });
    await repository.createLegacyNote({
      collectionId: collection.id,
      title: '计划',
      content: '验证移动行为',
    });

    const result = await repository.search('配额');
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('item');
    if (result[0]?.kind !== 'item') throw new Error('应返回网页搜索结果。');
    expect(result[0].collection.name).toBe('研究资料');
    expect(result[0].item.type).toBe('page');
    expect((await repository.search('')).flatMap((match) => match.kind === 'item' ? [match.item.title] : [])).toEqual([
      'IndexedDB 设计',
      '计划',
    ]);
  });

  it('集合标题命中时把集合结果排在卡片结果之前', async () => {
    const repository = createRepository();
    const collection = await repository.createCollection('研究资料');
    await repository.createPageItem({
      collectionId: collection.id,
      title: '数据库页面',
      url: 'https://example.com/database',
    });

    const result = await repository.search('研究');
    expect(result.map((match) => match.kind)).toEqual(['collection', 'item']);
    expect(result[0]?.kind === 'collection' ? result[0].collection.name : '').toBe('研究资料');
  });
});
