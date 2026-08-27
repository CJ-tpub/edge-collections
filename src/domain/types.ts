// 侧边栏使用的主题选项。
export type ThemeMode = 'system' | 'light' | 'dark';

// 卡片和集合的排序选项。
export type SortMode = 'manual' | 'name' | 'createdAt';

// 可持久化的集合记录。
export interface Collection {
  id: string;
  name: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  legacySourceId?: string;
}

// 集合中的网页卡片，保留后续 UI 所需的最小字段。
export interface PageItem {
  id: string;
  type: 'page';
  collectionId: string;
  title: string;
  url: string;
  normalizedUrl: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  legacySourceId?: string;
  faviconUrl?: string;
  thumbnailDataUrl?: string;
  note?: string;
}

// 兼容旧版 Collections 便笺的最小卡片记录。
export interface LegacyNoteItem {
  id: string;
  type: 'legacy-note';
  collectionId: string;
  title: string;
  content: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  legacySourceId?: string;
}

// 集合卡片的联合类型，仓库的 items 对象仓库存储此类型。
export type CollectionItem = PageItem | LegacyNoteItem;

// 新建集合的输入，不允许调用方伪造位置和时间戳。
export interface CreateCollectionInput {
  name: string;
}

// 新建网页卡片的输入。
export interface CreatePageItemInput {
  collectionId: string;
  title?: string;
  url: string;
  faviconUrl?: string;
  thumbnailDataUrl?: string;
  note?: string;
}

// 修改网页卡片时允许变更的字段；null 用于清空可选字段。
export interface PageItemPatch {
  title?: string;
  url?: string;
  faviconUrl?: string | null;
  thumbnailDataUrl?: string | null;
  note?: string | null;
}

// 新建旧便笺卡片的输入。
export interface CreateLegacyNoteInput {
  collectionId: string;
  title?: string;
  content?: string;
}

// 修改旧便笺卡片时允许变更的字段。
export interface LegacyNotePatch {
  title?: string;
  content?: string;
}

// 扩展设置只包含轻量状态，不把集合和卡片写入 storage.local。
export interface CollectionSettings {
  theme: ThemeMode;
  sort: SortMode;
  sortDescending: boolean;
  fontSize: number;
  recentCollectionId: string | null;
}

// v1 备份格式，为后续导入导出功能固定数据契约。
export interface BackupV1 {
  format: 'edge-collections-backup';
  version: 1;
  exportedAt: number;
  collections: Collection[];
  items: CollectionItem[];
  settings?: CollectionSettings;
}
