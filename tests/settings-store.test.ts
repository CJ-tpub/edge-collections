import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, SettingsStore } from '../src/settings/settings-store';

const globalWithChrome = globalThis as typeof globalThis & { chrome?: typeof chrome };
const originalChrome = globalWithChrome.chrome;

describe('侧栏显示设置', () => {
  let storedSettings: unknown;
  const get = vi.fn(async () => ({ collectionSettings: storedSettings }));
  const set = vi.fn(async (value: Record<string, unknown>) => {
    storedSettings = value.collectionSettings;
  });

  beforeEach(() => {
    storedSettings = undefined;
    get.mockClear();
    set.mockClear();
    globalWithChrome.chrome = {
      storage: { local: { get, set } },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    globalWithChrome.chrome = originalChrome;
  });

  it('旧设置缺少新字段时使用较大的默认字号和正序', async () => {
    storedSettings = { theme: 'dark', sort: 'name' };
    const settings = await new SettingsStore().get();
    expect(settings.fontSize).toBe(DEFAULT_FONT_SIZE);
    expect(settings.sortDescending).toBe(false);
  });

  it('字号限制在可读范围，排序方向可以持久化', async () => {
    const store = new SettingsStore();
    const updated = await store.update({ fontSize: MAX_FONT_SIZE + 10, sortDescending: true });
    expect(updated.fontSize).toBe(MAX_FONT_SIZE);
    expect(updated.sortDescending).toBe(true);
    const smaller = await store.update({ fontSize: MIN_FONT_SIZE - 10 });
    expect(smaller.fontSize).toBe(MIN_FONT_SIZE);
    expect(set).toHaveBeenCalled();
  });
});
