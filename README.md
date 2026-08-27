# 集锦扩展

> 仿原edge集锦的侧边栏集锦功能，支持修改、排序、批注、右键添加等功能。特色：支持原有edge集锦数据文件兼容导入，无缝衔接使用！本扩展可替代已移除的旧版 Edge 集锦功能。

这是一个使用原生 HTML/CSS、TypeScript strict 和 Vite 构建的 Microsoft Edge Manifest V3 扩展，用于在侧边栏中本地保存、整理和搜索网页集锦。数据默认保存在本机 IndexedDB，页面内容不会上传。

工具栏图标采用 Edge Collections 原有的“双卡片 + 加号”结构绘制为透明 PNG，尺寸位于 `public/icons`，不会打包网页截图。

## 安装与使用

```powershell
npm install
npm run typecheck
npm test
npm run build
```

打开 `edge://extensions`，启用“开发人员模式”，选择“加载解压缩的扩展”，加载构建生成的 `dist` 目录。点击工具栏按钮或按 `Ctrl+Shift+Y` 打开侧边栏。

侧栏支持：

- 新建、重命名、删除和拖拽排序集锦；
- 添加当前 HTTP/HTTPS 网页，编辑标题和备注/批注；
- 打开全部网页、移动/删除/上下重排卡片；
- 查看和编辑迁移来的旧便笺，不提供新建旧便笺入口；
- 按集锦名称、网页标题、网址、备注搜索；集锦匹配结果优先显示，并可从搜索结果直接编辑、移动或删除；
- 主题（跟随系统/浅色/深色）、字号（12–24 像素）及手动、名称、创建时间排序；
- “所有集锦”右侧按钮切换当前排序的正序/反序；拖拽排序靠近顶部或底部会自动滚动，并在刷新后保留当前视口锚点；
- 悬停“所有集锦”中的集锦行会显示圆形加号，可直接添加当前网页；
- 页面右键菜单“添加当前页到集锦”会打开独立小窗口，选择目标集锦后直接保存；
- 从旧版 Edge SQLite 恢复，或导入/导出 JSON、CSV。

更多菜单中的 SQLite 解析完全在本地 `sql.js` 执行。旧版 Edge 数据库只通过普通文件选择器手动导入，不调用本机助手或文件句柄 API。JSON 导入默认合并；选择替换时会先自动下载当前 JSON 备份。所有文件导入上限为 128 MiB，下载使用浏览器 Blob，不需要 downloads 权限。

## 旧版 Edge 数据迁移

旧版 Collections 数据库通常位于：

```text
C:\Users\<用户名>\AppData\Local\Microsoft\Edge\User Data\<配置文件>\Collections\collectionsSQLite
```

Windows 默认配置通常是：

```text
%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Collections\collectionsSQLite
```

其他 Edge 配置一般使用 `Profile 1`、`Profile 2` 等目录。若不确定当前配置名称，可打开 `edge://version`，查看“配置文件路径”，再进入该目录下的 `Collections\collectionsSQLite`。

Chromium 会把 Windows 的 Local AppData 和浏览器 User Data 视为敏感目录，因此新的文件句柄选择器会显示“包含系统文件”并拒绝打开。本扩展的“从旧版 Edge 数据库恢复…”固定使用普通文件上传窗口；在窗口地址栏输入上述目录，再选择无扩展名文件 `collectionsSQLite`，不经过会阻止 Local AppData 的 File System Access API。预览会显示集合、卡片数量和跳过警告，确认后以合并方式写入本扩展 IndexedDB。重复恢复会按稳定旧记录 ID 跳过已经存在的集合和卡片，只补充后来新增的记录；不会因同一旧库被多次选择而产生重复数据。

解析器兼容真实表 `collections`、`items`、`collections_items_relationship`、`comments`：集合读取 `id/title/position/date_created/date_modified`，关系和评论使用 `parent_id`；网页从 `source` JSON 恢复，annotation 即使 `source` 为 NULL 也读取 `text_content`，必要时将 `html_content` 转为纯文本。删除标记、未知类型、坏 JSON 和不安全 URL 会被跳过并显示中文警告。

## 备份与隐私

JSON 备份包含集合、网页、备注、旧便笺和轻量设置；CSV 包含 `Collection/Title/URL/Note/CreatedAt`，使用 UTF-8 BOM。建议在替换导入前另行保存下载的备份文件。

扩展仅使用本机 IndexedDB 保存集合和卡片，`storage.local` 只保存主题、排序、字号和最近集合，`storage.session` 只暂存右键捕获的当前页。扩展不上传 SQLite、网址、备注或缩略图，也不依赖 Microsoft 账号同步。

## 权限

manifest 仅声明：

- `sidePanel`：打开 Edge 侧边栏；
- `storage`：保存轻量设置和一次性的待处理页面快照；
- `contextMenus`：创建一个“添加当前页到集锦”的页面右键项；
- `tabs`：读取当前活动标签页并创建普通网页标签页。

没有申请广泛主机权限、file URL、nativeMessaging、downloads、书签或云同步权限。所有外链在打开前再次验证为 HTTP/HTTPS。

## 真实库验收测试

仅在本机显式设置路径时读取真实数据库；默认测试会跳过，且测试输出不打印标题、网址或数据库内容。

```powershell
$env:EDGE_COLLECTIONS_DB_PATH = 'C:\Users\<用户名>\AppData\Local\Microsoft\Edge\User Data\<配置文件>\Collections\collectionsSQLite'
$env:EDGE_COLLECTIONS_EXPECTED_COLLECTIONS = '55'
$env:EDGE_COLLECTIONS_EXPECTED_ITEMS = '343'
$env:EDGE_COLLECTIONS_EXPECTED_PAGE_NOTES = '45'
$env:EDGE_COLLECTIONS_EXPECTED_LEGACY_NOTES = '1'
$env:EDGE_COLLECTIONS_EXPECTED_THUMBNAILS = '323'
npm test -- --run tests/real-database.test.ts --testTimeout=30000
```

`dist` 是可直接加载的构建产物；`release/edge-collections-0.3.2.zip` 是内容相同的发布压缩包，解压后通过 Edge 的“加载解压缩的扩展”选择解压目录。

## 许可证

本项目采用 MIT License，详见根目录的 `LICENSE` 文件。
