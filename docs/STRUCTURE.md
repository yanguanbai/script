# 代码结构说明

以 `src/bilibili-history/bilibili-history.user.js` 为主体。结构用两个轴描述：**功能层**（按数据流，M 编号）和**样式族**（按相似视觉语言，A–I）。

编号只用于检索，不代表执行顺序；执行顺序只看文件位置。

---

## 轴一：功能层（M01–M37）

| 编号 | 层 | 职责 | 关键对象 / 函数 |
|---|---|---|---|
| M01–M03 | 常量层 | 内部键名与协议、运行参数、CSV 字段 | `RECORD_CHANGE_EVENT`、`CONFIG`、`CSV_COLUMNS` |
| M04–M05 | 工具层 | 时间换算与格式化、油猴存储用量 | `TimeTool`、`ByteTool` |
| M05b | 诊断层 | 错误码表与运行日志 | `ERR`、`ErrorLog`、`reportError` |
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
| J 忙碌遮罩 | `.bvh-settings-busy`、`.bvh-settings-spinner` | `settingsBase`（`createSettingsWindow` 末尾）+ `SettingsOperations.sync` 控制显隐 |

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

## 备份确认协议（5.10.21 起）

导出的唯一目的是"删之前先有一份外部副本"，所以**保存是否真的完成**决定了能不能删。协议拆三段，不许合并：

| 阶段 | 函数 | 是否写存储 | 说明 |
|---|---|---|---|
| 构建 | `prepareFullBackup(scope)` | 否 | 只生成 payload / 文件名 / 体积，放在 `StorageApi._pendingBackup` |
| 保存 | `saveBackupVerified(prep, handle, opts)` | 否 | 按能力逐档降级，见下表 |
| 登记 | `confirmBackup(prep, method)` | 是 | 只有成功或用户明确确认后，才写 `EXPORTED_RECORDS_KEY` 与 `BACKUP_CONFIRM_KEY` |

保存档位（`saveBackupVerified` 从强到弱）：

| 档 | 判定依据 | 结果 | 备注 |
|---|---|---|---|
| `picker` | `createWritable` + `close()` 完整返回 | `ok`，自动登记 | 需要点击手势；调用方应先 `requestBackupHandle`；沙箱里必须用真实窗口调用（`_nativeSaveFilePicker` / `_openSavePicker`），否则报 Illegal invocation |
| `gm_download` | `GM_download` 的 `onload` 回调 | `ok`，自动登记 | 需要 `@grant GM_download`；首次使用浏览器会问"允许下载" |
| `download` | 只有 `a.click()`，拿不到任何结果 | `pending` + E2004 | 必须由用户点"我已确认文件已保存" |

`opts.pickerTried=true` 表示调用方已弹过保存对话框，避免重复弹第二个。
`GM_download` 走 `data:` URL（不用 `blob:`，内置下载器解析 blob 不稳定）；90 秒内既无 `onload` 也无 `onerror` 则以 E2007 收口，避免设置页永久卡在忙碌状态。

三条不变量：

1. **`prepare` 绝不写 `EXPORTED_RECORDS_KEY`**。下载、取消、失败都不会让记录变成"可清理"。
2. **登记前逐键比对当前值**。`prepare` 到 `confirm` 之间被改过的记录从标记中剔除，避免新值被误标为已备份。
3. **`cleanExpireRecords` 只认已确认备份**。范围导出后，范围外的过期记录会保留，并在确认文案里给出数量。

待确认状态下只有三个按钮，含义必须固定，不要合并：

| 按钮 | 实际动作 | 何时使用 |
|---|---|---|
| 用系统对话框另存（成功后自动登记） | 重新 `showSaveFilePicker` → 写入 → `close()` → 自动 `confirmBackup` | 第一次导出被浏览器拦下、或降级成了普通下载 |
| 我已在下载列表确认过文件 | 只调 `confirmBackup(prep, 'download')`，不写盘 | 普通下载已落盘，由用户背书 |
| 取消这次备份 | 清 `_pendingBackup`，不登记 | 放弃这份内容 |

环境里没有可用保存对话框时，“另存”按钮置 `disabled` 并写清原因——否则它会再降级一次下载，凭空多出一份文件。

`migrateToContainerStructure` 不再隐式导出，改为前置条件 `hasConfirmedBackup()`；未确认直接中止（E2004）。

范围参数只作用于最终合并集，payload 的 `format`/`version` 不变，`importRecords` 无需改动：

```
scope = { kind: 'all' | 'video' | 'bangumi' | 'live' | 'collection' | 'gm', since, until }
```

`kind='gm'` 只取仍在油猴存储里的记录（`GM_getValue(key)` 存在），冷库里的记录不导出、也不会因这份备份被放行为可清理。

CSV 有两条出口，共用 `_exportCSV(entries, label, fileSuffix)`：

| 入口 | 数据来源 | 用途 |
|---|---|---|
| `exportCSVRecords()`（导出热层 CSV） | `GM_listValues()` + `GM_getValue`，主存模式下即当前库 | 快速核对热层 |
| `exportAllCSVRecords()`（导出全部 CSV） | `StorageRouter.readAllRecordsForBackup()`，与完整备份同源 | 已归档记录也一起看 |

两者都只读，不写 `EXPORTED_RECORDS_KEY`，因此不会放行清理。

---

## 错误码

`ERR` 按域分段，新增错误先登记再用；所有面向用户的失败走 `reportError(code, detail, {where})`：

| 段 | 范围 | 典型码 |
|---|---|---|
| E1xxx | 导入 | E1001 非 JSON、E1002 顶层非对象、E1101 字段无法识别、E1201 合集身份冲突、E1202 回读不一致 |
| E2xxx | 备份导出 | E2001 非历史页、E2002 主存库不可用、E2003 用户取消、E2004 保存未确认、E2006 生成失败 |
| E3xxx | 存储 | E3002 写入校验失败、E3003 冷库失联、E3004 版本不兼容 |
| E4xxx | 冷库归档 | E4001 冷库导入失败、E4002 归档中断、E4003 移除旧库登记失败 |
| E5xxx | 维护工具 | E5001 迁移未完成、E5002 归并失败、E5003 身份修复失败 |

日志写 `bvh_error_log_v1`，环形保留 50 条，且被 `ByteTool.calcStorageSize` 排除在容量统计之外。
设置页"运行日志"组按错误码归类显示（`E1201 ×2`），并支持一键复制。

---

## 设置页分组（M34）

顺序即用户看到的上到下：**常用个性化在前，调试与破坏性操作在后。**

| 组 | id | 内容 |
|---|---|---|
| 界面配色 | `bvh-group-theme` | 字号、预设主题、高级取色、对比度修正 |
| 观看去重 | `bvh-group-dedup` | 判定方式、时间差上限、进度差上限 |
| 记录与保留 | `bvh-group-retain` | 过期天数、同步页数、快照条数、来源配额、短观看阈值 / 保留天数 |
| 冷库与存储 | `bvh-group-cold` | 归档年龄 / 周期 / 开关、无结果查冷库、删空白库、立即归档、冷库清单、导入到冷库 |
| 数据导入导出 | `bvh-group-transfer` | 导出完整备份（含范围与时间筛选）、导出热层 CSV、导出全部 CSV、导入到当前存储、同步官方历史、备份确认闸门 |
| 维护工具 | `bvh-group-maint` | 重置次数、归并单集、修复身份、迁移到合集容器、清理过期、清理短观看、清空全部 |
| 运行日志 | `bvh-group-log` | 错误码归类、复制全部、清空日志 |

新增按钮统一放在 `bvh-cold-management` 容器里，复用现有按钮样式与忙碌锁；
每个按钮下方必须有一行常驻说明（做什么 / 影响什么 / 能否撤销），不依赖 `title` 悬浮提示。

### DB 主存模式下的置灰规则

`StorageRouter.isPrimaryMode()` 为真（归档年龄 = 0、已迁移）时，以下控件由 `SettingsOperations.sync` 统一停用：

| 控件 | 原因 |
|---|---|
| 归档年龄 / 归档周期 | 主存模式固定 0，不再从热层归档 |
| 自动归档（`data-cold-auto`） | 没有热层可归档 |
| 立即归档（`data-cold-archive`） | `archiveNow` 会直接报错 |
| 无结果自动查冷库（`data-cold-search-auto`） | 当前库就是冷库，记录已在 IndexedDB 里 |
| 导出范围的“只导出油猴存储”（`option[value="gm"]`） | 油猴里已无记录，等价于全量；选中时自动回退到“全部记录” |

冷库清单、导入 JSON 到冷库、删除空白冷库、导出、CSV、导入、清理、重置、归并、修复、迁移、清空**仍然可用**——`GM_*` 在文件顶部统一改写成 `StorageRouter` 调用，主存模式下走 DB。

置灰同时给 `title` 写明原因，并在冷库组顶部显示一条 `bvh-primary-note` 说明，避免“看着能点其实不生效”。

### 长任务的忙碌状态

`SettingsOperations.run(overlay, name, action)` 是设置页所有耗时操作的唯一入口：

1. 首个动作同步写 `overlay._bvhTask = name`，第二个点击进来直接 `return`（重入锁）；
2. `sync` 打开 `.bvh-settings-busy` 遮罩（转圈 + `BUSY_TEXT[name]` 文案），并把全部 `button/input/select/textarea` 置 `disabled`，在 `finally` 之前不可能重复触发；
3. `finally` 清空任务名并再 `sync` 一次，遮罩收起、控件按 primary 规则重新算出状态。

新增任务名时必须在 `BUSY_TEXT` 里补一条中文说明，否则遮罩会显示兜底文案。
冷库扫描（`_bvhScanning`）只锁它自己的刷新按钮，不弹遮罩，避免每次开窗闪一下。

设置页之外：`StorageApi.exportAllRecords` 另有 `_exportingBackup` 重入锁，历史页连点也只生成一份文件。

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
node --test src/bilibili-history/tests/history-import.test.cjs `
  src/bilibili-history/tests/flat-collection-import.test.cjs `
  src/bilibili-history/tests/backup-gate.test.cjs
node tools/sync-readme-versions.mjs --check
git diff --ignore-all-space -U0 | Select-String '^-[^-]'     # 结构类改动应只剩注释行
```

最后一条用于确认"被删掉的只有注释"：忽略空白后，任何非注释的删除行都说明动了逻辑。

---

## 已知待办（本次未处理）

- 80 处重复选择器声明（占 298 个选择器的 27%），来源是"基础层 + 覆盖层"两遍写法，合并需逐段截图核对。
- `refreshSettingsWindow` 约 700 行单函数（含新增的导入导出、维护工具、日志三块闭包），可拆成 5–6 个命名函数。
- 普通下载档（`<a download>`）无法确认保存，只能靠用户在设置页点"我已确认文件已保存"。
  已提供 `GM_download` 档做真检测；若管理器不支持，仍会落到这一档。
- 启动自动修复 `repairAndCleanLocalRecords` 仍然在写回前不做备份，只在 GM 模式生效。
