import type { CollectionSettings, SortMode, ThemeMode } from '../domain/types';

// storage.local 只保存这些轻量设置，集合和卡片始终由 IndexedDB 管理。
export const SETTINGS_STORAGE_KEY = 'collectionSettings';

// 字号范围保持在侧栏可读且不破坏紧凑布局的区间内。
export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 24;

// 新安装扩展时使用的默认设置。
export const DEFAULT_SETTINGS: CollectionSettings = {
  theme: 'system',
  sort: 'manual',
  sortDescending: false,
  fontSize: DEFAULT_FONT_SIZE,
  recentCollectionId: null,
};

// 修改设置时允许传入的字段。
export type SettingsPatch = Partial<CollectionSettings>;

// 对未知存储值做运行时对象判断，避免把不可信数据直接当作设置使用。
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

// 校验主题枚举。
const isThemeMode = (value: unknown): value is ThemeMode => (
  value === 'system' || value === 'light' || value === 'dark'
);

// 校验排序枚举。
const isSortMode = (value: unknown): value is SortMode => (
  value === 'manual'
    || value === 'name'
    || value === 'createdAt'
);

// 将输入字号限制为整数像素，损坏或越界值统一回退到默认字号。
const normalizeFontSize = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)))
    : DEFAULT_FONT_SIZE
);

// 将 storage.local 的未知内容安全地收敛到设置类型。
const parseSettings = (value: unknown): CollectionSettings => {
  if (!isRecord(value)) {
    return { ...DEFAULT_SETTINGS };
  }

  const theme = isThemeMode(value.theme) ? value.theme : DEFAULT_SETTINGS.theme;
  const sort = isSortMode(value.sort) ? value.sort : DEFAULT_SETTINGS.sort;
  const sortDescending = typeof value.sortDescending === 'boolean'
    ? value.sortDescending
    : DEFAULT_SETTINGS.sortDescending;
  const fontSize = normalizeFontSize(value.fontSize);
  const recentCollectionId = value.recentCollectionId === null
    || typeof value.recentCollectionId === 'string'
    ? value.recentCollectionId
    : DEFAULT_SETTINGS.recentCollectionId;
  return { theme, sort, sortDescending, fontSize, recentCollectionId };
};

// 封装 chrome.storage.local，仅暴露设置读写，避免误存集合主体数据。
export class SettingsStore {
  // 读取设置；缺失或损坏时返回默认值。
  public async get(): Promise<CollectionSettings> {
    const values = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    return parseSettings(values[SETTINGS_STORAGE_KEY]);
  }

  // 合并并保存少量设置。
  public async update(patch: SettingsPatch): Promise<CollectionSettings> {
    const current = await this.get();
    const next: CollectionSettings = {
      theme: patch.theme ?? current.theme,
      sort: patch.sort ?? current.sort,
      sortDescending: patch.sortDescending ?? current.sortDescending,
      fontSize: patch.fontSize === undefined
        ? current.fontSize
        : normalizeFontSize(patch.fontSize),
      recentCollectionId: patch.recentCollectionId === undefined
        ? current.recentCollectionId
        : patch.recentCollectionId,
    };
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
    return next;
  }
}
