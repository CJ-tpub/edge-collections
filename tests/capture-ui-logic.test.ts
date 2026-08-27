import { describe, expect, it } from 'vitest';
import { arePageCapturesEqual, createPageCapture, validatePageCapture } from '../src/capture/capture';
import type { Collection, PageItem } from '../src/domain/types';
import {
  domainFromUrl,
  getReorderTargetPosition,
  isImportFileSizeAllowed,
  makeDownloadFileName,
  MAX_IMPORT_FILE_SIZE,
  sortCollectionsForDisplay,
  sortItemsForDisplay,
} from '../src/sidepanel/ui-logic';

// 捕获逻辑只接受 HTTP/HTTPS，并把 favicon 降级为可选信息。
describe('当前页捕获逻辑', () => {
  it('规范化网页地址和标题，拒绝危险协议', () => {
    expect(createPageCapture({ title: '网页', url: ' HTTPS://Example.com/a/#段落 ' }, 1_700_000_000_123)).toEqual({
      title: '网页',
      url: 'https://example.com/a',
      capturedAt: 1_700_000_000_123,
    });
    expect(createPageCapture({ url: 'https://example.com', favIconUrl: 'javascript:bad' }).faviconUrl).toBeUndefined();
    expect(() => createPageCapture({ url: 'javascript:alert(1)' })).toThrow();
    expect(() => validatePageCapture({ title: '危险', url: 'data:text/html,危险' })).toThrow();
  });

  it('用时间和规范化 URL 区分连续待处理捕获', () => {
    const first = createPageCapture({ url: 'https://example.com/one' }, 10);
    const same = validatePageCapture(first);
    const newer = createPageCapture({ url: 'https://example.com/two' }, 11);
    expect(arePageCapturesEqual(first, same)).toBe(true);
    expect(arePageCapturesEqual(first, newer)).toBe(false);
    expect(arePageCapturesEqual(undefined, newer)).toBe(false);
  });
});

// UI 使用的排序、域名、文件大小和下载名均保持纯函数，便于回归测试。
describe('侧栏纯逻辑', () => {
  const collections: Collection[] = [
    { id: 'b', name: '乙', position: 1, createdAt: 2, updatedAt: 2 },
    { id: 'a', name: '甲', position: 0, createdAt: 1, updatedAt: 1 },
  ];
  const items: PageItem[] = [
    { id: 'p2', type: 'page', collectionId: 'a', title: '乙', url: 'https://example.com/b', normalizedUrl: 'https://example.com/b', position: 1, createdAt: 2, updatedAt: 2 },
    { id: 'p1', type: 'page', collectionId: 'a', title: '甲', url: 'https://example.com/a', normalizedUrl: 'https://example.com/a', position: 0, createdAt: 1, updatedAt: 1 },
  ];

  it('按手动、名称和创建时间稳定排序', () => {
    expect(sortCollectionsForDisplay(collections, 'manual').map((item) => item.id)).toEqual(['a', 'b']);
    expect(sortCollectionsForDisplay(collections, 'name').map((item) => item.id)).toEqual(['a', 'b']);
    expect(sortCollectionsForDisplay(collections, 'name', true).map((item) => item.id)).toEqual(['b', 'a']);
    expect(sortItemsForDisplay(items, 'createdAt').map((item) => item.id)).toEqual(['p1', 'p2']);
    expect(sortItemsForDisplay(items, 'createdAt', true).map((item) => item.id)).toEqual(['p2', 'p1']);
  });

  it('把拖放目标上边缘换算为正确插入位置，并识别自身边界不动', () => {
    expect(getReorderTargetPosition(0, 1, 3)).toBe(0);
    expect(getReorderTargetPosition(0, 2, 3)).toBe(1);
    expect(getReorderTargetPosition(2, 1, 3)).toBe(1);
    expect(getReorderTargetPosition(0, 1, 3, true)).toBe(2);
    expect(getReorderTargetPosition(2, 1, 3, true)).toBe(1);
  });

  it('提取安全域名并限制导入大小和下载名', () => {
    expect(domainFromUrl('https://Example.com/a')).toBe('example.com');
    expect(domainFromUrl('javascript:bad')).toBe('未知网站');
    expect(isImportFileSizeAllowed(MAX_IMPORT_FILE_SIZE)).toBe(true);
    expect(isImportFileSizeAllowed(MAX_IMPORT_FILE_SIZE + 1)).toBe(false);
    expect(makeDownloadFileName('集锦/备份', 'JSON', 1_735_689_600_000)).toMatch(/^集锦-备份-\d{8}\.json$/u);
  });
});
