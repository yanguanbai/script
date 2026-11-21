# 代码结构说明

以 `src/bilibili-history/bilibili-history.user.js` 为主体。结构用两个轴描述：**功能层**（按数据流，M 编号）和**样式族**（按相似视觉语言，A–I）。

编号只用于检索，不代表执行顺序；执行顺序只看文件位置。

---

## 轴一：功能层（M01–M37）

| 编号 | 层 | 职责 | 关键对象 / 函数 |
|---|---|---|---|
| M01–M03 | 常量层 | 内部键名与协议、运行参数、CSV 字段 | `RECORD_CHANGE_EVENT`、`CONFIG`、`CSV_COLUMNS` |
| M04–M05 | 工具层 | 时间换算与格式化、油猴存储用量 | `TimeTool`、`ByteTool` |
| M06, M08–M09 | 身份层 | 记录键解析、旧格式兼容、数据规范化 | `RecordKey`、`LegacyMigration`、`RecordNormalizer` |
| M07 | 采集层 | 从当前播放页解析番剧身份 | `PageData` 的番剧部分 |
| M10–M11, M14 | 存储层 | 容器合并、容器查找、原始记录读写与一致性 | `mergeContainers`、`RecordStore`、`StorageOperations`、`ColdArchiveStore`、`StorageRouter`、`ColdArchiveApi` |
| M12–M13 | 索引层 | 视图索引与最近快照、已打开列表刷新 | `HistoryViewIndex`、`refreshOpenHistoryLists` |
| M15, M32–M36 | 运维层 | 清理 / 导入导出 / 迁移、设置读取、启动修复 | `StorageApi`、`loadSettings`、`registerMenus`、`normalizeAllLocalRecords` |
| M16, M18 | 渲染层 | 条目展示状态、列表 HTML | `decorateEntry`、`HistoryListRenderer` |
| M17 | 查询层 | 搜索语法与条件匹配 | `SearchQuery` |
| M19–M22, M31 | 采集层 | 卡片 DOM 识别、官方历史同步、播放/直播采集、卡片标记 | `CardDom`、`OfficialHistorySync`、`startPlaybackRecorder`、`startLiveRecorder`、`startCardBadgeRenderer` |
| M23–M25 | 交互层 | 拖动、尺寸记忆、停靠吸附 | `makeDraggable`、`setupPersistentResize`、`makeDockableFloat` |
| M26 | 样式层 | 全部内嵌 CSS，14 个片段 | `injectStyle` |
| M27–M30, M34 | 界面层 | 播放悬浮窗（构建 / 解析 / UI）、历史记录页、设置窗口 | `PlaybackUI`、`HistoryPageUI`、`createSettingsWindow`、`refreshSettingsWindow` |
| M37 | 入口层 | 启动入口 | `mainInit` |

检索方式：在编辑器里搜 `【模块 M` 依次跳转；文件头也有一张同源索引。

---

## 轴二：样式族（A–I）

| 族 | 内容 | 代码位置 |
|---|---|---|
| A 玻璃面板 | 面板壳、遮罩、毛玻璃、入场动画（历史面板 / 播放浮窗 / 设置窗 / 菜单 / 对话框同一种语言） | `playbackFloat`、`playbackMenu`、`settingsBase`、`settingsLayoutOverrides`、`historyPanelAndSearch`、`historyPagePanel` |
| B 数值滑轨 | `liquid-slider / track / fill / thumb / markers / node` | `settingsBase`、`settingsLayoutOverrides` |
| C 开关 | `toggle-input` + `toggle-track` | `settingsBase` |
| D 列表 | 条目、分组卡、分集子列表、快照、类型标签 | `historyRecordsAndGroups`、`historyPanelAndSearch`、`historyPageControls` |
| E 卡片角标 | 来源标签 + 底部进度条 | `cardBadges` |
| F 菜单与对话框 | 右键记录菜单、「调整观看次数」对话框 | `recordMenusAndDialogs`、`playbackMenu` |
| G 主题变量 | token 定义 + 组件映射 + 预设 / 深浅色 / 取色预览 | `themeVariablesAndOverrides`、`darkThemeOverrides`、`themeEditorAndPreview` |
| H 状态修饰 | `is-active`、`is-danger`、`bvh-resizing`、`bvh-dragging` | `panelDragAndResize` 及各片段内联状态规则 |
| I 字号 | `--bvh-ui-font-size`、`--bvh-setting-font-size` | `settingsLayoutOverrides`、各片段 |

---

## 片段 → 创建者对照

改样式前先确认"这段 HTML 是谁产出的"，否则容易改了规则却找不到元素。

| 片段 | 族 | 规则数 | 由谁创建 |
|---|---|---:|---|
| `cardBadges` | E | 3 | M22 `startCardBadgeRenderer` |
| `playbackFloat` | A | 2 | M29 `PlaybackUI.render`（`#bvh-status-float`） |
| `playbackMenu` | A/F | 6 | M29 `PlaybackUI.render`（菜单面板） |
| `settingsBase` | A | 21 | M34 `createSettingsWindow` |
| `settingsLayoutOverrides` | A/B | 21 | M34 `refreshSettingsWindow`（放大版排版） |
| `historyPanelAndSearch` | A/D | 10 | M29 `PlaybackUI.render`（历史面板与搜索） |
| `recordMenusAndDialogs` | F | 11 | M18 `HistoryListRenderer._bindRecordContextMenu` |
| `historyRecordsAndGroups` | D | 38 | M18 `_renderRecordGroup` / `_renderRecordItem` / `_renderSnapItem` |
| `historyPagePanel` | A | 1 | M30 `HistoryPageUI.init` |
| `panelDragAndResize` | H | 5 | M24 `setupPersistentResize` + M23 `makeDraggable` |
| `historyPageControls` | D | 2 | M30 `HistoryPageUI.init` |
| `themeVariablesAndOverrides` | G | 57 | 全局（M26 自身 + 各界面共用） |
| `darkThemeOverrides` | G | 35 | 全局（黑金预设） |
| `themeEditorAndPreview` | G | 24 | M34 `refreshSettingsWindow` 的配色区 |

---

## 命名与注释约定

- 模块头固定三行：`// 【模块 Mxx · 层：名称】` + 职责 + 边界（不该做什么）。
- CSS 片段头固定一行：`/* [族 X · 名称] 用途；由谁生成。 */`。
- 片段内按子块加 `/* ── 子块 ── */`，不再逐条注释。
- 类名统一 `.bvh-<组件>-<元素>-<状态>`；片段键用 `<组件><Aspect>` 英文驼峰。
- 存储层四个对象各带 `// ── 子模块 Sn · 名称 ──` 标记，便于在 2000 行模块里定位。

---

## 改动守则

1. **CSS 片段顺序就是层叠顺序**。不要移动规则、不要把同一条规则复制到两个片段；现有重复声明是有意的覆盖层，合并需要逐段视觉核对。
2. 新增界面元素：先在该组件对应片段末尾加规则，再回头更新片段头里的"由谁生成"。
3. 新增模块：banner 顺延编号插到合适位置即可，编号与执行顺序无关。
4. 只做注释 / 缩进这类零逻辑改动时，用下面的方式自证。
5. 新增用户可见行为时，照仓库惯例在头部 changelog 补一行并提版本号。

---

## 校验方法

```powershell
node --check src/bilibili-history/bilibili-history.user.js
node --test src/bilibili-history/tests/history-import.test.cjs src/bilibili-history/tests/flat-collection-import.test.cjs
git diff --ignore-all-space -U0 | Select-String '^-[^-]'     # 应只剩注释行
```

最后一条用于确认"被删掉的只有注释"：忽略空白后，任何非注释的删除行都说明动了逻辑。

---

## 已知待办（本次未处理）

- 80 处重复选择器声明（占 298 个选择器的 27%），来源是"基础层 + 覆盖层"两遍写法，合并需逐段截图核对。
- `refreshSettingsWindow` 约 460 行单函数，内含主题同步、滑轨绘制、刻度节点、tooltip、冷库扫描等闭包，可拆成 5–6 个命名函数。
- `settingsBase` 里的冷库块与开关行目前仍混在表单片段内，后续可独立成片段。
