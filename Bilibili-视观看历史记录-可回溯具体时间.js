// ==UserScript==
// @name         Bilibili 视频观看历史记录 可回溯具体时间
// @namespace    Bilibili-video-History-Pro
// @version      5.7.12
// @description  播放页搜索窗口拖拽逻辑与历史页统一；保留既有功能。
// @author       Bart
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://live.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://www.bilibili.com/history
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-end
// @icon         https://www.bilibili.com/favicon.ico
// @license MIT
// ==/UserScript==
// 5.7.8：基于5.7.3修复播放页悬浮窗初始化被分集历史读取异常阻断的问题；不改电视剧/番剧存储结构。
// 5.7.9：系列元数据必须命中当前季；移除错误兜底系列，防止无关季被归入番剧系列；安全拆分未获当前系列确认的旧季归属。
// 5.7.10：修复 ep 路由切换时沿用旧 active 集节点/前缀相似链接导致分集身份串写；播放页改为精确只读 ep 记录，禁止 UI 读取按 p 回填；timeupdate 只采样播放位置、不反复重读 DOM；番剧无明确季名时不补造季名。
// 5.7.11：只对电视剧恢复季分组兜底；优先使用明确季名与系列 season 列表顺序，普通番剧仍不自动显示“第1季”。
// 5.7.12：修复索引展开时把电视剧“第N季”兜底标题也过滤掉的问题；仅番剧隐藏自动生成的季名，电视剧保留 UI 分季标题。
// 5.7.3：电视剧/番剧按明确的 series.series_id 跨季归组；季度名称保存在分集的小合集字段，旧 ss 容器兼容升级，不新增空字段。
(function () {
    'use strict';

    // 功能总览（以下注释描述现有职责，不代表新增或改变功能）：
    // 1. 记录采集：普通视频/番剧播放页、直播页分别采集；官方历史同步作为另一数据来源。
    // 2. 记录身份：RecordKey 统一解析 BV、分P、合集、ss/ep 与 live 身份，减少读写入口不一致。
    // 3. 原始存储：RecordStore 负责原始记录的增删改、容器/分集归并和跨标签页变更通知。
    // 4. 派生索引：HistoryViewIndex 服务排序、搜索与最近快照首屏；缓存可重建，不替代原始记录。
    // 5. 兼容维护：LegacyMigration、RecordNormalizer、StorageApi 处理旧格式、导入导出、修复与清理。
    // 6. 查询展示：SearchQuery 解析筛选条件，HistoryListRenderer 统一渲染分组/分集/快照列表。
    // 7. 页面 UI：CardDom 识别卡片；PlaybackUI 显示播放页悬浮窗；HistoryPageUI 显示历史记录面板。
    // 8. 交互与设置：拖动/停靠模块处理悬浮窗位置；菜单模块保存用户可调参数。
    //
    // ============================================================================
    // 本地观看记录统一为"容器"结构：
    //   - 同 BV 多P：容器 key = BV 号（无 ?p），分集在 parts[] 里按 p 区分；
    //   - 跨 BV 合集：容器 key = 合集标题（规范化），parts[] 存各分集；
    //   - 单个视频（无合集）：仍按 BV 单独一条，不进容器；
    //   - 番剧/电视剧仅以 ss 作为整季容器，ep 只作为 parts[] 中的分集身份，禁止创建 ep-key 的合集容器；
    //   - 普通合集分集保留完整 BV 身份，同 BV 多P 使用 BV?p=N；直播 live 保持现状。
    // 旧版本扁平分P记录（BV?p=N）由"迁移"入口一次性归并进容器。
    // HistoryViewIndex 提供排序与搜索；最近快照使用独立小缓存优先显示。
    // ============================================================================

    // 【模块：记录变更通知与索引标识】
    // 页面内的列表、播放悬浮窗和存储层需要共享同一份记录状态。这里定义内部变更事件、
    // 跨脚本管理器标签页广播用的信号键，以及各类索引、设置和缓存的持久化键名。
    // 这些键名属于存储协议的一部分；修改它们会影响旧数据读取或跨页面同步，因此这里只作说明，不改键值。
    const RECORD_CHANGE_EVENT = 'bvh-record-storage-changed';
    const RECORD_CHANGE_SIGNAL_KEY = 'bvh_internal_record_change_signal_v1';

    const HISTORY_VIEW_INDEX_KEY = 'bvh_history_view_index_v1';
    // 一次性本地数据修复标记：清除旧版本遗留的空观看记录，避免每次启动重复迁移。
    const LOCAL_DATA_REPAIR_VERSION_KEY = 'bvh_local_data_repair_version_v1';
    // 独立保存少量最近快照，避免首次打开面板时为了显示顶部 N 条而先读取整个大索引。
    const RECENT_SNAPSHOT_CACHE_KEY = 'bvh_recent_snapshot_cache_v1';
    // 最近快照按来源配额选取，并用全局时间顺序补足空缺；同一观看的跨来源快照按时间窗口去重。
    //      两轮取数，面板 N 个名额里 player 至少占 ceil(N*quota)；(b) source 缺失/非法的快照判为
    const HISTORY_VIEW_INDEX_VERSION = 14;

    const EXPIRE_SETTINGS_KEY = 'bvh_expire_settings_v1';
    const EXPORTED_RECORDS_KEY = 'bvh_exported_record_keys_v1';
    const SHORT_WATCH_SETTINGS_KEY = 'bvh_short_watch_settings_v1';
    const HISTORY_SYNC_SETTINGS_KEY = 'bvh_history_sync_settings_v1';
    const RECENT_SNAPSHOT_SETTINGS_KEY = 'bvh_recent_snapshot_settings_v1';
    const RECENT_SNAPSHOT_QUOTA_SETTINGS_KEY = 'bvh_recent_snapshot_quota_settings_v1';
    const CONTINUOUS_GAP_SETTINGS_KEY = 'bvh_continuous_gap_settings_v1';

    // 【模块：统一运行参数】
    // 集中管理记录过期、最近快照数量与来源配额、存储容量、采集间隔、搜索防抖、
    // 官方历史同步页数、短观看过滤和连续观看合并阈值。设置菜单会按对应配置项读写参数。
    // 配额、缓存上限和时间阈值之间存在配套关系，调整时应同时检查相关注释及使用位置。
    const CONFIG = {
        EXPIRE_DAY: 90,
        EXPIRE_MS: 90 * 24 * 3600 * 1000,
        MAX_RECORD_COUNT: 5,
        RECENT_SNAPSHOT_COUNT: 5,
        // 最近快照热池的池容量 = N，不是写死的值。N 就是 RECENT_SNAPSHOT_COUNT，
        // 也就是面板"最近N次快照"的设置值：每个来源桶各留最近 N 条，两桶合计 2N 条候选，
        // 面板只归并显示其中最新的 N 条。RECENT_SNAPSHOT_MAX = 50 是 N 的上限，不是池容量。
        // 池容量 = 2N，与全量记录条数无关，因此排序/合并耗时是常数级，不会随历史增长而卡顿。
        RECENT_SNAPSHOT_MAX: 50,
        // 最近快照来源配额：面板显示的 N 条里，player（播放页/直播页自动获取）
        // 至少占 ceil(N * RECENT_SNAPSHOT_PLAYER_QUOTA) 个名额，official 占其余名额；
        // 任一来源候选不足时，空出的名额在第二轮按时间全局补满。
        //   0.5 = 两来源平分；0 = 只显示 official；1 = 只显示 player。
        // 引入原因：纯时间归并下，一次官方历史翻页（一页可达 20 条、时间戳跨 2 小时）
        // 就能把 official 桶整桶刷成同一片时间窗，面板 N 个名额被单一来源占满，
        // "2N 候选"买到的只是候选数翻倍、不是覆盖面翻倍。
        RECENT_SNAPSHOT_PLAYER_QUOTA: 0.5,
        RECENT_SNAPSHOT_QUOTA_MIN: 0,
        RECENT_SNAPSHOT_QUOTA_MAX: 1,
        // 同一次观看的时间容差：官方历史只给到分钟精度（ts 落在整分钟），播放页是秒级，
        // 同一次观看跨桶最大可能相差 59 秒，故按 60 秒窗口判同一观看。
        RECENT_SNAPSHOT_DEDUP_WINDOW_MS: 60 * 1000,
        STORAGE_MAX_BYTE: 5 * 1024 * 1024,
        STORAGE_WARN_THRESHOLD: 4.5 * 1024 * 1024,
        RECORD_INTERVAL: 5000,
        SEARCH_DEBOUNCE: 300,
        SHORT_WATCH_EXPIRE_DAY: 30,
        SHORT_WATCH_MAX_POS_SEC: 10,
        AUTO_SYNC_DEBOUNCE: 1200,
        HISTORY_SYNC_PAGES: 10,
        // 连续观看判定：官方历史卡片在该间隔内持续更新、且进度向前推进时，
        // 视为"挂着持续播放的同一次观看"，不累加次数（详见 _isContinuousView）
        CONTINUOUS_GAP_MIN: 30,
    };

    // 【模块：CSV 导入/导出字段定义】
    // 将内部记录字段映射为稳定的 CSV 列名与中文表头，供导出文件和导入解析共用。
    // 该列表是文件交换格式的一部分；字段名需要与导入、导出代码保持一致。
    const CSV_COLUMNS = [
        ['bv_key', '视频BV号'],
        ['title', '视频标题'],
        ['author_name', '作者名字'],
        ['media_type', '内容类型'],
        ['media_tags', '卡片标签'],
        ['media_subtitle', '分集/副标题'],
        ['collection_title', '合集标题'],
        ['small_collection_title', '小合集标题'],
        ['collection_key', '合集标识'],
        ['part_number', '分集序号'],
        ['part_total', '分集总数'],
        ['is_expired', '是否失效'],
        ['last_ts', '最后播放时间'],
        ['last_progress', '最后播放进度'],
        ['watch_count', '观看次数'],
        ['has_reached_watch_threshold', '是否达到观看阈值'],
        ['snapshot_ts', '快照时间'],
        ['snapshot_pos', '快照播放位置'],
        ['snapshot_progress', '快照进度'],
        ['snapshot_watch_time', '快照观看时长说明'],
        ['snapshot_completed', '快照是否看完'],
        ['snapshot_author', '快照作者'],
        ['file_format', '文件格式'],
        ['file_version', '文件版本'],
        ['exported_at', '导出时间'],
    ];

    // ── 时间工具：时间戳格式化 + 把 B 站相对时间文本解析成时间戳 ──
    // 【模块：时间解析与格式化】
    // 统一处理本地时间显示、B 站官方历史卡片的相对日期文本，以及跨来源快照使用的时间值。
    // 官方页面可能显示“今天/昨天/前天”、月日或完整年月日等不同格式；无法可靠解析时保留无效标记，
    // 避免把无法识别的文本静默当成有效观看时间。
    const TimeTool = {
        now: () => Date.now(),
        // 把时间戳格式化为本地日期和时间，非法时间返回空字符串。
        formatTimestamp(ts) {
            const d = new Date(ts);
            if (!Number.isFinite(d.getTime())) return '';
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        },
        // 解析 B 站历史卡片上的相对时间或日期文本，返回时间戳及有效性标记。
        parseWatchTime(text, nowTs = Date.now()) {
            if (!text) return { ts: 0, text: '', valid: false };
            const raw = String(text).trim().replace(/\s+/g, ' ');
            const now = new Date(nowTs);
            let m;
            let d = new Date(nowTs);

            if ((m = raw.match(/^(今天|昨日|昨天|前天)\s*(\d{1,2}):(\d{1,2})$/))) {
                if (Number(m[2]) > 23 || Number(m[3]) > 59) return { ts: 0, text: raw, valid: false };
                const dayOffset = m[1] === '前天' ? 2 : (m[1] === '昨天' || m[1] === '昨日' ? 1 : 0);
                d.setDate(d.getDate() - dayOffset);
                d.setHours(Number(m[2]), Number(m[3]), 0, 0);
                return { ts: d.getTime(), text: raw, valid: Number.isFinite(d.getTime()) };
            }

            if ((m = raw.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/))) {
                if (Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) < 1 || Number(m[2]) > 31 || Number(m[3]) > 23 || Number(m[4]) > 59) {
                    return { ts: 0, text: raw, valid: false };
                }
                d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), 0, 0);
                if (d.getMonth() !== Number(m[1]) - 1 || d.getDate() !== Number(m[2])) return { ts: 0, text: raw, valid: false };
                if (d.getTime() > nowTs) d.setFullYear(d.getFullYear() - 1);
                return { ts: d.getTime(), text: raw, valid: Number.isFinite(d.getTime()) };
            }

            if ((m = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?\s*(\d{1,2}):(\d{1,2})$/))) {
                if (Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31 || Number(m[4]) > 23 || Number(m[5]) > 59) {
                    return { ts: 0, text: raw, valid: false };
                }
                d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
                const valid = Number.isFinite(d.getTime())
                && d.getFullYear() === Number(m[1])
                && d.getMonth() === Number(m[2]) - 1
                && d.getDate() === Number(m[3]);
                return { ts: valid ? d.getTime() : 0, text: raw, valid };
            }

            return { ts: 0, text: raw, valid: false };
        }
    };

    // ── 存储体积工具：估算 GM 存储占用（结果缓存 1.5 秒，避免频繁全量序列化） ──
    // 【模块：油猴存储用量统计】
    // 汇总 GM 存储中的键和值，估算当前占用空间和记录条数，并提供界面展示所需的单位格式。
    // 统计结果带短时缓存，避免搜索、列表刷新等高频操作反复序列化全部数据。
    const ByteTool = {
        _cache: { ts: 0, size: 0, recordCount: 0 },
        // 按字节、KB、MB 选择合适单位，供存储信息展示。
        format(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        },
        // 遍历油猴存储并估算占用体积；短时间内复用缓存，避免重复序列化。
        calcStorageSize() {
            const now = Date.now();
            if (now - this._cache.ts < 15000) return this._cache.size;
            const keys = GM_listValues();
            let totalStr = '';
            let recordCount = 0;
            keys.forEach(k => {
                totalStr += k + JSON.stringify(GM_getValue(k));
                if (RecordKey.isRecordKey(k)) recordCount++;
            });
            this._cache = { ts: now, size: new Blob([totalStr]).size, recordCount };
            return this._cache.size;
        },
        // 汇总当前已用空间和剩余空间，并提供格式化后的显示值。
        getStorageInfo() {
            const used = this.calcStorageSize();
            return {
                used,
                free: Math.max(0, CONFIG.STORAGE_MAX_BYTE - used),
                usedStr: this.format(used),
                freeStr: this.format(Math.max(0, CONFIG.STORAGE_MAX_BYTE - used)),
                recordCount: this._cache.recordCount
            };
        }
    };

    // 合并短时间内连续触发的调用，只在最后一次触发后等待指定时间执行。
    function debounce(fn, delay) {
        let t = null;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    // 把耗时工作尽量安排在浏览器空闲时执行，避免阻塞页面交互。
    function runWhenIdle(callback, timeout = 1200) {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(callback, { timeout });
        } else {
            setTimeout(() => callback({ timeRemaining: () => 0, didTimeout: true }), 80);
        }
    }

    // 返回高精度计时值；不支持 performance.now() 时退回普通时间戳。
    function nowHighRes() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    // ── 分钟级去重工具（跨来源重复判断的统一入口） ──
    // 官方历史卡片只显示 HH:mm（没有秒），播放页快照精确到秒，
    // 直接比 ts 永远对不上；压到"分钟"后，同一次观看产生的多条快照
    //（播放页轮询、官方卡片、ep→ss 合并）才能对上号。
    // 注意粒度就是"分钟"：同一分钟内进度差很多是正常现象
    //（5 秒轮询连续记录、拖动进度条、官方卡片实时刷新），
    // 所以快照去重只认分钟、不认进度；跨分钟的情况由
    // OfficialHistorySync._isContinuousView 再判是否"连续播放"。
    function minuteKeyOf(ts) {
        const n = Number(ts);
        return Number.isFinite(n) && n > 0 ? Math.floor(n / 60000) : '';
    }

    // 进度归一化：把 "45%"/"45.0%"/"45.00%" 都归到 45，用来判断"是不是同一个进度"。
    function normalizeProgressValue(value) {
        const raw = String(value == null ? '' : value).trim();
        const match = raw.match(/-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : raw;
    }

    // ── 记录键工具：识别视频/番剧/直播及合集容器的存储键 ──
    // 5.3.0 容器结构：同BV多P容器 key=BV号；跨BV合集容器 key=合集标题；单视频=BV；番剧=ss/ep；直播=live。
    // 【模块：记录键识别与规范化】
    // 负责识别普通 BV、BV 分 P、番剧季 ss、番剧集 ep、直播 live 等身份形式，
    // 并提供容器键转换、分组键计算、URL 解析和播放链接构建。
    // 这里决定“某条记录属于哪个视频/分集/整季”，是存储、同步、迁移和悬浮窗读取共同依赖的身份规则。
    const RecordKey = {
        // 判断是否为脚本管理的记录存储键：非空、且不以 bvh_ 开头（设置项/索引/信号都带 bvh_ 前缀）。
        // 跨BV合集容器以标题为键，无法用格式正则判定，故用排除法识别。
        isRecordKey(key) {
            return typeof key === 'string' && key.trim() !== '' && !key.startsWith('bvh_');
        },
        // 判断是否为旧格式分 P 视频键（BV?p=N，迁移前存在，新写入归入容器）。
        isPartKey(key) {
            return typeof key === 'string' && /^BV[a-zA-Z0-9]+\?p=\d+$/i.test(key);
        },
        // 判断是否为纯 BV 键（无 ?p），可能是同BV容器或单视频，靠 value.type 区分。
        isPlainBvKey(key) {
            return typeof key === 'string' && /^BV[a-zA-Z0-9]+$/i.test(key);
        },
        // 把分P/单视频/番剧/直播/标题容器键归一到"容器存储键"：
        // 同BV多P（BV?p=N）→ BV号（容器）；单视频BV不变；番剧/直播不变；跨BV标题容器原样。
        toContainerKey(key) {
            const s = String(key == null ? '' : key).trim();
            const v = s.match(/^(BV[a-zA-Z0-9]+)(?:\?p=\d+)?$/i);
            if (v) return v[1];
            const bg = s.match(/^(ss|ep)(\d+)$/i);
            if (bg) return `${bg[1].toLowerCase()}${bg[2]}`;
            const live = s.match(/^live(\d+)$/i);
            if (live) return `live${live[1]}`;
            return s;
        },
        // 判断是否为番剧容器键（整季ss或单集ep）。
        isBangumiKey(key) { return /^(?:ss|ep)\d+$/i.test(key); },
        // 判断记录键是否为番剧单集 ep 格式。
        isEpisodeKey(key) { return /^ep\d+$/i.test(key); },
        // 判断记录键是否为番剧整季 ss 格式。
        isSeasonKey(key) { return /^ss\d+$/i.test(key); },
        // 判断记录键是否为直播间格式。
        isLiveKey(key) { return /^live\d+$/i.test(key); },
        // 把分 P 视频、番剧、直播或标题容器映射到用于归组的统一键。
        getGroupKey(key) {
            if (typeof key !== 'string') return null;
            const videoMatch = key.match(/^(BV[a-zA-Z0-9]+)/);
            if (videoMatch) return videoMatch[1];
            const bangumiMatch = key.match(/^(ss|ep)(\d+)$/i);
            if (bangumiMatch) return `${bangumiMatch[1].toLowerCase()}${bangumiMatch[2]}`;
            const liveMatch = key.match(/^live(\d+)$/i);
            if (liveMatch) return `live${liveMatch[1]}`;
            // 跨BV标题容器：本身自成一组。
            return key;
        },
        // 将搜索框内容拆成普通关键词和结构化条件。
        parse(url) {
            const raw = String(url || '');
            const bv = raw.match(/BV[a-zA-Z0-9]+/);
            if (bv) {
                const pMatch = raw.match(/[?&]p=(\d+)/);
                const p = pMatch ? pMatch[1] : '1';
                return {
                    type: 'video',
                    key: bv[0] + (Number(p) > 1 ? `?p=${p}` : ''),
                    bvid: bv[0],
                    p
                };
            }
            const bg = raw.match(/\/bangumi\/play\/(ss|ep)(\d+)/i);
            if (bg) {
                const key = `${bg[1].toLowerCase()}${bg[2]}`;
                return {
                    type: 'bangumi',
                    key,
                    bvid: key,
                    p: '1',
                    isBangumi: true,
                    isEpisode: /^ep/i.test(key),
                    isSeason: /^ss/i.test(key)
                };
            }
            const live = raw.match(/live\.bilibili\.com\/(\d+)/) || raw.match(/\/live\/(\d+)/);
            if (live) {
                const key = `live${live[1]}`;
                return { type: 'live', key, bvid: key, p: '1', isLive: true };
            }
            return null;
        },
        // 根据记录键生成对应的视频、番剧或直播地址。
        buildUrl(key) {
            const value = String(key || '');
            if (this.isBangumiKey(value)) return `https://www.bilibili.com/bangumi/play/${value}`;
            if (this.isLiveKey(value)) return `https://live.bilibili.com/${value.slice(4)}`;
            const bv = value.match(/BV[a-zA-Z0-9]+/);
            return bv ? `https://www.bilibili.com/video/${value}` : '';
        }
    };

    // ── 页面数据：在 __INITIAL_STATE__ 等全局对象里深度搜索 seasonId（限深防循环） ──
    // 【模块：从当前播放页解析番剧身份】
    // 结合页面 URL、页面数据和可用的 DOM 信息，尽可能确定番剧季 ID、媒体 ID 与内容类型。
    // 页面结构会随 B 站版本变化；无法取得某项信息时应允许后续逻辑使用已有记录或其他识别路径。
    const PageData = {
        // 从 B 站页面初始化数据中有限深度地查找 seasonId，避免循环引用导致递归失控。
        resolveBangumiSeasonId() {
            try {
                const bangumiMatch = location.pathname.match(/\/bangumi\/play\/(ss|ep)(\d+)/i);
                if (!bangumiMatch) return null;
                // ss 地址本身就是明确的整季身份，优先级高于页面中可能同时存在的其他季数据。
                if (/^ss$/i.test(bangumiMatch[1])) {
                    const urlSeasonId = Number(bangumiMatch[2]);
                    return Number.isSafeInteger(urlSeasonId) && urlSeasonId >= 1000 ? urlSeasonId : null;
                }

                const episodeKey = `ep${bangumiMatch[2]}`.toLowerCase();
                const episodeId = String(bangumiMatch[2]);
                // ep 页面优先读取包含当前 ep 链接的分区面板，不读取其他隐藏分区的季标签。
                const panels = Array.from(document.querySelectorAll('.SectionPanel_panel__rImmk'));
                // 路由刚切换时，active 标记可能还停留在上一集；只接受 href 中 ep ID 完全一致的面板。
                // 不用 href*=ep181 这样的前缀选择器，否则它也会匹配 ep1810。
                const panelHasCurrentEpisode = panel => Array.from(panel.querySelectorAll('a[href*="/bangumi/play/ep"]')).some(link => {
                    const match = String(link.getAttribute('href') || '').match(/\/bangumi\/play\/(ep\d+)/i);
                    return match && match[1].toLowerCase() === episodeKey;
                });
                const panel = panels.find(panelHasCurrentEpisode) || null;
                const panelSeasonId = Number(
                    panel?.querySelector('.SectionTabs_wrap__wxiTB[data-active-id]')?.getAttribute('data-active-id')
                    || panel?.querySelector('.SectionTabs_tab__gqNSD.SectionTabs_active__cms8S')?.getAttribute('data-item-id')
                    || panel?.querySelector('[data-active-id].SectionTabs_wrap__wxiTB')?.getAttribute('data-active-id')
                ) || 0;
                if (panelSeasonId >= 1000) return panelSeasonId;

                // 新版番剧页把 SSR 数据放在 __NEXT_DATA__；优先沿当前 ep 对应的数据节点向上找季信息。
                const roots = [];
                const nextDataNode = document.querySelector('script#__NEXT_DATA__[type="application/json"]');
                if (nextDataNode?.textContent) {
                    try { roots.push(JSON.parse(nextDataNode.textContent)); } catch (_) {}
                }
                for (const value of [window.__INITIAL_STATE__, window.__pinia, window.__BILI_SSR_DATA__]) {
                    if (value && !roots.includes(value)) roots.push(value);
                }

                const readSeasonId = value => {
                    const n = Number(value);
                    return Number.isSafeInteger(n) && n >= 1000 ? n : 0;
                };
                const directSeasonId = obj => {
                    if (!obj || typeof obj !== 'object') return 0;
                    for (const key of ['season_id', 'seasonId']) {
                        const id = readSeasonId(obj[key]);
                        if (id) return id;
                    }
                    for (const key of ['season_info', 'seasonInfo', 'ogv_season_info', 'ogvSeasonInfo', 'season']) {
                        const nested = obj[key];
                        if (nested && typeof nested === 'object') {
                            const id = directSeasonId(nested);
                            if (id) return id;
                        }
                    }
                    return 0;
                };
                const episodeFields = new Set(['ep_id', 'episode_id', 'epid', 'episodeId', 'epId']);
                const episodePaths = [];
                const visited = new Set();
                const walk = (obj, path, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 18 || visited.has(obj)) return;
                    visited.add(obj);
                    let matchesEpisode = false;
                    for (const [key, value] of Object.entries(obj)) {
                        if (episodeFields.has(key) && String(value) === episodeId) matchesEpisode = true;
                        if ((key === 'id' || key === 'ep') && String(value) === episodeId && /episode|ep|report|supplement/i.test(path.map(x => String(x)).join('.'))) matchesEpisode = true;
                    }
                    if (matchesEpisode) episodePaths.push(path.concat(obj));
                    for (const [key, value] of Object.entries(obj)) {
                        if (value && typeof value === 'object') walk(value, path.concat(obj, key), depth + 1);
                    }
                };
                for (const root of roots) walk(root, [], 0);

                for (const path of episodePaths) {
                    // 从当前 ep 数据节点向外逐层查找，优先取最近的 season_info/season_id。
                    for (let i = path.length - 1; i >= 0; i--) {
                        const node = path[i];
                        if (!node || typeof node !== 'object') continue;
                        const id = directSeasonId(node);
                        if (id) return id;
                    }
                }

                // 不再用“SSR 里恰好只有一个 seasonId”作为兜底：SPA 切集时全局数据可能仍是上一集，
                // 唯一 ID 也不等于当前 ep 的归属。没有当前 ep/当前面板的明确关联就返回 null，等待下一次实时读取。
                return null;
            } catch (_) {
                return null;
            }
        },
        // 读取电视剧/番剧的系列级身份。media_id 是单季媒体身份，不能用于跨季归组。
        // 只接受明确的 series.series_id / series.series_title；缺失时不猜测系列 ID。
        resolveBangumiSeriesInfo(seasonId = 0) {
            try {
                const roots = [];
                const nextDataNode = document.querySelector('script#__NEXT_DATA__[type="application/json"]');
                if (nextDataNode?.textContent) {
                    try { roots.push(JSON.parse(nextDataNode.textContent)); } catch (_) {}
                }
                for (const value of [window.__INITIAL_STATE__, window.__pinia, window.__BILI_SSR_DATA__]) {
                    if (value && !roots.includes(value)) roots.push(value);
                }
                const wantedSeasonId = Number(seasonId) || 0;
                // 没有当前季的可靠 ID 时，不能从页面任意一个 series 对象猜系列；
                // 否则可能把另一个系列的 seasons 列表写进当前季容器，制造不存在的季。
                if (!Number.isSafeInteger(wantedSeasonId) || wantedSeasonId <= 0) return null;
                const visited = new Set();
                const walk = (obj, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 20 || visited.has(obj)) return null;
                    visited.add(obj);
                    const series = obj.series;
                    if (series && typeof series === 'object') {
                        const id = String(series.series_id ?? series.seriesId ?? '').trim();
                        const title = String(series.series_title ?? series.seriesTitle ?? '').trim();
                        if (/^\d+$/.test(id) && Number(id) > 0 && title) {
                            const seasons = Array.isArray(obj.seasons) ? obj.seasons : [];
                            const matchingSeason = seasons.find(item => Number(item?.season_id ?? item?.seasonId) === wantedSeasonId);
                            const currentId = Number(obj.season_id ?? obj.seasonId) || 0;
                            const belongsToCurrentSeries = currentId === wantedSeasonId || !!matchingSeason;
                            if (belongsToCurrentSeries) {
                                return {
                                    seriesId: id,
                                    seriesTitle: title,
                                    seasonTitle: String(matchingSeason?.season_title || matchingSeason?.seasonTitle || matchingSeason?.title || (currentId === wantedSeasonId ? (obj.season_title || obj.seasonTitle || '') : '')).trim(),
                                    seasons: seasons.filter(item => Number(item?.season_id ?? item?.seasonId) > 0).map(item => ({
                                        seasonId: Number(item.season_id ?? item.seasonId) || 0,
                                        seasonTitle: String(item.season_title || item.seasonTitle || item.title || '').trim()
                                    })).filter(item => item.seasonId)
                                };
                            }
                        }
                    }
                    for (const value of Object.values(obj)) {
                        if (value && typeof value === 'object') {
                            const found = walk(value, depth + 1);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                for (const root of roots) {
                    const found = walk(root, 0);
                    if (found) return found;
                }
                // 不再返回 fallback：未证明当前季属于该 series 时，交由调用方按独立 ss 季处理。
                return null;
            } catch (_) { return null; }
        },
        // 兼容旧调用者；此值仅代表媒体 ID，不用于跨季度系列归组。
        resolveBangumiMediaId() {
            try {
                const visited = new Set();
                const search = (obj, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 9 || visited.has(obj)) return '';
                    visited.add(obj);
                    for (const k of Object.keys(obj)) {
                        if (/^(mediaId|media_id|mediaid)$/i.test(k)) {
                            const value = String(obj[k] == null ? '' : obj[k]).trim();
                            if (/^\d+$/.test(value) && Number(value) > 0) return value;
                        }
                    }
                    for (const k of Object.keys(obj)) {
                        const found = search(obj[k], depth + 1);
                        if (found) return found;
                    }
                    return '';
                };
                const roots = [];
                const nextDataNode = document.querySelector('script#__NEXT_DATA__[type="application/json"]');
                if (nextDataNode?.textContent) {
                    try { roots.push(JSON.parse(nextDataNode.textContent)); } catch (_) {}
                }
                for (const value of [window.__INITIAL_STATE__, window.__pinia, window.__BILI_SSR_DATA__]) {
                    if (value && !roots.includes(value)) roots.push(value);
                }
                for (const root of roots) {
                    const result = search(root, 0);
                    if (result) return result;
                }
                return '';
            } catch (_) { return ''; }
        },
        resolveBangumiMediaType() {
            const labels = [
                document.title,
                document.querySelector('.media-info, .media-detail, .media-info-title, .media-title, .season-title')?.textContent,
                document.querySelector('.media-info-tag, .media-tag, .media-info .tag')?.textContent
            ].filter(Boolean).map(value => String(value));
            // B站不同播放页版本把作品类型放在不同的初始化对象字段里；
            // 只读取类型相关字段，避免把简介、评论等任意文本误判成媒体类型。
            try {
                const visited = new Set();
                const collectTypeLabels = (obj, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 8 || visited.has(obj)) return;
                    visited.add(obj);
                    for (const [key, value] of Object.entries(obj)) {
                        if (typeof value === 'string' && /(?:mediaType|media_type|typeName|type_name|seasonTypeName|season_type_name|categoryName|category_name)$/i.test(key)) {
                            labels.push(value);
                        }
                    }
                    for (const value of Object.values(obj)) {
                        if (value && typeof value === 'object') collectTypeLabels(value, depth + 1);
                    }
                };
                const roots = [];
                const nextDataNode = document.querySelector('script#__NEXT_DATA__[type="application/json"]');
                if (nextDataNode?.textContent) {
                    try { roots.push(JSON.parse(nextDataNode.textContent)); } catch (_) {}
                }
                for (const value of [window.__INITIAL_STATE__, window.__pinia, window.__BILI_SSR_DATA__]) {
                    if (value && !roots.includes(value)) roots.push(value);
                }
                roots.forEach(root => collectTypeLabels(root, 0));
            } catch (_) {}
            const text = labels.join(' ');
            if (/电视剧|连续剧|TV剧/i.test(text)) return '电视剧';
            if (/纪录片/.test(text)) return '纪录片';
            if (/电影/.test(text)) return '电影';
            return '番剧';
        }
    };

    // ── 旧格式迁移：把 4.x 早期的数组格式 / 简单对象格式升级成当前快照结构 ──
    // 【模块：旧格式记录兼容】
    // 把旧版本可能使用的数组、普通对象等记录形态转换为当前记录处理流程可接受的数据。
    // 这是兼容入口，不负责决定最终容器归属；规范化后的数据仍需交给统一的记录规范化/迁移逻辑。
    const LegacyMigration = {
        // 把旧版本数组记录转换成当前记录对象，并尽可能保留旧快照。
        fromArray(oldArr) {
            if (!Array.isArray(oldArr)) return null;
            const [_status, _oldField, lastProgress, _lastTime, title, lastTs, oldHistoryList] = oldArr;
            const snapshots = [];
            if (Array.isArray(oldHistoryList)) {
                oldHistoryList.forEach(h => {
                    if (!Array.isArray(h)) return;
                    const [posSec, progressPct, watchTimeStr, ts] = h;
                    snapshots.push({
                        ts: ts ?? 0,
                        pos: posSec ?? null,
                        progress: progressPct ?? '0%',
                        watchTimeStr: watchTimeStr ?? null,
                        // 旧数组格式的历史列表本就来自官方历史页，迁移时明确标注来源，
                        // 避免迁移快照因缺 source 变成 unknown
                        source: 'official'
                    });
                });
            }
            return {
                title: title ?? null,
                lastTs: lastTs ?? 0,
                lastProgress: lastProgress ?? '0%',
                watchCount: snapshots.length,
                snapshots,
                hasReachedWatchThreshold: oldArr.hasReachedWatchThreshold === true
            };
        },
        // 把旧版简单对象转换成当前记录结构，补出基础快照和时间信息。
        fromPlainObject(oldObj) {
            if (!oldObj || typeof oldObj !== 'object' || Array.isArray(oldObj)) return null;
            const title = oldObj.title || null;
            const lastProgress = oldObj.progress ?? '0%';
            const watchTimeStr = oldObj.watchDate || '';
            const savedTs = Number(oldObj.lastTs);
            const parsed = watchTimeStr ? TimeTool.parseWatchTime(watchTimeStr) : { ts: 0, valid: false };
            const ts = Number.isFinite(savedTs) && savedTs > 0 ? savedTs : (parsed.valid ? parsed.ts : 0);
            return {
                title,
                lastTs: ts,
                lastProgress,
                watchCount: Number.isFinite(Number(oldObj.watchCount)) && Number(oldObj.watchCount) > 0
                ? Math.floor(Number(oldObj.watchCount)) : 1,
                snapshots: [{ ts, pos: null, progress: lastProgress, watchTimeStr, source: 'official' }],
                hasReachedWatchThreshold: oldObj.hasReachedWatchThreshold === true
            };
        },
        // 识别旧记录格式并执行对应迁移；当前格式则原样交给后续归一化。
        migrateAny(raw) {
            if (Array.isArray(raw)) return this.fromArray(raw);
            if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.progress && !Array.isArray(raw.snapshots)) {
                return this.fromPlainObject(raw);
            }
            return raw;
        }
    };

    // ── 记录归一化：所有记录读写的统一入口（字段补全、按分钟去重、快照裁剪） ──
    // 【模块：记录数据规范化】
    // 将历史版本或外部导入的数据整理成当前统一字段结构，处理时间、快照数量、容器及分集字段，
    // 并把容器记录展开为索引可使用的条目。规范化用于兼容不同来源的数据，不应凭空制造观看事实。
    const RecordNormalizer = {
        // 优先用有效时间戳生成标准时间文本；时间戳无效时保留原始文本。
        normalizeWatchTime(ts, original) {
            const n = Number(ts);
            if (Number.isFinite(n) && n > 0) {
                const formatted = TimeTool.formatTimestamp(n);
                if (formatted) return formatted;
            }
            return typeof original === 'string' ? original : '';
        },

        // 快照上限策略：
        //   1. 普通快照按"分钟"去重 —— 同一分钟只保留时间戳最新的一条。
        //      同一分钟内进度本来就会连续变化（轮询/拖条/卡片刷新），
        //      带进度去重会把一次观看拆成多条；播放页轮询、官方历史反复同步、
        //      ep→ss 合并产生的重复快照也都会按分钟收敛。
        //   2. completed 快照（100%看完凭据）固定占 1 个永久名额，绝不参与上面的裁剪。
        //   3. 普通快照保留最新 N-1 条（N = MAX_RECORD_COUNT）。
        keepSnapshotsWithinLimit(snapshots) {
            const list = Array.isArray(snapshots) ? snapshots.filter(s => s && typeof s === 'object') : [];
            const completed = list.filter(s => s.completed === true);
            const ordinary = list.filter(s => s.completed !== true);

            // 普通快照：【仅按分钟】去重，同一分钟只保留时间戳最大（最新）的一条。
            // 后写入的（同分钟则 ts 更大）覆盖先写入的。
            const dedupMap = new Map();
            ordinary
                .slice()
                .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
                .forEach(snap => {
                dedupMap.set(minuteKeyOf(snap.ts), snap);
            });
            const deduped = Array.from(dedupMap.values());

            // completed 永久占 1 个名额（最近的一条）
            const permanent = completed.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0] || null;
            const recent = deduped
            .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
            .slice(-Math.max(0, CONFIG.MAX_RECORD_COUNT - (permanent ? 1 : 0)));

            const result = permanent ? [...recent, permanent] : recent;
            return result.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
        },

        // 快照写入：官方同步、播放页轮询两条路径的统一实现。
        //   1. 作者等不随单次观看变化的固定数据只存在记录顶层，快照里不重复保存；
        //   2. 进度为 100% 时自动打 completed 标记（官方卡片可能不显式给 completed）；
        //   3. completed 快照顶掉旧的 completed（保持"永久名额"只留最近一条）；
        //   4. 统一走 keepSnapshotsWithinLimit，然后刷新 lastTs / lastProgress。
        appendSnapshot(record, snapshot) {
            if (!Array.isArray(record.snapshots)) record.snapshots = [];
            if (String(snapshot.progress || '') === '100%') snapshot.completed = true;
            if (snapshot.completed === true) {
                record.snapshots = record.snapshots.filter(s => s && s.completed !== true);
            }
            record.snapshots.push(snapshot);
            record.snapshots = this.keepSnapshotsWithinLimit(record.snapshots);
            record.lastTs = Number(snapshot.ts || TimeTool.now());
            record.lastProgress = snapshot.progress || record.lastProgress || '0%';
        },

        // 补齐记录字段、修复数据类型、迁移旧结构并规范快照，是读写记录的统一入口。
        normalize(raw) {
            let rec = LegacyMigration.migrateAny(raw);
            if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;

            // 5.3.0 容器分支：type==='collection' 或带 parts 数组的即合集容器。
            if (rec.type === 'collection' || Array.isArray(rec.parts)) {
                return this.normalizeCollection(rec);
            }

            // 普通视频不写入合集专用字段。只有存在明确的合集/分集结构证据时，才保留这些字段；
            // collectionTitle 单独出现不作为合集证据，避免把普通视频标题误存成“大标题”。
            const hasCollectionStructure = rec.isCollection === true
                || (Number.isFinite(Number(rec.partTotal)) && Number(rec.partTotal) > 1)
                || (Number.isFinite(Number(rec.partNumber)) && Number(rec.partNumber) > 1)
                || (typeof rec.collectionKey === 'string' && !!rec.collectionKey.trim())
                || (typeof rec.smallCollectionTitle === 'string' && !!rec.smallCollectionTitle.trim())
                || (Number.isFinite(Number(rec.collectionOrder)) && Number(rec.collectionOrder) > 0)
                || (Number.isFinite(Number(rec.seasonId)) && Number(rec.seasonId) > 0);
            const normalized = {
                title: typeof rec.title === 'string' ? rec.title : (rec.title == null ? null : String(rec.title)),
                titleSource: rec.titleSource === 'player' || rec.titleSource === 'official' ? rec.titleSource : '',
                lastTs: Number.isFinite(Number(rec.lastTs)) && Number(rec.lastTs) > 0 ? Number(rec.lastTs) : 0,
                lastProgress: typeof rec.lastProgress === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(rec.lastProgress)
                ? rec.lastProgress : '0%',
                watchCount: Number.isFinite(Number(rec.watchCount)) && Number(rec.watchCount) >= 0
                ? Math.floor(Number(rec.watchCount)) : 0,
                snapshots: [],
                hasReachedWatchThreshold: rec.hasReachedWatchThreshold === true,
                officialHistorySeen: rec.officialHistorySeen === true,
                // 空记录只做标记，不删除。以后有真实观看数据时会自动变回有效记录。
                emptyRecord: false,
                schemaVersion: 2,
                authorName: typeof rec.authorName === 'string'
                ? rec.authorName
                : (typeof rec.author === 'string' ? rec.author : ''),
                mediaType: typeof rec.mediaType === 'string' && rec.mediaType.trim() ? rec.mediaType.trim() : '视频',
                mediaSubtitle: typeof rec.mediaSubtitle === 'string' ? rec.mediaSubtitle : '',
                mediaTags: Array.isArray(rec.mediaTags)
                ? [...new Set(rec.mediaTags.map(v => String(v || '').trim()).filter(Boolean))]
                : []
            };

            // 合集字段按需保存；普通视频的存储对象不携带空的大标题/小标题/分集排序字段。
            if (hasCollectionStructure) {
                const collectionTitle = typeof rec.collectionTitle === 'string' ? rec.collectionTitle.trim() : '';
                const smallCollectionTitle = typeof rec.smallCollectionTitle === 'string' ? rec.smallCollectionTitle.trim() : '';
                const collectionKey = typeof rec.collectionKey === 'string' ? rec.collectionKey.trim() : '';
                const partTitle = typeof rec.partTitle === 'string' ? rec.partTitle.trim() : '';
                const partNumber = Number(rec.partNumber);
                const partTotal = Number(rec.partTotal);
                const collectionOrder = Number(rec.collectionOrder);
                if (collectionTitle) normalized.collectionTitle = collectionTitle;
                if (smallCollectionTitle) normalized.smallCollectionTitle = smallCollectionTitle;
                if (collectionKey) normalized.collectionKey = collectionKey;
                if (partTitle) normalized.partTitle = partTitle;
                if (Number.isFinite(partNumber) && partNumber > 0) normalized.partNumber = Math.floor(partNumber);
                if (Number.isFinite(partTotal) && partTotal > 0) normalized.partTotal = Math.floor(partTotal);
                if (Number.isFinite(collectionOrder) && collectionOrder > 0) normalized.collectionOrder = Math.floor(collectionOrder);
            }

            // 保留 seasonId：mergeEpIntoSeason 里的 seasonId 匹配依赖它，之前丢失导致永远匹配不上
            const sid = Number(rec.seasonId);
            if (Number.isFinite(sid) && sid > 0) normalized.seasonId = sid;

            if (Array.isArray(rec.snapshots)) {
                normalized.snapshots = rec.snapshots
                    .filter(s => s && typeof s === 'object' && !Array.isArray(s))
                    .map(s => {
                    const tsNum = Number(s.ts);
                    const snapTs = Number.isFinite(tsNum) && tsNum > 0 ? tsNum : 0;
                    const posNum = s.pos === null || s.pos === undefined || s.pos === '' ? null : Number(s.pos);
                    const progress = typeof s.progress === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(s.progress)
                    ? s.progress : '0%';
                    return {
                        ts: snapTs,
                        pos: posNum !== null && Number.isFinite(posNum) && posNum >= 0 ? posNum : null,
                        progress,
                        watchTimeStr: this.normalizeWatchTime(snapTs, s.watchTimeStr),
                        ...(s.source === 'official' || s.source === 'player' ? { source: s.source } : {}),
                        ...(s.completed === true || progress === '100%' ? { completed: true } : {})
                    };
                });
            }

            normalized.snapshots = this.keepSnapshotsWithinLimit(normalized.snapshots);

            if (normalized.watchCount === 0 && normalized.snapshots.length) {
                normalized.watchCount = normalized.snapshots.length;
            }
            if (normalized.lastTs <= 0 && normalized.snapshots.length) {
                const newest = normalized.snapshots.reduce((a, b) => Number(a.ts || 0) >= Number(b.ts || 0) ? a : b);
                if (Number(newest.ts) > 0) normalized.lastTs = Number(newest.ts);
            }
            if ((!rec.lastProgress || rec.lastProgress === '0%') && normalized.snapshots.length) {
                const newest = normalized.snapshots.reduce((a, b) => Number(a.ts || 0) >= Number(b.ts || 0) ? a : b);
                normalized.lastProgress = newest.progress || normalized.lastProgress;
            }
            if (!normalized.hasReachedWatchThreshold) {
                normalized.hasReachedWatchThreshold = normalized.snapshots.some(s =>
                                                                                Number.isFinite(s.pos) && s.pos >= CONFIG.SHORT_WATCH_MAX_POS_SEC);
            }
            // 只标记“没有任何观看事实”的旧记录，保留键、标题、作者及合集元数据供后续修复匹配。
            normalized.emptyRecord = normalized.snapshots.length === 0
                && normalized.watchCount <= 0
                && normalized.lastTs <= 0
                && normalized.officialHistorySeen !== true
                && normalized.hasReachedWatchThreshold !== true;
            return normalized;
        },

        // 规范化合集容器（5.3.0）：type==='collection'，parts[] 存分集。
        normalizeCollection(rec) {
            const parts = (Array.isArray(rec.parts) ? rec.parts : [])
                .filter(p => p && typeof p === 'object' && !Array.isArray(p))
                .map(p => this.normalizePart(p, rec));
            const rawTitle = typeof rec.title === 'string' ? rec.title : (typeof rec.collectionTitle === 'string' ? rec.collectionTitle : '');
            const safeTitle = /^(?:undefined|null)$/i.test(rawTitle.trim()) ? '' : rawTitle.trim();
            const container = {
                type: 'collection',
                key: typeof rec.key === 'string' ? rec.key : '',
                title: safeTitle,
                authorName: typeof rec.authorName === 'string' ? rec.authorName : (typeof rec.author === 'string' ? rec.author : ''),
                mediaType: typeof rec.mediaType === 'string' && rec.mediaType.trim() ? rec.mediaType.trim() : '视频',
                collectionKey: typeof rec.collectionKey === 'string' ? rec.collectionKey : '',
                smallCollections: Array.isArray(rec.smallCollections)
                    ? rec.smallCollections.map(sc => ({ title: String(sc?.title || '').trim(), order: Number.isFinite(Number(sc?.order)) && Number(sc.order) >= 0 ? Math.floor(Number(sc.order)) : 0 })).filter(sc => sc.title)
                    : [],
                parts,
                ...(rec.legacyAggregate && typeof rec.legacyAggregate === 'object' ? { legacyAggregate: rec.legacyAggregate } : {}),
                schemaVersion: 4,
                updatedAt: Number.isFinite(Number(rec.updatedAt)) && Number(rec.updatedAt) > 0 ? Number(rec.updatedAt) : 0
            };
            return container;
        },

        // 规范化合集容器内的单个分集（parts[] 元素）。
        normalizePart(part, container) {
            const snapshots = (Array.isArray(part.snapshots) ? part.snapshots : [])
                .filter(s => s && typeof s === 'object' && !Array.isArray(s))
                .map(s => {
                    const tsNum = Number(s.ts);
                    const snapTs = Number.isFinite(tsNum) && tsNum > 0 ? tsNum : 0;
                    const posNum = s.pos === null || s.pos === undefined || s.pos === '' ? null : Number(s.pos);
                    const progress = typeof s.progress === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(s.progress) ? s.progress : '0%';
                    return {
                        ts: snapTs,
                        pos: posNum !== null && Number.isFinite(posNum) && posNum >= 0 ? posNum : null,
                        progress,
                        watchTimeStr: this.normalizeWatchTime(snapTs, s.watchTimeStr),
                        ...(s.source === 'official' || s.source === 'player' ? { source: s.source } : {}),
                        ...(s.completed === true || progress === '100%' ? { completed: true } : {})
                    };
                });
            // 旧格式的分集身份可能落在 episodeKey/key/bvid/bvKey，不能只看 bv；
            // 例如 bv=ssNN、episodeKey=ep181 时，必须以精确 ep 身份为准，避免读错或覆盖另一集。
            const canonicalEpKey = [part.epKey, part.episodeKey, part.key, part.bvid, part.bvKey, part.bv]
                .map(value => String(value || '').trim().toLowerCase())
                .find(value => /^ep\d+$/i.test(value)) || '';
            const rawSmallCollectionTitle = typeof part.smallCollectionTitle === 'string' ? part.smallCollectionTitle.trim() : '';
            const normalized = {
                p: Number.isFinite(Number(part.p)) && Number(part.p) > 0 ? Math.floor(Number(part.p)) : (Number.isFinite(Number(part.partNumber)) && Number(part.partNumber) > 0 ? Math.floor(Number(part.partNumber)) : 0),
                // 与 5.4.5 的实际存储格式一致：番剧/电视剧分集的 bv、epKey 都保留完整 ep 标识；
                // epKey 是分集身份字段，不是独立存储键。整季唯一容器仍是 ssNN。
                bv: canonicalEpKey || (typeof part.bv === 'string' ? part.bv.trim() : ''),
                ...(canonicalEpKey ? { epKey: canonicalEpKey } : {}),
                ...(part.seasonTitleVerified === true ? { seasonTitleVerified: true } : {}),
                ...(Number.isFinite(Number(part.seasonId)) && Number(part.seasonId) > 0 ? { seasonId: Math.floor(Number(part.seasonId)) } : {}),
                ...(typeof part.sectionTitle === 'string' && part.sectionTitle.trim() ? { sectionTitle: part.sectionTitle.trim() } : {}),
                title: (() => { const value = typeof part.title === 'string' ? part.title : (typeof part.partTitle === 'string' ? part.partTitle : ''); return /^(?:undefined|null)$/i.test(value.trim()) ? '' : value; })(),
                partTotal: Number.isFinite(Number(part.partTotal)) && Number(part.partTotal) > 0 ? Math.floor(Number(part.partTotal)) : 0,
                ...(rawSmallCollectionTitle ? { smallCollectionTitle: rawSmallCollectionTitle } : {}),
                ...(Number.isFinite(Number(part.collectionOrder)) && Number(part.collectionOrder) > 0 ? { collectionOrder: Math.floor(Number(part.collectionOrder)) } : {}),
                lastTs: Number.isFinite(Number(part.lastTs)) && Number(part.lastTs) > 0 ? Number(part.lastTs) : 0,
                lastProgress: typeof part.lastProgress === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(part.lastProgress) ? part.lastProgress : '0%',
                watchCount: Number.isFinite(Number(part.watchCount)) && Number(part.watchCount) >= 0 ? Math.floor(Number(part.watchCount)) : 0,
                snapshots,
                hasReachedWatchThreshold: part.hasReachedWatchThreshold === true,
                officialHistorySeen: part.officialHistorySeen === true,
                emptyRecord: false
            };
            if (normalized.watchCount === 0 && normalized.snapshots.length) normalized.watchCount = normalized.snapshots.length;
            if (normalized.lastTs <= 0 && normalized.snapshots.length) {
                const newest = normalized.snapshots.reduce((a, b) => Number(a.ts || 0) >= Number(b.ts || 0) ? a : b);
                if (Number(newest.ts) > 0) normalized.lastTs = Number(newest.ts);
            }
            if ((!part.lastProgress || part.lastProgress === '0%') && normalized.snapshots.length) {
                const newest = normalized.snapshots.reduce((a, b) => Number(a.ts || 0) >= Number(b.ts || 0) ? a : b);
                normalized.lastProgress = newest.progress || normalized.lastProgress;
            }
            if (!normalized.hasReachedWatchThreshold) {
                normalized.hasReachedWatchThreshold = normalized.snapshots.some(s => Number.isFinite(s.pos) && s.pos >= CONFIG.SHORT_WATCH_MAX_POS_SEC);
            }
            normalized.emptyRecord = normalized.snapshots.length === 0
                && normalized.watchCount <= 0
                && normalized.lastTs <= 0
                && normalized.officialHistorySeen !== true
                && normalized.hasReachedWatchThreshold !== true;
            return normalized;
        },

        // 提取列表索引需要的字段，避免索引缓存携带无关数据。
        toIndexRecord(key, raw) {
            const rec = this.normalize(raw);
            if (!rec) return null;
            if (rec.type === 'collection') {
                const allSnapshots = [];
                let lastTs = 0, lastProgress = '0%', watchCount = 0, anyThreshold = false;
                if (rec.legacyAggregate && typeof rec.legacyAggregate === 'object') {
                    const legacy = rec.legacyAggregate;
                    lastTs = Number(legacy.lastTs) || 0;
                    lastProgress = legacy.lastProgress || '0%';
                    watchCount = Math.max(0, Number(legacy.watchCount) || 0);
                    anyThreshold = legacy.hasReachedWatchThreshold === true;
                    if (Array.isArray(legacy.snapshots)) allSnapshots.push(...legacy.snapshots);
                }
                for (const p of rec.parts) {
                    if (Number(p.lastTs) > lastTs) lastTs = Number(p.lastTs);
                    if (p.lastProgress) lastProgress = p.lastProgress;
                    watchCount += Math.max(0, Number(p.watchCount) || 0);
                    anyThreshold = anyThreshold || p.hasReachedWatchThreshold === true;
                    for (const s of p.snapshots) allSnapshots.push(s);
                }
                return {
                    key: rec.key || key,
                    isCollection: true,
                    collectionTitle: rec.title || '',
                    collectionKey: rec.collectionKey || rec.key || key,
                    title: rec.title || '',
                    collectionOrder: 0,
                    partTitle: '',
                    partNumber: 0,
                    partTotal: rec.parts.length,
                    lastProgress,
                    lastTs,
                    watchCount,
                    snapshots: allSnapshots,
                    authorName: rec.authorName,
                    mediaType: rec.mediaType,
                    mediaSubtitle: '',
                    mediaTags: [],
                    parts: rec.parts,
                    hasReachedWatchThreshold: anyThreshold
                };
            }
            return {
                key,
                title: rec.title == null ? '' : String(rec.title),
                collectionTitle: rec.collectionTitle || '',
                smallCollectionTitle: rec.smallCollectionTitle || '',
                collectionOrder: rec.collectionOrder || 0,
                collectionKey: rec.collectionKey || '',
                partTitle: rec.partTitle || '',
                partNumber: rec.partNumber || 0,
                partTotal: rec.partTotal || 0,
                lastProgress: rec.lastProgress,
                lastTs: rec.lastTs,
                watchCount: rec.watchCount,
                snapshots: rec.snapshots,
                authorName: rec.authorName,
                mediaType: rec.mediaType,
                mediaSubtitle: rec.mediaSubtitle,
                mediaTags: rec.mediaTags
            };
        },

        // 5.3.0：把存储转成索引条目数组。容器展开成分集条目（key=BV?p=N 或 BV），
        // 单视频返回单条；这样归组/渲染完全复用既有"分集条目 + collectionKey 归组"逻辑。
        expandToIndexItems(key, raw) {
            const rec = this.normalize(raw);
            if (!rec) return [];
            if (rec.type === 'collection') {
                const cKey = rec.key || key;
                const cTitle = rec.title || '';
                const cAuthor = rec.authorName || '';
                const cMedia = rec.mediaType || '视频';
                const cColKey = rec.collectionKey || cKey;
                const total = Math.max(1, rec.parts.length);
                return rec.parts.map(part => {
                    const isBangumiPart = /^ep\d+$/i.test(String(part.bv || part.epKey || ''));
                    const rawPartNumber = Number(part.p) || 0;
                    const p = isBangumiPart ? rawPartNumber : Math.max(1, rawPartNumber || 1);
                    const rawSmallTitle = String(part.smallCollectionTitle || '').trim();
                    // 番剧不应凭 seasonId 虚构季名；电视剧则需要用“第N季”作为 UI 分组名。
                    // 这里仅影响展开后的展示字段，不修改原始 parts 数据。
                    const isSyntheticSeasonTitle = isBangumiPart
                        && /^第\s*(?:\d+|[一二三四五六七八九十百]+)\s*季$/.test(rawSmallTitle);
                    const isTelevisionContainer = /电视剧|television|\btv\b/i.test(String(cMedia || ''));
                    const displaySmallTitle = isSyntheticSeasonTitle && !isTelevisionContainer ? '' : rawSmallTitle;
                    const storedBv = part.bv || cKey;
                    const parsedBv = String(storedBv).match(/^(BV[a-zA-Z0-9]+)(?:\?p=(\d+))?$/i);
                    const baseBv = parsedBv ? parsedBv[1] : storedBv;
                    // 新数据直接从 bv 读取完整键；旧数据若仍是基础 BV，则兼容推导 ?p=N。
                    const isBvMultiPartContainer = /^BV[a-zA-Z0-9]+$/i.test(cKey)
                        && /^BV[a-zA-Z0-9]+$/i.test(baseBv)
                        && baseBv.toUpperCase() === cKey.toUpperCase();
                    const partKey = isBangumiPart ? storedBv : (parsedBv && parsedBv[2] ? storedBv : (isBvMultiPartContainer && p > 1 ? `${baseBv}?p=${p}` : storedBv));
                    return {
                        key: partKey,
                        containerKey: cKey,
                        bvKey: isBangumiPart ? storedBv : baseBv,
                        ...(isBangumiPart ? { isBangumiPart: true, seasonId: part.seasonId || Number(String(cKey).replace(/^ss/i, '')) || 0, sectionTitle: part.sectionTitle || '' } : {}),
                        isCollectionPart: true,
                        collectionKey: cColKey,
                        collectionTitle: cTitle,
                        title: part.title || '',
                        authorName: cAuthor || part.authorName || '',
                        mediaType: cMedia,
                        partTitle: part.title || '',
                        partNumber: p,
                        partTotal: part.partTotal || total,
                        smallCollectionTitle: displaySmallTitle,
                        seasonTitleVerified: part.seasonTitleVerified === true,
                        collectionOrder: part.collectionOrder || 0,
                        lastTs: part.lastTs || 0,
                        lastProgress: part.lastProgress || '0%',
                        watchCount: part.watchCount || 0,
                        snapshots: part.snapshots || [],
                        hasReachedWatchThreshold: part.hasReachedWatchThreshold === true
                    };
                });
            }
            const it = this.toIndexRecord(key, raw);
            return it ? [it] : [];
        }
    };

    // ── 合集去重合并辅助（导入/归并时复用）──────────────────────────────
    // 合并两个合集容器：parts 按 p 号合并，快照按签名去重，观看次数取大、最近时间取新，
    // 非空的标题/作者/元信息保留；不丢弃任何一边的观看事实。
    // 【模块：合并两个容器记录】
    // 将 incoming 的分集和记录信息并入 target，处理同一分集重复、快照合并及元数据补齐。
    // 合并时以稳定的分集身份为基础，避免同一视频因标题或入口不同而重复出现。
    function mergeContainers(target, incoming) {
        const out = {
            type: 'collection',
            key: target.key || incoming.key || '',
            title: target.title || incoming.title || '',
            authorName: target.authorName || incoming.authorName || '',
            mediaType: target.mediaType && target.mediaType !== '视频' ? target.mediaType : (incoming.mediaType || '视频'),
            collectionKey: target.collectionKey || incoming.collectionKey || '',
            smallCollections: [...(target.smallCollections || []), ...(incoming.smallCollections || [])],
            parts: (target.parts || []).map(p => ({ ...p })),
            ...(target.legacyAggregate ? { legacyAggregate: target.legacyAggregate } : (incoming.legacyAggregate ? { legacyAggregate: incoming.legacyAggregate } : {})),
            schemaVersion: 4
        };
        const byP = new Map(out.parts.map(p => [p.p, p]));
        for (const incPart of (incoming.parts || [])) {
            const exist = byP.get(incPart.p);
            if (!exist) { byP.set(incPart.p, { ...incPart }); continue; }
            const snapMap = new Map();
            for (const s of [...(exist.snapshots || []), ...(incPart.snapshots || [])]) {
                if (!s || typeof s !== 'object') continue;
                const sig = `${Number(s.ts) || 0}|${s.pos == null ? '' : Number(s.pos)}|${String(s.progress || '')}|${s.completed === true ? 1 : 0}`;
                const old = snapMap.get(sig);
                if (!old || String(s.watchTimeStr || '').length > String(old.watchTimeStr || '').length) snapMap.set(sig, s);
            }
            exist.snapshots = RecordNormalizer.keepSnapshotsWithinLimit([...snapMap.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
            exist.watchCount = Math.max(Number(exist.watchCount) || 0, Number(incPart.watchCount) || 0, exist.snapshots.length);
            if (incPart.title && !exist.title) exist.title = incPart.title;
            if (incPart.bv && /^ep\d+$/i.test(String(incPart.bv)) && !/^ep\d+$/i.test(String(exist.bv || ''))) exist.bv = incPart.bv;
            if (incPart.seasonId && !exist.seasonId) exist.seasonId = incPart.seasonId;
            if (incPart.sectionTitle && !exist.sectionTitle) exist.sectionTitle = incPart.sectionTitle;
            if (Number(incPart.lastTs || 0) > Number(exist.lastTs || 0)) {
                exist.lastTs = Number(incPart.lastTs);
                exist.lastProgress = incPart.lastProgress || exist.lastProgress;
            }
            exist.partTotal = Math.max(Number(exist.partTotal) || 0, Number(incPart.partTotal) || 0);
            exist.hasReachedWatchThreshold = exist.hasReachedWatchThreshold === true || incPart.hasReachedWatchThreshold === true;
            exist.officialHistorySeen = exist.officialHistorySeen === true || incPart.officialHistorySeen === true;
            if (incPart.smallCollectionTitle && !exist.smallCollectionTitle) exist.smallCollectionTitle = incPart.smallCollectionTitle;
        }
        out.parts = [...byP.values()].sort((a, b) => a.p - b.p);
        if (!out.legacyAggregate && incoming.legacyAggregate) out.legacyAggregate = incoming.legacyAggregate;
        return out;
    }

    // 在本地已有容器里找可与 incoming 合并的目标：
    //  1) 去掉 ?p= 后 BV 相同 → 必为同一合集；
    //  2) 标题相同且作者相同 → 必为同一合集；
    // 都不满足返回 null（先当独立/扁平，等播放页读到合集信息再归并）。
    // 【模块：为待合并记录寻找本地容器】
    // 根据 incoming 的身份信息，在本地已有记录中寻找可能承载该记录的容器。
    // 此处用于迁移/修复阶段的归属判断；不能仅凭标题相似就把不同视频或不同番剧季合并。
    function findLocalContainerToMerge(incoming) {
        const incomingBv = (incoming.key || '').match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || '';
        const incomingTitle = String(incoming.title || '').trim();
        const incomingAuthor = String(incoming.authorName || '').trim();
        for (const k of GM_listValues()) {
            const rec = RecordNormalizer.normalize(GM_getValue(k, null));
            if (!rec || rec.type !== 'collection') continue;
            if (incomingBv) {
                const localBv = (rec.key || '').match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || '';
                if (localBv && localBv.toLowerCase() === incomingBv.toLowerCase()) return { key: k, container: rec };
            }
            if (incomingTitle && incomingAuthor
                && String(rec.title || '').trim() === incomingTitle
                && String(rec.authorName || '').trim() === incomingAuthor) {
                return { key: k, container: rec };
            }
        }
        return null;
    }

    // ── 历史视图索引：全量记录的有序镜像，后台分批构建 + 防抖落盘，供面板快速渲染 ──
    // 【模块：历史视图索引与最近快照缓存】
    // 原始记录存储是观看数据的事实来源；本模块维护可重建的排序/搜索索引，并另存容量受限的最近快照缓存。
    // 列表首屏可优先读取小缓存，完整索引则在需要时重建或刷新。索引与缓存都属于派生数据，
    // 即使丢失也应能从原始记录重新生成，不应反过来覆盖原始观看记录。
    const HistoryViewIndex = {
        _index: null,
        _ready: false,
        _building: false,
        _generation: 0,
        _saveTimer: null,
        _refreshTimer: null,
        _refreshIdleId: null,
        _pendingChanges: new Map(),
        // 自上次重建以来发生过变更的记录键：热池据此【只并入这些键】，
        // 因此面板级快照列表的维护代价与本地总记录数无关。
        _dirtyKeys: new Set(),
        _recentCacheMemory: null,
        _recentCacheLoaded: false,
        _recentCacheSaveTimer: null,
        _ensureAfterPaintScheduled: false,

        // 快照来源分桶：只认显式的 official / player，其余一律 unknown。
        // 改前：source 缺失（旧格式迁移、直播页写入）会被默认判成 player，
        // 于是"自动获取那 N 条"里混进无出处快照，池一满就顶掉真正的新 player 候选。
        // 改后：unknown 不入热池；写入路径已在源头补齐 source，存量 unknown 会随
        // 下一次 _pruneHotPool / 同步自然淘汰，无需手动清库。
        _sourceBucket(snap) {
            const src = snap && snap.source;
            if (src === 'official') return 'official';
            if (src === 'player') return 'player';
            return 'unknown';
        },

        // 把 keys 对应的记录快照插入有序数组 latest（按 ts 降序，最多 maxCount 条）。
        // _collectLatestSnapshots（全量）和 _mergeSnapshotsIntoLatest（增量）都走这里。
        // sourceFilter 非空时只收该来源桶的快照，供热池分来源使用。
        _insertSnapshots(latest, keys, itemsByKey, limit, sourceFilter = null) {
            const maxCount = Math.max(1, Math.min(CONFIG.RECENT_SNAPSHOT_MAX, Number(limit) || 5));
            for (const key of keys) {
                const it = itemsByKey[key];
                if (!it) continue;
                for (const snap of (Array.isArray(it.snapshots) ? it.snapshots : [])) {
                    if (sourceFilter && this._sourceBucket(snap) !== sourceFilter) continue;
                    const candidate = {
                        ...snap,
                        bvKey: it.key,
                        title: it.title,
                        authorName: it.authorName || '',
                        watchCount: it.watchCount,
                        mediaType: it.mediaType || '',
                        mediaTags: it.mediaTags || [],
                        mediaSubtitle: it.mediaSubtitle || ''
                    };
                    const ts = Number(candidate.ts || 0);
                    let insertAt = latest.findIndex(item => ts > Number(item.ts || 0));
                    if (insertAt < 0) insertAt = latest.length;
                    if (insertAt < maxCount) {
                        latest.splice(insertAt, 0, candidate);
                        if (latest.length > maxCount) latest.pop();
                    }
                }
            }
        },

        // 从全部记录中汇总最近的 N 条快照。
        _collectLatestSnapshots(itemsByKey, limit = CONFIG.RECENT_SNAPSHOT_COUNT) {
            const latest = [];
            this._insertSnapshots(latest, Object.keys(itemsByKey), itemsByKey, limit);
            return latest;
        },

        // 只把新变更记录的快照并入最近快照列表，供增量更新使用。
        _mergeSnapshotsIntoLatest(latest, itemsByKey, newKeys, limit) {
            this._insertSnapshots(latest, newKeys, itemsByKey, limit);
        },

        // ── 最近快照热池 ──
        // 结构：{ player: [...], official: [...] }，两桶各自按 ts 降序、各限 N 条
        // （N = RECENT_SNAPSHOT_COUNT），因此候选总量恒为 2N，与本地历史条数无关。
        //   player  桶：播放页 / 直播页自动写入的快照（自动获取那一批）；
        //   official桶：官方历史页同步进来的快照（视频页同步加载那一批）。
        // 因为容量恒定，全量重建和增量并入的单条代价都只是 O(池容量)，
        // 与本地总记录数无关，所以打开面板时不会因为数据总量大而卡顿。
        _emptyHotPool() {
            return { player: [], official: [] };
        },

        // 全量汇总两桶热池（后台分批构建结束时使用）。
        _collectHotSnapshots(itemsByKey, perSourceLimit = CONFIG.RECENT_SNAPSHOT_COUNT) {
            const hot = this._emptyHotPool();
            const keys = Object.keys(itemsByKey);
            this._insertSnapshots(hot.player, keys, itemsByKey, perSourceLimit, 'player');
            this._insertSnapshots(hot.official, keys, itemsByKey, perSourceLimit, 'official');
            return hot;
        },

        // 增量并入：只处理本次变更的 keys，单次代价 = 池容量 + 该记录快照条数，
        // 与本地总记录数无关。变更记录的旧条目先整条摘掉再重插，
        // 保证同一条快照不会因反复同步在池里重复堆积。
        _mergeSnapshotsIntoHot(hot, itemsByKey, newKeys, perSourceLimit = CONFIG.RECENT_SNAPSHOT_COUNT) {
            if (!hot || !Array.isArray(hot.player) || !Array.isArray(hot.official)) return;
            const touched = new Set(newKeys.map(k => String(k)));
            const keep = list => list.filter(entry => !touched.has(String(entry.bvKey)));
            hot.player = keep(hot.player);
            hot.official = keep(hot.official);
            this._insertSnapshots(hot.player, newKeys, itemsByKey, perSourceLimit, 'player');
            this._insertSnapshots(hot.official, newKeys, itemsByKey, perSourceLimit, 'official');
        },

        // 清理池中已失效的条目：记录被删、或该分钟快照已不在记录里（清理/重置等）。
        _pruneHotPool(hot, itemsByKey, perSourceLimit = CONFIG.RECENT_SNAPSHOT_COUNT) {
            // 桶内本就按 ts 降序，剪枝后截到 N 条：N 调小时旧池会随之收敛
            const cap = Math.max(1, Number(perSourceLimit) || CONFIG.RECENT_SNAPSHOT_COUNT);
            const alive = list => (Array.isArray(list) ? list : []).filter(entry => {
                // 清理旧缓存中缺少来源标记的快照，避免错误归入自动采集来源。
                // 在下一次重建时一次性清出，之后由带 source 的新快照填回。
                if (this._sourceBucket(entry) === 'unknown') return false;
                const it = itemsByKey[entry.bvKey];
                if (!it) return false;
                const mk = minuteKeyOf(entry.ts);
                return (Array.isArray(it.snapshots) ? it.snapshots : [])
                    .some(s => minuteKeyOf(s.ts) === mk);
            }).slice(0, cap);
            return { player: alive(hot && hot.player), official: alive(hot && hot.official) };
        },

        // 来源配额比例（夹在允许区间内，非法值回退 0.5）。
        _quotaRatio() {
            const raw = Number(CONFIG.RECENT_SNAPSHOT_PLAYER_QUOTA);
            if (!Number.isFinite(raw)) return 0.5;
            const min = Number(CONFIG.RECENT_SNAPSHOT_QUOTA_MIN) || 0;
            const max = Number.isFinite(Number(CONFIG.RECENT_SNAPSHOT_QUOTA_MAX))
            ? Number(CONFIG.RECENT_SNAPSHOT_QUOTA_MAX) : 1;
            return Math.max(min, Math.min(max, raw));
        },

        // 从独立的小缓存读取最近快照。该缓存不包含 itemsByKey / sortedKeys，体积只随 N 增长。
        _readRecentCache() {
            if (this._recentCacheLoaded) return this._recentCacheMemory;
            this._recentCacheLoaded = true;
            try {
                const saved = GM_getValue(RECENT_SNAPSHOT_CACHE_KEY, null);
                if (saved && saved.version === 1
                    && saved.hotSnapshots
                    && Array.isArray(saved.hotSnapshots.player)
                    && Array.isArray(saved.hotSnapshots.official)
                    && Array.isArray(saved.latestSnapshots)) {
                    this._recentCacheMemory = saved;
                }
            } catch (err) {
                console.warn('[Bilibili History] 读取最近快照缓存失败：', err);
            }
            return this._recentCacheMemory;
        },

        // 只把最近快照相关字段写入独立缓存，不复制整份历史索引。
        _makeRecentCache(index) {
            if (!index || !index.hotSnapshots) return null;
            return {
                version: 1,
                indexVersion: HISTORY_VIEW_INDEX_VERSION,
                count: CONFIG.RECENT_SNAPSHOT_COUNT,
                hotSnapshots: index.hotSnapshots,
                latestSnapshots: Array.isArray(index.latestSnapshots) ? index.latestSnapshots : [],
                savedAt: Date.now(),
                building: index.building === true
            };
        },

        // 后台重建期间也定时保存小缓存，让首次安装的最近记录尽早可用；写入做防抖。
        _scheduleRecentCacheSave() {
            if (this._recentCacheSaveTimer) clearTimeout(this._recentCacheSaveTimer);
            this._recentCacheSaveTimer = setTimeout(() => {
                this._recentCacheSaveTimer = null;
                const cache = this._makeRecentCache(this._index);
                if (!cache) return;
                try {
                    GM_setValue(RECENT_SNAPSHOT_CACHE_KEY, cache);
                    this._recentCacheMemory = cache;
                    this._recentCacheLoaded = true;
                } catch (err) {
                    console.warn('[Bilibili History] 保存最近快照缓存失败：', err);
                }
            }, 350);
        },

        // 首屏先显示独立缓存，再延后读取完整索引，避免大索引读取阻塞最近记录的首次绘制。
        _ensureAfterRecentPaint(listDom, variant) {
            if (this._ensureAfterPaintScheduled) return;
            this._ensureAfterPaintScheduled = true;
            setTimeout(() => {
                this._ensureAfterPaintScheduled = false;
                if (!listDom || !listDom.isConnected) return;
                const index = this.ensure();
                if (this._ready && !this._building) {
                    const inputId = variant === 'history-page' ? 'bvh-hp-search' : 'bvh-history-search';
                    const input = document.getElementById(inputId);
                    HistoryListRenderer.renderInto(listDom, input ? input.value : '', variant);
                }
                // 若索引需要后台重建，重建批次会自行刷新已打开的面板。
            }, 50);
        },

        // 面板显示取用：从两桶（各 N 条，合计 2N 候选）里选出 N 条展示。
        // 第一轮按来源配额取数：player 先占 ceil(N * quota) 个名额、official 占其余名额，
        // 保证"自动获取"与"官方同步"两个来源都有可见位置，不再被单一来源整屏占满；
        // 第二轮把两桶剩余候选按时间全局归并，补满空出的名额（优先更新优先加载）。
        // 选完再按 ts 降序排一次，保证面板呈现仍是"最近的在上"。
        // 同一视频在 RECENT_SNAPSHOT_DEDUP_WINDOW_MS 窗口内的多条快照算同一次观看，只占 1 格；
        // 用窗口而非整分钟，是因为官方 ts 被截断到分钟、播放页是秒级，二者可能差到 59 秒。
        // 热池不足 limit 时用 latestSnapshots 兜底补齐（兼容升级前索引 / 只有官方来源的早期数据）。
        recentDisplaySnapshots(limit = CONFIG.RECENT_SNAPSHOT_COUNT, sourceIndex = null) {
            // 不调用 ensure()：这里必须只读内存或小缓存，不能为了最近 N 条触发整份索引加载。
            const index = sourceIndex || (this._index && this._index.hotSnapshots ? this._index : this._readRecentCache());
            if (!index) return [];
            const maxCount = Math.max(1, Number(limit) || CONFIG.RECENT_SNAPSHOT_COUNT);
            const windowMs = Number(CONFIG.RECENT_SNAPSHOT_DEDUP_WINDOW_MS) || 60 * 1000;
            const picked = [];

            const isSameView = snap => {
                const ts = Number(snap.ts || 0);
                const key = String(snap.bvKey);
                return picked.some(item => String(item.bvKey) === key
                                   && Math.abs(Number(item.ts || 0) - ts) < windowMs);
            };
            const push = snap => {
                if (!snap || !snap.bvKey) return false;
                if (isSameView(snap)) return false;
                picked.push(snap);
                return true;
            };
            const sortByTs = () => picked.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

            const hot = index.hotSnapshots;
            const playerList = hot && Array.isArray(hot.player) ? hot.player : [];
            const officialList = hot && Array.isArray(hot.official) ? hot.official : [];

            // 第一轮：各桶按自己的配额出，桶内本就按 ts 降序，从前往后取。
            // 去重命中也要前进指针，否则会在重复项上原地打转。
            const playerQuota = Math.ceil(maxCount * this._quotaRatio());
            const officialQuota = maxCount - playerQuota;
            let i = 0;
            let j = 0;
            let playerTaken = 0;
            let officialTaken = 0;
            while (i < playerList.length && playerTaken < playerQuota && picked.length < maxCount) {
                if (push(playerList[i])) playerTaken++;
                i++;
            }
            while (j < officialList.length && officialTaken < officialQuota && picked.length < maxCount) {
                if (push(officialList[j])) officialTaken++;
                j++;
            }

            // 第二轮：某一侧候选不足（配额名额没用完）时，两桶剩余候选按时间归并补满。
            while (picked.length < maxCount && (i < playerList.length || j < officialList.length)) {
                const takePlayer = j >= officialList.length
                || (i < playerList.length && Number(playerList[i].ts || 0) >= Number(officialList[j].ts || 0));
                push(takePlayer ? playerList[i++] : officialList[j++]);
            }

            sortByTs();

            // 兜底：热池没攒够（刚升级 / 记录很少）时，用常驻最近快照列表补位
            if (picked.length < maxCount && Array.isArray(index.latestSnapshots)) {
                for (const snap of index.latestSnapshots) {
                    if (picked.length >= maxCount) break;
                    push(snap);
                }
                sortByTs();
            }
            return picked.slice(0, maxCount);
        },

        // 重建观看次数排序和最近快照列表，并按需安排索引保存。
        // hotHint：后台分批构建已经增量攒好的热池，直接沿用即可。
        _rebuild(itemsByKey, shouldSave = true, hotHint = null) {
            const items = Object.values(itemsByKey);
            items.sort((a, b) => {
                const countDiff = Number(b.watchCount || 0) - Number(a.watchCount || 0);
                return countDiff || Number(b.lastTs || 0) - Number(a.lastTs || 0);
            });

            const latestSnapshots = this._collectLatestSnapshots(itemsByKey, CONFIG.RECENT_SNAPSHOT_COUNT);

            // 热池维护策略：
            //   1. 外部传入 hotHint（后台分批构建的成果）→ 直接沿用；
            //   2. 已有热池且本轮只有少量记录变更 → 剪枝后【只并入脏键】，代价恒定；
            //   3. 其余情况（首次构建 / 索引重建）→ 全量汇总一次。
            let hotSnapshots;
            const prevHot = this._index && this._index.hotSnapshots;
            const prevUsable = prevHot && Array.isArray(prevHot.player) && Array.isArray(prevHot.official);
            if (hotHint && Array.isArray(hotHint.player) && Array.isArray(hotHint.official)) {
                hotSnapshots = hotHint;
            } else if (prevUsable && this._dirtyKeys.size) {
                hotSnapshots = this._pruneHotPool({
                    player: prevHot.player.slice(),
                    official: prevHot.official.slice()
                }, itemsByKey, CONFIG.RECENT_SNAPSHOT_COUNT);
                this._mergeSnapshotsIntoHot(hotSnapshots, itemsByKey, Array.from(this._dirtyKeys), CONFIG.RECENT_SNAPSHOT_COUNT);
            } else {
                hotSnapshots = this._collectHotSnapshots(itemsByKey, CONFIG.RECENT_SNAPSHOT_COUNT);
            }
            this._dirtyKeys.clear();

            this._index = {
                version: HISTORY_VIEW_INDEX_VERSION,
                itemsByKey,
                sortedKeys: items.map(it => it.key),
                latestSnapshots,
                hotSnapshots,
                building: false
            };
            this._ready = true;
            // 卡片角标依赖本页内存索引；索引重建/增量刷新后通知角标重新查询并渲染。
            window.dispatchEvent(new CustomEvent('bvh-history-index-updated'));
            if (shouldSave) this._scheduleSave();
            return this._index;
        },

        // 延迟保存索引，合并短时间内的多次更新，减少存储写入。
        _scheduleSave() {
            if (!this._index) return;
            if (this._saveTimer) clearTimeout(this._saveTimer);
            const doSave = () => {
                const snapshot = this._index;
                if (!snapshot || snapshot.building) return;
                try {
                    GM_setValue(HISTORY_VIEW_INDEX_KEY, snapshot);
                } catch (err) {
                    console.warn('[Bilibili History] 保存排序索引失败，将在下次打开时重建：', err);
                }
                const recentCache = this._makeRecentCache(snapshot);
                if (recentCache) {
                    try {
                        GM_setValue(RECENT_SNAPSHOT_CACHE_KEY, recentCache);
                        this._recentCacheMemory = recentCache;
                        this._recentCacheLoaded = true;
                    } catch (err) {
                        console.warn('[Bilibili History] 保存最近快照缓存失败：', err);
                    }
                }
            };
            this._saveTimer = setTimeout(() => {
                this._saveTimer = null;
                if (typeof window.requestIdleCallback === 'function') {
                    window.requestIdleCallback(doSave, { timeout: 800 });
                } else {
                    doSave();
                }
            }, 400);
        },

        // 合并索引刷新请求，在空闲时重建排序并更新已打开的列表。
        _scheduleRefresh() {
            if (this._refreshTimer) clearTimeout(this._refreshTimer);
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null;
                if (!this._index || this._building) return;
                if (this._refreshIdleId && typeof window.cancelIdleCallback === 'function') {
                    window.cancelIdleCallback(this._refreshIdleId);
                }
                const refresh = () => {
                    this._refreshIdleId = null;
                    if (!this._index || this._building) return;
                    this._rebuild(this._index.itemsByKey, true);
                    refreshOpenHistoryLists(true);
                };
                if (typeof window.requestIdleCallback === 'function') {
                    this._refreshIdleId = window.requestIdleCallback(refresh, { timeout: 1800 });
                } else {
                    setTimeout(refresh, 100);
                }
            }, 700);
        },

        // 优先使用内存或持久化索引；索引缺失或版本过期时启动后台重建。
        ensure() {
            if (this._index && this._ready) return this._index;
            if (this._building && this._index) return this._index;

            const saved = GM_getValue(HISTORY_VIEW_INDEX_KEY, null);
            const hotOk = saved && saved.hotSnapshots
            && Array.isArray(saved.hotSnapshots.player) && Array.isArray(saved.hotSnapshots.official);
            if (saved && saved.version === HISTORY_VIEW_INDEX_VERSION
                && hotOk
                && saved.itemsByKey && typeof saved.itemsByKey === 'object'
                && Array.isArray(saved.sortedKeys) && Array.isArray(saved.latestSnapshots)) {
                this._index = saved;
                this._index.building = false;
                this._ready = true;
                return this._index;
            }

            this._index = {
                version: HISTORY_VIEW_INDEX_VERSION,
                itemsByKey: {},
                sortedKeys: [],
                latestSnapshots: [],
                hotSnapshots: this._emptyHotPool(),
                building: true
            };
            this._ready = false;
            this._rebuildAsync();
            return this._index;
        },

        // 分批读取本地记录并构建索引，控制单批执行时间，同时接收构建期间的变更。
        _rebuildAsync() {
            if (this._building) return;
            this._building = true;
            const generation = ++this._generation;

            let keys;
            try {
                keys = GM_listValues().filter(k => RecordKey.isRecordKey(k));
            } catch (err) {
                this._building = false;
                console.warn('[Bilibili History] 获取记录键失败：', err);
                return;
            }

            const itemsByKey = {};
            const latestSnapshots = [];
            const hotSnapshots = this._emptyHotPool();
            let cursor = 0;
            const HARD_BATCH = 120;
            const TIME_BUDGET_MS = 8;

            let lastRefreshTs = 0;
            let refreshTimer = null;
            const doRefresh = (preserveScroll = false) => {
                if (generation !== this._generation) return;
                lastRefreshTs = Date.now();
                refreshOpenHistoryLists(preserveScroll);
            };
            const throttledRefresh = (force = false) => {
                if (force) {
                    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
                    doRefresh(true);
                    return;
                }
                const elapsed = Date.now() - lastRefreshTs;
                if (elapsed >= 200) { doRefresh(true); return; }
                if (refreshTimer) return;
                refreshTimer = setTimeout(() => {
                    refreshTimer = null;
                    doRefresh(true);
                }, 200 - elapsed);
            };

            const processBatch = () => {
                if (generation !== this._generation) return;

                const newKeys = [];
                let processed = 0;
                const startTime = nowHighRes();

                while (cursor < keys.length && processed < HARD_BATCH) {
                    if (processed > 0 && (nowHighRes() - startTime > TIME_BUDGET_MS)) break;
                    const key = keys[cursor++];
                    processed++;
                    try {
                        const items = RecordNormalizer.expandToIndexItems(key, GM_getValue(key));
                        for (const item of items) {
                            itemsByKey[item.key] = item;
                            newKeys.push(item.key);
                        }
                    } catch (err) {
                        // 单条损坏记录不阻断其余历史
                    }
                }

                if (newKeys.length) {
                    this._mergeSnapshotsIntoLatest(latestSnapshots, itemsByKey, newKeys, CONFIG.RECENT_SNAPSHOT_COUNT);
                    this._mergeSnapshotsIntoHot(hotSnapshots, itemsByKey, newKeys, CONFIG.RECENT_SNAPSHOT_COUNT);
                }

                if (cursor < keys.length) {
                    this._index = {
                        version: HISTORY_VIEW_INDEX_VERSION,
                        itemsByKey,
                        sortedKeys: Object.keys(itemsByKey),
                        latestSnapshots,
                        hotSnapshots,
                        building: true
                    };
                    this._ready = false;
                    // 后台分批构建时也通知角标；已有索引项可以先显示，后续批次再刷新。
                    window.dispatchEvent(new CustomEvent('bvh-history-index-updated'));
                    this._scheduleRecentCacheSave();
                    throttledRefresh();
                    runWhenIdle(processBatch, 1000);
                    return;
                }

                for (const [changedKey, change] of this._pendingChanges) {
                    for (const itKey of Object.keys(itemsByKey)) {
                        const it = itemsByKey[itKey];
                        if (itKey === changedKey || it?.collectionKey === changedKey || it?.containerKey === changedKey || it?.bvKey === changedKey) delete itemsByKey[itKey];
                    }
                    if (!change.deleted) {
                        const items = RecordNormalizer.expandToIndexItems(changedKey, change.value);
                        for (const item of items) itemsByKey[item.key] = item;
                    }
                }
                this._pendingChanges.clear();
                this._building = false;
                this._rebuild(itemsByKey, true, hotSnapshots);
                throttledRefresh(true);
            };

            runWhenIdle(processBatch, 500);
        },

        // 把单条记录的新增、修改或删除同步到索引；构建期间则暂存变更。
        updateKey(key, rawValue, deleted = false) {
            if (!RecordKey.isRecordKey(key)) return;
            if (this._building) {
                this._pendingChanges.set(key, { value: rawValue, deleted });
                return;
            }
            if (!this._index) return;
            this._dirtyKeys.add(key);
            // 先删除该 key 对应的全部索引条目（含容器展开的分集条目）。
            const removeMatching = () => {
                const ibk = this._index.itemsByKey;
                for (const itKey of Object.keys(ibk)) {
                    const it = ibk[itKey];
                    if (itKey === key || it?.collectionKey === key || it?.containerKey === key || it?.bvKey === key) delete ibk[itKey];
                }
            };
            removeMatching();
            if (!deleted) {
                const items = RecordNormalizer.expandToIndexItems(key, rawValue);
                for (const item of items) this._index.itemsByKey[item.key] = item;
            }
            this._scheduleRefresh();
        },

        // 清空内存状态和持久化索引，使下一次读取重新构建。
        reset() {
            this._index = null;
            this._ready = false;
            this._building = false;
            this._generation++;
            this._pendingChanges.clear();
            this._dirtyKeys.clear();
            if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
            if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
            if (this._recentCacheSaveTimer) { clearTimeout(this._recentCacheSaveTimer); this._recentCacheSaveTimer = null; }
            this._recentCacheMemory = null;
            this._recentCacheLoaded = false;
            this._ensureAfterPaintScheduled = false;
            GM_deleteValue(HISTORY_VIEW_INDEX_KEY);
        }
    };

    // 只刷新当前已经打开的历史列表，并保留用户正在输入的搜索条件。
    // 【模块：刷新已打开的历史列表】
    // 当存储记录发生增删改或跨标签页同步时，通知当前页面中已打开的列表重新读取数据并渲染。
    // 根据参数决定是否尽量保留当前滚动位置，避免同步更新打断用户正在浏览的位置。
    function refreshOpenHistoryLists(preserveScroll = false) {
        const pagePanel = document.getElementById('bvh-history-page-panel');
        if (pagePanel && pagePanel.classList.contains('bvh-hp-show')) {
            const listDom = document.getElementById('bvh-hp-list');
            const searchInput = document.getElementById('bvh-hp-search');
            if (pagePanel.classList.contains('bvh-resizing')) {
                pagePanel.dataset.bvhRefreshPending = 'true';
            } else if (listDom) {
                HistoryListRenderer.renderInto(listDom, searchInput?.value || '', 'history-page', {
                    preserveScrollTop: preserveScroll ? listDom.scrollTop : null
                });
            }
        }
        const legacyPanel = document.getElementById('bvh-history-panel');
        if (legacyPanel && legacyPanel.style.display === 'block') {
            const listDom = document.getElementById('bvh-history-list');
            const searchInput = document.getElementById('bvh-history-search');
            if (legacyPanel.classList.contains('bvh-resizing')) {
                legacyPanel.dataset.bvhRefreshPending = 'true';
            } else if (listDom) {
                HistoryListRenderer.renderInto(listDom, searchInput?.value || '', 'playback', {
                    preserveScrollTop: preserveScroll ? listDom.scrollTop : null
                });
            }
        }
    }
    // ── 记录存取：GM_setValue/GM_getValue 的统一封装，负责索引维护与跨标签页广播 ──
    // 【模块：原始记录存储与一致性维护】
    // 封装记录的读、写、删除、容器/分集合并、快速键索引维护，以及本地与其他标签页之间的变更通知。
    // 本地原始记录是唯一事实来源；键索引和视图索引只用于加速查找，必须能在必要时重建。
    // 涉及番剧 ep→ss、合集 parts[]、旧扁平记录兼容的操作，均应通过这里的统一入口保持一致。
    const RecordStore = {
        _keyIndex: null,

        // 按需建立记录分组索引，避免每次查找都遍历全部存储键。
        _ensureKeyIndex() {
            if (this._keyIndex) return this._keyIndex;
            this._keyIndex = new Map();
            GM_listValues().filter(k => RecordKey.isRecordKey(k)).forEach(k => this._addToIndex(k));
            return this._keyIndex;
        },

        // 把记录键加入对应内容组。
        _addToIndex(key) {
            if (!this._keyIndex || !RecordKey.isRecordKey(key)) return;
            const groupKey = RecordKey.getGroupKey(key);
            if (!groupKey) return;
            if (!this._keyIndex.has(groupKey)) this._keyIndex.set(groupKey, new Set());
            this._keyIndex.get(groupKey).add(key);
        },

        // 从内容组中移除记录键，并清理空分组。
        _removeFromIndex(key) {
            if (!this._keyIndex || !RecordKey.isRecordKey(key)) return;
            const groupKey = RecordKey.getGroupKey(key);
            if (!groupKey) return;
            const keys = this._keyIndex.get(groupKey);
            if (!keys) return;
            keys.delete(key);
            if (keys.size === 0) this._keyIndex.delete(groupKey);
        },

        // 根据存储中的最新状态更新分组索引。
        _refreshIndexKey(key) {
            if (!this._keyIndex || !RecordKey.isRecordKey(key)) return;
            if (GM_getValue(key, null) === null) this._removeFromIndex(key);
            else this._addToIndex(key);
        },

        // 清空内存中的分组索引，后续访问时重新建立。
        clearIndex() {
            // 置空而不是只清空 Map；否则 _ensureKeyIndex 会误以为索引已建立，后续永远漏掉旧记录。
            this._keyIndex = null;
        },

        // 读取同一内容组的记录，归一化后按最近观看时间排序。
        getGroupRecords(groupKey) {
            const keys = this._ensureKeyIndex().get(groupKey);
            if (!keys || keys.size === 0) return [];
            const out = [];
            keys.forEach(k => {
                const rec = RecordNormalizer.normalize(GM_getValue(k));
                if (rec) out.push({ key: k, ...rec });
            });
            out.sort((a, b) => Number(b.lastTs || 0) - Number(a.lastTs || 0));
            return out;
        },

        // 向当前页面发送记录变更事件，通知其他界面刷新相关内容。
        notifyChange(key, source = 'local') {
            if (!RecordKey.isRecordKey(key)) return;
            window.dispatchEvent(new CustomEvent(RECORD_CHANGE_EVENT, {
                detail: {
                    key,
                    bvid: (key.match(/^BV[a-zA-Z0-9]+/) || key.match(/^(?:ss|ep)\d+/i) || [key])[0],
                    source
                }
            }));
        },

        // 本地记录变化后同时触发页面事件和油猴跨标签页通知。
        _broadcast(key) {
            if (!RecordKey.isRecordKey(key)) return;
            this.notifyChange(key, 'local');
            GM_setValue(RECORD_CHANGE_SIGNAL_KEY, {
                key,
                ts: Date.now(),
                nonce: Math.random().toString(36).slice(2)
            });
        },

        // 读取已备份记录标记，并确保返回值为对象。
        _exportedMap() {
            const value = GM_getValue(EXPORTED_RECORDS_KEY, {});
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        },

        // 记录发生修改后移除旧的已备份标记，避免把未重新备份的数据误认为已备份。
        _clearExportedMark(key) {
            if (!RecordKey.isRecordKey(key)) return;
            const exported = this._exportedMap();
            if (Object.prototype.hasOwnProperty.call(exported, key)) {
                delete exported[key];
                GM_setValue(EXPORTED_RECORDS_KEY, exported);
            }
        },

        // 写入记录后同步维护分组索引、视图索引、备份标记和跨标签通知。
        set(key, value) {
            GM_setValue(key, value);
            this._addToIndex(key);
            HistoryViewIndex.updateKey(key, value, false);
            this._clearExportedMark(key);
            this._broadcast(key);
        },

        // 删除记录并同步清理索引、备份标记及跨标签通知。
        // 5.3.0：删除分P键时映射到容器——删对应 part，而非整个容器；parts 清空则删容器。
        delete(key) {
            if (RecordKey.isEpisodeKey(key)) {
                const epKey = String(key).toLowerCase();
                for (const seasonKey of GM_listValues().filter(k => RecordKey.isSeasonKey(k))) {
                    const season = RecordNormalizer.normalize(GM_getValue(seasonKey, null));
                    if (!season || season.type !== 'collection') continue;
                    const before = season.parts.length;
                    season.parts = season.parts.filter(part => String(part.bv || part.epKey || '').toLowerCase() !== epKey);
                    if (season.parts.length !== before) {
                        if (season.parts.length || season.legacyAggregate) this.set(seasonKey, RecordNormalizer.normalize(season));
                        else this.deleteRaw(seasonKey);
                        this._clearExportedMark(epKey);
                        this._broadcast(epKey);
                        return;
                    }
                }
            }
            if (RecordKey.isPartKey(key)) {
                const m = String(key).match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                const bv = m[1], p = Number(m[2]);
                const container = RecordNormalizer.normalize(GM_getValue(bv, null));
                if (container && container.type === 'collection') {
                    const idx = container.parts.findIndex(pp => pp.p === p);
                    if (idx >= 0) container.parts.splice(idx, 1);
                    if (container.parts.length) {
                        this.set(bv, RecordNormalizer.normalize(container));
                        return;
                    }
                    // parts 已空 → 落到下面删除整个容器。
                }
            }
            GM_deleteValue(key);
            this._removeFromIndex(key);
            HistoryViewIndex.updateKey(key, null, true);
            this._clearExportedMark(key);
            this._broadcast(key);
        },

        // 5.3.0：直接删除一个原始存储键（不经过容器感知），供迁移/合集修复删除旧扁平键时使用。
        deleteRaw(key) {
            if (GM_getValue(key, null) === null) return;
            GM_deleteValue(key);
            this._removeFromIndex(key);
            HistoryViewIndex.updateKey(key, null, true);
            this._clearExportedMark(key);
            this._broadcast(key);
        },

        // 5.3.0：统一写入入口——把一条记录（可能是分P）合并进合集容器，或作为单视频扁平存储。
        // options 可带：partTitle/partNumber/partTotal/containerTitle/collectionKey/smallCollectionTitle/collectionOrder/isCollection
        // 容器判定：分P(BV?p=N)、明确合集(isCollection/partTotal>1)、或本地已存在同BV容器。
        upsertRecord(key, record, options = {}) {
            if (!record || typeof record !== 'object') return;
            const episodeKey = String(options.episodeKey || (RecordKey.isEpisodeKey(String(key || '')) ? key : '')).toLowerCase();
            let seasonKey = String(options.seasonKey || (episodeKey && (Number(options.seasonId) || Number(record.seasonId)) ? `ss${Number(options.seasonId) || Number(record.seasonId)}` : '')).toLowerCase();
            // ep 永远是分集身份，不允许落入通用合集分支而生成 ep-key 的 collection 容器。
            // 若当前页面未提供 seasonId，先用已有 ss.parts 中的精确 ep 身份反查所属整季。
            if (episodeKey && RecordKey.isEpisodeKey(episodeKey) && !RecordKey.isSeasonKey(seasonKey)) {
                for (const candidateKey of GM_listValues()) {
                    if (!RecordKey.isSeasonKey(candidateKey)) continue;
                    const candidate = RecordNormalizer.normalize(GM_getValue(candidateKey, null));
                    if (candidate?.type === 'collection' && candidate.parts.some(part =>
                        [part.bv, part.epKey].some(value => String(value || '').trim().toLowerCase() === episodeKey)
                    )) {
                        seasonKey = String(candidateKey).toLowerCase();
                        break;
                    }
                }
            }
            const mergeLegacyEpisodeData = () => {
                const oldEpisode = RecordNormalizer.normalize(GM_getValue(episodeKey, null));
                if (!oldEpisode) return oldEpisode;
                let oldData = oldEpisode;
                if (oldEpisode.type === 'collection' && Array.isArray(oldEpisode.parts)) {
                    oldData = oldEpisode.parts.find(part =>
                        [part.bv, part.epKey].some(value => String(value || '').trim().toLowerCase() === episodeKey)
                    ) || (oldEpisode.parts.length === 1 ? oldEpisode.parts[0] : null);
                }
                if (!oldData) return oldEpisode;
                const snaps = new Map();
                for (const snap of [...(oldData.snapshots || []), ...(record.snapshots || [])]) {
                    if (!snap || typeof snap !== 'object') continue;
                    const sig = `${Number(snap.ts) || 0}|${snap.pos == null ? '' : Number(snap.pos)}|${String(snap.progress || '')}|${snap.completed === true ? 1 : 0}`;
                    const previous = snaps.get(sig);
                    if (!previous || String(snap.watchTimeStr || '').length > String(previous.watchTimeStr || '').length) snaps.set(sig, snap);
                }
                record.snapshots = RecordNormalizer.keepSnapshotsWithinLimit([...snaps.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
                record.watchCount = Math.max(Number(record.watchCount) || 0, Number(oldData.watchCount) || 0, record.snapshots.length);
                if (Number(oldData.lastTs || 0) > Number(record.lastTs || 0)) {
                    record.lastTs = Number(oldData.lastTs) || 0;
                    record.lastProgress = oldData.lastProgress || record.lastProgress || '0%';
                }
                if (!record.title && oldData.title) record.title = oldData.title;
                if (!record.authorName && oldData.authorName) record.authorName = oldData.authorName;
                return oldEpisode;
            };
            if (episodeKey && RecordKey.isEpisodeKey(episodeKey)) {
                const oldEpisode = mergeLegacyEpisodeData();
                if (RecordKey.isSeasonKey(seasonKey)) {
                    const unsafeLegacyCollection = oldEpisode?.type === 'collection'
                        && Array.isArray(oldEpisode.parts)
                        && oldEpisode.parts.length > 1;
                    if (unsafeLegacyCollection) {
                        console.warn(`${TAG} [番剧分集写入] ${episodeKey} 存在无法安全识别的旧多分集容器，暂不覆盖或删除以避免丢数据。`);
                        return;
                    }
                    const container = this._mergeEpisodeIntoSeason(seasonKey, episodeKey, record, options);
                    this.set(seasonKey, container);
                    // 只有能确定旧 ep 键的数据已并入当前分集时才删除重复键。
                    if (GM_getValue(episodeKey, null) !== null && (!oldEpisode || oldEpisode.type !== 'collection' || oldEpisode.parts.length === 1)) this.deleteRaw(episodeKey);
                    return;
                }
                // ep 只能作为 ss.parts[] 内的分集身份，绝不再写成独立顶层记录。
                // 如果页面没有提供 seasonId，且本地也找不到该 ep 所属 ss，则停止本次写入；
                // 旧 ep 键原样保留，等待后续有明确归属时迁移，避免丢失观看事实。
                console.warn(`${TAG} [番剧分集写入] ${episodeKey} 未能确定所属 ss 整季，跳过写入以避免生成独立 ep 记录或错误归季。`);
                return;
            }
            const s = String(key || '');
            let bv = s, p = 1;
            const pm = s.match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
            if (pm) { bv = pm[1]; p = Number(pm[2]); }
            else if (RecordKey.isPlainBvKey(s)) { bv = s; p = 1; }
            const partTotal = Number(options.partTotal) || Number(record.partTotal) || 0;
            const existingContainer = RecordNormalizer.normalize(GM_getValue(bv, null));
            const hasContainer = !!(existingContainer && existingContainer.type === 'collection');
            const shouldContainer = RecordKey.isPartKey(s) || options.isCollection === true || partTotal > 1 || hasContainer;
            if (!shouldContainer) {
                // 普通视频写入前统一归一化：自动省略空的合集/分集专用字段，不改变观看事实。
                this.set(s, RecordNormalizer.normalize(record) || record);
                return;
            }
            // 首次建容器前，把本地已存在的同BV扁平记录（BV 单视频、BV?p=*）一并并入，避免丢失。
            if (!hasContainer) {
                const rawFlat = GM_getValue(bv, null);
                if (rawFlat && typeof rawFlat === 'object' && !Array.isArray(rawFlat) && !rawFlat.type) {
                    this._mergePartIntoContainer(bv, RecordNormalizer.normalize(rawFlat), { partNumber: 1 });
                }
                for (const k of GM_listValues()) {
                    if (k === s || k === bv) continue;
                    if (RecordKey.isPartKey(k)) {
                        const m = k.match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                        if (m && m[1] === bv) {
                            this._mergePartIntoContainer(bv, RecordNormalizer.normalize(GM_getValue(k, null)), { partNumber: Number(m[2]) });
                        }
                    }
                }
            }
            const container = this._mergePartIntoContainer(bv, record, {
                ...options,
                partNumber: Number(options.partNumber) || p,
                partTotal
            });
            if (!container) return;
            this.set(bv, container);
            // 旧扁平分P键若存在且与容器键不同 → 删除（已并入容器；用 deleteRaw 避免容器感知误删刚并入的 part）
            for (const k of GM_listValues()) {
                if (k === bv) continue;
                if (k === s || RecordKey.isPartKey(k)) {
                    const m = k.match(/^(BV[a-zA-Z0-9]+)(?:\?p=(\d+))?$/i);
                    if (m && m[1] === bv && GM_getValue(k, null) !== null) this.deleteRaw(k);
                }
            }
        },

        // 番剧/电视剧统一使用整季 ss 容器，单集 ep 作为 parts[] 中的独立观看实体。
        // 每集独立保留次数、快照、标题；整季统计由索引层聚合，避免不同集的记录混在一起。
        _mergeEpisodeIntoSeason(seasonKey, episodeKey, record, options = {}) {
            const sid = Number(options.seasonId) || Number(String(seasonKey).replace(/^ss/i, '')) || Number(record.seasonId) || 0;
            const old = RecordNormalizer.normalize(GM_getValue(seasonKey, null));
            const container = old && old.type === 'collection'
                ? old
                : {
                    type: 'collection', key: seasonKey, title: '', authorName: record.authorName || '', mediaType: record.mediaType || '番剧',
                    collectionKey: `season:${sid || seasonKey}`, parts: [], schemaVersion: 4,
                    ...(old && !old.type ? { legacyAggregate: { title: old.title || '', watchCount: Number(old.watchCount) || 0, lastTs: Number(old.lastTs) || 0, lastProgress: old.lastProgress || '0%', snapshots: Array.isArray(old.snapshots) ? old.snapshots : [], hasReachedWatchThreshold: old.hasReachedWatchThreshold === true } } : {})
                };
            const seriesTitle = String(options.containerTitle || record.collectionTitle || '').trim();
            // 仅当明确拿到系列级 key 时，才把旧的“第 N 季”容器标题升级为系列标题。
            // 不写入空字段，也不覆盖无法确认系列身份的旧记录。
            if (seriesTitle && (String(options.collectionKey || '').startsWith('series:') || !container.title || container.title === seasonKey)) {
                container.title = seriesTitle;
            }
            container.mediaType = /电视剧|番剧|电影|纪录片/.test(String(record.mediaType || container.mediaType || '番剧')) ? String(record.mediaType || container.mediaType) : '番剧';
            container.collectionKey = String(options.collectionKey || container.collectionKey || `season:${sid || seasonKey}`);

            // 旧版可能把 ss 整季自身的累计记录误写成 p=1 的 part（无 epKey、bv=ss、无标题/总集数）。
            // 这类数据无法证明属于第 1 集，必须原样保存在 legacyAggregate，不能误分配给 ep1。
            const ambiguousSeasonRows = container.parts.filter(item =>
                ![item.bv, item.epKey].some(value => /^ep\d+$/i.test(String(value || '').trim())) &&
                Number(item.p) === 1 &&
                !String(item.title || item.partTitle || '').trim() &&
                !(Number(item.partTotal) > 0) &&
                !(Number(item.collectionOrder) > 0) &&
                String(item.bv || '').toLowerCase() === String(seasonKey).toLowerCase()
            );
            if (ambiguousSeasonRows.length) {
                const oldAggregate = container.legacyAggregate && typeof container.legacyAggregate === 'object'
                    ? { ...container.legacyAggregate }
                    : {};
                const snapMap = new Map();
                for (const snap of [...(oldAggregate.snapshots || []), ...ambiguousSeasonRows.flatMap(item => item.snapshots || [])]) {
                    if (!snap || typeof snap !== 'object') continue;
                    const sig = `${Number(snap.ts) || 0}|${snap.pos == null ? '' : Number(snap.pos)}|${String(snap.progress || '')}|${snap.completed === true ? 1 : 0}`;
                    const previous = snapMap.get(sig);
                    if (!previous || String(snap.watchTimeStr || '').length > String(previous.watchTimeStr || '').length) snapMap.set(sig, snap);
                }
                const aggregateSnapshots = [...snapMap.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
                const latestAggregateRow = [...ambiguousSeasonRows].sort((a, b) => Number(b.lastTs || 0) - Number(a.lastTs || 0))[0];
                container.legacyAggregate = {
                    ...oldAggregate,
                    title: oldAggregate.title || container.title || '',
                    watchCount: Math.max(Number(oldAggregate.watchCount) || 0, ...ambiguousSeasonRows.map(item => Number(item.watchCount) || 0), aggregateSnapshots.length),
                    lastTs: Math.max(Number(oldAggregate.lastTs) || 0, ...ambiguousSeasonRows.map(item => Number(item.lastTs) || 0)),
                    lastProgress: Number(latestAggregateRow?.lastTs || 0) >= Number(oldAggregate.lastTs || 0)
                        ? (latestAggregateRow?.lastProgress || oldAggregate.lastProgress || '0%')
                        : (oldAggregate.lastProgress || '0%'),
                    snapshots: RecordNormalizer.keepSnapshotsWithinLimit(aggregateSnapshots),
                    hasReachedWatchThreshold: oldAggregate.hasReachedWatchThreshold === true || ambiguousSeasonRows.some(item => item.hasReachedWatchThreshold === true)
                };
                container.parts = container.parts.filter(item => !ambiguousSeasonRows.includes(item));
            }

            const title = String(options.partTitle || record.partTitle || record.title || '').trim();
            const titleEpisodeNumber = title.match(/第\s*(\d+)\s*集/);
            // 切换刚发生而页面集列表尚未同步时，不能用旧标题/旧 active 节点推导集号。
            const episodeNumberVerified = options.disallowLegacyPartFallback !== true;
            const explicitP = episodeNumberVerified
                ? (Number(options.partNumber) || Number(record.partNumber) || (titleEpisodeNumber ? Number(titleEpisodeNumber[1]) : 0))
                : 0;
            const existingExact = container.parts.find(item =>
                [item.bv, item.epKey].some(value => String(value || '').trim().toLowerCase() === episodeKey)
            );
            // 旧结构按 p 接回只允许使用当前 ep 链接证实的集号；没有证据就新建独立 ep 身份，不能吞并别集。
            const legacyPart = !existingExact && episodeNumberVerified && explicitP > 0
                ? container.parts.find(item =>
                    ![item.bv, item.epKey].some(value => /^ep\d+$/i.test(String(value || '').trim())) &&
                    Number(item.p) === explicitP &&
                    (!String(item.bv || '').trim() ||
                     String(item.bv || '').toLowerCase() === String(seasonKey).toLowerCase() ||
                     String(item.bv || '').toLowerCase() === `ss${sid}`)
                )
                : null;
            let part = existingExact || legacyPart;
            if (!part) {
                part = { p: explicitP || (options.disallowLegacyPartFallback === true ? 0 : container.parts.length + 1), bv: episodeKey, epKey: episodeKey, seasonId: sid, sectionTitle: String(options.sectionTitle || record.sectionTitle || '').trim(), title: '', partTotal: Number(options.partTotal) || 0, lastTs: 0, lastProgress: '0%', watchCount: 0, snapshots: [], hasReachedWatchThreshold: false, officialHistorySeen: false };
                container.parts.push(part);
            }
            const p = explicitP || Number(part.p) || (options.disallowLegacyPartFallback === true ? 0 : container.parts.length);
            // 如果之前已经生成了 epKey 分集，同时还残留一条旧的 ss-bv 同 p 分集，
            // 把旧分集的快照/观看信息并入标准分集后再移除旧项，避免重复或丢数据。
            const duplicateLegacyParts = container.parts.filter(item =>
                options.disallowLegacyPartFallback !== true &&
                item !== part &&
                ![item.bv, item.epKey].some(value => /^ep\d+$/i.test(String(value || '').trim())) &&
                Number(item.p) === p &&
                (!String(item.bv || '').trim() ||
                 String(item.bv || '').toLowerCase() === String(seasonKey).toLowerCase() ||
                 String(item.bv || '').toLowerCase() === `ss${sid}`)
            );
            for (const legacy of duplicateLegacyParts) {
                const snapMap = new Map();
                for (const snap of [...(part.snapshots || []), ...(legacy.snapshots || [])]) {
                    if (!snap || typeof snap !== 'object') continue;
                    const sig = `${Number(snap.ts) || 0}|${snap.pos == null ? '' : Number(snap.pos)}|${String(snap.progress || '')}|${snap.completed === true ? 1 : 0}`;
                    const previous = snapMap.get(sig);
                    if (!previous || String(snap.watchTimeStr || '').length > String(previous.watchTimeStr || '').length) snapMap.set(sig, snap);
                }
                part.snapshots = [...snapMap.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
                part.watchCount = Math.max(Number(part.watchCount) || 0, Number(legacy.watchCount) || 0, part.snapshots.length);
                if (Number(legacy.lastTs || 0) > Number(part.lastTs || 0)) {
                    part.lastTs = Number(legacy.lastTs);
                    part.lastProgress = legacy.lastProgress || part.lastProgress || '0%';
                }
                if (!part.title && legacy.title) part.title = legacy.title;
                part.partTotal = Math.max(Number(part.partTotal) || 0, Number(legacy.partTotal) || 0);
                part.hasReachedWatchThreshold = part.hasReachedWatchThreshold === true || legacy.hasReachedWatchThreshold === true;
                part.officialHistorySeen = part.officialHistorySeen === true || legacy.officialHistorySeen === true;
                container.parts = container.parts.filter(item => item !== legacy);
            }
            part.p = p;
            part.bv = episodeKey;
            part.epKey = episodeKey;
            if (sid) part.seasonId = sid;
            if (title) part.title = title;
            if (options.sectionTitle || record.sectionTitle) part.sectionTitle = String(options.sectionTitle || record.sectionTitle).trim();
            const smallCollectionTitle = String(options.smallCollectionTitle || record.smallCollectionTitle || '').trim();
            if (smallCollectionTitle) part.smallCollectionTitle = smallCollectionTitle;
            if (options.seasonTitleVerified === true && smallCollectionTitle) part.seasonTitleVerified = true;
            part.partTotal = Math.max(Number(part.partTotal) || 0, Number(options.partTotal) || 0);
            const snapshots = new Map();
            [...(part.snapshots || []), ...(record.snapshots || [])].forEach(snap => {
                if (!snap || typeof snap !== 'object') return;
                const sig = `${Number(snap.ts) || 0}|${snap.pos == null ? '' : Number(snap.pos)}|${String(snap.progress || '')}|${snap.completed === true ? 1 : 0}`;
                const previous = snapshots.get(sig);
                if (!previous || String(snap.watchTimeStr || '').length > String(previous.watchTimeStr || '').length) snapshots.set(sig, snap);
            });
            part.snapshots = RecordNormalizer.keepSnapshotsWithinLimit([...snapshots.values()].sort((a,b) => Number(a.ts || 0) - Number(b.ts || 0)));
            part.watchCount = Math.max(Number(part.watchCount) || 0, Number(record.watchCount) || 0, part.snapshots.length);
            if (Number(record.lastTs || 0) >= Number(part.lastTs || 0)) {
                part.lastTs = Number(record.lastTs) || Number(part.lastTs) || 0;
                part.lastProgress = record.lastProgress || part.lastProgress || '0%';
            }
            part.hasReachedWatchThreshold = part.hasReachedWatchThreshold === true || record.hasReachedWatchThreshold === true;
            part.officialHistorySeen = part.officialHistorySeen === true || record.officialHistorySeen === true;
            container.parts.sort((a,b) => (Number(a.p) || 0) - (Number(b.p) || 0));
            return RecordNormalizer.normalize(container);
        },

        // 5.3.0：把一条扁平记录合并进容器对应分集（p）。
        // 标题优先级：分集标题取选集(options.partTitle)/已有，合集标题取播放页合集框(containerTitle)>视频页>官方；分集标题缺失时保持已有不覆盖。
        _mergePartIntoContainer(containerKey, record, options = {}) {
            const existing = RecordNormalizer.normalize(GM_getValue(containerKey, null));
            const container = existing && existing.type === 'collection'
                ? existing
                : { type: 'collection', key: containerKey, title: '', authorName: '', mediaType: '视频', parts: [], schemaVersion: 4 };
            const p = Math.max(1, Number(options.partNumber) || 1);
            // 合集标题优先级：播放页合集框/视频页(containerTitle) > 已有 > 官方(record.collectionTitle||title)
            if (options.containerTitle) container.title = String(options.containerTitle).trim();
            else if (!container.title && (record.collectionTitle || record.title)) container.title = String(record.collectionTitle || record.title || '').trim();
            if (!container.authorName && record.authorName) container.authorName = String(record.authorName).trim();
            if (record.mediaType && record.mediaType !== '视频') container.mediaType = record.mediaType;
            // 稳定归属键（collectionKey）：优先播放页传入的指纹；已有非空值不被空值覆盖；缺省可从记录继承。
            if (options.collectionKey) container.collectionKey = String(options.collectionKey);
            else if (!container.collectionKey && record.collectionKey) container.collectionKey = String(record.collectionKey);

            const incomingTitle = String(options.partTitle || record.partTitle || '').trim();
            const suppliedPartKey = String(options.partKey || record.bv || record.bvid || '').trim();
            let completePartKey = '';
            if (/^BV[a-zA-Z0-9]+(?:\?p=\d+)?$/i.test(suppliedPartKey)) {
                const suppliedMatch = suppliedPartKey.match(/^(BV[a-zA-Z0-9]+)(?:\?p=(\d+))?$/i);
                const suppliedBv = suppliedMatch[1];
                const suppliedPage = Number(suppliedMatch[2]) || 1;
                completePartKey = suppliedPage > 1
                    ? `${suppliedBv}?p=${suppliedPage}`
                    : (suppliedBv.toUpperCase() === String(containerKey).split('?')[0].toUpperCase() && p > 1 ? `${suppliedBv}?p=${p}` : suppliedBv);
            } else if (/^BV[a-zA-Z0-9]+$/i.test(String(containerKey))) {
                completePartKey = `${containerKey}${p > 1 ? `?p=${p}` : ''}`;
            } else {
                completePartKey = suppliedPartKey || String(containerKey);
            }
            const wantedBase = completePartKey.split('?')[0].toLowerCase();
            const wantedPage = Number((completePartKey.match(/[?&]p=(\d+)/i) || [])[1]) || 1;
            // 优先按完整分集身份匹配。仅同 BV 多P 容器才允许用 p 作为身份兜底；
            // 跨 BV 合集不能因为顺序号相同就把另一个视频的快照覆盖掉。
            const existingPart = container.parts.find(pp => String(pp.bv || '').trim().toLowerCase() === completePartKey.toLowerCase())
                || container.parts.find(pp => {
                    const oldKey = String(pp.bv || '').trim();
                    if (!oldKey) return Number(pp.p) === p; // 无身份的旧分集允许按序号接回
                    const oldBase = oldKey.split('?')[0].toLowerCase();
                    const oldPage = Number((oldKey.match(/[?&]p=(\d+)/i) || [])[1]) || 1;
                    const sameVideo = oldBase === wantedBase;
                    const sameContainerBv = /^BV[a-z0-9]+$/i.test(String(containerKey))
                        && oldBase === String(containerKey).toLowerCase()
                        && wantedBase === String(containerKey).toLowerCase();
                    return Number(pp.p) === p && sameVideo && (oldPage === wantedPage || sameContainerBv);
                });
            if (existingPart) {
                existingPart.bv = completePartKey;
                const snapMap = new Map();
                for (const s of [...(existingPart.snapshots || []), ...(record.snapshots || [])]) {
                    if (!s || typeof s !== 'object') continue;
                    const sig = `${Number(s.ts) || 0}|${s.pos == null ? '' : Number(s.pos)}|${String(s.progress || '')}|${s.completed === true ? 1 : 0}`;
                    const old = snapMap.get(sig);
                    if (!old || String(s.watchTimeStr || '').length > String(old.watchTimeStr || '').length) snapMap.set(sig, s);
                }
                existingPart.snapshots = RecordNormalizer.keepSnapshotsWithinLimit([...snapMap.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
                existingPart.watchCount = Math.max(Number(existingPart.watchCount) || 0, Number(record.watchCount) || 0, existingPart.snapshots.length);
                if (incomingTitle) existingPart.title = incomingTitle;
                if (Number(record.lastTs || 0) > Number(existingPart.lastTs || 0)) {
                    existingPart.lastTs = Number(record.lastTs);
                    existingPart.lastProgress = record.lastProgress || existingPart.lastProgress;
                }
                existingPart.partTotal = Math.max(Number(existingPart.partTotal) || 0, Number(options.partTotal) || 0);
                if (record.hasReachedWatchThreshold === true) existingPart.hasReachedWatchThreshold = true;
                if (record.officialHistorySeen === true) existingPart.officialHistorySeen = true;
                if (options.smallCollectionTitle) existingPart.smallCollectionTitle = String(options.smallCollectionTitle).trim();
                if (Number.isFinite(Number(options.collectionOrder)) && Number(options.collectionOrder) >= 0) existingPart.collectionOrder = Math.floor(Number(options.collectionOrder));
            } else {
                const snapshots = (Array.isArray(record.snapshots) ? record.snapshots : [])
                    .filter(s => s && typeof s === 'object')
                    .map(s => ({ ...s }));
                const part = {
                    p, bv: completePartKey,
                    title: incomingTitle || '',
                    partTotal: Number(options.partTotal) || Number(record.partTotal) || 0,
                    smallCollectionTitle: String(options.smallCollectionTitle || record.smallCollectionTitle || '').trim(),
                    collectionOrder: Number.isFinite(Number(options.collectionOrder)) ? Math.floor(Number(options.collectionOrder)) : (Number.isFinite(Number(record.collectionOrder)) ? Math.floor(Number(record.collectionOrder)) : 0),
                    lastTs: Number(record.lastTs) || 0,
                    lastProgress: record.lastProgress || '0%',
                    watchCount: Math.max(1, Number(record.watchCount) || 0, snapshots.length),
                    snapshots: RecordNormalizer.keepSnapshotsWithinLimit(snapshots),
                    hasReachedWatchThreshold: record.hasReachedWatchThreshold === true,
                    officialHistorySeen: record.officialHistorySeen === true,
                    emptyRecord: false
                };
                container.parts.push(part);
            }
            container.parts.sort((a, b) => a.p - b.p);
            return RecordNormalizer.normalize(container);
        },

        // 播放页读取 ep 历史的只读入口：只按真实 ep 身份精确匹配，不按 p 猜集、不迁移、不写入。
        // 悬浮窗渲染和暂停前读取都必须是纯读取；按集数回填旧 ss part 只能留在明确的写入/修复流程。
        readEpisodeExact(key) {
            const episodeKey = String(key || '').trim().toLowerCase();
            if (!RecordKey.isEpisodeKey(episodeKey)) return null;

            const asFlat = (part, container = null) => ({
                key: episodeKey,
                ...part,
                bv: episodeKey,
                title: part.title || part.partTitle || '',
                collectionTitle: part.collectionTitle || container?.title || container?.collectionTitle || '',
                collectionKey: part.collectionKey || container?.collectionKey || '',
                mediaType: part.mediaType || container?.mediaType || '番剧',
                authorName: part.authorName || container?.authorName || '',
                snapshots: [...(Array.isArray(part.snapshots) ? part.snapshots : [])]
            });
            const matchesEpisode = part => part && [
                part.bv, part.epKey, part.episodeKey, part.key, part.bvid, part.bvKey
            ].some(value => String(value || '').trim().toLowerCase() === episodeKey);

            try {
                const direct = RecordNormalizer.normalize(GM_getValue(episodeKey, null));
                if (direct && direct.type !== 'collection') {
                    return { key: episodeKey, bv: episodeKey, p: Number(direct.p) || 0, container: null, part: direct, flat: asFlat(direct) };
                }
                if (direct?.type === 'collection' && Array.isArray(direct.parts)) {
                    const part = direct.parts.find(matchesEpisode);
                    if (part) return { key: episodeKey, bv: episodeKey, p: Number(part.p) || 0, container: direct, part, flat: asFlat(part, direct) };
                }

                // 只扫描 ss 原始容器，并且要求分集内部的身份字段精确命中当前 ep。
                for (const seasonKey of GM_listValues().filter(RecordKey.isSeasonKey)) {
                    let container = null;
                    try { container = RecordNormalizer.normalize(GM_getValue(seasonKey, null)); } catch (_) { continue; }
                    if (!container || container.type !== 'collection' || !Array.isArray(container.parts)) continue;
                    const part = container.parts.find(matchesEpisode);
                    if (!part) continue;
                    return { key: episodeKey, bv: episodeKey, p: Number(part.p) || 0, container, part, flat: asFlat(part, container), seasonKey };
                }
            } catch (error) {
                console.warn(`${TAG} [精确分集读取] 读取失败：${episodeKey}`, error);
            }
            return null;
        },

        // 5.3.0：官方历史同步读取本地记录的统一入口。
        // 分P键(BV?p=N)→ 读同BV容器的对应 part，构造扁平记录供同步逻辑处理；
        // 纯BV键→ 若已是容器取 p1 part，否则返回扁平单视频记录。
        // 返回 { key, bv, p, container, part, flat }；flat 为 null 表示本地无该记录（走首次创建）。
        readSyncRecord(key) {
            const s = String(key || '');
            if (RecordKey.isEpisodeKey(s)) {
                const epKey = s.toLowerCase();
                const seasonKeys = GM_listValues().filter(k => RecordKey.isSeasonKey(k));
                let preferredSeasonKey = '';
                try {
                    const currentSeasonId = typeof PageData !== 'undefined' && PageData.resolveBangumiSeasonId
                        ? Number(PageData.resolveBangumiSeasonId()) || 0
                        : 0;
                    if (currentSeasonId) preferredSeasonKey = `ss${currentSeasonId}`;
                } catch (_) {}

                // 由当前页面真实 ep 链接读取集数；p 在番剧容器里只表示集数序号，不拼接为 ?p=N。
                let episodeNumber = 0;
                try {
                    const panels = Array.from(document.querySelectorAll('.SectionPanel_panel__rImmk'));
                    for (const panel of panels) {
                        const heading = String(panel.querySelector('.SectionHeader_titleWrap__n0F38 h3')?.textContent || '').trim();
                        if (/预告|预览|预热视频|PV/i.test(heading)) continue;
                        const links = Array.from(panel.querySelectorAll('a[href*="/bangumi/play/ep"]'));
                        const link = links.find(a => {
                            const match = String(a.getAttribute('href') || '').match(/\/bangumi\/play\/(ep\d+)/i);
                            return match && match[1].toLowerCase() === epKey;
                        });
                        if (!link) continue;
                        const numberText = [
                            link.querySelector('.EpisodeVirtualList_numberTitle__6SOS6')?.textContent,
                            link.getAttribute('title'),
                            link.textContent
                        ].filter(Boolean).join(' ');
                        const numMatch = numberText.match(/第\s*(\d+)\s*集/);
                        if (numMatch) episodeNumber = Number(numMatch[1]) || 0;
                        if (!episodeNumber) {
                            const parentText = String(link.closest('[class*="EpisodeVirtualList"]')?.textContent || '');
                            const parentMatch = parentText.match(/第\s*(\d+)\s*集/);
                            if (parentMatch) episodeNumber = Number(parentMatch[1]) || 0;
                        }
                        break;
                    }
                } catch (_) {}

                const orderedSeasonKeys = preferredSeasonKey && seasonKeys.includes(preferredSeasonKey)
                    ? [preferredSeasonKey, ...seasonKeys.filter(k => k !== preferredSeasonKey)]
                    : seasonKeys;
                for (const seasonKey of orderedSeasonKeys) {
                    const container = RecordNormalizer.normalize(GM_getValue(seasonKey, null));
                    if (!container || container.type !== 'collection') continue;
                    let part = container.parts.find(item =>
                    [item.bv, item.epKey].some(value => String(value || '').trim().toLowerCase() === epKey)
                );
                    // 旧版没有 epKey、bv 错存为 ss 的分集，只有当前页面能把 ep 与集数对应时才按 p 接回旧数据。
                    if (!part && episodeNumber > 0 && preferredSeasonKey && seasonKey === preferredSeasonKey) {
                        part = container.parts.find(item =>
                            !/^ep\d+$/i.test(String(item.bv || item.epKey || '')) &&
                            Number(item.p) === episodeNumber &&
                            !(Number(item.p) === 1 &&
                              !String(item.title || item.partTitle || '').trim() &&
                              !(Number(item.partTotal) > 0) &&
                              !(Number(item.collectionOrder) > 0) &&
                              String(item.bv || '').toLowerCase() === seasonKey.toLowerCase()) &&
                            (!String(item.bv || '').trim() ||
                             String(item.bv || '').toLowerCase() === seasonKey.toLowerCase())
                        );
                    }
                    if (part) {
                        const isLegacyIdentity = String(part.bv || part.epKey || '').toLowerCase() !== epKey;
                        if (isLegacyIdentity && episodeNumber > 0) {
                            // 现在有真实页面证据证明“这个 ep = 这一集”，立即原位修复身份字段。
                            // 不重建 part、不清空观看数据；p 仍是集数序号而不是 ?p 参数。
                            part.bv = epKey;
                            part.epKey = epKey;
                            part.p = Number(part.p) || episodeNumber;
                            const sid = Number(String(seasonKey).replace(/^ss/i, '')) || 0;
                            if (sid) part.seasonId = sid;
                            this.set(seasonKey, RecordNormalizer.normalize(container) || container);
                            const savedContainer = RecordNormalizer.normalize(GM_getValue(seasonKey, null)) || container;
                            part = savedContainer.parts.find(item => String(item.bv || item.epKey || '').toLowerCase() === epKey) || part;
                            return {
                                key: s, bv: epKey, p: Number(part.p) || episodeNumber || 1, container: savedContainer, part,
                                flat: {
                                    key: epKey, ...part, bv: epKey,
                                    title: part.title || '',
                                    mediaType: savedContainer.mediaType || '番剧',
                                    authorName: savedContainer.authorName || '',
                                    snapshots: [...(part.snapshots || [])]
                                }
                            };
                        }
                        return {
                            key: s, bv: epKey, p: Number(part.p) || episodeNumber || 1, container, part,
                            flat: {
                                key: epKey, ...part, bv: epKey,
                                title: part.title || '',
                                mediaType: container.mediaType || '番剧',
                                authorName: container.authorName || '',
                                snapshots: [...(part.snapshots || [])]
                            }
                        };
                    }
                }
            }
            const isPart = RecordKey.isPartKey(s);
            let bv = s, p = 1;
            if (isPart) {
                const m = s.match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                bv = m[1]; p = Number(m[2]);
            }
            const container = RecordNormalizer.normalize(GM_getValue(bv, null));
            if (container && container.type === 'collection') {
                const part = container.parts.find(pp => String(pp.bv || '').toLowerCase() === s.toLowerCase() || String(pp.epKey || '').toLowerCase() === s.toLowerCase())
                    || container.parts.find(pp => pp.p === p) || null;
                const flat = part ? { key: isPart ? s : s, ...part, snapshots: [...(part.snapshots || [])] } : null;
                return { key: s, bv, p, container, part, flat };
            }
            if (isPart) return { key: s, bv, p, container: null, part: null, flat: null };
            const rec = RecordNormalizer.normalize(GM_getValue(s, null));
            if (rec && !rec.type) return { key: s, bv, p, container: null, part: null, flat: { ...rec, snapshots: [...(rec.snapshots || [])] } };
            return { key: s, bv, p, container: rec, part: null, flat: null };
        },

        // 监听其他标签页发来的记录变更，读取最新数据并更新当前标签的索引。
        initRemoteListener() {
            if (typeof GM_addValueChangeListener !== 'function') return;
            GM_addValueChangeListener(RECORD_CHANGE_SIGNAL_KEY, (_key, _oldValue, newValue, remote) => {
                if (!remote || !newValue || !RecordKey.isRecordKey(newValue.key)) return;
                this._refreshIndexKey(newValue.key);
                const value = GM_getValue(newValue.key, null);
                HistoryViewIndex.updateKey(newValue.key, value, value === null);
                this.notifyChange(newValue.key, 'remote');
            });
        }
    };

    // 根据当前过期天数设置更新清理按钮文字。
    function updateCleanupButtonLabels() {
        const label = `清理已备份过期记录（${CONFIG.EXPIRE_DAY}天）`;
        ['hp-clean', 'bvh-clean-expire'].forEach(id => {
            const button = document.getElementById(id);
            if (button) button.textContent = label;
        });
    }

    // ── 存储业务 API：清理 / 导出 / 导入 / 归并 / 次数重置等按钮背后的具体实现 ──
    // 【模块：面向界面的记录管理操作】
    // 提供清理短观看记录、清理过期记录、调整观看次数、删除记录、导入/导出、
    // 番剧身份修复、旧结构迁移和存储容量提醒等管理功能。
    // 这些操作会调用 RecordStore 维护原始数据，并让索引/列表跟随更新；此处注释不代表额外改变行为。
    const StorageApi = {
        // 按油猴设置清理未达到观看阈值且满足保留期限的短观看记录。
        cleanShortWatchRecords() {
            const keepMs = CONFIG.SHORT_WATCH_EXPIRE_DAY * 24 * 3600 * 1000;
            const nowTs = TimeTool.now();
            let deletedRecords = 0;
            let deletedSnapshots = 0;

            // 清理单个"观看实体"（扁平记录 或 容器 part）里过期的短观看快照。
            // 返回 null=无可清理；否则 {changed, empty, thresholdChanged}（empty=快照全删光）。
            const cleanEntity = rec => {
                if (!rec || typeof rec !== 'object' || !Array.isArray(rec.snapshots)) return null;
                const oldLength = rec.snapshots.length;
                if (oldLength === 0) return null;
                let hasReachedThreshold = rec.hasReachedWatchThreshold === true;
                let allValidAndShort = true;
                for (const snap of rec.snapshots) {
                    const pos = snap && snap.pos;
                    if (pos === null || pos === undefined || pos === '' || !Number.isFinite(Number(pos)) || Number(pos) < 0) { allValidAndShort = false; continue; }
                    if (Number(pos) >= CONFIG.SHORT_WATCH_MAX_POS_SEC) { hasReachedThreshold = true; allValidAndShort = false; }
                }
                let thresholdChanged = false;
                if (hasReachedThreshold && rec.hasReachedWatchThreshold !== true) { rec.hasReachedWatchThreshold = true; thresholdChanged = true; }
                if (hasReachedThreshold || !allValidAndShort) return { changed: false, empty: false, thresholdChanged };
                const filtered = rec.snapshots.filter(snap => {
                    const ts = snap && snap.ts;
                    const validTimestamp = ts !== null && ts !== undefined && ts !== '' && Number.isFinite(Number(ts)) && Number(ts) > 0;
                    const isDue = validTimestamp && (CONFIG.SHORT_WATCH_EXPIRE_DAY === 0 || nowTs - Number(ts) >= keepMs);
                    if (isDue) { deletedSnapshots++; return false; }
                    return true;
                });
                rec.snapshots = filtered;
                if (filtered.length === 0) return { changed: true, empty: true, thresholdChanged };
                if (filtered.length !== oldLength) {
                    const latest = filtered.reduce((a, b) => (Number(a.ts || 0) >= Number(b.ts || 0) ? a : b));
                    rec.lastTs = Number(latest.ts || rec.lastTs || 0);
                    rec.lastProgress = latest.progress || rec.lastProgress || '0%';
                }
                return { changed: filtered.length !== oldLength, empty: false, thresholdChanged };
            };

            GM_listValues().forEach(key => {
                const rec = RecordNormalizer.normalize(GM_getValue(key));
                if (!rec) return;
                if (rec.type === 'collection') {
                    // 容器：逐 part 清理，快照清空的 part 移除；容器 parts 全空则删容器。
                    let containerChanged = false;
                    rec.parts = rec.parts.filter(part => {
                        const res = cleanEntity(part);
                        if (!res) return true;
                        if (res.changed && res.empty) { deletedRecords++; return false; }
                        if (res.changed || res.thresholdChanged) containerChanged = true;
                        return true;
                    });
                    if (rec.parts.length === 0) { RecordStore.delete(key); deletedRecords++; }
                    else if (containerChanged) RecordStore.set(key, RecordNormalizer.normalize(rec));
                    return;
                }
                const res = cleanEntity(rec);
                if (!res) return;
                if (res.changed && res.empty) { RecordStore.delete(key); deletedRecords++; }
                else if (res.changed || res.thresholdChanged) RecordStore.set(key, RecordNormalizer.normalize(rec));
            });
            return { deletedRecords, deletedSnapshots };
        },

        // 只处理已导出备份且符合过期条件的记录，并在删除前向用户确认。
        cleanExpireRecords() {
            const allKeys = GM_listValues()
            .filter(k => RecordKey.isRecordKey(k))
            .map(key => {
                const rec = RecordNormalizer.normalize(GM_getValue(key));
                return { key, watchCount: rec?.watchCount || 0, lastTs: rec?.lastTs || 0 };
            })
            .sort((a, b) => (b.watchCount - a.watchCount) || (b.lastTs - a.lastTs))
            .map(item => item.key);

            const exportedMap = RecordStore._exportedMap();
            const nowTs = TimeTool.now();
            const expiredExported = [];
            const unknownTimeExported = [];

            allKeys.forEach(key => {
                if (!Object.prototype.hasOwnProperty.call(exportedMap, key)) return;
                const rec = LegacyMigration.migrateAny(GM_getValue(key));
                if (!rec || typeof rec !== 'object') return;
                const ts = Number(rec.lastTs);
                if (!Number.isFinite(ts) || ts <= 0) unknownTimeExported.push(key);
                else if (nowTs - ts > CONFIG.EXPIRE_MS) expiredExported.push(key);
            });

            if (expiredExported.length === 0 && unknownTimeExported.length === 0) {
                alert(`没有可清理的已备份记录。\n清理条件：已导出备份，并且超过 ${CONFIG.EXPIRE_DAY} 天未更新；时间不明的记录会单独询问。`);
                return;
            }

            let includeUnknownTime = false;
            if (unknownTimeExported.length > 0) {
                includeUnknownTime = confirm(
                    `另发现 ${unknownTimeExported.length} 条已备份但时间不确定的记录（缺少有效时间戳，无法判断是否超过 ${CONFIG.EXPIRE_DAY} 天）。\n\n` +
                    `点击"确定"：也清理这些时间不明的记录。\n点击"取消"：保留时间不明的记录，只清理明确过期的记录。`
                );
            }
            const candidates = includeUnknownTime ? [...expiredExported, ...unknownTimeExported] : expiredExported;
            if (candidates.length === 0) {
                alert('没有选择要删除的记录，时间不明的记录已保留。');
                return;
            }

            const confirmDelete = confirm(
                `即将删除 ${candidates.length} 条记录：\n` +
                `- 明确超过 ${CONFIG.EXPIRE_DAY} 天且已导出备份：${expiredExported.length} 条\n` +
                `- 时间不明且已导出备份：${includeUnknownTime ? unknownTimeExported.length : 0} 条\n\n` +
                `未导出备份的记录不会删除。确认继续？`
            );
            if (!confirmDelete) return;

            candidates.forEach(key => {
                RecordStore.delete(key);
                delete exportedMap[key];
            });
            GM_setValue(EXPORTED_RECORDS_KEY, exportedMap);
            alert(`清理完成，共删除 ${candidates.length} 条记录。`);
            refreshOpenHistoryLists(true);
            updateCleanupButtonLabels();
        },

        // 将单条记录的观看次数调低，保留快照、标题、作者和进度等信息。
        setWatchCount(key, targetCount) {
            if (!RecordKey.isRecordKey(key)) return false;
            const nextCount = Number(targetCount);
            if (!Number.isInteger(nextCount) || nextCount < 0 || nextCount > 10000) {
                alert(`请输入 0 到 ${10000} 之间的整数。`);
                return false;
            }
            // 5.3.0：分P键对应容器 part。
            if (RecordKey.isPartKey(key)) {
                const m = String(key).match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                const bv = m[1], p = Number(m[2]);
                const container = RecordNormalizer.normalize(GM_getValue(bv, null));
                const part = container?.parts?.find(pp => pp.p === p);
                if (!part) { alert('这条观看记录已不存在。'); return false; }
                part.watchCount = nextCount;
                RecordStore.set(bv, container);
                refreshOpenHistoryLists(true);
                return true;
            }
            const rec = RecordNormalizer.normalize(GM_getValue(key));
            if (!rec) {
                alert('这条观看记录已不存在。');
                return false;
            }
            rec.watchCount = nextCount;
            RecordStore.set(key, rec);
            refreshOpenHistoryLists(true);
            return true;
        },

        // 删除单条记录，并同步更新索引与备份标记。
        deleteSingleRecord(key) {
            // 5.3.0：分P键对应容器 part；纯BV键可能本身是容器。
            let title;
            if (RecordKey.isPartKey(key)) {
                const m = String(key).match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                const bv = m[1], p = Number(m[2]);
                const container = RecordNormalizer.normalize(GM_getValue(bv, null));
                const part = container?.parts?.find(pp => pp.p === p);
                if (!part) { alert('这条观看记录已不存在。'); return false; }
                title = part.title || key;
            } else {
                if (GM_getValue(key, null) === null) {
                    alert('这条观看记录已不存在。');
                    return false;
                }
                const rec = RecordNormalizer.normalize(GM_getValue(key));
                title = rec?.title || key;
            }
            if (!confirm(`确定删除这条视频记录？\n${title}\n\n删除后无法恢复。`)) return false;
            RecordStore.delete(key);
            refreshOpenHistoryLists(true);
            return true;
        },

        // 导出完整 JSON 备份，同时登记导出状态并刷新列表标记。
        exportAllRecords() {
            const allKeys = GM_listValues().filter(k => RecordKey.isRecordKey(k));
            const exportObj = { format: 'bvh-history-backup', version: 2, exportedAt: Date.now(), records: {} };
            const nowTs = TimeTool.now();
            const exportedMap = RecordStore._exportedMap();
            let exportedCount = 0;

            allKeys.forEach(key => {
                const recordData = GM_getValue(key);
                const normalized = RecordNormalizer.normalize(recordData);
                if (!normalized) return;
                if (JSON.stringify(recordData) !== JSON.stringify(normalized)) RecordStore.set(key, normalized);

                const ts = Number(normalized.lastTs);
                const isExpired = Number.isFinite(ts) && ts > 0 && nowTs - ts > CONFIG.EXPIRE_MS;
                exportObj.records[key] = { key, data: normalized, isExpired, exportedAt: nowTs };
                exportedMap[key] = nowTs;
                exportedCount++;
            });

            const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `bvh_history_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            GM_setValue(EXPORTED_RECORDS_KEY, exportedMap);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            refreshOpenHistoryLists();
            updateCleanupButtonLabels();
            alert(
                `已生成备份，包含 ${exportedCount} 条视频记录。\n` +
                `已为这些记录登记备份状态；普通记录显示"已备份"，超过 ${CONFIG.EXPIRE_DAY} 天或时间不明的记录显示"可清理"。`
            );
        },

        // 归并单集(ep)到整季(ss)：
        //snapshotKey 用"分钟+进度"而非精确 ts——
        // 官方历史卡片只有分钟精度，用精确 ts 永远匹配不上播放页秒级快照，
        // 导致 watchCount 被重复累加。
        mergeEpIntoSeason(options = {}) {
            const silent = options && options.silent === true;
            const epKeys = GM_listValues().filter(k => RecordKey.isEpisodeKey(k));
            if (!epKeys.length) {
                if (!silent) alert('没有单集(ep)记录需要归并。');
                return { merged: [], skipped: [] };
            }
            if (!silent && !confirm('将把单集(ep)记录的快照合并进对应整季(ss)记录，并删除 ep 记录。确认继续？')) {
                return { merged: [], skipped: [], cancelled: true };
            }

            const ssCandidates = GM_listValues()
            .filter(k => RecordKey.isSeasonKey(k))
            .map(k => ({ key: k, rec: RecordNormalizer.normalize(GM_getValue(k)) }));
            const merged = [];
            const skipped = [];

            epKeys.forEach(epKey => {
                const rawEpRec = RecordNormalizer.normalize(GM_getValue(epKey));
                if (!rawEpRec) {
                    skipped.push(epKey);
                    return;
                }
                // 旧版本可能把 ep 键错误保存成 collection，真实观看事实在 data.parts[]，
                // 必须先提取与 epKey 精确匹配的分集；只有单分集旧容器才允许安全兜底。
                let epRec = rawEpRec;
                if (rawEpRec.type === 'collection' && Array.isArray(rawEpRec.parts)) {
                    // 多分集旧容器不能在只迁移其中一集后整条删除；保留原键并报告跳过，防止误删其他集。
                    if (rawEpRec.parts.length > 1) {
                        skipped.push(epKey);
                        return;
                    }
                    const sourcePart = rawEpRec.parts.find(part =>
                        String(part.bv || part.epKey || '').toLowerCase() === String(epKey).toLowerCase()
                    ) || (rawEpRec.parts.length === 1 ? rawEpRec.parts[0] : null);
                    if (!sourcePart) {
                        skipped.push(epKey);
                        return;
                    }
                    epRec = {
                        ...rawEpRec,
                        ...sourcePart,
                        key: epKey,
                        title: sourcePart.title || rawEpRec.title || '',
                        mediaType: rawEpRec.mediaType || sourcePart.mediaType || '番剧',
                        seasonId: Number(sourcePart.seasonId) || Number(rawEpRec.seasonId) || 0,
                        collectionTitle: rawEpRec.title || rawEpRec.collectionTitle || '',
                        collectionKey: rawEpRec.collectionKey || sourcePart.collectionKey || ''
                    };
                }
                const hasViewingFacts = (Array.isArray(epRec.snapshots) && epRec.snapshots.length > 0)
                    || Number(epRec.watchCount) > 0 || Number(epRec.lastTs) > 0
                    || epRec.officialHistorySeen === true || epRec.hasReachedWatchThreshold === true;
                if (!hasViewingFacts) {
                    skipped.push(epKey);
                    return;
                }

                let target = null;
                if (epRec.seasonId) {
                    target = ssCandidates.find(s => String(s.key).toLowerCase() === `ss${epRec.seasonId}`) || null;
                }
                // 精确 ep 身份已存在于某个 ss.parts[] 时，它比标题猜测更可靠。
                if (!target) {
                    target = ssCandidates.find(s => s.rec?.type === 'collection' && Array.isArray(s.rec.parts)
                        && s.rec.parts.some(part => String(part.bv || part.epKey || '').toLowerCase() === String(epKey).toLowerCase())) || null;
                }
                if (!target) {
                    const seriesTitle = String(epRec.collectionTitle || rawEpRec.title || '').replace(/-.*$/, '').trim();
                    // 标题只作最后兜底，而且必须唯一匹配；相似标题可能对应不同季，不能随便归并到第一条。
                    const titleMatches = ssCandidates.filter(s => {
                        const t = String(s.rec?.title || '').trim();
                        return t && seriesTitle && (seriesTitle === t || seriesTitle.startsWith(t) || t.startsWith(seriesTitle));
                    });
                    if (titleMatches.length === 1) target = titleMatches[0];
                }
                if (!target) {
                    skipped.push(epKey);
                    return;
                }

                const existingTarget = RecordNormalizer.normalize(GM_getValue(target.key));
                // 无论 ss 旧记录是 collection 还是早期扁平格式，都统一经分集归并入口写入 parts[]。
                // _mergeEpisodeIntoSeason 会把旧 ss 自身累计数据保存在 legacyAggregate，避免误分配给某一集。
                const migrated = this._mergeEpisodeIntoSeason(target.key, epKey, epRec, {
                    seasonId: epRec.seasonId || Number(String(target.key).replace(/^ss/i, '')),
                    partTitle: epRec.partTitle || epRec.title || '',
                    partNumber: Number(epRec.p) || Number(epRec.partNumber)
                        || Number((String(epRec.partTitle || epRec.title || '').match(/第\s*(\d+)\s*集/) || [])[1])
                        || (Array.isArray(existingTarget?.parts) ? existingTarget.parts.length + 1 : 1),
                    containerTitle: existingTarget?.title || epRec.collectionTitle || ''
                });
                if (!migrated || migrated.type !== 'collection' || !Array.isArray(migrated.parts)) {
                    // 无法形成标准 ss 容器时不删除源 ep，保证观看事实仍可恢复。
                    skipped.push(epKey);
                    return;
                }
                RecordStore.set(target.key, migrated);
                RecordStore.deleteRaw(epKey);
                merged.push(`${epKey} → ${target.key}`);
            });

            if (silent) {
                if (merged.length) {
                    console.log(`[Bilibili History] 自动归并单集(ep)到整季(ss)：${merged.length} 条`, merged);
                }
            } else {
                alert(
                    `归并完成。\n已归并：${merged.length} 条\n` +
                    `${merged.length ? '· ' + merged.join('\n· ') : ''}\n` +
                    `跳过（找不到对应整季）：${skipped.length} 条` +
                    `${skipped.length ? '\n· ' + skipped.join('\n· ') : ''}`
                );
            }
            refreshOpenHistoryLists();
            return { merged, skipped };
        },

        // 把记录及其快照整理成 CSV 行，格式化时间和播放位置后触发下载。
        exportCSVRecords() {
            const allKeys = [...new Set(GM_listValues().filter(k => RecordKey.isRecordKey(k)))];
            const nowTs = TimeTool.now();
            const exportedAt = new Date().toLocaleString('sv-SE');

            const formatTimestamp = value => {
                if (value === null || value === undefined || value === '') return '';
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) return '';
                const ms = n > 1e11 ? n : n * 1000;
                const d = new Date(ms);
                return Number.isNaN(d.getTime())
                    ? String(value)
                : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
            };
            const formatSeconds = value => {
                if (value === null || value === undefined || value === '') return '';
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0) return String(value);
                const total = Math.floor(n);
                const h = Math.floor(total / 3600);
                const m = Math.floor((total % 3600) / 60);
                const sec = total % 60;
                return h > 0
                    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
                : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
            };
            const csvCell = value => {
                const text = value === null || value === undefined ? '' : String(value);
                return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
            };

            const rows = [CSV_COLUMNS.map(h => csvCell(h[1])).join(',')];
            let recordCount = 0;

            const records = [];
            const seenKeys = new Set();
            allKeys.forEach(key => {
                if (seenKeys.has(key)) return;
                seenKeys.add(key);
                const normalized = RecordNormalizer.normalize(GM_getValue(key));
                if (!normalized) return;
                if (normalized.type === 'collection' && Array.isArray(normalized.parts)) {
                    // 可读 CSV 按分集展开合集容器；不能把容器本身当成普通视频，否则 watchCount/snapshots 会变成 0/空。
                    normalized.parts.forEach(part => {
                        const p = Math.max(1, Number(part.p) || 1);
                        const bv = String(part.bv || (/^BV/i.test(key) ? key : '')).trim();
                        // CSV 只对真正的 BV 多 P 容器输出 ?p=N，其他合集按原始 BV/ep 键导出。
                        const isBvMultiPartContainer = /^BV[a-zA-Z0-9]+$/i.test(String(key))
                            && /^BV[a-zA-Z0-9]+$/i.test(bv)
                            && bv.toUpperCase() === String(key).toUpperCase();
                        const partKey = part.epKey ? String(part.epKey) : (bv ? (String(bv).includes('?p=') ? bv : `${bv}${isBvMultiPartContainer && p > 1 ? `?p=${p}` : ''}`) : `${key}#part-${p}`);
                        records.push({
                            key: partKey,
                            normalized: {
                                title: part.title || '', authorName: normalized.authorName || '',
                                mediaType: normalized.mediaType || '视频', mediaTags: [], mediaSubtitle: part.smallCollectionTitle || '',
                                collectionTitle: normalized.title || '', smallCollectionTitle: part.smallCollectionTitle || '',
                                collectionKey: normalized.collectionKey || key, partNumber: p,
                                partTotal: part.partTotal || normalized.parts.length,
                                lastTs: Number(part.lastTs) || 0, lastProgress: part.lastProgress || '0%',
                                watchCount: Number(part.watchCount) || 0, snapshots: Array.isArray(part.snapshots) ? part.snapshots : [],
                                hasReachedWatchThreshold: part.hasReachedWatchThreshold === true
                            }
                        });
                    });
                    if (normalized.legacyAggregate && typeof normalized.legacyAggregate === 'object') {
                        const legacy = normalized.legacyAggregate;
                        records.push({ key: `${key}#legacy`, normalized: { title: legacy.title || normalized.title || '', authorName: normalized.authorName || '', mediaType: normalized.mediaType || '番剧', mediaTags: [], mediaSubtitle: '', collectionTitle: normalized.title || '', collectionKey: normalized.collectionKey || key, lastTs: Number(legacy.lastTs) || 0, lastProgress: legacy.lastProgress || '0%', watchCount: Number(legacy.watchCount) || 0, snapshots: Array.isArray(legacy.snapshots) ? legacy.snapshots : [], hasReachedWatchThreshold: legacy.hasReachedWatchThreshold === true } });
                    }
                    // 空合集仍导出容器信息，避免仅含元数据的合集在 CSV 中彻底消失。
                    if (!normalized.parts.length && !normalized.legacyAggregate) records.push({ key, normalized: { ...normalized, title: normalized.title || '', watchCount: 0, lastTs: 0, lastProgress: '0%', snapshots: [], collectionTitle: normalized.title || '', collectionKey: normalized.collectionKey || key } });
                    return;
                }
                records.push({ key, normalized });
            });
            records.sort((a, b) => {
                const countDiff = Number(b.normalized.watchCount || 0) - Number(a.normalized.watchCount || 0);
                return countDiff || Number(b.normalized.lastTs || 0) - Number(a.normalized.lastTs || 0);
            });

            records.forEach(({ key, normalized }) => {
                recordCount++;
                const ts = Number(normalized.lastTs) || 0;
                const base = {
                    bv_key: key,
                    title: normalized.title || '',
                    author_name: normalized.authorName || '',
                    media_type: normalized.mediaType || '视频',
                    media_tags: (normalized.mediaTags || []).join('、'),
                    media_subtitle: normalized.mediaSubtitle || '',
                    collection_title: normalized.collectionTitle || '',
                    small_collection_title: normalized.smallCollectionTitle || '',
                    collection_key: normalized.collectionKey || '',
                    part_number: normalized.partNumber || '',
                    part_total: normalized.partTotal || '',
                    is_expired: ts > 0 && nowTs - ts > CONFIG.EXPIRE_MS ? '是' : '否',
                    last_ts: formatTimestamp(ts),
                    last_progress: normalized.lastProgress || '',
                    watch_count: normalized.watchCount || 0,
                    has_reached_watch_threshold: normalized.hasReachedWatchThreshold ? '是' : '否',
                    file_format: 'bvh-history-csv',
                    file_version: 1,
                    exported_at: exportedAt
                };

                const snapshots = Array.isArray(normalized.snapshots) ? normalized.snapshots.slice() : [];
                snapshots.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
                const rowSnapshots = snapshots.length ? snapshots : [null];

                rowSnapshots.forEach(snap => {
                    const row = {
                        ...base,
                        snapshot_ts: snap ? formatTimestamp(snap.ts) : '',
                        snapshot_pos: snap ? formatSeconds(snap.pos) : '',
                        snapshot_progress: snap ? (snap.progress || '') : '',
                        snapshot_watch_time: snap ? (snap.watchTimeStr || '') : '',
                        snapshot_completed: snap ? (snap.completed === true ? '是' : '') : '',
                        snapshot_author: snap ? (normalized.authorName || '') : ''
                    };
                    rows.push(CSV_COLUMNS.map(([keyName]) => csvCell(row[keyName])).join(','));
                });
            });

            const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `bvh_history_readable_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            alert(`CSV 导出完成。\n视频记录：${recordCount} 条\n导出行数（按快照展开）：${rows.length - 1} 行\n此 CSV 仅用于查看和分析，不会被登记为可清理的 JSON 备份。`);
        },

        // 读取 JSON 备份，校验并归一化数据，再按记录键合并或写入本地存储。
        importRecords() {
            if (!confirm('导入会覆盖备份中同名的视频记录。建议先导出当前数据作为备份，确认继续导入？')) return;

            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = e => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = evt => {
                    try {
                        const rawText = String(evt.target.result || '');
                        let rawData;
                        try {
                            rawData = JSON.parse(rawText);
                        } catch (parseError) {
                            let txt = rawText;
                            txt = txt.replace(/'([a-zA-Z0-9_]+)'(\s*:)/g, '"$1"$2');
                            txt = txt.replace(/:\s*'([^']*?)'(?=\s*[,}\]])/g, ':"$1"');
                            txt = txt.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
                            rawData = JSON.parse(txt);
                        }
                        if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
                            throw new Error('备份顶层必须是 JSON 对象。');
                        }

                        const sourceRecords = rawData.format === 'bvh-history-backup' && rawData.records && typeof rawData.records === 'object'
                        ? rawData.records : rawData;
                        const exportedMap = RecordStore._exportedMap();
                        let importCnt = 0;
                        let skipCnt = 0;
                        const errors = [];

                        Object.keys(sourceRecords).forEach(sourceKey => {
                            try {
                                const entry = sourceRecords[sourceKey];
                                const key = RecordKey.isRecordKey(sourceKey)
                                ? sourceKey
                                : (entry && RecordKey.isRecordKey(entry.key) ? entry.key : null);
                                if (!key) return;

                                const data = entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'data')
                                ? entry.data : entry;
                                const normalized = RecordNormalizer.normalize(data);
                                if (!normalized) throw new Error('无法识别记录结构');

                                const existing = RecordNormalizer.normalize(GM_getValue(key));
                                // 合集容器导入：同key容器不再整体覆盖。先找本地可合并目标
                                // （去?p=后同BV，或标题相同且作者相同），命中则合并分集与快照，
                                // 避免导入不同版本时产生重复或丢掉本地观看记录；都不命中才整体写入。
                                if (normalized.type === 'collection') {
                                    let target = (existing && existing.type === 'collection') ? existing : null;
                                    let targetKey = target ? key : null;
                                    if (!target) {
                                        const hit = findLocalContainerToMerge(normalized);
                                        if (hit) { target = hit.container; targetKey = hit.key; }
                                    }
                                    if (target) {
                                        const merged = mergeContainers(target, normalized);
                                        RecordStore.set(targetKey, merged);
                                        delete exportedMap[targetKey];
                                        importCnt++;
                                        return;
                                    }
                                    RecordStore.set(key, normalized);
                                    delete exportedMap[key];
                                    importCnt++;
                                    return;
                                }
                                if (existing) {
                                    ['authorName', 'mediaType', 'mediaSubtitle', 'collectionTitle', 'smallCollectionTitle'].forEach(field => {
                                        const incoming = normalized[field];
                                        const local = existing[field];
                                        const incomingEmpty = incoming == null || (typeof incoming === 'string' && !incoming.trim());
                                        if (incomingEmpty && local) normalized[field] = local;
                                    });
                                    // 旧记录没有 titleSource 时按已有本地标题处理：导入不能用另一个来源的标题覆盖它。
                                    if (existing.title && normalized.title && existing.title !== normalized.title) {
                                        // 标题冲突只保留本地具体视频标题；除非明确属于合集，否则不把新标题塞进合集标题字段。
                                        const hasCollectionStructure = normalized.type === 'collection'
                                            || Number(normalized.partTotal) > 1
                                            || Number(normalized.partNumber) > 1
                                            || !!String(normalized.collectionKey || '').trim()
                                            || !!String(normalized.smallCollectionTitle || '').trim()
                                            || Number(normalized.seasonId) > 0;
                                        if (hasCollectionStructure) normalized.collectionTitle = normalized.collectionTitle || normalized.title;
                                        normalized.title = existing.title;
                                        normalized.titleSource = existing.titleSource || 'player';
                                    } else if (!normalized.title && existing.title) {
                                        normalized.title = existing.title;
                                        normalized.titleSource = existing.titleSource || 'player';
                                    }
                                    if (!normalized.titleSource && existing.titleSource) normalized.titleSource = existing.titleSource;
                                    if (normalized.mediaType === '视频' && existing.mediaType && existing.mediaType !== '视频') {
                                        normalized.mediaType = existing.mediaType;
                                    }
                                    if ((!Array.isArray(normalized.mediaTags) || normalized.mediaTags.length === 0)
                                        && Array.isArray(existing.mediaTags) && existing.mediaTags.length) {
                                        normalized.mediaTags = existing.mediaTags.slice();
                                    }
                                }

                                RecordStore.set(key, normalized);
                                delete exportedMap[key];
                                importCnt++;
                            } catch (itemError) {
                                skipCnt++;
                                errors.push(`${sourceKey}: ${itemError.message}`);
                                console.warn(`导入记录 ${sourceKey} 失败：`, itemError);
                            }
                        });

                        GM_setValue(EXPORTED_RECORDS_KEY, exportedMap);
                        const errorSummary = errors.slice(0, 5).join('\n');
                        alert(
                            `导入完成。\n成功导入：${importCnt} 条\n跳过损坏记录：${skipCnt} 条` +
                            `${errorSummary ? `\n\n部分错误：\n${errorSummary}` : ''}\n\n` +
                            `导入的记录需重新导出备份后，才会被标记为可清理。`
                        );
                        refreshOpenHistoryLists();
                    } catch (err) {
                        alert('导入失败：' + err.message);
                    }
                };
                reader.readAsText(file, 'utf-8');
            };
            input.click();
        },

        // 删除当前视频或番剧单集对应的本地记录，并处理关联整季记录。
        deleteCurrentRecord() {
            const parsed = RecordKey.parse(window.location.href);
            if (!parsed) return;
            RecordStore.delete(parsed.key);
            // ep 单集已由 RecordStore.delete 从 ss 容器中精准移除，不再删除整季容器。
            alert('已删除本条（当前p）观看记录');
            location.reload();
        },

        // 清除全部观看记录及备份标记，并重置索引。
        deleteAllRecords() {
            if (!confirm('确认删除全部观看历史？该操作不可恢复！建议先导出备份！')) return;
            GM_listValues().filter(k => RecordKey.isRecordKey(k)).forEach(k => RecordStore.delete(k));
            GM_setValue(EXPORTED_RECORDS_KEY, {});
            HistoryViewIndex.reset();
            RecordStore.clearIndex();
            alert('全部记录清除完成');
            location.reload();
        },

        // 把所有记录的观看次数重置为 1。
        // 适用场景：旧版本误判导致次数虚高、或只想保留"看过/没看过"信息时一键纠正。
        // 只改 watchCount，快照、标题、作者、进度等信息全部保留。
        resetAllWatchCounts() {
            const keys = GM_listValues().filter(k => RecordKey.isRecordKey(k));
            if (!keys.length) {
                alert('当前没有任何观看记录。');
                return;
            }
            if (!confirm(`将把 ${keys.length} 条记录的观看次数全部重置为 1（快照、标题、作者等信息保留）。\n确认继续？`)) return;
            keys.forEach(key => {
                const rec = RecordNormalizer.normalize(GM_getValue(key));
                if (!rec) return;
                if (rec.type === 'collection') {
                    // 容器：重置每个分集的观看次数。
                    let changed = false;
                    rec.parts.forEach(part => {
                        if (Number(part.watchCount) !== 1) { part.watchCount = 1; changed = true; }
                    });
                    if (rec.legacyAggregate && Number(rec.legacyAggregate.watchCount) !== 1) { rec.legacyAggregate.watchCount = 1; changed = true; }
                    if (changed) RecordStore.set(key, rec);
                    return;
                }
                rec.watchCount = 1;
                RecordStore.set(key, rec);
            });
            // 次数变了，排序索引需要重建（索引按 watchCount 排序）
            HistoryViewIndex.reset();
            RecordStore.clearIndex();
            HistoryViewIndex.ensure();
            alert(`重置完成，共处理 ${keys.length} 条记录，观看次数已全部变为 1。`);
        },

        // 5.4.9：只根据本地已有的 ep 记录修复旧 ss 容器，不依赖当前页面或 DOM。
        // 旧数据 bv=ssNNNNN、p=N 时，从其他本地记录中寻找同系列、同 p 的明确 ep 身份。
        // 只有唯一候选才改写；p=1 的疑似整季聚合行、候选冲突、没有映射的行全部保留。
        repairBangumiIdentityFromLocalData() {
            const keys = GM_listValues().filter(key => RecordKey.isRecordKey(key));
            const records = new Map();
            for (const key of keys) {
                const rec = RecordNormalizer.normalize(GM_getValue(key, null));
                if (rec) records.set(key, rec);
            }

            const seriesTokens = rec => {
                if (!rec || typeof rec !== 'object') return [];
                const ck = String(rec.collectionKey || '').trim().toLocaleLowerCase();
                if (ck) return [`ck:${ck}`];
                const title = String(rec.title || rec.collectionTitle || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
                const media = String(rec.mediaType || '').trim().toLocaleLowerCase();
                return title ? [`title:${title}|${media}`] : [];
            };
            const epPattern = /^ep\d+$/i;
            const mapKey = (token, p) => `${token}|p:${Number(p)}`;
            const candidates = new Map();
            const addCandidate = (token, p, ep) => {
                if (!token || !(Number(p) > 0) || !epPattern.test(String(ep || ''))) return;
                const k = mapKey(token, p);
                if (!candidates.has(k)) candidates.set(k, new Set());
                candidates.get(k).add(String(ep).toLowerCase());
            };

            // 建映射时只信任已经存在的 ep ID，不根据相邻集数或 ep 数字推算。
            for (const [key, rec] of records) {
                const keyEp = epPattern.test(key) ? key.toLowerCase() : '';
                const tokens = seriesTokens(rec);
                if (!tokens.length) continue;
                if (rec.type === 'collection' && Array.isArray(rec.parts)) {
                    for (const part of rec.parts) {
                        const pnum = Number(part.p || part.partNumber || part.collectionOrder) || 0;
                        const ep = epPattern.test(String(part.bv || '')) ? String(part.bv).toLowerCase()
                            : (epPattern.test(String(part.epKey || '')) ? String(part.epKey).toLowerCase()
                            : (keyEp && rec.parts.length === 1 ? keyEp : ''));
                        if (!ep) continue;
                        for (const token of tokens) addCandidate(token, pnum, ep);
                    }
                } else if (keyEp) {
                    const pnum = Number(rec.partNumber || rec.collectionOrder || rec.p) || 0;
                    for (const token of tokens) addCandidate(token, pnum, keyEp);
                }
            }

            const mergeSnapshots = (a, b) => {
                const bySignature = new Map();
                for (const snap of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
                    if (!snap || typeof snap !== 'object') continue;
                    const sig = `${Number(snap.ts) || 0}|${snap.pos == null ? '' : Number(snap.pos)}|${String(snap.progress || '')}|${snap.completed === true ? 1 : 0}`;
                    const previous = bySignature.get(sig);
                    if (!previous || String(snap.watchTimeStr || '').length > String(previous.watchTimeStr || '').length) bySignature.set(sig, snap);
                }
                return RecordNormalizer.keepSnapshotsWithinLimit([...bySignature.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
            };

            const changes = [];
            // 旧版 BV?p=N 可能仍独立存在。先将其完整合并进 BV 容器，确认备份成功后才删除旧键。
            const legacyPartKeysToDelete = new Set();
            let restoredLegacyParts = 0;
            let repaired = 0, merged = 0, ambiguous = 0, unmapped = 0, aggregateSkipped = 0;
            for (const [seasonKey, rec] of records) {
                if (!RecordKey.isSeasonKey(seasonKey) || rec.type !== 'collection' || !Array.isArray(rec.parts)) continue;
                const tokens = seriesTokens(rec);
                if (!tokens.length) continue;
                let changed = false;
                for (let i = 0; i < rec.parts.length; i++) {
                    const part = rec.parts[i];
                    const pnum = Number(part.p) || 0;
                    const oldBv = String(part.bv || '').trim().toLowerCase();
                    const oldEp = String(part.epKey || '').trim().toLowerCase();
                    if (epPattern.test(oldBv) || epPattern.test(oldEp)) {
                        const canonicalEp = epPattern.test(oldBv) ? oldBv : oldEp;
                        if (part.bv !== canonicalEp || part.epKey !== canonicalEp) { part.bv = canonicalEp; part.epKey = canonicalEp; changed = true; }
                        continue;
                    }
                    // 只处理明显把整季 ID 写进分集 bv 的旧记录，避免碰普通分集/其他类型数据。
                    if (oldBv && !/^ss\d+$/i.test(oldBv)) continue;
                    if (!pnum) { unmapped++; continue; }
                    if (pnum === 1 && !String(part.title || part.partTitle || '').trim()
                        && !(Number(part.partTotal) > 0) && !(Number(part.collectionOrder) > 0)
                        && oldBv === seasonKey.toLowerCase()) {
                        aggregateSkipped++;
                        continue;
                    }
                    const found = new Set();
                    for (const token of tokens) {
                        const set = candidates.get(mapKey(token, pnum));
                        if (set) for (const ep of set) found.add(ep);
                    }
                    if (found.size !== 1) {
                        if (found.size > 1) ambiguous++; else unmapped++;
                        continue;
                    }
                    const ep = [...found][0];
                    const duplicateIndex = rec.parts.findIndex((other, idx) => idx !== i &&
                        (String(other.epKey || '').toLowerCase() === ep || String(other.bv || '').toLowerCase() === ep));
                    if (duplicateIndex >= 0) {
                        const target = rec.parts[duplicateIndex];
                        target.snapshots = mergeSnapshots(target.snapshots, part.snapshots);
                        target.watchCount = Math.max(Number(target.watchCount) || 0, Number(part.watchCount) || 0, target.snapshots.length);
                        if (Number(part.lastTs || 0) > Number(target.lastTs || 0)) {
                            target.lastTs = Number(part.lastTs) || 0;
                            target.lastProgress = part.lastProgress || target.lastProgress || '0%';
                        }
                        target.title = target.title || part.title || part.partTitle || '';
                        target.partTotal = Math.max(Number(target.partTotal) || 0, Number(part.partTotal) || 0);
                        target.hasReachedWatchThreshold = target.hasReachedWatchThreshold === true || part.hasReachedWatchThreshold === true;
                        target.officialHistorySeen = target.officialHistorySeen === true || part.officialHistorySeen === true;
                        rec.parts.splice(i, 1);
                        i--;
                        merged++;
                    } else {
                        part.bv = ep;
                        part.epKey = ep;
                        repaired++;
                    }
                    changed = true;
                }
                if (changed) changes.push([seasonKey, rec]);
            }

            // 把仍然存在的旧扁平 BV?p=N 记录重新整合进同 BV 容器。
            // 这是“其他集不显示”的关键兼容：不能只修当前容器已有的 part，必须把残留旧键也并回来。
            const legacyGroups = new Map();
            for (const key of keys) {
                if (!RecordKey.isPartKey(key)) continue;
                const m = key.match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                if (!m) continue;
                const base = m[1];
                if (!legacyGroups.has(base)) legacyGroups.set(base, []);
                legacyGroups.get(base).push({ key, p: Number(m[2]) });
            }
            for (const [baseKey, legacyParts] of legacyGroups) {
                const rawBase = records.get(baseKey) || RecordNormalizer.normalize(GM_getValue(baseKey, null));
                let container = rawBase && rawBase.type === 'collection'
                    ? rawBase
                    : { type: 'collection', key: baseKey, title: rawBase?.title || '', authorName: rawBase?.authorName || '', mediaType: rawBase?.mediaType || '视频', collectionKey: rawBase?.collectionKey || '', smallCollections: [], parts: [], schemaVersion: 4, updatedAt: 0 };
                let changed = !(rawBase && rawBase.type === 'collection');
                // 若 BV 主键原本是单视频扁平记录，保留为第 1 P，而不是被容器化时覆盖。
                if (rawBase && rawBase.type !== 'collection' && !container.parts.some(part => Number(part.p) === 1)) {
                    container.parts.push({
                        p: 1, bv: baseKey, title: rawBase.partTitle || (rawBase.title && rawBase.title !== container.title ? rawBase.title : ''),
                        partTotal: Number(rawBase.partTotal) || 0, smallCollectionTitle: rawBase.smallCollectionTitle || '', collectionOrder: Number(rawBase.collectionOrder) || 0,
                        lastTs: Number(rawBase.lastTs) || 0, lastProgress: rawBase.lastProgress || '0%', watchCount: Number(rawBase.watchCount) || 0,
                        snapshots: Array.isArray(rawBase.snapshots) ? rawBase.snapshots : [], hasReachedWatchThreshold: rawBase.hasReachedWatchThreshold === true,
                        officialHistorySeen: rawBase.officialHistorySeen === true, emptyRecord: rawBase.emptyRecord === true
                    });
                    changed = true;
                }
                for (const legacy of legacyParts.sort((a, b) => a.p - b.p)) {
                    const flat = records.get(legacy.key) || RecordNormalizer.normalize(GM_getValue(legacy.key, null));
                    if (!flat || flat.type === 'collection') continue;
                    const incoming = {
                        p: legacy.p, bv: legacy.key,
                        title: flat.partTitle || (flat.title && flat.title !== container.title ? flat.title : ''),
                        partTotal: Number(flat.partTotal) || 0, smallCollectionTitle: flat.smallCollectionTitle || '', collectionOrder: Number(flat.collectionOrder) || 0,
                        lastTs: Number(flat.lastTs) || 0, lastProgress: flat.lastProgress || '0%', watchCount: Number(flat.watchCount) || 0,
                        snapshots: Array.isArray(flat.snapshots) ? flat.snapshots : [], hasReachedWatchThreshold: flat.hasReachedWatchThreshold === true,
                        officialHistorySeen: flat.officialHistorySeen === true, emptyRecord: flat.emptyRecord === true
                    };
                    const target = container.parts.find(part => Number(part.p) === legacy.p);
                    if (target) {
                        const oldSignature = JSON.stringify([target.bv, target.lastTs, target.watchCount, (target.snapshots || []).length]);
                        target.bv = legacy.key;
                        target.snapshots = mergeSnapshots(target.snapshots, incoming.snapshots);
                        target.watchCount = Math.max(Number(target.watchCount) || 0, Number(incoming.watchCount) || 0, target.snapshots.length);
                        if (!target.title && incoming.title) target.title = incoming.title;
                        target.partTotal = Math.max(Number(target.partTotal) || 0, incoming.partTotal);
                        target.smallCollectionTitle = target.smallCollectionTitle || incoming.smallCollectionTitle;
                        target.collectionOrder = Number(target.collectionOrder) || incoming.collectionOrder || 0;
                        if (Number(incoming.lastTs) > Number(target.lastTs)) { target.lastTs = incoming.lastTs; target.lastProgress = incoming.lastProgress; }
                        target.hasReachedWatchThreshold = target.hasReachedWatchThreshold === true || incoming.hasReachedWatchThreshold;
                        target.officialHistorySeen = target.officialHistorySeen === true || incoming.officialHistorySeen;
                        const newSignature = JSON.stringify([target.bv, target.lastTs, target.watchCount, (target.snapshots || []).length]);
                        if (oldSignature !== newSignature) changed = true;
                    } else {
                        container.parts.push(incoming);
                        changed = true;
                    }
                    legacyPartKeysToDelete.add(legacy.key);
                    restoredLegacyParts++;
                }
                if (changed) {
                    container.parts.sort((a, b) => (Number(a.p) || 0) - (Number(b.p) || 0));
                    records.set(baseKey, RecordNormalizer.normalize(container) || container);
                    const idx = changes.findIndex(([key]) => key === baseKey);
                    if (idx >= 0) changes[idx] = [baseKey, records.get(baseKey)];
                    else changes.push([baseKey, records.get(baseKey)]);
                }
            }

            // 普通 BV 多P 合集也直接修正 bv：bv 保存完整的 BV 或 BV?p=N，不增加额外字段。
            let collectionKeysFixed = 0;
            for (const [containerKey, rec] of records) {
                if (RecordKey.isSeasonKey(containerKey) || !/^BV[a-zA-Z0-9]+$/i.test(containerKey)
                    || rec.type !== 'collection' || !Array.isArray(rec.parts)) continue;
                let changed = false;
                for (const part of rec.parts) {
                    const pnum = Math.max(1, Number(part.p) || 1);
                    const rawBv = String(part.bv || containerKey).trim();
                    const baseBv = rawBv.match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || containerKey;
                    const canonicalBv = `${baseBv}${baseBv.toUpperCase() === containerKey.toUpperCase() && pnum > 1 ? `?p=${pnum}` : ''}`;
                    if (part.bv !== canonicalBv) {
                        part.bv = canonicalBv;
                        changed = true;
                        collectionKeysFixed++;
                    }
                }
                if (changed) {
                    const existingChange = changes.findIndex(([k]) => k === containerKey);
                    if (existingChange >= 0) changes[existingChange] = [containerKey, rec];
                    else changes.push([containerKey, rec]);
                }
            }

            if (!changes.length && !legacyPartKeysToDelete.size) {
                alert(`本地数据扫描完成，没有需要修改的记录。\n番剧无映射：${unmapped} 条\n番剧映射冲突：${ambiguous} 条\n疑似整季聚合记录保留：${aggregateSkipped} 条\n普通合集完整分集键修正：${collectionKeysFixed} 条`);
                return;
            }
            if (!confirm(`将直接整合油猴本地存储，不需要打开播放页。\n\n待写入容器：${changes.length} 个\n从旧 BV?p=N 键恢复/合并分集：${restoredLegacyParts} 条\n修正番剧旧分集身份：${repaired} 条\n合并重复分集：${merged} 条\n修正普通合集完整分集键：${collectionKeysFixed} 条\n番剧无映射保留：${unmapped} 条\n番剧映射冲突保留：${ambiguous} 条\n疑似整季聚合保留：${aggregateSkipped} 条\n\n将先备份受影响容器和旧分P记录；写入成功后才删除已合并的旧分P键。是否继续？`)) return;

            const backupKey = `bvh_bangumi_identity_backup_${Date.now()}`;
            const backup = { createdAt: Date.now(), records: {} };
            for (const [key] of changes) {
                const raw = GM_getValue(key, null);
                if (raw !== null) backup.records[key] = raw;
            }
            for (const key of legacyPartKeysToDelete) {
                const raw = GM_getValue(key, null);
                if (raw !== null) backup.records[key] = raw;
            }
            try { GM_setValue(backupKey, backup); }
            catch (error) {
                alert(`无法保存修复前备份，已取消修改。\n${String(error && error.message || error)}`);
                return;
            }
            for (const [key, rec] of changes) RecordStore.set(key, RecordNormalizer.normalize(rec) || rec);
            // 只有容器已写入后才删除旧键；如果写入失败，原始分集仍保留。
            for (const key of legacyPartKeysToDelete) {
                const m = key.match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                if (m && changes.some(([changedKey]) => changedKey.toUpperCase() === m[1].toUpperCase())) RecordStore.deleteRaw(key);
            }
            HistoryViewIndex.reset();
            RecordStore.clearIndex();
            HistoryViewIndex.ensure();
            refreshOpenHistoryLists(true);
            alert(`本地分集数据整合完成。\n从旧 BV?p=N 键恢复/合并：${restoredLegacyParts} 条\n修正番剧分集身份：${repaired} 条\n合并重复分集：${merged} 条\n修正普通合集完整分集键：${collectionKeysFixed} 条\n写入容器：${changes.length} 个\n番剧无映射保留：${unmapped} 条\n番剧映射冲突保留：${ambiguous} 条\n疑似整季聚合保留：${aggregateSkipped} 条\n\n修复前备份已保存在油猴内部键：${backupKey}。如果某些分集旧键已被此前版本删除且没有备份，本脚本无法凭空恢复这些观看数据。`);
        },

        // 5.3.0：把旧版本扁平记录迁移到「合集容器」结构（设置菜单"更新本地数据结构"触发）。
        //   - 同BV多P（BV?p=N）归并成容器 BV（parts[] 按 p 排序）；
        //   - 纯单视频 BV（无分P）保持单独一条；番剧 ep/ss、直播 live 保持；
        //   - 跨BV合集（旧数据无 collectionKey）先按单视频保留，播放页扫描后并入；
        //   - 分集标题：从记录 partTitle 取，取不到留空，等播放页选集列表回填；
        //   - 删除旧键前逐条确认；迁移前自动导出一份备份 JSON 供回退。
        migrateToContainerStructure() {
            const allKeys = GM_listValues().filter(k => RecordKey.isRecordKey(k));
            if (!allKeys.length) { alert('当前没有任何记录。'); return; }

            if (!confirm(
                '即将把本地历史迁移到「合集容器」结构：\n' +
                '- 同BV多P（BV?p=N）归并成合集容器，分集进 parts[]\n' +
                '- 删除旧的分P键（删除前会逐条确认）\n' +
                '- 迁移前自动导出一份备份 JSON 供回退\n\n继续？'
            )) return;
            this.exportAllRecords();

            const mergeSnapshots = (listA, listB) => {
                const snapMap = new Map();
                for (const s of [...(listA || []), ...(listB || [])]) {
                    if (!s || typeof s !== 'object') continue;
                    const sig = `${Number(s.ts) || 0}|${s.pos == null ? '' : Number(s.pos)}|${String(s.progress || '')}|${s.completed === true ? 1 : 0}`;
                    const old = snapMap.get(sig);
                    if (!old || String(s.watchTimeStr || '').length > String(old.watchTimeStr || '').length) snapMap.set(sig, s);
                }
                return RecordNormalizer.keepSnapshotsWithinLimit([...snapMap.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
            };

            // 1) 扫描归组：bv -> {parts:[{p,key}], plain:null}。
            // 只清理“确实没有观看事实、也没有可用于合集匹配的元数据”的空记录；
            // 有标题/作者/合集信息的空记录仍保留，避免破坏后续合集识别与标题回填。
            const hasUsefulEmptyMetadata = rec => !!(rec && (
                String(rec.title || '').trim() || String(rec.partTitle || '').trim() ||
                String(rec.collectionTitle || '').trim() || String(rec.smallCollectionTitle || '').trim() ||
                String(rec.collectionKey || '').trim() || String(rec.authorName || '').trim() ||
                String(rec.author || '').trim() || Number(rec.collectionOrder) > 0 ||
                Number(rec.partTotal) > 1 || Number(rec.seasonId) > 0
            ));
            const isUselessEmptyFlatRecord = rec => !!(
                rec && rec.type !== 'collection' && rec.emptyRecord === true &&
                !hasUsefulEmptyMetadata(rec)
            );
            const groups = new Map();
            const uselessEmptyKeys = new Set();
            for (const key of allKeys) {
                const raw = GM_getValue(key, null);
                const rec = RecordNormalizer.normalize(raw);
                if (rec && rec.type !== 'collection' && isUselessEmptyFlatRecord(rec)) {
                    uselessEmptyKeys.add(key);
                    continue;
                }
                if (RecordKey.isPartKey(key)) {
                    const m = key.match(/^(BV[a-zA-Z0-9]+)\?p=(\d+)$/i);
                    const g = groups.get(m[1]) || { parts: [], plain: null };
                    g.parts.push({ p: Number(m[2]), key });
                    groups.set(m[1], g);
                } else if (RecordKey.isPlainBvKey(key)) {
                    const g = groups.get(key) || { parts: [], plain: null };
                    g.plain = key;
                    groups.set(key, g);
                }
                // 其余（ep/ss/live/已有容器/标题容器）保持原键；空容器分集会在下面安全裁剪。
            }

            // 2) 构造容器与待删键。
            const toWrite = [];
            const toDelete = [...uselessEmptyKeys];
            let collectionCount = 0;
            for (const [bv, g] of groups) {
                const existing = RecordNormalizer.normalize(GM_getValue(bv, null));
                const hasContainer = !!(existing && existing.type === 'collection');
                if (hasContainer) {
                    const beforeCount = existing.parts.length;
                    existing.parts = existing.parts.filter(part => !(part.emptyRecord === true &&
                        !String(part.title || '').trim() && !String(part.smallCollectionTitle || '').trim() &&
                        !(Number(part.collectionOrder) > 0)));
                    if (existing.parts.length !== beforeCount) {
                        // 空分集既无观看事实，也没有标题/分组元数据，属于可安全移除的冗余项。
                        existing.updatedAt = TimeTool.now();
                    }
                }
                if (!g.parts.length) {
                    if (hasContainer) toWrite.push({ key: bv, value: RecordNormalizer.normalize(existing) });
                    continue; // 纯单视频：保持原键
                }
                let container = hasContainer ? existing : { type: 'collection', key: bv, title: '', authorName: '', mediaType: '视频', parts: [], schemaVersion: 4 };
                for (const part of g.parts) {
                    const rec = RecordNormalizer.normalize(GM_getValue(part.key, null));
                    if (!rec) { toDelete.push(part.key); continue; }
                    if (isUselessEmptyFlatRecord(rec)) { toDelete.push(part.key); continue; }
                    if (!container.title && rec.title) container.title = rec.title;
                    if (!container.authorName && rec.authorName) container.authorName = rec.authorName;
                    const newPart = {
                        p: part.p, bv,
                        title: rec.partTitle || '',
                        partTotal: rec.partTotal || 0,
                        smallCollectionTitle: rec.smallCollectionTitle || '',
                        collectionOrder: rec.collectionOrder || 0,
                        lastTs: rec.lastTs || 0,
                        lastProgress: rec.lastProgress || '0%',
                        watchCount: rec.watchCount || 0,
                        snapshots: rec.snapshots || [],
                        hasReachedWatchThreshold: rec.hasReachedWatchThreshold === true,
                        officialHistorySeen: rec.officialHistorySeen === true
                    };
                    const existingPart = container.parts.find(pp => pp.p === part.p);
                    if (existingPart) {
                        existingPart.snapshots = mergeSnapshots(existingPart.snapshots, newPart.snapshots);
                        existingPart.watchCount = Math.max(Number(existingPart.watchCount) || 0, Number(newPart.watchCount) || 0);
                        if (!existingPart.title && newPart.title) existingPart.title = newPart.title;
                        if (Number(newPart.lastTs) > Number(existingPart.lastTs) || 0) { existingPart.lastTs = newPart.lastTs; existingPart.lastProgress = newPart.lastProgress; }
                        existingPart.hasReachedWatchThreshold = existingPart.hasReachedWatchThreshold || newPart.hasReachedWatchThreshold;
                    } else {
                        container.parts.push(newPart);
                    }
                    toDelete.push(part.key);
                }
                if (g.plain) {
                    const rec = RecordNormalizer.normalize(GM_getValue(g.plain, null));
                    if (rec && isUselessEmptyFlatRecord(rec)) {
                        toDelete.push(g.plain);
                    } else if (rec && !container.parts.some(pp => pp.p === 1)) {
                        container.parts.push({
                            p: 1, bv, title: rec.partTitle || (rec.title && rec.title !== container.title ? rec.title : ''),
                            partTotal: rec.partTotal || 0, smallCollectionTitle: rec.smallCollectionTitle || '', collectionOrder: 0,
                            lastTs: rec.lastTs || 0, lastProgress: rec.lastProgress || '0%', watchCount: rec.watchCount || 0,
                            snapshots: rec.snapshots || [], hasReachedWatchThreshold: rec.hasReachedWatchThreshold === true, officialHistorySeen: rec.officialHistorySeen === true
                        });
                    }
                    toDelete.push(g.plain);
                }
                container.parts.sort((a, b) => a.p - b.p);
                if (container.parts.length || hasContainer) { toWrite.push({ key: bv, value: RecordNormalizer.normalize(container) }); if (container.parts.length) collectionCount++; }
            }

            // 去重待删键，避免“空记录清理”和“旧键迁移”重复计数。
            const uniqueToDelete = [...new Set(toDelete)];

            // 3) 删除旧键前确认。
            if (uniqueToDelete.length) {
                const sample = uniqueToDelete.slice(0, 20).map(k => `- ${k}`).join('\n');
                if (!confirm(
                    `本次整理将删除 ${uniqueToDelete.length} 条旧扁平键或无效空记录（有观看事实或有用标题/合集元数据的记录会保留）：\n${sample}` +
                    (uniqueToDelete.length > 20 ? `\n… 还有 ${uniqueToDelete.length - 20} 条` : '') +
                    `\n\n点击"确定"删除并完成迁移；点击"取消"中止（不删任何键、不做改动）。`
                )) { alert('已中止迁移，未做任何删除。'); return; }
            }

            // 4) 写入容器、删除旧键（旧扁平键用 deleteRaw 直接删，避免容器感知误删刚并入的 part）、重建索引。
            for (const { key, value } of toWrite) {
                if (value && value.type === 'collection') RecordStore.set(key, value);
            }
            for (const key of uniqueToDelete) RecordStore.deleteRaw(key);
            HistoryViewIndex.reset();
            RecordStore.clearIndex();
            HistoryViewIndex.ensure();
            alert(`整理完成：处理 ${toWrite.length} 个键（含 ${collectionCount} 个合集容器），删除旧扁平键/无效空记录 ${uniqueToDelete.length} 条。带观看事实或可用于合集匹配的标题、作者、分组元数据均予以保留；分集标题留空的会在播放页扫描合集时回填。`);
        },

        // 检查油猴存储是否接近容量上限，超过警戒线时提示用户。
        checkStorageWarn() {
            const used = ByteTool.calcStorageSize();
            if (used > CONFIG.STORAGE_WARN_THRESHOLD) {
                alert(`⚠️ 存储即将满！已用 ${ByteTool.format(used)}，上限 ${ByteTool.format(CONFIG.STORAGE_MAX_BYTE)}，建议导出备份+清理过期记录`);
                return true;
            }
            return false;
        }
    };

    // 给一条记录或快照补上备份、过期状态。
    // 只在【真正要渲染出来的那几条】上调用：不再为全部记录预先复制一份带状态的中间数组，
    // 也不再在每次搜索输入时把整份历史重新整理一遍。
    // 【模块：为列表条目补充展示状态】
    // 根据原始条目、已导出标记和当前时间计算界面所需的附加状态，例如是否已导出或是否过期。
    // 该步骤只服务于展示，不应改变原始记录内容。
    function decorateEntry(entry, exportedMap, nowTs) {
        const key = entry.key != null ? entry.key : entry.bvKey;
        const rawTs = Number(entry.lastTs);
        const validTs = Number.isFinite(rawTs) && rawTs > 0;
        const isExported = Object.prototype.hasOwnProperty.call(exportedMap, key);
        const isExp = isExported && validTs && (nowTs - rawTs) > CONFIG.EXPIRE_MS;
        const isUnknownTime = !validTs;
        return {
            ...entry,
            isExp,
            isUnknownTime,
            isExported,
            canClean: isExported && (isExp || isUnknownTime)
        };
    }

    // ── 高级搜索解析器：把搜索框输入拆成"普通关键词"和"结构化条件" ──
    //
    // 用法（多个条件用空格隔开，全部满足才命中）：
    //   普通词           BV号 / 标题 / 作者 / 标签 / 分集 任意字段包含即命中
    //   次数>=3          观看次数比较：支持 次数>5  观看<=2  count:>=10
    //   进度>50          最后进度比较（百分比数值）：支持 进度=100  progress:<80
    //   2024-05-01       时间匹配：年 / 年月 / 年月日，命中任一快照时间
    //   快照:45%         只在快照内容（时间+进度+位置）里检索
    //
    // 示例：
    //   "次数>=3 进度>50"        → 看过至少 3 次、且进度超过 50% 的
    //   "2024-05 老番茄"         → 2024 年 5 月看过、标题/作者含"老番茄"
    //   "快照:100%"              → 任何带"已看完"快照的记录
    // 【模块：历史记录搜索语法与条件匹配】
    // 解析用户输入中的普通关键词和结构化条件，再分别匹配观看次数、进度、时间及快照内容。
    // 普通关键词用于标题、作者、合集等可搜索文本；条件查询用于精确筛选记录。
    // 多个条件如何组合由各匹配函数明确规定，避免把搜索语法的含义散落在渲染代码中。
    const SearchQuery = {
        // 将搜索框内容拆成普通关键词和结构化条件。
        parse(raw) {
            const text = String(raw || '').trim();
            const keywords = [];
            const conditions = [];
            if (!text) return { keywords, conditions };
            text.split(/\s+/).forEach(token => {
                const cond = this._parseCondition(token);
                if (cond) conditions.push(cond);
                else keywords.push(token.toLowerCase());
            });
            return { keywords, conditions };
        },

        // 把一个 token 解析成结构化条件；识别不了就当普通关键词
        _parseCondition(token) {
            let m;
            // 单条观看次数与分组总观看次数分开：次数>=3；总观看>=20 / 总次数>5 / totalcount:>=10
            if ((m = token.match(/^(?:总观看(?:次数)?|总次数|合计观看|合集观看|totalcount|groupcount|totalwatch)\s*[:：]?\s*(>=|<=|>|<|!=|=)\s*(\d+)次?$/i))) {
                return { type: 'totalcount', op: m[1], value: Number(m[2]) };
            }
            if ((m = token.match(/^(?:次数|观看(?:次数)?|单条观看|count|watchcount)\s*[:：]?\s*(>=|<=|>|<|!=|=)\s*(\d+)次?$/i))) {
                return { type: 'count', op: m[1], value: Number(m[2]) };
            }
            // 进度：进度>50 / progress:=100 / 进度<=80（百分号可写可不写）
            if ((m = token.match(/^(?:进度|progress)\s*[:：]?\s*(>=|<=|>|<|!=|=)\s*(\d+(?:\.\d+)?)%?$/i))) {
                return { type: 'progress', op: m[1], value: Number(m[2]) };
            }
            // 时间：支持年份、年月、完整日期、月日；允许用“时间:”或“time:”显式标记。
            // 年月格式单独处理，避免 2024-05 被错误地当成“月-日”解析。
            if ((m = token.match(/^(?:(?:时间|time)\s*[:：])?(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}|\d{4})$/))) {
                return { type: 'time', needle: m[1].replace(/\//g, '-') };
            }
            // 快照内容：快照:45% / snap:2024-05
            if ((m = token.match(/^(?:快照|snap)\s*[:：](.+)$/i))) {
                return { type: 'snapshot', needle: m[1].toLowerCase() };
            }
            return null;
        },

        // 按指定比较符比较两个数值，供次数和进度条件共用。
        compare(op, left, right) {
            switch (op) {
                case '>': return left > right;
                case '<': return left < right;
                case '>=': return left >= right;
                case '<=': return left <= right;
                case '!=': return left !== right;
                case '=':
                default: return left === right;
            }
        },

        // 各条件判定：conditions 里没有该类型 = 不限制（恒 true）；全部满足才命中
        matchCount(q, count) {
            return q.conditions.every(c => c.type !== 'count' || this.compare(c.op, Number(count) || 0, c.value));
        },
        // 提取进度数值，并判断其是否满足所有进度条件。
        matchProgress(q, progress) {
            return q.conditions.every(c => {
                if (c.type !== 'progress') return true;
                const m = String(progress || '').match(/-?\d+(?:\.\d+)?/);
                return this.compare(c.op, m ? Number(m[0]) : 0, c.value);
            });
        },
        // 判断记录快照时间是否命中输入的日期条件。
        matchTime(q, watchTimeStr, ts) {
            const timeConds = q.conditions.filter(c => c.type === 'time');
            if (!timeConds.length) return true;
            const formatted = watchTimeStr || TimeTool.formatTimestamp(ts);
            // 多个时间条件按"或"处理：命中任意一个日期即可
            return timeConds.some(c => formatted.includes(c.needle));
        },
        // 把快照时间、进度和播放位置合并检索，检查快照条件是否全部命中。
        matchSnapshot(q, snapshots) {
            const snapConds = q.conditions.filter(c => c.type === 'snapshot');
            if (!snapConds.length) return true;
            const snapText = (snapshots || [])
            .map(s => `${s.watchTimeStr || ''} ${s.progress || ''} ${s.pos ?? ''}`)
            .join(' ')
            .toLowerCase();
            return snapConds.every(c => snapText.includes(c.needle));
        },
        // 要求每个普通关键词都能在可搜索文本中找到。
        matchKeywords(q, haystack) {
            return q.keywords.every(k => haystack.includes(k));
        }
    };

    // 【模块：历史列表查询与渲染】
    // 负责把索引/原始记录转成历史列表 UI，包括搜索过滤、合集分组、分集显示、快照条目、
    // 状态标记、右键菜单和存储信息展示。播放悬浮窗与历史记录页面可复用同一套记录展示逻辑，
    // 通过 variant/options 区分具体场景，而不是各自维护一套互不一致的匹配规则。
    const HistoryListRenderer = {
        _states: new WeakMap(),
        _storageUpdateScheduled: false,
        _expandedGroups: new Set(),
        _groupSortMode: 'watch', // 'watch' = 按观看时间；'collection' = 按合集原始顺序


        // 存储统计会遍历并序列化全部 GM 数据，不能放在最近快照首屏的同步路径上。
        // 延后到首屏绘制之后更新，并用较长缓存窗口避免每次输入搜索都重复扫描。
        _scheduleStorageLabelUpdate() {
            const label = document.getElementById('bvh-hp-storage');
            if (!label || this._storageUpdateScheduled) return;
            this._storageUpdateScheduled = true;
            setTimeout(() => {
                this._storageUpdateScheduled = false;
                if (!label.isConnected) return;
                const info = ByteTool.getStorageInfo();
                label.textContent = `存储：已用 ${info.usedStr} / 剩余 ${info.freeStr}（上限 ${ByteTool.format(CONFIG.STORAGE_MAX_BYTE)}） / 总条数 ${info.recordCount}`;
            }, 300);
        },
        // 在查询结果上右键，使用与脚本其他面板一致的粉色玻璃拟态菜单。
        _bindRecordContextMenu(li, key) {
            li.addEventListener('contextmenu', event => {
                if (!RecordKey.isRecordKey(key)) return;
                event.preventDefault();
                event.stopPropagation();
                document.getElementById('bvh-record-context-menu')?.remove();
                document.getElementById('bvh-record-count-dialog')?.remove();

                const menu = document.createElement('div');
                menu.id = 'bvh-record-context-menu';
                menu.className = 'bvh-record-context-menu';
                menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 210))}px`;
                menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 112))}px`;

                const title = document.createElement('div');
                title.className = 'bvh-record-context-title';
                title.textContent = '记录操作';
                menu.appendChild(title);

                const closeMenu = () => {
                    menu.remove();
                    document.removeEventListener('pointerdown', closeOutside, true);
                    document.removeEventListener('keydown', closeEscape, true);
                };
                const closeOutside = e => {
                    if (!menu.contains(e.target)) closeMenu();
                };
                const closeEscape = e => { if (e.key === 'Escape') closeMenu(); };
                const makeButton = (label, action, danger = false) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = `bvh-record-context-action${danger ? ' is-danger' : ''}`;
                    button.textContent = label;
                    button.addEventListener('click', () => { closeMenu(); action(); });
                    menu.appendChild(button);
                };
                makeButton('调整观看次数', () => {
                    const rec = RecordNormalizer.normalize(GM_getValue(key));
                    if (!rec) {
                        alert('这条观看记录已不存在。');
                        refreshOpenHistoryLists();
                        return;
                    }
                    const currentCount = Math.max(0, Math.floor(Number(rec.watchCount) || 0));
                    const overlay = document.createElement('div');
                    overlay.id = 'bvh-record-count-dialog';
                    overlay.className = 'bvh-record-dialog-overlay';
                    overlay.innerHTML = `
                        <section class="bvh-record-dialog" role="dialog" aria-modal="true" aria-labelledby="bvh-record-dialog-title">
                            <div class="bvh-record-dialog-title" id="bvh-record-dialog-title">调整观看次数</div>
                            <div class="bvh-record-dialog-desc">修改次数会保留该视频的快照、标题、作者和进度信息。</div>
                            <label class="bvh-record-count-label" for="bvh-record-count-input">观看次数（0–10000）</label>
                            <input id="bvh-record-count-input" class="bvh-record-count-input" type="number" min="0" max="10000" step="1" value="${currentCount}">
                            <div class="bvh-record-dialog-actions">
                                <button type="button" class="bvh-record-dialog-btn" data-action="cancel">取消</button>
                                <button type="button" class="bvh-record-dialog-btn is-primary" data-action="save">保存</button>
                            </div>
                        </section>`;
                    document.body.appendChild(overlay);
                    const input = overlay.querySelector('#bvh-record-count-input');
                    const closeDialog = () => {
                        overlay.remove();
                        document.removeEventListener('keydown', dialogEscape, true);
                    };
                    const dialogEscape = e => { if (e.key === 'Escape') closeDialog(); };
                    overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });
                    overlay.querySelector('[data-action="cancel"]').addEventListener('click', closeDialog);
                    const save = () => {
                        const raw = input.value.trim();
                        if (!/^\d+$/.test(raw) || Number(raw) > 10000) {
                            input.setCustomValidity('请输入 0 到 10000 之间的整数。');
                            input.reportValidity();
                            return;
                        }
                        closeDialog();
                        StorageApi.setWatchCount(key, Number(raw));
                    };
                    overlay.querySelector('[data-action="save"]').addEventListener('click', save);
                    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
                    input.addEventListener('input', () => input.setCustomValidity(''));
                    document.addEventListener('keydown', dialogEscape, true);
                    requestAnimationFrame(() => { input.focus(); input.select(); });
                });
                makeButton('删除整条记录', () => StorageApi.deleteSingleRecord(key), true);
                document.body.appendChild(menu);
                setTimeout(() => {
                    document.addEventListener('pointerdown', closeOutside, true);
                    document.addEventListener('keydown', closeEscape, true);
                }, 0);
            });
        },

        // 分批推进列表任务。与旧版的关键差别：旧版只把【建 DOM】分批，
        // tasks 在进入本函数前已经全量筛选完毕；现在任务源是一个可暂停的取数器，
        // 每帧同时受两个预算约束 —— 最多推进多少条筛选、最多插入多少节点，
        // 因此搜索时的数据整理也是分批的。
        // generation 令牌：新搜索（或任何一次重新渲染）会让旧任务立即停止，
        // 旧搜索剩下没扫完的记录不会被继续处理，结果也不会混进新列表。
        renderTasks(listDom, tasks, options = {}) {
            let state = this._states.get(listDom);
            if (!state) {
                state = { generation: 0 };
                this._states.set(listDom, state);
            }
            state.generation++;
            const generation = state.generation;

            // 任务源：数组（快照区那几条固定任务）或取数器（全部记录的流式筛选）
            const next = Array.isArray(tasks)
                ? (() => {
                    let i = 0;
                    return () => (i < tasks.length ? tasks[i++] : null);
                })()
                : tasks;

            // preserveScrollTop：渲染期间用遮罩挡住"列表清空后滚动条归零"的过程，
            // 渲染完成后先滚回目标位置、再移除遮罩，避免用户看到"先回顶部再滑回来"。
            const preserveScrollTop = Number.isFinite(options.preserveScrollTop)
                ? options.preserveScrollTop
                : null;
            const useMask = preserveScrollTop != null;

            if (useMask) listDom.classList.add('bvh-list-rendering');
            listDom.replaceChildren();

            const PULL_BUDGET = 240;  // 每帧最多推进多少条筛选
            const APPEND_BUDGET = 80; // 每帧最多插入多少个节点

            const flush = () => {
                if (state.generation !== generation) {
                    if (useMask) listDom.classList.remove('bvh-list-rendering');
                    return; // 已被新渲染取消
                }
                let pulls = 0;
                let appended = 0;
                let finished = false;
                while (pulls < PULL_BUDGET && appended < APPEND_BUDGET) {
                    const makeNode = next();
                    pulls++;
                    if (makeNode === null) {
                        finished = true;
                        break;
                    }
                    if (typeof makeNode !== 'function') continue; // 该条未命中，不占插入预算
                    try {
                        const node = makeNode();
                        if (node) {
                            listDom.appendChild(node);
                            appended++;
                        }
                    } catch (err) {
                        console.warn('[Bilibili History] 创建历史列表行失败：', err);
                    }
                }
                if (finished) {
                    if (useMask) {
                        listDom.scrollTop = preserveScrollTop;
                        listDom.classList.remove('bvh-list-rendering');
                    }
                    if (typeof options.onFinish === 'function') options.onFinish();
                    return;
                }
                if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flush);
                else setTimeout(flush, 16);
            };
            if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flush);
            else setTimeout(flush, 0);
        },

        // 把一次搜索的条件按类型分好，供逐条判定时跳过不相关的检查，
        // 避免每条记录都把 conditions 重新过滤一遍。
        _splitConditions(query) {
            const parts = { count: [], totalcount: [], progress: [], time: [], snapshot: [] };
            for (const cond of (query.conditions || [])) {
                if (parts[cond.type]) parts[cond.type].push(cond);
            }
            return parts;
        },

        // 快照行的判定器。没有关键词时完全跳过 _buildHaystack（那是逐条最贵的一步）。
        _buildSnapMatcher(query, index) {
            const parts = this._splitConditions(query);
            const keywords = (query.keywords || []).length > 0;
            const groupTotals = new Map();
            if (parts.totalcount.length && index?.itemsByKey) {
                for (const key of index.sortedKeys || Object.keys(index.itemsByKey)) {
                    const item = index.itemsByKey[key];
                    if (!item) continue;
                    const bv = String(item.key || key).match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || String(key);
                    const group = item.collectionKey ? `collection:${item.collectionKey}` : `bv:${bv}`;
                    groupTotals.set(group, (groupTotals.get(group) || 0) + Math.max(0, Number(item.watchCount) || 0));
                }
            }
            return snap => {
                if (keywords && !SearchQuery.matchKeywords(query, this._buildHaystack(snap))) return false;
                if (parts.count.length && !SearchQuery.matchCount(query, snap.watchCount)) return false;
                if (parts.totalcount.length && index?.itemsByKey) {
                    const item = index.itemsByKey[snap.bvKey];
                    const bv = String(snap.bvKey || '').match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || String(snap.bvKey || '');
                    const group = item?.collectionKey ? `collection:${item.collectionKey}` : `bv:${bv}`;
                    if (!parts.totalcount.every(c => SearchQuery.compare(c.op, groupTotals.get(group) || 0, c.value))) return false;
                }
                if (parts.progress.length && !SearchQuery.matchProgress(query, snap.progress)) return false;
                if (parts.time.length && !SearchQuery.matchTime(query, snap.watchTimeStr, snap.ts)) return false;
                return true;
            };
        },

        // 整记录行的判定器。时间条件不存在时不做 formatTimestamp，
        // 快照条件不存在时不拼接快照文本 —— 两者原本每次输入都对全部记录各跑一遍。
        _buildRecordMatcher(query, index) {
            const parts = this._splitConditions(query);
            const keywords = (query.keywords || []).length > 0;
            // 总观看按显示层的合集分组口径统计：同 collectionKey 的记录求和；
            // 没有合集元数据时退回同 BV 的各 P，避免把不同视频混在一起。
            const groupTotals = new Map();
            if (parts.totalcount.length && index?.itemsByKey) {
                for (const key of index.sortedKeys || Object.keys(index.itemsByKey)) {
                    const item = index.itemsByKey[key];
                    if (!item) continue;
                    const bv = String(item.key || key).match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || String(key);
                    const group = item.collectionKey ? `collection:${item.collectionKey}` : `bv:${bv}`;
                    groupTotals.set(group, (groupTotals.get(group) || 0) + Math.max(0, Number(item.watchCount) || 0));
                }
            }
            return it => {
                if (keywords && !SearchQuery.matchKeywords(query, this._buildHaystack(it))) return false;
                if (parts.count.length && !SearchQuery.matchCount(query, it.watchCount)) return false;
                if (parts.totalcount.length) {
                    const bv = String(it.key || '').match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || String(it.key || '');
                    const group = it.collectionKey ? `collection:${it.collectionKey}` : `bv:${bv}`;
                    if (!parts.totalcount.every(c => SearchQuery.compare(c.op, groupTotals.get(group) || 0, c.value))) return false;
                }
                if (parts.progress.length && !SearchQuery.matchProgress(query, it.lastProgress)) return false;
                if (parts.time.length
                    && !SearchQuery.matchTime(query, TimeTool.formatTimestamp(it.lastTs), it.lastTs)) return false;
                if (parts.snapshot.length && !SearchQuery.matchSnapshot(query, it.snapshots)) return false;
                return true;
            };
        },

        // 全部记录流：普通视频若有多个已记录分 P，则在显示层归为一个可展开主项；
        // 原始记录和索引仍按每个 P 独立保存，展开项继续使用各自的 key、次数与快照。
        _recordStream(index, matcher, exportedMap, nowTs) {
            const keys = index.sortedKeys;
            const itemsByKey = index.itemsByKey;
            const groups = new Map();
            const collectionByBv = new Map();
            for (const key of keys) {
                const item = itemsByKey[key];
                const bv = String(key || '').match(/^(BV[a-zA-Z0-9]+)(?:\?p=\d+)?$/i);
                if (item?.collectionKey && bv) collectionByBv.set(bv[1], item.collectionKey);
            }
            const groupIdFor = item => {
                if (!item) return null;
                // 先按合集指纹归组，不能先要求 key 是 BV；番剧/电视剧分集键是 ep123...。
                if (item.collectionKey) return `collection:${item.collectionKey}`;
                const bv = String(item.key || '').match(/^(BV[a-zA-Z0-9]+)(?:\?p=\d+)?$/i);
                if (!bv) return null;
                const collectionKey = collectionByBv.get(bv[1]);
                if (collectionKey) return `collection:${collectionKey}`;
                return `bv:${bv[1]}`;
            };
            for (const key of keys) {
                const source = itemsByKey[key];
                if (!source) continue;
                const groupId = groupIdFor(source);
                if (!groupId) continue;
                if (!groups.has(groupId)) groups.set(groupId, []);
                groups.get(groupId).push(key);
            }
            const multiGroups = new Map();
            for (const [groupId, groupKeys] of groups) {
                if (groupKeys.length > 1 || groupKeys.some(groupKey => !!itemsByKey[groupKey]?.collectionKey)) {
                    multiGroups.set(groupId, groupKeys);
                }
            }

            let cursor = 0;
            const emittedGroups = new Set();
            return () => {
                while (cursor < keys.length) {
                    const key = keys[cursor++];
                    const source = itemsByKey[key];
                    if (!source) continue;
                    const groupId = groupIdFor(source);
                    const groupKeys = groupId && multiGroups.get(groupId);
                    if (groupKeys) {
                        if (emittedGroups.has(groupId)) continue;
                        emittedGroups.add(groupId);
                        const allParts = groupKeys
                        .map(partKey => itemsByKey[partKey])
                        .filter(Boolean);

                        const smallKeyOf = item => {
                            const t = String(item.smallCollectionTitle || '').trim();
                            return t ? `small:${t}` : `item:${item.key}`;
                        };

                        if (this._groupSortMode === 'watch') {
                            // 小合集整体成组，组间按组内最新观看时间降序，组内也按观看时间降序。
                            // 普通 item 各自成组，不会打断小合集的连续性。
                            const groupMaxTs = new Map();
                            allParts.forEach(item => {
                                const g = smallKeyOf(item);
                                const ts = Number(item.lastTs) || 0;
                                if (!groupMaxTs.has(g) || ts > groupMaxTs.get(g)) groupMaxTs.set(g, ts);
                            });
                            allParts.sort((a, b) => {
                                const ga = smallKeyOf(a), gb = smallKeyOf(b);
                                if (ga !== gb) {
                                    const ta = groupMaxTs.get(ga) || 0, tb = groupMaxTs.get(gb) || 0;
                                    if (ta !== tb) return tb - ta;
                                    const oa = Number(a.collectionOrder) || 0, ob = Number(b.collectionOrder) || 0;
                                    if (oa !== ob) return oa - ob;
                                    return 0;
                                }
                                const ta = Number(a.lastTs) || 0, tb = Number(b.lastTs) || 0;
                                if (ta !== tb) return tb - ta;
                                const na = Number(a.partNumber) || 0, nb = Number(b.partNumber) || 0;
                                if (na !== nb) return na - nb;
                                return 0;
                            });
                        } else {
                            allParts.sort((a, b) => {
                                if (a.collectionKey && a.collectionKey === b.collectionKey) {
                                    const orderA = Number(a.collectionOrder) || 0;
                                    const orderB = Number(b.collectionOrder) || 0;
                                    if (orderA !== orderB) return orderA - orderB;
                                    const na = Number(a.partNumber) || 0;
                                    const nb = Number(b.partNumber) || 0;
                                    if (na && nb && na !== nb) return na - nb;
                                }
                                const getP = item => {
                                    const m = String(item.key).match(/\?p=(\d+)/i);
                                    return m ? Number(m[1]) : 1;
                                };
                                return getP(a) - getP(b);
                            });
                        }
                        const matchedParts = allParts.filter(matcher);
                        if (!matchedParts.length) continue;
                        return () => this._renderRecordGroup(allParts, matchedParts, exportedMap, nowTs);
                    }
                    if (!matcher(source)) continue;
                    return () => this._renderRecordItem(decorateEntry(source, exportedMap, nowTs));
                }
                return null;
            };
        },

        // 分 P 标签统一用小尺寸圆角胶囊，沿用历史面板的粉色/浅色视觉语言。
        _partLabel(itemOrKey) {
            let pn = 0;
            if (itemOrKey && typeof itemOrKey === 'object') {
                if (Number(itemOrKey.partNumber) > 0) pn = Number(itemOrKey.partNumber);
                if (!pn && itemOrKey.key) {
                    const m = String(itemOrKey.key).match(/\?p=(\d+)/i);
                    if (m) pn = Number(m[1]);
                }
                if (pn) return `第${pn}集`;
                itemOrKey = itemOrKey.key;
            }
            const match = String(itemOrKey || '').match(/\?p=(\d+)/i);
            return match ? `第${Number(match[1])}集` : '视频';
        },

        // 创建同一 BV 多分 P 的汇总项。总次数只用于外层展示；每个子项仍绑定原始记录 key。
        _renderRecordGroup(allParts, matchedParts, exportedMap, nowTs) {
            const li = document.createElement('li');
            li.className = 'bvh-history-item bvh-history-group-item';
            const totalCount = allParts.reduce((sum, item) => sum + Math.max(0, Number(item.watchCount) || 0), 0);
            const snapshotCandidates = allParts.flatMap(item =>
                                                        (Array.isArray(item.snapshots) ? item.snapshots : [])
                                                        .filter(snap => Number(snap.ts || 0) > 0)
                                                        .map(snap => ({ item, snap, ts: Number(snap.ts) }))
                                                       );
            let latest = snapshotCandidates.reduce((best, candidate) =>
                                                   !best || candidate.ts > best.ts ? candidate : best, null);
            // 兼容没有快照但仍有记录时间的旧数据；有真实快照时绝不以记录级时间冒充快照时间。
            if (!latest) {
                const latestRecord = allParts.reduce((best, item) =>
                                                     !best || Number(item.lastTs || 0) > Number(best.lastTs || 0) ? item : best, null);
                if (latestRecord) latest = { item: latestRecord, snap: null, ts: Number(latestRecord.lastTs) || 0 };
            }
            const isCollectionGroup = allParts.some(item => !!item.collectionKey);
            const latestPart = latest
            ? this._partLabel(latest.item)
            : '';
            const collectionVideoCount = isCollectionGroup
            ? new Set(allParts.map(item => {
                const key = String(item.key || '');
                return (key.match(/^(BV[a-zA-Z0-9]+)/i) || key.match(/^(ep\d+)/i) || [])[1] || key;
            }).filter(Boolean)).size
            : 0;
            const latestTime = latest?.snap?.watchTimeStr || (latest?.ts ? TimeTool.formatTimestamp(latest.ts) : '无记录');
            const latestProgress = latest?.snap?.progress || latest?.item?.lastProgress || '0%';
            const title = isCollectionGroup
            ? (allParts.find(item => String(item.collectionTitle || '').trim())?.collectionTitle || '未命名合集')
            : (latest?.item?.title || allParts.find(item => item.title)?.title || '无标题');
            const groupAuthor = allParts.find(item => String(item.authorName || '').trim())?.authorName || '作者未知';
            const stableGroupKey = isCollectionGroup ? `collection:${allParts.find(item => item.collectionKey)?.collectionKey}` : `bv:${RecordKey.getGroupKey(allParts[0].key)}`;
            const expanded = this._expandedGroups.has(stableGroupKey);

            const head = document.createElement('div');
            head.className = 'bvh-group-head';
            const sortLabel = this._groupSortMode === 'watch' ? '按观看' : '按合集';
            const isBangumiGroup = allParts.some(item => item.isBangumiPart || /^ep\d+$/i.test(String(item.key || '')));
            head.innerHTML = `
    <div class="bvh-group-main">
        <div class="bvh-group-title-line">
            <span class="bvh-count-mark">[总观看${totalCount}次]</span>
            <span class="bvh-part-label">${isCollectionGroup ? `${collectionVideoCount} 个${isBangumiGroup ? '分集' : '视频'}有记录` : `${allParts.length} 个分 P`}</span>
        </div>
        <div class="bvh-group-title">${this._escapeHtml(title)}</div>
        <div class="bvh-group-author">UP：${this._escapeHtml(groupAuthor)}</div>
        <div class="bvh-group-latest">最新快照：${this._escapeHtml(latestTime)} · ${latestPart} · ${this._escapeHtml(latestProgress)}</div>
    </div>
    <div class="bvh-group-actions">

        <button type="button" class="bvh-group-toggle bvh-group-sort" title="当前排序：${this._groupSortMode === 'watch' ? '按观看时间' : '按合集顺序'}，点击切换">${sortLabel}</button>
        <button type="button" class="bvh-group-toggle bvh-group-expand" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? (isCollectionGroup ? '收起合集 ▲' : '收起分 P ▲') : (isCollectionGroup ? '展开合集 ▼' : '展开分 P ▼')}</button>
    </div>
`;
            li.appendChild(head);

            const children = document.createElement('div');
            children.className = 'bvh-group-children';
            children.hidden = !expanded;
            let activeSmallCollectionKey = null;
            let activeSmallCollectionBox = null;
            let activeSmallCollectionTitle = '';
            for (const rawPart of matchedParts) {
                const part = decorateEntry(rawPart, exportedMap, nowTs);
                const smallTitle = String(part.smallCollectionTitle || '').trim();
                // 同一个大合集内，小合集按标题连续成组；不再按 BV 分组，否则一个小合集跨多个 BV 时会被拆散。
                const smallGroupKey = smallTitle ? `small:${smallTitle}` : '';
                let rowParent = children;
                if (smallGroupKey) {
                    if (smallGroupKey !== activeSmallCollectionKey) {
                        activeSmallCollectionKey = smallGroupKey;
                        activeSmallCollectionTitle = smallTitle;
                        activeSmallCollectionBox = document.createElement('section');
                        activeSmallCollectionBox.className = 'bvh-small-collection-box is-collapsed';
                        const smallCount = matchedParts.filter(item => String(item.smallCollectionTitle || '').trim() === smallTitle).length;
                        const subHead = document.createElement('div');
                        subHead.className = 'bvh-small-collection-head';
                        subHead.innerHTML = `
                            <span class="bvh-small-collection-mark" aria-hidden="true"></span>
                            <span class="bvh-small-collection-name">${this._escapeHtml(smallTitle)}</span>
                            <span class="bvh-small-collection-count">${smallCount} 条记录</span>
                            <span class="bvh-small-collection-chevron" aria-hidden="true">⌄</span>
                        `;
                        const smallBody = document.createElement('div');
                        smallBody.className = 'bvh-small-collection-body';
                        activeSmallCollectionBox.append(subHead, smallBody);
                        children.appendChild(activeSmallCollectionBox);
                        subHead.addEventListener('click', event => {
                            event.stopPropagation();
                            const collapsed = subHead.parentElement.classList.toggle('is-collapsed');
                            subHead.setAttribute('aria-expanded', String(!collapsed));
                        });
                    }
                    rowParent = activeSmallCollectionBox.querySelector('.bvh-small-collection-body');
                } else {
                    activeSmallCollectionKey = null;
                    activeSmallCollectionBox = null;
                    activeSmallCollectionTitle = '';
                }

                const row = document.createElement('div');
                row.className = 'bvh-part-row';
                const snapshots = (part.snapshots || []).slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
                const snapshotMarkup = snapshots.length
                ? snapshots.map(snap => `<div class="bvh-snapshot-item"><span class="bvh-snapshot-time">${this._escapeHtml(snap.watchTimeStr || TimeTool.formatTimestamp(snap.ts))}</span><span class="bvh-snapshot-progress">${this._escapeHtml(snap.progress || '0%')}</span></div>`).join('')
                : '<div class="bvh-snapshot-empty">暂无快照</div>';
                const recentTime = part.lastTs ? TimeTool.formatTimestamp(part.lastTs) : '无记录';
                const rawPartKey = String(part.key || '');
                const partBv = (rawPartKey.match(/^(BV[a-zA-Z0-9]+)/i) || [])[1] || '';
                // 跳转/显示一律用记录的原始键（原始 BV、原始 ?p 原样保留），
                // 绝不在此按分集号强制重拼 ?p：重拼容易落到错误分集，导致点开找不到视频。
                // 容器展开时已按 part.p 拼好键，这里直接使用即可。
                const displayPartKey = rawPartKey;
                row.innerHTML = `
                    <div class="bvh-part-main-line">
                        <span class="bvh-part-label">${this._partLabel(part)}</span>
                        <span class="bvh-part-title">${this._escapeHtml(part.title || '无标题')}</span>
                        <button type="button" class="bvh-part-detail-toggle" aria-expanded="false" title="查看观看详情">详情⌄</button>
                    </div>
                    <div class="bvh-part-quick-meta">
                        <span class="bvh-part-bv">${this._escapeHtml(displayPartKey)}</span>
                        <span>UP：${this._escapeHtml(part.authorName || groupAuthor || '作者未知')}</span>
                        <span>观看 <strong>${Number(part.watchCount) || 0}</strong> 次</span>
                        <span>进度 <strong>${this._escapeHtml(part.lastProgress || '0%')}</strong></span>
                        <span class="bvh-part-quick-time">${this._escapeHtml(recentTime)}</span>
                    </div>
                    <div class="bvh-part-details" hidden>
                        <div class="bvh-part-detail-line"><span>最近观看</span><span>${this._escapeHtml(recentTime)}</span></div>
                        <div class="bvh-part-snapshots"><div class="bvh-part-section-title">观看快照</div>${snapshotMarkup}</div>
                    </div>
                `;
                row.addEventListener('click', event => {
                    if (event.target.closest('.bvh-part-detail-toggle, .bvh-part-details')) return;
                    event.stopPropagation();
                    const url = RecordKey.buildUrl(displayPartKey);
                    if (url) window.open(url, '_blank');
                });
                const detailToggle = row.querySelector('.bvh-part-detail-toggle');
                const detailBox = row.querySelector('.bvh-part-details');
                detailToggle.addEventListener('click', event => {
                    event.stopPropagation();
                    detailBox.hidden = !detailBox.hidden;
                    detailToggle.setAttribute('aria-expanded', String(!detailBox.hidden));
                    detailToggle.textContent = detailBox.hidden ? '详情⌄' : '收起⌃';
                    row.classList.toggle('is-detail-open', !detailBox.hidden);
                });
                this._bindRecordContextMenu(row, part.key);
                rowParent.appendChild(row);
            }
            li.appendChild(children);

            const groupKey = stableGroupKey;
            const expandBtn = head.querySelector('.bvh-group-expand');
            const toggle = () => {
                const nextExpanded = children.hidden;
                children.hidden = !nextExpanded;
                expandBtn.textContent = nextExpanded ? (isCollectionGroup ? '收起合集 ▲' : '收起分 P ▲') : (isCollectionGroup ? '展开合集 ▼' : '展开分 P ▼');
                expandBtn.setAttribute('aria-expanded', String(nextExpanded));
                if (nextExpanded) this._expandedGroups.add(groupKey);
                else this._expandedGroups.delete(groupKey);
            };
            head.querySelector('.bvh-group-sort').addEventListener('click', event => {
                event.stopPropagation();
                this._groupSortMode = this._groupSortMode === 'watch' ? 'collection' : 'watch';
                refreshOpenHistoryLists(true);
            });
            head.addEventListener('click', toggle);
            return li;
        },

        _escapeHtml(value) {
            return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[ch]);
        },

        // 根据内容类型或记录键生成列表使用的类型标签。
        _mediaLabel(mediaType, key) {
            if (mediaType) return `[${mediaType}]`;
            if (RecordKey.isLiveKey(key)) return '[直播]';
            if (RecordKey.isBangumiKey(key)) return '[番剧/电影]';
            return '';
        },

        // 生成记录状态标记，例如备份、过期或可清理状态。
        _stateMark(entry) {
            if (entry.canClean) return '<span class="bvh-exp-mark">[可清理]</span>';
            if (entry.isExported) return '<span class="bvh-exp-mark">[已备份]</span>';
            if (entry.isUnknownTime) return '<span class="bvh-exp-mark">[时间不明]</span>';
            return '';
        },

        // 关键词搜索的统一来源：把能拿到的字段都拼进同一个字符串，
        // 快照行（有 bvKey/watchTimeStr）和整记录行（有 key/snapshots）都走这里。
        _buildHaystack(entity) {
            const parts = [
                entity.key, entity.bvKey,
                entity.title, entity.authorName, entity.collectionTitle, entity.smallCollectionTitle,
                entity.watchTimeStr,
                entity.mediaType, entity.mediaSubtitle, entity.partTitle, entity.partNumber, entity.partTotal,
                entity.collectionOrder, entity.totalWatchCount, entity.bvId, entity.watchCount, entity.lastProgress, entity.collectionKey
            ];
            if (entity.collectionKey) parts.push('总观看 总观看次数 总次数 totalcount groupcount 合集');
            if (Array.isArray(entity.mediaTags)) parts.push(entity.mediaTags.join(' '));
            if (Array.isArray(entity.snapshots)) {
                entity.snapshots.forEach(s => parts.push(s.watchTimeStr, s.progress, s.pos, s.completed ? '已看完 完播' : ''));
            }
            return parts.filter(v => v != null && v !== '').join(' ').toLowerCase();
        },

        // 创建一条快照列表项，展示该次观看的时间和进度等信息。
        _renderSnapItem(snap) {
            const li = document.createElement('li');
            li.className = 'bvh-history-item';
            const mediaLabel = this._mediaLabel(snap.mediaType, snap.bvKey);
            const stateMark = this._stateMark(snap);
            li.innerHTML = `
                ${stateMark}
                <span class="bvh-count-mark">[观看${snap.watchCount}次]</span>
                ${mediaLabel} ${snap.bvKey} | ${snap.progress}
                <br/>${snap.title || '无标题'}
                ${snap.mediaSubtitle ? `<br/><small style="color:#888;">${snap.mediaSubtitle}</small>` : ''}
                ${(snap.mediaTags || []).length ? `<br/><small style="color:#888;">标签：${snap.mediaTags.join('、')}</small>` : ''}
                <br/><small>UP：${snap.authorName || '作者未知'}</small>
                <br/><small>观看时间：${snap.watchTimeStr}</small>
            `;
            li.onclick = () => {
                const url = RecordKey.buildUrl(snap.bvKey);
                if (url) window.open(url, '_blank');
            };
            this._bindRecordContextMenu(li, snap.bvKey);
            return li;
        },

        // 创建一条视频记录列表项，并附上观看次数及状态信息。
        _renderRecordItem(it) {
            const li = document.createElement('li');
            li.className = 'bvh-history-item';
            const snapshotText = it.snapshots.map(s => `${s.watchTimeStr} ${s.progress}`).join(' | ');
            const mediaLabel = this._mediaLabel(it.mediaType, it.key);
            const stateMark = this._stateMark(it);
            li.innerHTML = `
                ${stateMark}
                <span class="bvh-count-mark">[观看${it.watchCount}次]</span>
                ${mediaLabel} ${it.key} | ${it.lastProgress}
                <br/>${it.title || '无标题'}
                ${(it.mediaTags || []).length ? `<br/><small style="color:#888;">标签：${it.mediaTags.join('、')}</small>` : ''}
                <br/><small>UP：${it.authorName || '作者未知'}</small>
                <br/><small>最近${CONFIG.MAX_RECORD_COUNT}次快照：${snapshotText || '暂无快照'}</small>
            `;
            li.onclick = () => {
                const url = RecordKey.buildUrl(it.key);
                if (url) window.open(url, '_blank');
            };
            this._bindRecordContextMenu(li, it.key);
            return li;
        },

        // 创建列表分组标题，并按需使用绿色样式。
        _header(text, green = false) {
            const li = document.createElement('li');
            li.className = 'bvh-history-header' + (green ? ' bvh-history-header-green' : '');
            li.innerText = text;
            return li;
        },

        // 创建分组之间的视觉分隔线。
        _divider() {
            const li = document.createElement('li');
            li.className = 'bvh-history-divider';
            return li;
        },

        // 渲染列表。最近快照区直接从热池取数（与记录总量无关，永不等待全量整理）；
        // 全部记录区改为流式筛选 + 分批推进，新的搜索输入会立即取消上一次还没跑完的任务。
        renderInto(listDom, filterTxt, variant = 'playback', options = {}) {
            if (!listDom) return;

            this._scheduleStorageLabelUpdate();

            const nowTs = TimeTool.now();
            // 先判断完整索引是否已在内存中；没有就只读独立最近快照缓存，暂不碰大索引。
            const index = HistoryViewIndex._index && HistoryViewIndex._ready
            ? HistoryViewIndex._index : null;
            const recentSource = index || HistoryViewIndex._readRecentCache();
            const query = SearchQuery.parse(filterTxt);
            const exportedMap = RecordStore._exportedMap();

            const isBuilding = !index || HistoryViewIndex._building === true || index.building === true;
            const latestHeaderText = variant === 'playback'
            ? `【最近${CONFIG.RECENT_SNAPSHOT_COUNT}次观看记录（快照）】`
            : `最近${CONFIG.RECENT_SNAPSHOT_COUNT}次快照`;
            const allHeaderText = variant === 'playback' ? '【全部内容 · 按观看次数排名】' : '全部内容 · 按观看次数';

            // ── 最近 N 次快照：候选恒为 2N，读热池即可，不扫描全部记录 ──
            const snapMatcher = this._buildSnapMatcher(query, index || recentSource);
            const headTasks = [() => this._header(latestHeaderText)];
            for (const snap of HistoryViewIndex.recentDisplaySnapshots(CONFIG.RECENT_SNAPSHOT_COUNT, recentSource)) {
                const item = index?.itemsByKey?.[snap.bvKey];
                const decorated = decorateEntry({
                    ...snap,
                    mediaType: item?.mediaType || snap.mediaType || '',
                    mediaSubtitle: item?.mediaSubtitle || snap.mediaSubtitle || '',
                    mediaTags: item?.mediaTags || snap.mediaTags || [],
                    // 快照自身时间比记录时间新时以快照为准，保证过期判定不偏移
                    lastTs: Math.max(Number(item?.lastTs) || 0, Number(snap.ts) || 0)
                }, exportedMap, nowTs);
                if (!snapMatcher(decorated)) continue;
                headTasks.push(() => this._renderSnapItem(decorated));
            }

            if (isBuilding) {
                headTasks.push(() => {
                    const li = document.createElement('li');
                    li.className = 'bvh-history-loading bvh-history-loading-inline';
                    li.innerHTML = '<span class="bvh-loading-spinner" aria-hidden="true"></span><span>正在后台整理全部记录，完成后自动显示…</span>';
                    return li;
                });
                this.renderTasks(listDom, headTasks, options);
                HistoryViewIndex._ensureAfterRecentPaint(listDom, variant);
                return;
            }

            // ── 全部记录：流式筛选，不复制整份中间数组 ──
            headTasks.push(() => this._divider());
            headTasks.push(() => this._header(allHeaderText, true));

            const head = headTasks;
            let headCursor = 0;
            let stream = null;
            const source = () => {
                if (headCursor < head.length) return head[headCursor++];
                if (!stream) {
                    stream = this._recordStream(index, this._buildRecordMatcher(query, index), exportedMap, nowTs);
                }
                return stream();
            };
            this.renderTasks(listDom, source, options);
        }
    };

    // 【模块：B 站视频卡片 DOM 识别】
    // 从首页、搜索、动态、个人空间等页面的卡片中提取标签、链接、BV/分集身份和作者信息，
    // 并把可识别的卡片与本地观看记录对应起来。优先依据稳定的链接/数据标记判断身份，
    // 不应仅依赖容易变化的标题文本或页面样式类名。
    const CardDom = {
        // 判断文本是否像卡片标签，过滤明显不是标签的内容。
        isTagText(raw) {
            const t = String(raw || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 12) return false;
            if (/^\d{1,2}:\d{2}$/.test(t)) return false;
            if (/\d{1,2}:\d{2}\/\d{1,2}:\d{2}/.test(t)) return false;
            if (/^\d+(\.\d+)?%$/.test(t)) return false;
            return true;
        },

        // 从卡片 DOM 的多个可能位置收集标签文本并去重。
        extractRawCardTags(card) {
            const result = [];
            const push = txt => {
                const t = String(txt || '').replace(/\s+/g, ' ').trim();
                if (t && !result.includes(t)) result.push(t);
            };

            const containerSelectors = [
                '.bili-cover-card__tags', '.bili-cover-card__tag',
                '.video-card__tags', '.bili-video-card__tags', '.cover-tags'
            ];

            for (const sel of containerSelectors) {
                const els = card?.querySelectorAll?.(sel) || [];
                for (const el of els) {
                    const children = Array.from(el.children || []);
                    if (children.length) {
                        children.forEach(c => {
                            const t = c.innerText || c.textContent;
                            if (this.isTagText(t)) push(t);
                        });
                    } else {
                        const t = el.innerText || el.textContent;
                        if (this.isTagText(t)) push(t);
                    }
                }
                if (result.length) break;
            }

            if (!result.length) {
                const cover = card?.querySelector?.('a[href*="/video/"], a[href*="/bangumi/play/"]')
                || card?.querySelector?.('.bili-cover-card');
                if (cover) {
                    const seen = new Set();
                    const walk = node => {
                        Array.from(node.childNodes || []).forEach(n => {
                            if (n.nodeType === Node.TEXT_NODE) {
                                const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
                                if (t && !seen.has(t)) {
                                    seen.add(t);
                                    push(t);
                                }
                            } else if (n.nodeType === Node.ELEMENT_NODE) {
                                if (n.matches?.('svg, i, .bili-cover-card__progress, .bili-cover-card__stats, a[href]')) return;
                                if (!n.querySelector?.('a[href], .bili-cover-card__stats, .bili-cover-card__progress')) {
                                    const t = n.innerText || n.textContent;
                                    if (this.isTagText(t)) push(t);
                                }
                                walk(n);
                            }
                        });
                    };
                    walk(cover);
                }
            }
            return result;
        },

        // 从卡片中提取指向视频、番剧或直播的链接。
        extractCardHref(card) {
            const anchor = card?.querySelector?.('a[href*="/video/"], a[href*="/bangumi/play/"]')
            || card?.querySelector?.('a.bili-cover-card[href]');
            return String(anchor?.getAttribute('href') || '');
        },

        // 把卡片链接解析为统一的内容身份信息。
        extractIdentity(href) {
            const h = String(href || '');
            if (!/bilibili\.com|b23\.tv/.test(h)) return null;
            const parsed = RecordKey.parse(h);
            if (!parsed) return null;
            return { type: parsed.type, key: parsed.key };
        },

        // 从卡片的作者链接或作者文本中提取作者名称。
        extractAuthorFromCard(card) {
            const a = card?.querySelector('.bili-video-card__author, a.bili-video-card__author, .bili-video-card__subtitle a[href*="space.bilibili.com"]');
            return a?.querySelector('.bili-video-card__text span:last-child')?.textContent?.trim()
            || a?.textContent?.trim() || '';
        },

        // 从当前视频页读取作者名称。
        extractAuthorFromVideoPage() {
            const panel = document.querySelector('.up-panel-container, .up-info-container');
            if (!panel) return '';
            const nameEl = panel.querySelector('.up-name');
            return nameEl?.childNodes?.[0]?.textContent?.trim() || nameEl?.textContent?.trim() || '';
        },

        // 合并作者信息，避免空值或重复同步覆盖已有有效数据。
        mergeAuthorMetadata(record, incoming) {
            if (!record || typeof incoming !== 'string') return record;
            const normalizedIncoming = incoming.trim();
            if (normalizedIncoming && normalizedIncoming !== String(record.authorName || '').trim()) {
                record.authorName = normalizedIncoming;
            }
            record.schemaVersion = 2;
            return record;
        }
    };

    // ── 官方历史同步：读取 /history 页面卡片，与本地记录对账（同分钟 / 连续播放判定） ──
    // 【模块：B 站官方历史记录同步】
    // 读取官方历史页面中的视频条目和观看时间/进度，将其合并进本地记录，并维护同步设置与去重规则。
    // 官方历史时间通常只有分钟精度，而播放页采集精确到秒；因此同步需要与本地快照规则协作，
    // 防止同一次持续播放被重复计数，同时保留真正再次观看时的快照。
    const OfficialHistorySync = {
        _syncing: false,

        // 防止重复启动同步任务，并根据静默模式决定是否显示操作反馈。
        async sync(silent = false) {
            if (this._syncing) {
                console.warn('[BVH] 上一次同步仍在进行，跳过本次');
                return { skipped: true };
            }
            this._syncing = true;
            try {
                return await this._runSync(silent);
            } catch (err) {
                console.error('[BVH] 同步整体失败：', err);
                return { error: String(err && err.message || err) };
            } finally {
                this._syncing = false;
            }
        },

        // 读取官方历史卡片，解析时间、进度和元数据，再与本地记录对账合并。
        async _runSync(silent) {
            const MAX_SCROLL_PAGES = CONFIG.HISTORY_SYNC_PAGES;
            const SCROLL_WAIT_MS = 1500;
            const TAG = '[BVH]';

            const extractCardData = card => {
                try {
                    const href = CardDom.extractCardHref(card);
                    let ident = CardDom.extractIdentity(href);
                    if (!ident) return null;

                    let seasonId = 0;
                    if (ident.type === 'bangumi' && RecordKey.isEpisodeKey(ident.key)) {
                        const ssLink = card.querySelector('a[href*="/bangumi/play/ss"]');
                        const ssMatch = ssLink && String(ssLink.getAttribute('href') || '').match(/\/bangumi\/play\/(ss\d+)/i);
                        if (ssMatch) seasonId = Number(ssMatch[1].replace(/^ss/i, '')) || 0;
                    }

                    const titleEl = card.querySelector('.bili-video-card__title a');
                    const cardTags = CardDom.extractRawCardTags(card);
                    const mediaTags = [...new Set(cardTags)];
                    const subtitle = card.querySelector('.bili-video-card__subtitle .bili-video-card__text span')?.textContent?.trim() || '';
                    const mediaType = cardTags[0] || (ident.type === 'live' ? '直播' : ident.type === 'bangumi' ? '番剧' : '视频');
                    const progressEl = card.querySelector('.bili-cover-card__progress');
                    const dateEl = card.querySelector('.bili-video-card__corner span');
                    const durationEl = card.querySelector('.bili-cover-card__stat span');

                    const title = titleEl?.getAttribute('title') || titleEl?.textContent?.trim() || null;
                    const authorName = ident.type === 'bangumi' ? '' : CardDom.extractAuthorFromCard(card);

                    let progress = '0%';
                    if (progressEl) {
                        const style = progressEl.getAttribute('style') || '';
                        const pMatch = style.match(/(?:--bili-cover-card-)?progress-value:\s*([\d.]+%)/i);
                        if (pMatch) progress = pMatch[1];
                        else {
                            const computedProgress = getComputedStyle(progressEl).getPropertyValue('--bili-cover-card-progress-value').trim();
                            if (/^[\d.]+%$/.test(computedProgress)) progress = computedProgress;
                        }
                    }

                    let posSec = null;
                    if (durationEl) {
                        const durationText = durationEl.textContent.trim();
                        const timeToSeconds = value => {
                            const raw = String(value || '').trim();
                            if (!raw) return null;
                            const parts = raw.split(':').map(Number);
                            if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
                            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                            if (parts.length === 2) return parts[0] * 60 + parts[1];
                            return parts[0];
                        };
                        const timeParts = durationText.split('/');
                        if (timeParts.length === 2) {
                            const currentSec = timeToSeconds(timeParts[0]);
                            const durationSec = timeToSeconds(timeParts[1]);
                            if (currentSec !== null && durationSec !== null && durationSec >= 0) {
                                posSec = currentSec;
                                if (currentSec === 0 && parseFloat(progress) > 0 && durationSec > 0) {
                                    posSec = Math.floor(durationSec * parseFloat(progress) / 100);
                                }
                            }
                        }
                    }

                    const dateText = dateEl?.textContent?.trim() || '';
                    return { ident, title, mediaTags, subtitle, mediaType, progress, posSec, dateText, authorName, seasonId };
                } catch (e) {
                    console.warn(TAG, 'extractCardData 单卡失败：', e);
                    return null;
                }
            };

            const collectAllCardData = async () => {
                const seen = new Map();

                const collectCurrent = (label) => {
                    const cards = Array.from(document.querySelectorAll('.history-card__main .bili-video-card'));
                    let added = 0;
                    cards.forEach(card => {
                        const data = extractCardData(card);
                        if (!data) return;
                        // 同一 key + 同一 dateText 视为同一张卡片（避免 DOM 抖动重复）
                        const cardId = `${data.ident.key}|${data.dateText}`;
                        if (!seen.has(cardId)) {
                            seen.set(cardId, data);
                            added++;
                        }
                    });
                    console.log(`${TAG} [采集] ${label}：DOM 卡片 ${cards.length}，本轮新增 ${added}，累计 ${seen.size}`);
                    return cards.length;
                };

                if (silent) {
                    collectCurrent('自动同步-仅当前DOM');
                    return Array.from(seen.values());
                }

                let lastCardCount = 0;
                let lastScrollHeight = 0;
                let page = 0;
                let stableRounds = 0;

                while (page < MAX_SCROLL_PAGES) {
                    const cardCount = collectCurrent(`第 ${page + 1} 轮`);

                    const scrollHeight = document.documentElement.scrollHeight;
                    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
                    const clientHeight = window.innerHeight;
                    const atBottom = scrollTop + clientHeight >= scrollHeight - 10;

                    console.log(`${TAG} [滚动状态] scrollH=${scrollHeight} clientH=${clientHeight} scrollTop=${scrollTop} atBottom=${atBottom} cards=${cardCount} 累计=${seen.size}`);

                    const noChange = cardCount === lastCardCount && scrollHeight === lastScrollHeight;
                    if (noChange && atBottom) {
                        stableRounds++;
                        if (stableRounds >= 2) {
                            console.log(`${TAG} [停止] 连续两轮无变化且到底，退出滚动`);
                            break;
                        }
                    } else {
                        stableRounds = 0;
                    }
                    lastCardCount = cardCount;
                    lastScrollHeight = scrollHeight;
                    page++;

                    // 从当前视口分段向下滚动，而不是每轮直接跳到页面底部。
                    // 本次结束后保留实际滚动位置；再次手动同步时从当前位置继续。
                    const step = Math.max(400, Math.floor(clientHeight * 0.8));
                    const nextTop = Math.min(scrollTop + step, Math.max(0, scrollHeight - clientHeight));
                    if (nextTop > scrollTop) window.scrollTo(0, nextTop);
                    await new Promise(resolve => setTimeout(resolve, SCROLL_WAIT_MS));
                }

                collectCurrent('滚动结束');
                const list = Array.from(seen.values());
                console.log(`${TAG} [采集完成] 共 ${list.length} 条`);
                return list;
            };

            const cardDataList = await collectAllCardData();
            if (cardDataList.length === 0) {
                console.warn(`${TAG} 采集结果为空，不写 GM`);
                if (!silent) alert('未找到可同步的历史卡片，请确保页面已加载');
                return { scanned: 0, added: 0, updated: 0, skipped: 0 };
            }

            let addCount = 0;
            let updateCount = 0;
            let skipCount = 0;
            let errorCount = 0;
            let bangumiTouched = false;
            const nowTs = TimeTool.now();

            for (const data of cardDataList) {
                let bvid = data.ident.key;
                try {
                    const { ident, title, mediaTags, subtitle, mediaType, progress, posSec, dateText, authorName, seasonId: detectedSeasonId } = data;
                    const key = ident.key;
                    bvid = key;
                    const existingSyncEntry = RecordStore.readSyncRecord(key);
                    const seasonId = Number(detectedSeasonId) || (RecordKey.isSeasonKey(existingSyncEntry?.bv) ? Number(String(existingSyncEntry.bv).replace(/^ss/i, '')) : 0);

                    const parsedOfficialTime = TimeTool.parseWatchTime(dateText, nowTs);
                    if (!parsedOfficialTime.valid || !parsedOfficialTime.ts) {
                        skipCount++;
                        console.warn(`${TAG} [写入] 时间解析失败跳过：${key} 原文="${dateText}"`);
                        continue;
                    }
                    const officialTs = parsedOfficialTime.ts;
                    const watchTimeStr = TimeTool.formatTimestamp(officialTs);
                    const isCompleted = progress === '100%';

                    let localRecord = existingSyncEntry?.flat || null;
                    if (localRecord && !Array.isArray(localRecord.snapshots)) localRecord.snapshots = [];
                    if (localRecord && !Number.isFinite(Number(localRecord.watchCount))) localRecord.watchCount = localRecord.snapshots.length;

                    if (!localRecord || typeof localRecord !== 'object') {
                        // 首次创建：直接用官方卡片信息，watchCount=1；分P键经 upsertRecord 归入合集容器。
                        RecordStore.upsertRecord(key, {
                            title,
                            collectionTitle: '',
                            titleSource: 'official',
                            lastTs: officialTs,
                            lastProgress: progress,
                            watchCount: 1,
                            snapshots: [{
                                ts: officialTs,
                                pos: posSec,
                                progress,
                                watchTimeStr,
                                source: 'official',
                                ...(isCompleted ? { completed: true } : {})
                            }],
                            hasReachedWatchThreshold: isCompleted || (Number.isFinite(posSec) && posSec !== null && posSec >= CONFIG.SHORT_WATCH_MAX_POS_SEC),
                            officialHistorySeen: true,
                            authorName,
                            mediaType: mediaType || '视频',
                            mediaSubtitle: subtitle,
                            mediaTags,
                            schemaVersion: 2
                        }, ident.type === 'bangumi' && RecordKey.isEpisodeKey(ident.key) && seasonId
                            ? { episodeKey: ident.key, seasonKey: `ss${seasonId}`, seasonId, partTitle: title || '' }
                            : {});
                        addCount++;
                        console.log(`${TAG} [写入] 新增 ${key} | ${watchTimeStr} | ${progress}`);
                        if (ident.type === 'bangumi') bangumiTouched = true;
                    } else {
                        // ── 更新已有记录是否为同一次观看的判 ──
                        //
                        // 用户反馈的 bug：一个视频挂着持续播放时，B 站官方历史卡片的
                        // "观看时间 + 进度"会随播放一直往前变，每次同步都被当成新一次观看，
                        // watchCount 不断 +1，产生大量重复计数。
                        // 根因：旧规则"同分钟 + 同进度才算同一次观看"有两个漏洞——
                        //   ① 同一分钟内进度本来就会变（5 秒轮询、拖动进度条），
                        //      同分钟不同进度被误判成新观看；
                        //   ② 跨分钟但仍在同一次播放中（挂着刷剧），
                        //      分钟变了、进度涨了，也被误判成新观看。
                        // 新规则（按优先级）：
                        //   A. 本地已有【同一分钟】的快照 → 同一次观看：覆盖更新，不累加；
                        //   B. 最新快照与本次构成【连续播放】（见 _isContinuousView：
                        //      时间间隔在阈值内、且进度向前推进）→ 同一次观看：
                        //      只把最新快照的时间/进度往前滚，不累加；
                        //   C. 其他 → 才是真正的新一次观看：新建快照，watchCount++。
                        const officialMinute = minuteKeyOf(officialTs);
                        const officialProgressNum = parseFloat(progress) || 0;
                        const latestSnap = localRecord.snapshots.reduce(
                            (best, s) => (!best || Number(s.ts || 0) > Number(best.ts || 0)) ? s : best,
                            null
                        );
                        const sameMinuteSnap = localRecord.snapshots.find(snap =>
                                                                          Number(snap.ts) > 0 && minuteKeyOf(snap.ts) === officialMinute
                                                                         );
                        // 本地快照精确到秒，官方历史时间精度较低。
                        // 同一视频的官方时间与本地快照相差不超过前后 60 秒时，
                        // 视为同一条记录，保留本地快照，不用官方时间覆盖，也不新增观看次数。
                        const nearbyLocalSnap = localRecord.snapshots.find(snap => {
                            const localTs = Number(snap && snap.ts || 0);
                            return localTs > 0 && Math.abs(localTs - officialTs) <= 60 * 1000;
                        });

                        let snapshotChanged = false;
                        let isNewView = false;
                        const matchedByTimePrecision = !!nearbyLocalSnap;

                        if (matchedByTimePrecision) {
                            // 精确本地记录优先：跳过官方快照写入，继续沿用原有元数据判断。
                        } else if (sameMinuteSnap) {
                            // A. 同一次观看（同一分钟）：用官方卡片的最新内容覆盖
                            sameMinuteSnap.ts = officialTs;
                            sameMinuteSnap.pos = posSec;
                            sameMinuteSnap.progress = progress;
                            sameMinuteSnap.watchTimeStr = watchTimeStr;
                            sameMinuteSnap.source = 'official';
                            if (isCompleted) sameMinuteSnap.completed = true;
                            snapshotChanged = true;
                        } else if (latestSnap && this._isContinuousView(latestSnap, officialTs, officialProgressNum)) {
                            // B. 同一次观看（挂着持续播放，分钟已跨但播放未中断）：
                            //    只把最新快照往前滚，不新增快照、不累加次数
                            latestSnap.ts = officialTs;
                            latestSnap.pos = posSec;
                            latestSnap.progress = progress;
                            latestSnap.watchTimeStr = watchTimeStr;
                            latestSnap.source = 'official';
                            if (isCompleted) latestSnap.completed = true;
                            snapshotChanged = true;
                        } else {
                            // C. 真正的新一次观看
                            RecordNormalizer.appendSnapshot(localRecord, {
                                ts: officialTs, pos: posSec, progress, watchTimeStr,
                                source: 'official',
                                ...(isCompleted ? { completed: true } : {})
                            });
                            localRecord.watchCount = Math.max(1, (Number(localRecord.watchCount) || 0) + 1);
                            snapshotChanged = true;
                            isNewView = true;
                        }

                        localRecord.officialHistorySeen = true;
                        if (isCompleted) localRecord.hasReachedWatchThreshold = true;
                        if (Number.isFinite(posSec) && posSec !== null && posSec >= CONFIG.SHORT_WATCH_MAX_POS_SEC) {
                            localRecord.hasReachedWatchThreshold = true;
                        }
                        // 命中 ±60 秒的本地精确快照时，官方时间不再覆盖记录级时间/进度。
                        if (!matchedByTimePrecision && officialTs >= Number(localRecord.lastTs || 0)) {
                            localRecord.lastTs = officialTs;
                            localRecord.lastProgress = progress;
                        }
                        const incomingAuthor = String(authorName || '').trim();
                        const authorChanged = !!incomingAuthor && incomingAuthor !== String(localRecord.authorName || '').trim();
                        let titleMetadataChanged = false;
                        if (title) {
                            if (!String(localRecord.title || '').trim()) {
                                // 记录没有标题时，官方标题只作为暂时补全，并标记来源。
                                localRecord.title = title;
                                localRecord.titleSource = 'official';
                                titleMetadataChanged = true;
                            } else if (title !== localRecord.title) {
                                // 官方历史标题来源不稳定，可能是合集名也可能是视频名；不据此覆盖具体标题或合集主名称。
                                // 合集主名称只由播放页合集框的 title 属性写入。
                            }
                        }
                        const metadataChanged = titleMetadataChanged
                        || mediaType !== (localRecord.mediaType || '')
                        || subtitle !== (localRecord.mediaSubtitle || '')
                        || JSON.stringify(mediaTags) !== JSON.stringify(localRecord.mediaTags || [])
                        || authorChanged;
                        localRecord.mediaType = mediaType || '视频';
                        localRecord.mediaSubtitle = subtitle;
                        localRecord.mediaTags = mediaTags;
                        CardDom.mergeAuthorMetadata(localRecord, authorName);

                        if (!snapshotChanged && !metadataChanged && !isNewView) {
                            skipCount++;
                            continue;
                        }

                        // 写入前统一走一次去重，防止历史遗留的重复快照继续存在
                        localRecord.snapshots = RecordNormalizer.keepSnapshotsWithinLimit(localRecord.snapshots);

                        RecordStore.upsertRecord(key, localRecord, ident.type === 'bangumi' && RecordKey.isEpisodeKey(ident.key) && seasonId
                            ? { episodeKey: ident.key, seasonKey: `ss${seasonId}`, seasonId, partTitle: title || '' }
                            : {});
                        updateCount++;
                        console.log(`${TAG} [写入] ${isNewView ? '计为新观看' : '更新已有官方记录'} ${key} | ${watchTimeStr} | ${progress}`);
                        if (ident.type === 'bangumi') bangumiTouched = true;
                    }
                } catch (e) {
                    errorCount++;
                    console.error(`${TAG} [写入] 单条失败 ${bvid}：`, e);
                }
            }

            const summary = { scanned: cardDataList.length, added: addCount, updated: updateCount, skipped: skipCount, errors: errorCount };
            console.log(`${TAG} ===== 同步汇总 =====`, summary);
            console.log(`${TAG} 实际写入 GM：${addCount + updateCount} 条`);

            HistoryViewIndex.reset();
            RecordStore.clearIndex();

            if (!silent) {
                const syncTimes = cardDataList
                .map(item => TimeTool.parseWatchTime(item.dateText, nowTs))
                .filter(item => item && item.valid && Number(item.ts) > 0)
                .map(item => Number(item.ts));
                const minSyncTs = syncTimes.length ? Math.min(...syncTimes) : 0;
                const maxSyncTs = syncTimes.length ? Math.max(...syncTimes) : 0;
                const rangeText = minSyncTs && maxSyncTs
                ? `${TimeTool.formatTimestamp(minSyncTs)} 至 ${TimeTool.formatTimestamp(maxSyncTs)}`
                : '无法从本次历史卡片中解析';
                alert(
                    `同步完成\n\n` +
                    `扫描：${cardDataList.length} 条\n` +
                    `新增：${addCount} 条\n` +
                    `更新：${updateCount} 条\n` +
                    `跳过：${skipCount} 条\n` +
                    `失败：${errorCount} 条\n\n` +
                    `本次内容时间范围：${rangeText}\n` +
                    `索引更新时间：${TimeTool.formatTimestamp(TimeTool.now())}`
                );
            }
            if (bangumiTouched) {
                try {
                    StorageApi.mergeEpIntoSeason({ silent: true });
                } catch (err) {
                    console.warn(`${TAG} 自动归并 ep 到 ss 失败：`, err);
                }
            }

            const listDom = document.getElementById('bvh-hp-list');
            if (listDom) {
                HistoryListRenderer.renderInto(listDom, document.getElementById('bvh-hp-search')?.value || '', 'history-page');
            }

            return summary;
        },

        // 判定"挂着持续播放"是否为同一次观看：
        // 条件 1：与最新快照的时间间隔不超过 CONFIG.CONTINUOUS_GAP_MIN 分钟。
        //         挂着刷剧时官方卡片每分钟都在更新，间隔必然很小；
        //         隔天/隔几小时回看，间隔以小时计，自然被排除。
        // 条件 2：进度必须向前推进（允许相等，容忍卡片 0%/刷新抖动）。
        //         短时间内重看一个视频，进度会从后面回到前面（往回走），
        //         进度一回退就说明是新的观看，不能算连续播放。
        _isContinuousView(lastSnap, newTs, newProgressNum) {
            const lastTs = Number(lastSnap && lastSnap.ts || 0);
            const lastProgressNum = parseFloat(lastSnap && lastSnap.progress) || 0;
            if (!lastTs || !Number.isFinite(Number(newTs))) return false;
            const gapMs = Number(newTs) - lastTs;
            if (gapMs < 0) return true;   // 时间倒流视为同源重复读数，不算新观看
            if (gapMs > CONFIG.CONTINUOUS_GAP_MIN * 60000) return false;
            return newProgressNum >= lastProgressNum;
        }
    };

    try {
        window.__BVH_SYNC__ = OfficialHistorySync;
    } catch (e) { /* 忽略 */ }

    // ── 播放记录器：播放器事件 + MutationObserver + 5 秒轮询，持续写入当前观看快照 ──
    // 【模块：普通视频与番剧播放页自动采集】
    // 在播放页面识别当前视频/分集，按配置间隔采集播放位置、进度和观看时间，并在完成播放时记录完成快照。
    // 采集结果写入统一记录存储；页面切换、播放器重建及番剧身份变化时，需要避免把旧播放器状态写给新视频。
    function startPlaybackRecorder() {
        let recordTimer = null;
        let activeRecordKey = null;
        let hasCountedThisSession = false;
        let hasSavedSnapshotThisSession = false;
        let endingWasVisible = false;
        let lastEndingSavedKey = null;
        let lastVideoElement = null;
        let warnedMissingMedia = false;
        // 每个视频首次成功写入记录后最多刷新一次浮窗，不能在 timeupdate 高频循环中反复 render。
        let playbackFloatRefreshedAfterSave = false;

        const resetForVideo = key => {
            activeRecordKey = key;
            playbackFloatRefreshedAfterSave = false;
            hasCountedThisSession = false;
            hasSavedSnapshotThisSession = false;
            endingWasVisible = false;
            lastEndingSavedKey = null;
        };

        // 只返回真正具有 HTMLMediaElement 播放属性的对象。
        // 部分新版播放器把 video 放在 bwp-video 的 shadowRoot 中；直接把 bwp-video
        // 自定义元素当 video 使用时，duration/currentTime 可能是 undefined，记录循环会提前退出。
        const getPlayableMediaElement = () => {
            const candidates = [
                document.querySelector('.bpx-player-video-wrap video'),
                document.querySelector('.bpx-player-container video'),
                document.querySelector('.bilibili-player-video video'),
                document.querySelector('video')
            ];
            for (const player of document.querySelectorAll('bwp-video')) {
                candidates.push(
                    player.shadowRoot?.querySelector('video'),
                    player.querySelector?.('video'),
                    player.video,
                    player.$refs?.video
                );
                if (typeof player.currentTime === 'number'
                    && typeof player.duration === 'number'
                    && typeof player.addEventListener === 'function') {
                    candidates.push(player);
                }
            }
            return candidates.find(candidate =>
                candidate
                && typeof candidate.currentTime === 'number'
                && typeof candidate.duration === 'number'
                && typeof candidate.addEventListener === 'function'
            ) || null;
        };

        const getCurrentContext = () => {
            const parsed = RecordKey.parse(window.location.href);
            const isVideoPage = window.location.pathname.includes('/video/');
            const isBangumiPage = window.location.pathname.includes('/bangumi/play/');
            if (!parsed || (!isVideoPage && !isBangumiPage)) return null;
            const video = getPlayableMediaElement();
            if (!video) {
                // 只在视频/番剧播放页提示一次，避免静默跳过导致“完全没有记录”却无从定位。
                if (!warnedMissingMedia) {
                    warnedMissingMedia = true;
                    console.warn(`${TAG} [播放记录诊断] 未找到可读取 currentTime/duration 的 video 元素，当前页面暂时无法记录观看进度。`, {
                        url: window.location.href,
                        videoCount: document.querySelectorAll('video').length,
                        bwpVideoCount: document.querySelectorAll('bwp-video').length,
                        bpxVideoCount: document.querySelectorAll('.bpx-player-video-wrap video, .bpx-player-container video').length
                    });
                }
                return null;
            }
            warnedMissingMedia = false;

            let key = parsed.key;
            let seasonId = null;
            let seasonKey = '';
            let episodeKey = RecordKey.isEpisodeKey(parsed.key) ? parsed.key.toLowerCase() : '';
            if (isBangumiPage) {
                // ss 地址是整季身份的最终来源；ep 地址则必须由当前分集面板或对应 SSR 数据确认归属。
                const sid = RecordKey.isSeasonKey(parsed.key)
                    ? Number(parsed.key.replace(/^ss/i, '')) || 0
                    : PageData.resolveBangumiSeasonId();
                if (sid >= 1000) {
                    seasonId = sid;
                    seasonKey = `ss${sid}`;
                }

                // ss 是整季入口，不是正在观看的分集身份。只有能从当前选中项明确解析出 ep，
                // 才把播放记录写到 ep 对应的 ss.parts[]；无法确认当前集时不写 ss 记录。
                if (RecordKey.isSeasonKey(parsed.key)) {
                    const episodeLinks = Array.from(document.querySelectorAll(
                        '.SectionPanel_panel__rImmk a[href*="/bangumi/play/ep"], a[href*="/bangumi/play/ep"]'
                    ));
                    const isActiveEpisodeLink = link => {
                        const item = link.closest(
                            '.EpisodeVirtualList_listItem__QZXPZ, .EpisodeVirtualList_numberItem__GLWgO, [aria-current="page"], [data-state="active"]'
                        ) || link.parentElement;
                        if (!item) return false;
                        if (link.getAttribute('aria-current') === 'page' || item.getAttribute('aria-current') === 'page') return true;
                        if (item.getAttribute('data-state') === 'active') return true;
                        if (item.classList.contains('active') || item.classList.contains('EpisodeVirtualList_activeNumber__Sm49O')) return true;
                        return !!item.querySelector('.EpisodeVirtualList_activeNumber__Sm49O, [aria-current="page"], [data-state="active"]');
                    };
                    const activeLink = episodeLinks.find(isActiveEpisodeLink);
                    const activeHref = activeLink?.getAttribute('href') || '';
                    const activeEpMatch = activeHref.match(/\/bangumi\/play\/(ep\d+)/i);
                    episodeKey = activeEpMatch ? activeEpMatch[1].toLowerCase() : '';
                    if (!episodeKey) {
                        // 部分页面将“当前集”标记放在集数节点而不是链接自身，沿当前标记的父节点找真实 ep 链接。
                        const activeMarker = document.querySelector(
                            '.SectionPanel_panel__rImmk .EpisodeVirtualList_activeNumber__Sm49O, .SectionPanel_panel__rImmk .EpisodeVirtualList_numberItem__GLWgO[aria-current="page"], .SectionPanel_panel__rImmk .EpisodeVirtualList_listItem__QZXPZ[aria-current="page"]'
                        );
                        const markerItem = activeMarker?.closest(
                            '.EpisodeVirtualList_listItem__QZXPZ, .EpisodeVirtualList_numberItem__GLWgO, li, a'
                        ) || activeMarker?.parentElement;
                        const markerHref = markerItem?.matches?.('a[href*="/bangumi/play/ep"]')
                            ? markerItem.getAttribute('href')
                            : markerItem?.querySelector?.('a[href*="/bangumi/play/ep"]')?.getAttribute('href') || '';
                        const markerMatch = markerHref.match(/\/bangumi\/play\/(ep\d+)/i);
                        episodeKey = markerMatch ? markerMatch[1].toLowerCase() : '';
                    }
                    if (!episodeKey) {
                        console.warn(`${TAG} [播放记录诊断] 当前地址为整季 ss，但无法明确识别当前 ep，跳过写入，避免把整季当成一集记录。`, { url: location.href });
                        return null;
                    }
                    key = episodeKey;
                }
            }
            return { ...parsed, key, seasonId, seasonKey, episodeKey, isBangumi: isBangumiPage, video };
        };

        // B站新版合集列表的 .video-pod__item 常常只有 data-key="数字aid"，没有 BV 链接。
        // 旧代码把这个数字当成 BV 读取，结果所有非当前视频的分集都没有 BV，
        // 后续本地记录匹配自然一个都找不到。这是此前“扫描了但没合并”的核心原因。
        const collectionAidBvidCache = new Map();
        const collectionAidResolveTried = new Set();
        let collectionAidResolvePromise = null;
        // 仅在官方 view.pages 明确证明当前 BV 是多P时，才把数字 data-key 行视为同 BV 的分P。
        // 否则数字 key 只是一条列表内部标识，不能把整张跨BV合集错误地映射到当前 BV。
        let videoPagesCacheBv = '';
        let videoPagesCache = null;
        const resolveCollectionAids = () => {
            if (collectionAidResolvePromise) return collectionAidResolvePromise;
            collectionAidResolvePromise = (async () => {
                // 数字 data-key 既非 aid 也非 BV（实测拿它调 view?aid 会查到无关视频造成错配），
                // 不再反查；只直接读取 href 里的 BV，以及当前播放项用地址栏 BV 建立对照。全集以 ugc_season 为准。
                for (const row of document.querySelectorAll('.video-pod .video-pod__item')) {
                    const rawKey = String(row.getAttribute('data-key') || '').trim();
                    const rowHref = row.querySelector('a[href*="/video/BV"]')?.getAttribute('href') || '';
                    const hrefBv = (rowHref.match(/(BV[a-zA-Z0-9]+)/i) || [])[1] || '';
                    if (hrefBv) { collectionAidBvidCache.set(rawKey, hrefBv); continue; }
                    const currentBv = (location.pathname.match(/\/(BV[a-zA-Z0-9]+)(?:\/|$)/i) || [])[1] || '';
                    if (currentBv && (row.classList.contains('active') || row.getAttribute('data-scrolled') === 'true')) {
                        collectionAidBvidCache.set(rawKey, currentBv);
                    }
                }
                return collectionAidBvidCache;
            })().finally(() => { collectionAidResolvePromise = null; });
            return collectionAidResolvePromise;
        };

        // 5.3.0：用当前页 BV 调官方 view 接口读取 ugc_season 合集全集（每集真实 bvid + 集名）。
        // 新版选集 DOM 只给内部数字 data-key（既非 aid 也非 BV），拿它调 view?aid 会查到无关视频造成错配，
        // 因此合集全集一律以官方 ugc_season 为准，数字 data-key 只作列表顺序参考。
        const fetchUgcSeasonEpisodes = async () => {
            const currentBv = (location.pathname.match(/\/(BV[a-zA-Z0-9]+)(?:\/|$)/i) || [])[1] || '';
            if (!currentBv) return null;
            try {
                const response = await fetch(`${location.origin}/x/web-interface/view?bvid=${encodeURIComponent(currentBv)}`, { credentials: 'include' });
                if (!response.ok) return null;
                const json = await response.json();
                const season = json?.data?.ugc_season;
                if (!season || !Array.isArray(season.sections)) return null;
                const episodes = [];
                season.sections.forEach(section => {
                    (section.episodes || []).forEach(ep => {
                        const bvid = String(ep?.bvid || '').trim();
                        if (!/^BV[a-zA-Z0-9]+$/i.test(bvid)) return;
                        episodes.push({
                            bvid,
                            aid: String(ep?.aid || ''),
                            title: String(ep?.title || '').trim(),
                            sectionTitle: String(section?.title || '').trim()
                        });
                    });
                });
                if (!episodes.length) return null;
                return {
                    seasonTitle: String(season.title || '').trim(),
                    seasonId: String(season.season_id || '').trim(),
                    episodes
                };
            } catch (error) {
                console.warn(`${TAG} [合集扫描] ugc_season 读取失败：`, error);
                return null;
            }
        };

        // 5.3.0：单 BV 多 P 场景——用 view 接口的 pages[]（分P号 + cid + 分P标题），按分P号匹配本地 BV?p=N 记录并回填集名。
        // 这种页面右侧选集/播放器菜单只给数字 cid（既非 aid 也非 BV），DOM 里拿不到 BV，只能靠接口 pages 与顺序号。
        const fetchVideoPages = async () => {
            const currentBv = (location.pathname.match(/\/(BV[a-zA-Z0-9]+)(?:\/|$)/i) || [])[1] || '';
            if (!currentBv) return null;
            try {
                const response = await fetch(`${location.origin}/x/web-interface/view?bvid=${encodeURIComponent(currentBv)}`, { credentials: 'include' });
                if (!response.ok) return null;
                const json = await response.json();
                const pages = json?.data?.pages;
                if (!Array.isArray(pages) || pages.length < 2) return null;
                const result = {
                    bv: currentBv,
                    title: String(json?.data?.title || '').trim(),
                    pages: pages.map(p => ({
                        page: Number(p.page) || 1,
                        cid: String(p.cid || ''),
                        part: String(p.part || '').trim()
                    }))
                };
                videoPagesCacheBv = currentBv;
                videoPagesCache = result;
                return result;
            } catch (error) {
                console.warn(`${TAG} [合集扫描] video pages 读取失败：`, error);
                return null;
            }
        };

        // 合集元数据只从合集框本身读取；具体视频标题始终按 BV/分 P 读取。
        // 兼容新版列表仅提供数字 aid 的结构：先把 aid 解析为 BV，再与本地记录逐条匹配。
        const getCurrentCollectionInfo = () => {
            const clean = value => { const text = String(value || '').replace(/_哔哩哔哩_bilibili$/, '').replace(/\s+/g, ' ').trim(); return /^(?:undefined|null)$/i.test(text) ? '' : text; };
            const currentBv = (location.pathname.match(/\/(BV[a-zA-Z0-9]+)(?:\/|$)/i) || [])[1] || '';
            const urlPart = Math.max(1, Number(new URLSearchParams(location.search).get('p')) || 1);
            const pods = Array.from(document.querySelectorAll('.video-pod'));
            if (!pods.length) {
                const bangumiMatch = location.pathname.match(/\/bangumi\/play\/(ss|ep)(\d+)/i);
                if (!bangumiMatch) return null;
                const epKey = /^ep/i.test(bangumiMatch[1]) ? `ep${bangumiMatch[2]}` : '';
                // ss 地址优先确定整季；ep 地址由统一解析器读取当前分集所属季，后续再用当前面板作兜底。
                const urlSeasonId = /^ss$/i.test(bangumiMatch[1]) ? Number(bangumiMatch[2]) || 0 : 0;
                const resolvedSeasonId = urlSeasonId || Number(PageData.resolveBangumiSeasonId()) || 0;
                // 所有分集/季/分区信息都限定在当前 ep 所属的 SectionPanel 内，避免跨面板串数据。
                const panels = Array.from(document.querySelectorAll('.SectionPanel_panel__rImmk'));
                const episodeAnchor = epKey
                    ? panels.map(panel => Array.from(panel.querySelectorAll('a[href*="/bangumi/play/ep"]')).find(link => {
                        const match = String(link.getAttribute('href') || '').match(/\/bangumi\/play\/(ep\d+)/i);
                        return match && match[1].toLowerCase() === epKey;
                    })).find(Boolean) || null
                    : null;
                const activeEpisode = episodeAnchor?.closest('.SectionPanel_panel__rImmk')?.querySelector('.EpisodeVirtualList_activeNumber__Sm49O, .EpisodeVirtualList_numberItem__GLWgO[aria-current="page"], .EpisodeVirtualList_listItem__QZXPZ[aria-current="page"]')
                    || panels.map(panel => panel.querySelector('.EpisodeVirtualList_activeNumber__Sm49O, .EpisodeVirtualList_numberItem__GLWgO[aria-current="page"], .EpisodeVirtualList_listItem__QZXPZ[aria-current="page"]')).find(Boolean)
                    || null;
                // ep 地址是当前集身份的唯一依据。虚拟列表可能暂时还把旧集标成 active，禁止用它给新 ep 取集号。
                const currentEpisode = epKey ? episodeAnchor : activeEpisode;
                const section = currentEpisode?.closest('.SectionPanel_panel__rImmk') || null;
                const sectionTitle = clean(section?.querySelector(':scope > .SectionHeader_header__g7gEL .SectionHeader_titleWrap__n0F38 h3, .SectionHeader_titleWrap__n0F38 h3')?.textContent || '');
                const pageTitle = clean(document.querySelector('.media-title, .media-info-title, .season-title, .media-info .title, h1')?.getAttribute('title') || document.querySelector('.media-title, .media-info-title, .season-title, .media-info .title, h1')?.textContent || document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title);
                const episodeTitle = clean(currentEpisode?.querySelector('.EpisodeVirtualList_numberTitle__6SOS6, .EpisodeVirtualList_copy__KYrCH strong + span')?.textContent || currentEpisode?.getAttribute('title') || '');
                const seasonTabs = section ? Array.from(section.querySelectorAll('.SectionTabs_scroller__3Lyhy [data-item-id], .SectionTabs_wrap__wxiTB [data-item-id].SectionTabs_tab__gqNSD')) : [];
                const activeSeasonTab = seasonTabs.find(tab => tab.classList.contains('SectionTabs_active__cms8S') || tab.getAttribute('aria-current') === 'page') || null;
                const activeSeasonId = Number(section?.querySelector('.SectionTabs_wrap__wxiTB[data-active-id]')?.getAttribute('data-active-id') || activeSeasonTab?.getAttribute('data-item-id')) || 0;
                const sid = resolvedSeasonId || activeSeasonId;
                const resolvedSeasonTab = (sid ? seasonTabs.find(tab => Number(tab.getAttribute('data-item-id')) === sid) : null) || activeSeasonTab;
                const seasonTitle = clean(resolvedSeasonTab?.textContent || (sid ? section?.querySelector(`.SectionTabs_wrap__wxiTB [data-item-id="${sid}"]`)?.textContent : '') || '');
                const seasonOrder = resolvedSeasonTab ? seasonTabs.indexOf(resolvedSeasonTab) : 0;
                const seriesInfo = PageData.resolveBangumiSeriesInfo(sid);
                const seriesId = String(seriesInfo?.seriesId || '').trim();
                const seriesTitle = clean(seriesInfo?.seriesTitle || '');
                const resolvedSeasonTitle = clean(seriesInfo?.seasonTitle || '');
                // 番剧没有明确季名时保持为空，不能仅凭 seasonId 显示虚构的“第1季”。
                // 电视剧仍需要在同一系列下按季分组；季名缺失时，先按 SSR 系列 seasons 的真实顺序，
                // 再按当前页面的季标签顺序兜底。旧 ss 容器已明确是电视剧时，也保留电视剧分季显示。
                const seriesSeasonOrder = Array.isArray(seriesInfo?.seasons)
                    ? seriesInfo.seasons.findIndex(item => Number(item?.seasonId) === Number(sid))
                    : -1;
                let savedSeasonMediaType = '';
                if (sid > 0) {
                    try {
                        const savedSeason = RecordNormalizer.normalize(GM_getValue(`ss${sid}`, null));
                        savedSeasonMediaType = String(savedSeason?.mediaType || '').trim();
                    } catch (_) {}
                }
                const currentMediaType = PageData.resolveBangumiMediaType();
                const isTelevisionSeries = currentMediaType === '电视剧' || savedSeasonMediaType === '电视剧';
                const seasonDisplayOrder = seriesSeasonOrder >= 0
                    ? seriesSeasonOrder
                    : Math.max(0, seasonOrder);
                const inferredTelevisionSeasonTitle = isTelevisionSeries && sid > 0
                    ? `第${seasonDisplayOrder + 1}季`
                    : '';
                const displaySeasonTitle = seasonTitle || resolvedSeasonTitle || inferredTelevisionSeasonTitle;
                // 生成的电视剧季名仅用于 UI 分组，不把它标记成 B 站明确提供的原始季名。
                const seasonTitleVerified = !!(seasonTitle || resolvedSeasonTitle);
                const isEpisodeNumber = /^\d+(?:\.\d+)?$/.test(episodeTitle);
                const episodeLabel = episodeTitle ? (isEpisodeNumber ? `第${episodeTitle}集` : episodeTitle) : '';
                // 有明确系列 ID 时跨季归入同一逻辑大合集；没有 ID 时保守地按季归组，绝不靠标题猜测合并。
                const knownSeasonId = sid || activeSeasonId || (/^ss$/i.test(bangumiMatch[1]) ? Number(bangumiMatch[2]) : 0) || 0;
                const seriesCollectionKey = seriesId ? `series:${seriesId}` : (knownSeasonId ? `season:${knownSeasonId}` : '');
                return {
                    collectionTitle: seriesTitle || (episodeAnchor || !epKey ? pageTitle : ''),
                    collectionKey: seriesCollectionKey,
                    smallCollectionTitle: displaySeasonTitle,
                    seasonTitleVerified,
                    // href 精确命中只证明节点属于当前 ep；只有该节点同时给出明确集序号，才允许旧数据按 p 归并。
                    episodeNumberVerified: !!episodeAnchor && Number(episodeTitle) > 0,
                    partTitle: episodeLabel ? (sectionTitle && !/^正片$/i.test(sectionTitle) ? `${sectionTitle} · ${episodeLabel}` : episodeLabel) : '',
                    partNumber: Number(episodeTitle) || 0,
                    partTotal: Number(section?.querySelector('.SectionHeader_titleWrap__n0F38 span')?.textContent?.match(/\/\s*(\d+)/)?.[1]) || 0,
                    collectionOrder: seasonOrder * 10000 + (Number(episodeTitle) || 0),
                    seasonId: sid || 0,
                    seriesId: seriesId || '',
                    seriesSeasons: Array.isArray(seriesInfo?.seasons) ? seriesInfo.seasons : [],
                    sectionTitle,
                    episodeKey: epKey,
                    isBangumi: true
                };
            }

            const parsePod = pod => {
                const list = pod.querySelector(':scope > .video-pod__body .video-pod__list')
                || pod.querySelector('.video-pod__list');
                if (!list) return null;
                // 只取当前列表直属的视频项，避免父合集把子合集的 BV 重复收进去。
                const rows = Array.from(list.children).filter(node => node.matches?.('.video-pod__item'));
                if (!rows.length) return null;

                const headerLink = pod.querySelector(':scope > .video-pod__header .title.jumpable')
                || pod.querySelector('.video-pod__header .title.jumpable');
                // 这个节点的可见文本常常是进度（如 4.0/16.1h），只能把 title 属性当合集名称。
                // 无标题大合集退回读取播放页主标题；分集标题仍独立取自选集列表，不互相覆盖。
                const pageMainTitle = clean(
                    document.querySelector('h1.video-title')?.getAttribute('title')
                    || document.querySelector('h1.video-title')?.textContent
                    || document.querySelector('.video-info-title')?.getAttribute('title')
                    || document.querySelector('.video-info-title')?.textContent
                    || document.querySelector('.video-title-container h1')?.getAttribute('title')
                    || document.querySelector('.video-title-container h1')?.textContent
                    || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
                    || ''
                );
                const officialCollectionTitle = clean(headerLink?.getAttribute('title'));
                const collectionTitle = officialCollectionTitle || pageMainTitle;
                const href = String(headerLink?.getAttribute('href') || '');
                const sid = (href.match(/[?&]sid=(\d+)/i) || [])[1] || '';
                const seasonId = (href.match(/[?&]season_id=(\d+)/i) || [])[1] || '';

                const videos = rows.map((row, rowIndex) => {
                    const rowHref = row.querySelector('a[href*="/video/BV"]')?.getAttribute('href') || row.getAttribute('data-href') || '';
                    const rawDataKey = clean(row.getAttribute('data-key') || '');
                    const hrefBv = (rowHref.match(/(BV[a-zA-Z0-9]+)/i) || [])[1] || '';
                    const currentBvFallback = (row.classList.contains('active') || row.getAttribute('data-scrolled') === 'true')
                        ? currentBv : '';
                    let bvId = clean(row.getAttribute('data-bvid') || hrefBv
                        || (/^\d+$/.test(rawDataKey) ? (collectionAidBvidCache.get(rawDataKey) || currentBvFallback) : rawDataKey));
                    const multiPod = row.querySelector(':scope > .multi-p');
                    const head = row.querySelector('.multi-p > .head, .simple-base-item.head');
                    const headTitle = clean(head?.querySelector('.title')?.getAttribute('title')
                                            || head?.querySelector('.title-txt')?.textContent
                                            || head?.getAttribute('title'));
                    // 关键兼容：用户提供的真实 DOM 中，单集标题 .title 就是 .video-pod__item 的直接子节点，
                    // 并不存在嵌套的 .simple-base-item.normal 或 .single-p。旧选择器因此读不到任何分集标题，
                    // pages 变成空数组，后续扫描即使解析出了 BV 也没有 part 可迁移。
                    const rowTitleNode = row.querySelector(':scope > .title') || row.querySelector('.title');
                    const rowTitle = clean(rowTitleNode?.getAttribute('title')
                        || rowTitleNode?.querySelector('.title-txt')?.textContent
                        || rowTitleNode?.textContent);
                    // multi-p 的 head 是大合集内的“小合集/课程”名称；普通 video-pod item 自身的标题才是具体视频名。
                    const smallCollectionTitle = multiPod ? (headTitle || rowTitle) : '';
                    const videoTitle = multiPod ? '' : (headTitle || rowTitle
                        || clean(row.querySelector(':scope .single-p .title')?.getAttribute('title')
                            || row.querySelector(':scope .single-p .title-txt')?.textContent));
                    const pageNodes = Array.from(row.querySelectorAll('.page-list .page-item.sub'));
                    const pages = pageNodes.map((node, index) => {
                        const pageHref = node.querySelector('a[href]')?.getAttribute('href') || node.getAttribute('href') || '';
                        const explicitPage = node.getAttribute('data-page') || node.getAttribute('data-p')
                            || node.querySelector('[data-page]')?.getAttribute('data-page')
                            || node.querySelector('[data-p]')?.getAttribute('data-p')
                            || (pageHref.match(/[?&]p=(\d+)/i) || [])[1];
                        return {
                            title: clean(node.querySelector('.title')?.getAttribute('title')
                                         || node.querySelector('.title-txt')?.textContent
                                         || node.getAttribute('title')),
                            pageNumber: Math.max(1, Number(explicitPage) || index + 1),
                            active: node.classList.contains('active')
                            || !!node.querySelector('.simple-base-item.active')
                        };
                    }).filter(page => page.title);

                    // 单 P 视频没有 page-list：它本身就是该 BV 的具体视频标题。
                    if (!pages.length && (videoTitle || headTitle)) {
                        pages.push({
                            title: videoTitle || headTitle,
                            pageNumber: 1,
                            active: row.classList.contains('active')
                            || row.getAttribute('data-scrolled') === 'true'
                            || !!row.querySelector('.simple-base-item.active')
                        });
                    }

                    // 只有官方接口确认当前 BV 存在多个 pages 时，数字 data-key 行才按同 BV 分P处理。
                    // 跨BV合集的数字 key 不能一律映射到当前 BV；否则每集都会被错当成当前视频的分P。
                    // 注意：这里必须是 /^\d+$/。此前多写了一层反斜杠，导致数字 data-key
                    // 永远无法通过判断，单 BV 多 P 的分集映射分支实际不会执行。
                    const isNumericCidRow = /^\d+$/.test(rawDataKey) && !hrefBv && !row.getAttribute('data-bvid');
                    const rowIsCurrent = row.getAttribute('data-scrolled') === 'true'
                        || row.classList.contains('active')
                        || !!row.querySelector('.simple-base-item.active');
                    const confirmedSameBvMultiPage = videoPagesCacheBv === currentBv
                        && Array.isArray(videoPagesCache?.pages)
                        && videoPagesCache.pages.length > 1;
                    // 接口缓存尚未返回时，如果地址栏已有 p>1 且该行被标记为当前项，
                    // 也能立即把当前分集标题与 URL 的 p 对齐；不把其他数字 data-key 猜成 BV。
                    if (isNumericCidRow && currentBv && (confirmedSameBvMultiPage || (rowIsCurrent && urlPart > 1))) {
                        bvId = clean(currentBv);
                        pages.length = 0;
                        pages.push({
                            title: rowTitle,
                            pageNumber: rowIsCurrent && urlPart > 1 ? urlPart : rowIndex + 1,
                            active: rowIsCurrent
                        });
                    }
                    return {
                        bvId,
                        videoTitle,
                        smallCollectionTitle,
                        collectionOrder: rowIndex,
                        pages,
                        active: row.classList.contains('active')
                        || row.getAttribute('data-scrolled') === 'true'
                        || !!row.querySelector('.simple-base-item.active')
                    };
                }).filter(video => video.bvId || video.pages.length);

                if (!videos.length) return null;
                // 不要把分集标题和 DOM 顺序放进合集指纹：标题加载/修正、列表顺序变化会
                // 让同一合集得到不同 key，历史界面就会把它拆成多个合集。优先用官方 ID，
                // 没有官方 ID 时使用当前合集内去重后的 BV 集合，标题仅用于完全没有 BV 的兜底。
                const bvIdentity = [...new Set(videos.map(video => String(video.bvId || '')).filter(Boolean))].sort().join('|');
                const fallbackIdentity = videos.map(video => video.videoTitle || video.pages.map(page => page.title).join('|')).filter(Boolean).sort().join('|');
                const identity = sid ? `sid:${sid}` : seasonId ? `season:${seasonId}` :
                (bvIdentity ? `bvs:${bvIdentity}` : `titles:${fallbackIdentity}`);
                let hash = 2166136261;
                for (let i = 0; i < identity.length; i++) {
                    hash ^= identity.charCodeAt(i);
                    hash = Math.imul(hash, 16777619);
                }
                const collectionKey = `pod-${(hash >>> 0).toString(36)}`;
                const allParts = videos.flatMap(video => video.pages.map(page => ({
                    title: page.title,
                    bvId: video.bvId,
                    smallCollectionTitle: video.smallCollectionTitle || '',
                    collectionOrder: video.collectionOrder,
                    index: page.pageNumber,
                    partTotal: video.pages.length
                })));
                return { pod, collectionTitle, officialCollectionTitle, hasStableId: !!(sid || seasonId), collectionKey, videos, allParts };
            };

            const parsedPods = pods.map(parsePod).filter(Boolean);
            if (!parsedPods.length) return null;

            let currentPod = currentBv
            ? parsedPods.find(info => info.videos.some(video => video.bvId === currentBv))
            : null;
            if (!currentPod) {
                currentPod = parsedPods.find(info => info.videos.some(video => video.active)) || null;
            }
            if (!currentPod) return null;

            // 先按 BV 重叠关系建立 pod 连通组：只要两个 pod 共享一个 BV，就属于同一合集组；
            // 反过来，一个合集也可以包含多个完全不同的 BV。没有标题/ID 的并列 pod 仍作为同一大合集兜底合并。
            const podHasBv = (podInfo, bv) => podInfo.videos.some(video => String(video.bvId || '') === String(bv || ''));
            const relatedPods = new Set([currentPod]);
            let expanded = true;
            while (expanded) {
                expanded = false;
                for (const candidate of parsedPods) {
                    if (relatedPods.has(candidate)) continue;
                    const sharesBv = [...relatedPods].some(existing => existing.videos.some(video => video.bvId && podHasBv(candidate, video.bvId)));
                    if (sharesBv) { relatedPods.add(candidate); expanded = true; }
                }
            }
            if (!currentPod.hasStableId && !currentPod.officialCollectionTitle) {
                for (const candidate of parsedPods) {
                    if (!candidate.hasStableId && !candidate.officialCollectionTitle) relatedPods.add(candidate);
                }
            }
            if (relatedPods.size > 1) {
                const podGroup = [...relatedPods];
                const mergedVideoMap = new Map();
                const allBvs = new Set();
                const mergedPartMap = new Map();
                for (const info of podGroup) {
                    for (const video of info.videos) {
                        const id = String(video.bvId || '');
                        if (id) allBvs.add(id);
                        const videoKey = id || `title:${String(video.videoTitle || '').toLowerCase()}`;
                        const existing = mergedVideoMap.get(videoKey);
                        if (!existing) {
                            mergedVideoMap.set(videoKey, { ...video, pages: [...(video.pages || [])] });
                        } else {
                            const pageMap = new Map((existing.pages || []).map(page => [Number(page.pageNumber) || 1, page]));
                            for (const page of (video.pages || [])) {
                                const pn = Number(page.pageNumber) || 1;
                                const oldPage = pageMap.get(pn);
                                if (!oldPage || (!oldPage.title && page.title)) pageMap.set(pn, page);
                            }
                            existing.pages = [...pageMap.values()].sort((a, b) => (Number(a.pageNumber) || 1) - (Number(b.pageNumber) || 1));
                            if (!existing.videoTitle && video.videoTitle) existing.videoTitle = video.videoTitle;
                            if (!existing.smallCollectionTitle && video.smallCollectionTitle) existing.smallCollectionTitle = video.smallCollectionTitle;
                        }
                    }
                    for (const part of info.allParts) {
                        const partId = `${String(part.bvId || '')}:p${Number(part.index) || 1}`;
                        const old = mergedPartMap.get(partId);
                        if (!old || (!old.title && part.title)) mergedPartMap.set(partId, part);
                    }
                }
                // 同一组中若所有 pod 共用同一个官方 ID，优先官方 ID；否则使用组内完整 BV 集合，避免从不同入口算出不同 key。
                const sidSet = new Set(podGroup.map(info => (info.pod.querySelector('.video-pod__header .title.jumpable')?.getAttribute('href')?.match(/[?&]sid=(\d+)/i) || [])[1] || ''));
                const seasonSet = new Set(podGroup.map(info => (info.pod.querySelector('.video-pod__header .title.jumpable')?.getAttribute('href')?.match(/[?&]season_id=(\d+)/i) || [])[1] || ''));
                const sharedSid = sidSet.size === 1 ? [...sidSet][0] : '';
                const sharedSeason = seasonSet.size === 1 ? [...seasonSet][0] : '';
                const identity = sharedSid ? `sid:${sharedSid}` : sharedSeason ? `season:${sharedSeason}` : `bvs:${[...allBvs].sort().join('|')}`;
                let hash = 2166136261;
                for (let i = 0; i < identity.length; i++) { hash ^= identity.charCodeAt(i); hash = Math.imul(hash, 16777619); }
                currentPod = {
                    ...currentPod,
                    collectionKey: `pod-${(hash >>> 0).toString(36)}`,
                    videos: [...mergedVideoMap.values()],
                    allParts: [...mergedPartMap.values()]
                };
            }
            // 优先选中当前 BV 对应的 active 行。多P列表多条行的 bvId 相同时，也不能误取第一集。
            let currentVideo = currentBv
            ? currentPod.videos.find(video => video.bvId === currentBv && video.active)
                || currentPod.videos.find(video => video.bvId === currentBv)
            : null;
            if (!currentVideo) currentVideo = currentPod.videos.find(video => video.active) || null;
            if (!currentVideo) return null;

            let currentPage = currentVideo.pages.find(page => page.active) || null;
            if (!currentPage) currentPage = currentVideo.pages.find(page => page.pageNumber === urlPart) || null;
            if (!currentPage && currentVideo.pages.length === 1) currentPage = currentVideo.pages[0];

            return {
                collectionKey: currentPod.collectionKey,
                collectionTitle: currentPod.collectionTitle || '',
                partTitle: currentPage?.title || '',
                smallCollectionTitle: currentVideo.smallCollectionTitle || '',
                collectionOrder: currentVideo.collectionOrder || 0,
                partNumber: currentPage?.pageNumber || 0,
                partTotal: currentVideo.pages.length || 0,
                parts: currentPod.allParts,
                videos: currentPod.videos
            };
        };

        // 标题来源分级：合集 DOM 中匹配到的当前 BV/分 P > 播放页标题节点 > 页面标题。
        // document.title 只作为低可信兜底，绝不写入 collectionTitle。
        const getCurrentPlayerTitle = (knownCollectionInfo = null) => {
            const collectionInfo = knownCollectionInfo || getCurrentCollectionInfo();
            if (collectionInfo?.isBangumi) {
                if (collectionInfo.episodeNumberVerified && collectionInfo.partTitle) {
                    return { title: collectionInfo.partTitle, trusted: true, specific: true };
                }
                // 当前 ep 尚未出现在可见选集节点时，页面 H1 可能仍是上一集；宁可不覆盖标题，也不串写。
                return { title: '', trusted: false, specific: false };
            }
            if (collectionInfo?.partTitle) {
                return { title: collectionInfo.partTitle, trusted: true, specific: true };
            }
            const clean = value => String(value || '').replace(/_哔哩哔哩_bilibili$/, '').replace(/\s+/g, ' ').trim();
            const selectors = [
                'h1.video-title',
                '.video-info-title',
                '.video-title-container h1',
                'h1[title].video-title',
                'meta[property="og:title"]'
            ];
            for (const selector of selectors) {
                const node = document.querySelector(selector);
                const value = selector.startsWith('meta[') ? node?.getAttribute('content')
                : (node?.getAttribute('title') || node?.textContent);
                const title = clean(value);
                if (title) return { title, trusted: true, specific: false };
            }
            const pageTitle = clean(document.title);
            if (pageTitle) return { title: pageTitle, trusted: !document.querySelector('.video-pod'), specific: false };
            return { title: '', trusted: false, specific: false };
        };

        // 选集列表中的 active 标题是具体集名，可修复旧版本误写入的合集名。
        // 其他标题来源仅在缺失时补全，或替换明确标记为官方来源的标题。
        const applyPlayerTitle = (record, titleInfo) => {
            const title = String(titleInfo?.title || '').trim();
            if (!title) return;
            const oldTitle = String(record.title || '').trim();
            if (titleInfo.specific) {
                // 具体视频标题只写入记录 title/partTitle；绝不把旧 title 猜成合集主名称。
                record.title = title;
                record.partTitle = title;
                record.titleSource = 'player';
                return;
            }
            if (!oldTitle) {
                record.title = title;
                record.titleSource = titleInfo.trusted ? 'player' : (record.titleSource || 'official');
                return;
            }
            if (title === oldTitle) {
                if (titleInfo.trusted) record.titleSource = 'player';
                return;
            }
            if (titleInfo.trusted && record.titleSource === 'official') {
                // 替换官方历史中的不可靠标题，但绝不把旧标题挪入合集主名称字段。
                record.title = title;
                record.titleSource = 'player';
            }
        };

        // 用当前页面明确的系列关系修复已存在的季度容器；只更新归属元数据，不创建空容器、不改观看事实。
        // 每季仍以 ssNN 为原始存储键，系列通过共同 collectionKey 关联，避免大规模改写旧存储格式。
        const syncKnownSeriesSeasonMetadata = info => {
            if (!info || !String(info.collectionKey || '').startsWith('series:') || !info.collectionTitle) return;
            // seasons 的 ID 本身就是归属依据；标题缺失不代表该季无效。
            const seasonNames = new Map((Array.isArray(info.seriesSeasons) ? info.seriesSeasons : [])
                .filter(item => Number(item?.seasonId) > 0)
                .map(item => [Number(item.seasonId), String(item?.seasonTitle || '').trim()]));
            if (Number(info.seasonId) > 0) {
                const currentSeasonTitle = String(info.smallCollectionTitle || '').trim();
                if (!seasonNames.has(Number(info.seasonId)) || currentSeasonTitle) {
                    seasonNames.set(Number(info.seasonId), currentSeasonTitle || seasonNames.get(Number(info.seasonId)) || '');
                }
            }
            for (const key of GM_listValues()) {
                if (!RecordKey.isSeasonKey(key)) continue;
                const sid = Number(String(key).replace(/^ss/i, '')) || 0;
                const raw = GM_getValue(key, null);
                const container = RecordNormalizer.normalize(raw);
                if (!container || container.type !== 'collection') continue;
                let changed = false;
                const isVerifiedSeason = seasonNames.has(sid);

                // 旧版本若曾把无关 ss 季错误归进当前 series，不能继续显示成这个系列的季。
                // 只拆分归属元数据，不删除容器、分集、观看次数或快照。
                if (!isVerifiedSeason) {
                    if (container.collectionKey !== info.collectionKey) continue;
                    const knownSeasonTitle = (container.parts || [])
                        .map(part => String(part?.smallCollectionTitle || part?.seasonTitle || '').trim())
                        .find(Boolean);
                    container.collectionKey = `season:${sid}`;
                    container.title = knownSeasonTitle || `ss${sid}`;
                    RecordStore.set(key, RecordNormalizer.normalize(container));
                    continue;
                }

                if (container.title !== info.collectionTitle) { container.title = info.collectionTitle; changed = true; }
                if (container.collectionKey !== info.collectionKey) { container.collectionKey = info.collectionKey; changed = true; }
                const seasonTitle = seasonNames.get(sid);
                for (const part of container.parts || []) {
                    if (!/^ep\d+$/i.test(String(part.bv || part.epKey || ''))) continue;
                    if (seasonTitle && part.smallCollectionTitle !== seasonTitle) {
                        part.smallCollectionTitle = seasonTitle;
                        part.seasonTitleVerified = true;
                        changed = true;
                    } else if (seasonTitle && part.seasonTitleVerified !== true) {
                        part.seasonTitleVerified = true;
                        changed = true;
                    }
                }
                if (changed) RecordStore.set(key, RecordNormalizer.normalize(container));
            }
        };

        // 每次本地播放记录写入时同步保存合集指纹和集序号；这只增加元数据，不改变 key/快照/次数。
        const applyCollectionInfo = (record, info = getCurrentCollectionInfo()) => {
            if (!info) return;
            syncKnownSeriesSeasonMetadata(info);
            if (info.collectionKey) record.collectionKey = info.collectionKey;
            if (info.seasonId) record.seasonId = Number(info.seasonId);
            if (info.sectionTitle) record.sectionTitle = String(info.sectionTitle);
            // 播放页 UP 主作为合集及分集共同的作者元数据来源。
            const authorNode = document.querySelector('.up-name, .username, .up-info .name, .video-owner .name, a[href*="space.bilibili.com/"] .name');
            const pageAuthor = String(authorNode?.getAttribute('title') || authorNode?.textContent || '').trim();
            if (pageAuthor && record.authorName !== pageAuthor) record.authorName = pageAuthor;
            record.partTitle = info.partTitle || record.partTitle || '';
            record.smallCollectionTitle = info.smallCollectionTitle || '';
            record.collectionOrder = Number(info.collectionOrder) || 0;
            record.partNumber = info.partNumber || record.partNumber || 0;
            record.partTotal = info.partTotal || record.partTotal || 0;
            // 当前合集框是主名称的唯一来源；没有 title 属性就明确存空，不用进度文本或视频名代替。
            if (record.collectionTitle !== (info.collectionTitle || '')) {
                record.collectionTitle = info.collectionTitle || '';
            }
        };

        // 扫描到的合集是修复本地数据的依据：按 BV+P 精确匹配；缺 BV 时才用“分集标题+UP 主”唯一匹配。
        // 同一 BV/P 的别名键（BV 与 BV?p=1）合并成一条原始记录；不同 BV/P 的观看记录绝不互相吞并。
        const repairKnownPlaylistPartTitles = (currentKey, info) => {
            if (!info || !Array.isArray(info.parts) || !info.parts.length) return { changed: 0, merged: 0, matched: 0 };

            const normalizeBv = value => String(value || '').trim();
            const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
            const normalizeTitle = value => cleanText(value).toLocaleLowerCase();
            const parseLocalVideoKey = key => {
                const match = String(key || '').match(/^(BV[a-zA-Z0-9]+)(?:\?p=(\d+))?$/i);
                if (!match) return null;
                return { original: String(key), bv: normalizeBv(match[1]), page: Math.max(1, Number(match[2]) || 1) };
            };
            const authorNode = document.querySelector('.up-name, .username, .up-info .name, .video-owner .name, a[href*="space.bilibili.com/"] .name, .up-info-container .username');
            const scannedAuthor = cleanText(authorNode?.getAttribute('title') || authorNode?.textContent || '');
            const containerTitle = cleanText(info.collectionTitle || '');

            // 优先以 BV+P 建立唯一分集表。重复出现在不同 pod 的条目只保留信息更完整的版本。
            const partByIdentity = new Map();
            const noBvParts = [];
            for (const part of info.parts) {
                const bv = normalizeBv(part.bvId);
                const page = Math.max(1, Number(part.index) || 1);
                if (!/^BV[a-zA-Z0-9]+$/.test(bv)) {
                    if (part.title) noBvParts.push(part);
                    continue;
                }
                const id = `${bv}:p${page}`;
                const existing = partByIdentity.get(id);
                if (!existing || (!existing.title && part.title) || ((Number(part.partTotal) || 0) > (Number(existing.partTotal) || 0))) {
                    partByIdentity.set(id, part);
                }
            }

            // 收集本地记录：5.3.0 容器(type=collection)与旧扁平(BV / BV?p=N)。
            const containers = new Map(); // bv -> { key, container }
            const flatRecords = []; // { key, bv, page, record }
            for (const key of GM_listValues()) {
                const rec = RecordNormalizer.normalize(GM_getValue(key, null));
                if (!rec) continue;
                if (rec.type === 'collection') {
                    const bv = normalizeBv(rec.key || key);
                    if (/^BV[A-Z0-9]+$/.test(bv)) containers.set(bv, { key: bv, container: rec });
                } else {
                    const parsed = parseLocalVideoKey(key);
                    if (parsed) flatRecords.push({ key, bv: parsed.bv, page: parsed.page, record: rec });
                }
            }

            const matches = new Map();
            for (const [identity, part] of partByIdentity) {
                const bv = normalizeBv(part.bvId);
                const page = Math.max(1, Number(part.index) || 1);
                const flatKeys = flatRecords.filter(item => item.bv === bv && item.page === page).map(item => item.key);
                const container = containers.get(bv);
                if (container || flatKeys.length) {
                    matches.set(identity, { part, bv, page, flatKeys });
                }
            }

            // 部分新版选集 DOM 只给 aid。若 aid 转 BV 失败，用标题和当前 UP 主找本地记录；只有唯一命中才修改，避免误认同名视频。
            const usedFallbackKeys = new Set();
            for (const part of noBvParts) {
                const title = normalizeTitle(part.title);
                if (!title) continue;
                const candidates = flatRecords.filter(item => {
                    if (usedFallbackKeys.has(item.key)) return false;
                    const localTitle = normalizeTitle(item.record.partTitle || item.record.title);
                    if (localTitle !== title) return false;
                    const localAuthor = cleanText(item.record.authorName || '');
                    // 无 BV 时只能用“分集标题 + 同一 UP 主”兜底；作者缺失或不一致都不冒险合并，避免同名视频串记录。
                    if (!scannedAuthor || !localAuthor || localAuthor.toLocaleLowerCase() !== scannedAuthor.toLocaleLowerCase()) return false;
                    return true;
                });
                if (candidates.length !== 1) continue;
                const candidate = candidates[0];
                usedFallbackKeys.add(candidate.key);
                const identity = `local:${candidate.key}`;
                matches.set(identity, { part, bv: candidate.bv, page: candidate.page, flatKeys: [candidate.key], fallback: true });
            }

            if (!matches.size) {
                console.warn(`${TAG} [合集扫描迁移] 没有匹配到本地记录：分集=${info.parts.length}，已解析BV=${partByIdentity.size}，无BV待标题匹配=${noBvParts.length}`);
                return { changed: 0, merged: 0, matched: 0 };
            }

            const mergeRecords = (match) => {
                const { bv, page, part, flatKeys } = match;
                // 读/建同BV容器。
                let container = RecordNormalizer.normalize(GM_getValue(bv, null));
                if (!container || container.type !== 'collection') {
                    container = { type: 'collection', key: bv, title: containerTitle || '', authorName: scannedAuthor || '', mediaType: '视频', parts: [], schemaVersion: 4 };
                }
                const beforeContainer = JSON.stringify(container);
                // 合集标题优先级：播放页合集框 title(containerTitle) 最高，其次已有；分集标题用选集集名覆盖(高优先)。
                if (containerTitle && container.title !== containerTitle) container.title = containerTitle;
                // 稳定归属键（sid/season/指纹）：扫描到的合集按它归组，已有值不被空覆盖。
                if (info.collectionKey && container.collectionKey !== info.collectionKey) container.collectionKey = info.collectionKey;
                if (!container.authorName && scannedAuthor) container.authorName = scannedAuthor;
                const incomingTitle = cleanText(part?.title || '');
                const smallTitle = cleanText(part?.smallCollectionTitle || '');
                const order = Number.isFinite(Number(part?.collectionOrder)) ? Math.floor(Number(part?.collectionOrder)) : 0;
                const partTotal = Math.max(1, Number(part?.partTotal) || 1);
                const completePartBv = `${bv}${partTotal > 1 && page > 1 ? `?p=${page}` : ''}`;

                let targetPart = container.parts.find(pp => pp.p === page);
                // 汇总 flatKeys（旧扁平记录）的快照/次数/时间。
                const allSnap = [];
                let wc = 0, lt = 0, lp = '0%', thr = false;
                for (const fk of flatKeys) {
                    const rec = RecordNormalizer.normalize(GM_getValue(fk, null));
                    if (!rec) continue;
                    wc += Math.max(0, Number(rec.watchCount) || 0);
                    for (const s of (Array.isArray(rec.snapshots) ? rec.snapshots : [])) allSnap.push(s);
                    if (Number(rec.lastTs || 0) > lt) { lt = Number(rec.lastTs || 0); lp = rec.lastProgress || '0%'; }
                    thr = thr || rec.hasReachedWatchThreshold === true;
                }
                if (!targetPart) {
                    targetPart = {
                        p: page, bv: completePartBv,
                        title: incomingTitle || '',
                        partTotal,
                        smallCollectionTitle: smallTitle,
                        collectionOrder: order,
                        lastTs: lt, lastProgress: lp,
                        watchCount: Math.max(1, wc, allSnap.length),
                        snapshots: RecordNormalizer.keepSnapshotsWithinLimit(allSnap),
                        hasReachedWatchThreshold: thr, officialHistorySeen: true, emptyRecord: false
                    };
                    container.parts.push(targetPart);
                } else {
                    targetPart.bv = completePartBv;
                    const snapMap = new Map();
                    for (const s of [...(targetPart.snapshots || []), ...allSnap]) {
                        if (!s || typeof s !== 'object') continue;
                        const sig = `${Number(s.ts) || 0}|${s.pos == null ? '' : Number(s.pos)}|${String(s.progress || '')}|${s.completed === true ? 1 : 0}`;
                        const old = snapMap.get(sig);
                        if (!old || String(s.watchTimeStr || '').length > String(old.watchTimeStr || '').length) snapMap.set(sig, s);
                    }
                    targetPart.snapshots = RecordNormalizer.keepSnapshotsWithinLimit([...snapMap.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)));
                    targetPart.watchCount = Math.max(Number(targetPart.watchCount) || 0, wc, targetPart.snapshots.length);
                    if (incomingTitle) targetPart.title = incomingTitle;
                    if (Number(lt) > Number(targetPart.lastTs || 0)) { targetPart.lastTs = lt; targetPart.lastProgress = lp; }
                    targetPart.partTotal = Math.max(Number(targetPart.partTotal) || 0, partTotal);
                    if (smallTitle) targetPart.smallCollectionTitle = smallTitle;
                    targetPart.collectionOrder = order;
                    targetPart.hasReachedWatchThreshold = targetPart.hasReachedWatchThreshold || thr;
                    targetPart.officialHistorySeen = true;
                }
                container.parts.sort((a, b) => a.p - b.p);
                const needsWrite = JSON.stringify(container) !== beforeContainer;
                if (needsWrite) RecordStore.set(bv, RecordNormalizer.normalize(container));
                let merged = 0;
                for (const fk of flatKeys) {
                    if (fk !== bv && GM_getValue(fk, null) !== null) { RecordStore.deleteRaw(fk); merged++; }
                }
                return { changed: needsWrite ? 1 : 0, merged };
            };

            let changedCount = 0;
            let mergedCount = 0;
            for (const match of matches.values()) {
                const result = mergeRecords(match);
                changedCount += result.changed;
                mergedCount += result.merged;
            }
            if (changedCount || mergedCount) {
                HistoryViewIndex.reset();
                RecordStore.clearIndex();
                console.info(`${TAG} [合集扫描迁移] ${containerTitle || '无标题合集'}：扫描分集=${info.parts.length}，匹配本地=${matches.size}，更新=${changedCount}，合并重复原始键=${mergedCount}，容器=${containerTitle || '按BV'}`);
            }
            return { changed: changedCount, merged: mergedCount, matched: matches.size };
        };

        // 独立于播放计数循环：播放页首次打开或选集 DOM 发生变化时才扫描并迁移本地数据，不随进度轮询反复遍历全部记录。
        let collectionRepairTimer = null;
        const scheduleCollectionRepair = (delay = 700) => {
            if (collectionRepairTimer !== null) return;
            collectionRepairTimer = setTimeout(async () => {
                collectionRepairTimer = null;
                try {
                    // 三级来源，按可靠度优先：
                    // 1) ugc_season 独立BV合集全集（每集带真实 bvid+集名）；
                    // 2) 单BV多P的 view.pages（按分P号匹配本地 BV?p=N）；
                    // 3) DOM 解析兜底（data-key=BV 的形态）。
                    const seasonData = await fetchUgcSeasonEpisodes();
                    let info = null;
                    let sourceLabel = 'DOM';
                    if (seasonData) {
                        sourceLabel = 'ugc_season';
                        const bvIdentity = [...new Set(seasonData.episodes.map(ep => ep.bvid))].sort().join('|');
                        info = {
                            collectionTitle: seasonData.seasonTitle,
                            collectionKey: seasonData.seasonId ? `season:${seasonData.seasonId}` : `bvs:${bvIdentity}`,
                            parts: seasonData.episodes.map((ep, order) => ({
                                bvId: ep.bvid,
                                title: ep.title,
                                index: 1,
                                partTotal: seasonData.episodes.length,
                                smallCollectionTitle: ep.sectionTitle || '',
                                collectionOrder: order
                            }))
                        };
                    } else {
                        const videoPages = await fetchVideoPages();
                        if (videoPages) {
                            sourceLabel = 'video-pages';
                            info = {
                                collectionTitle: videoPages.title,
                                collectionKey: `bvs:${videoPages.bv}`,
                                parts: videoPages.pages.map(ep => ({
                                    bvId: videoPages.bv,
                                    title: ep.part,
                                    index: ep.page,
                                    partTotal: videoPages.pages.length,
                                    smallCollectionTitle: '',
                                    collectionOrder: ep.page
                                }))
                            };
                        } else {
                            await resolveCollectionAids();
                            info = getCurrentCollectionInfo();
                        }
                    }
                    if (!info) {
                        console.warn(`${TAG} [合集扫描迁移] 暂未识别到当前合集：pods=${document.querySelectorAll('.video-pod').length}, items=${document.querySelectorAll('.video-pod .video-pod__item').length}`);
                        return;
                    }
                    const parsed = RecordKey.parse(window.location.href);
                    const result = repairKnownPlaylistPartTitles(parsed?.key || location.pathname, info);
                    console.info(`${TAG} [合集扫描诊断] ${info.collectionTitle || '无标题合集'}：来源=${sourceLabel}，扫描分集=${info.parts.length}，已解析BV=${info.parts.filter(part => /^BV/i.test(String(part.bvId || ''))).length}，更新=${result.changed}，合并重复键=${result.merged}`);
                } catch (error) {
                    console.warn(`${TAG} [合集扫描迁移] 扫描失败：`, error);
                }
            }, delay);
        };

        const readRecord = key => {
            // ep 播放写入前只读取当前 ep 的精确原始记录，不能按旧 DOM 上的 p 把另一集当成本集。
            // 普通视频/合集仍走统一 readSyncRecord，兼容原有分P读取行为。
            const sr = RecordKey.isEpisodeKey(String(key || ''))
                ? RecordStore.readEpisodeExact(key)
                : RecordStore.readSyncRecord(key);
            const rec = sr && sr.flat;
            if (!rec || typeof rec !== 'object') {
                return { title: null, lastTs: 0, lastProgress: '0%', watchCount: 0, snapshots: [], hasReachedWatchThreshold: false };
            }
            if (!Array.isArray(rec.snapshots)) rec.snapshots = [];
            if (!Number.isFinite(Number(rec.watchCount))) rec.watchCount = rec.snapshots.length;
            return rec;
        };

        // 只在暂停、切换视频、结束播放或离开页面时保存检查点。
        // 播放中的 timeupdate / DOM 变化 / 定时轮询只用于识别当前视频，不写入记录。
        let lastActiveContext = null;
        let lastSavedCheckpoint = null;
        let isSavingCheckpoint = false;
        let contextMetadataKey = '';
        let contextMetadataAt = 0;
        let contextCollectionInfo = null;
        let contextTitleInfo = null;

        const savePlaybackCheckpoint = (context, reason = 'pause') => {
            if (!context || isSavingCheckpoint) return false;
            const { key, video } = context;
            if (!key || !video) return false;
            // 切换事件到来时，video DOM 常已被 B 站复用于新集；使用上一轮为旧集缓存的标量位置，不能读新集的 currentTime。
            const useCapturedSample = reason === 'switch'
                && Number.isFinite(Number(context.sampledPos))
                && Number.isFinite(Number(context.sampledDuration))
                && Number(context.sampledDuration) > 0;
            const pos = useCapturedSample ? Number(context.sampledPos) : Number(video.currentTime);
            const duration = useCapturedSample ? Number(context.sampledDuration) : Number(video.duration);
            if (!Number.isFinite(pos) || pos < 0 || !Number.isFinite(duration) || duration <= 0) return false;
            // 刚打开视频但尚未实际播放时不创建记录；退出/暂停时才落盘。
            if (pos <= 0 && reason !== 'ended') return false;

            const completed = reason === 'ended' || (!useCapturedSample && video.ended === true);
            const progress = completed ? '100%' : `${Math.min(99, Math.max(0, Math.floor((pos / duration) * 100)))}%`;
            // pause、ended、beforeunload 可能在同一位置连续触发。相同会话同一进度只保存一次。
            if (lastSavedCheckpoint && lastSavedCheckpoint.key === key
                && Math.abs(lastSavedCheckpoint.pos - pos) < 1
                && lastSavedCheckpoint.progress === progress) {
                return false;
            }

            isSavingCheckpoint = true;
            try {
                const nowTs = TimeTool.now();
                const liveParsed = RecordKey.parse(window.location.href);
                const isSameRoute = !!liveParsed && liveParsed.key === key;
                // 当前集保存用当前页面的新鲜节点；切换上一集只用上一轮已采集的元数据，绝不混读新 URL 的 DOM。
                const collectionInfo = isSameRoute
                    ? getCurrentCollectionInfo()
                    : (context.collectionInfo || null);
                const titleInfo = isSameRoute
                    ? getCurrentPlayerTitle(collectionInfo)
                    : (context.titleInfo || { title: '', trusted: false, specific: false });
                const record = readRecord(key);
                if (context.seasonId) record.seasonId = context.seasonId;
                if (context.isBangumi) record.mediaType = (record.mediaType && record.mediaType !== '视频') ? record.mediaType : PageData.resolveBangumiMediaType();

                if (!hasCountedThisSession) {
                    record.watchCount = Math.max(0, Number(record.watchCount) || 0) + 1;
                    hasCountedThisSession = true;
                    StorageApi.checkStorageWarn();
                }
                if (pos >= CONFIG.SHORT_WATCH_MAX_POS_SEC || completed) record.hasReachedWatchThreshold = true;
                applyPlayerTitle(record, titleInfo);
                applyCollectionInfo(record, collectionInfo);
                CardDom.mergeAuthorMetadata(record, CardDom.extractAuthorFromVideoPage());

                RecordNormalizer.appendSnapshot(record, {
                    ts: nowTs,
                    pos: completed ? duration : pos,
                    progress,
                    watchTimeStr: TimeTool.formatTimestamp(nowTs),
                    ...(completed ? { completed: true } : {}),
                    source: 'player'
                });
                record.lastTs = nowTs;
                record.lastProgress = progress;

                RecordStore.upsertRecord(key, record, {
                    ...(context.episodeKey ? {
                        episodeKey: context.episodeKey,
                        seasonKey: context.seasonKey || (Number(collectionInfo?.seasonId) > 0 ? `ss${Number(collectionInfo.seasonId)}` : ''),
                        seasonId: Number(context.seasonId) || Number(collectionInfo?.seasonId) || 0,
                        sectionTitle: collectionInfo?.sectionTitle || ''
                    } : {}),
                    partTitle: collectionInfo?.partTitle || '',
                    partNumber: collectionInfo?.partNumber || 0,
                    partTotal: collectionInfo?.partTotal || 0,
                    containerTitle: collectionInfo?.collectionTitle || '',
                    collectionKey: collectionInfo?.collectionKey || '',
                    smallCollectionTitle: collectionInfo?.smallCollectionTitle || '',
                    seasonTitleVerified: collectionInfo?.seasonTitleVerified === true,
                    collectionOrder: collectionInfo?.collectionOrder || 0,
                    ...(context.isBangumi && collectionInfo?.episodeNumberVerified !== true ? { disallowLegacyPartFallback: true } : {})
                });

                lastSavedCheckpoint = { key, pos, progress };
                const playbackFloat = document.getElementById('bvh-status-float');
                if ((!playbackFloat || playbackFloat.dataset.hasRecord !== 'true') && !playbackFloatRefreshedAfterSave) {
                    playbackFloatRefreshedAfterSave = true;
                    PlaybackUI.render();
                }
                if (completed) lastEndingSavedKey = key;
                return true;
            } catch (error) {
                console.warn(`${TAG} [播放记录] 保存检查点失败：`, error);
                return false;
            } finally {
                isSavingCheckpoint = false;
            }
        };

        // 只识别当前视频及切换，不在这里写记录；同时把上一集的元数据和播放位置留在内存快照中。
        // 快照只是切换保护，不替代 GM 原始记录；真正保存时 readRecord 仍直接读当前 GM 存储。
        const loop = (refreshMetadata = false) => {
            const context = getCurrentContext();
            if (!context) {
                if (lastActiveContext) savePlaybackCheckpoint(lastActiveContext, 'switch');
                lastActiveContext = null;
                activeRecordKey = null;
                hasCountedThisSession = false;
                hasSavedSnapshotThisSession = false;
                lastSavedCheckpoint = null;
                endingWasVisible = false;
                contextMetadataKey = '';
                contextMetadataAt = 0;
                contextCollectionInfo = null;
                contextTitleInfo = null;
                return;
            }

            const keyChanged = activeRecordKey !== context.key;
            if (keyChanged) {
                if (lastActiveContext && lastActiveContext.key !== context.key) {
                    savePlaybackCheckpoint(lastActiveContext, 'switch');
                }
                resetForVideo(context.key);
                lastSavedCheckpoint = null;
                contextMetadataKey = '';
                contextMetadataAt = 0;
                contextCollectionInfo = null;
                contextTitleInfo = null;
            }

            const now = Date.now();
            if (contextMetadataKey !== context.key || refreshMetadata || now - contextMetadataAt >= Math.max(1000, Number(CONFIG.RECORD_INTERVAL) || 5000)) {
                const routeParsed = RecordKey.parse(window.location.href);
                if (routeParsed && routeParsed.key === context.key) {
                    const currentInfo = getCurrentCollectionInfo();
                    if (!context.episodeKey || currentInfo?.episodeKey === context.episodeKey) {
                        contextCollectionInfo = currentInfo;
                        contextTitleInfo = getCurrentPlayerTitle(currentInfo);
                    } else {
                        contextCollectionInfo = null;
                        contextTitleInfo = null;
                    }
                }
                contextMetadataKey = context.key;
                contextMetadataAt = now;
            }

            // 仅采集数值快照，不进行存储写入；即使 B 站复用同一个 video 节点，切换保存也不会读到新集的 currentTime。
            lastActiveContext = {
                ...context,
                collectionInfo: contextCollectionInfo,
                titleInfo: contextTitleInfo,
                sampledPos: Number(context.video.currentTime),
                sampledDuration: Number(context.video.duration),
                sampledAt: now
            };
            lastVideoElement = context.video;
        };

        const attachVideoEvents = () => {
            const video = getPlayableMediaElement();
            if (!video) return;
            if (video.dataset?.bvhEventsAttached !== 'true') {
                if (video.dataset) video.dataset.bvhEventsAttached = 'true';
                // 监听器不能直接传 loop：浏览器会把 Event 对象作为第一个参数，导致每次 timeupdate 都强制重读 DOM 元数据。
                video.addEventListener('playing', () => loop(true));
                video.addEventListener('timeupdate', () => loop());
                video.addEventListener('pause', () => {
                    const context = getCurrentContext();
                    if (context && context.key === activeRecordKey) savePlaybackCheckpoint(context, 'pause');
                });
                video.addEventListener('ended', () => {
                    const context = getCurrentContext();
                    if (context) savePlaybackCheckpoint(context, 'ended');
                });
                lastVideoElement = video;
            }
            loop();
        };

        const observer = new MutationObserver(mutations => {
            // 播放器 class/style 高频变化与合集数据无关，不应触发整库扫描或播放记录循环。
            const childMutations = mutations.filter(mutation => mutation.type === 'childList');
            if (!childMutations.length) return;
            attachVideoEvents();
            loop();
            // 仅在选集列表结构真正增删时重扫；忽略进度条、按钮样式等属性变化。
            const collectionChanged = childMutations.some(mutation => {
                const target = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
                if (target?.closest?.('.video-pod__list, .video-pod__body')) return true;
                return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(node =>
                    node.nodeType === 1 && (node.matches?.('.video-pod') || node.querySelector?.('.video-pod'))
                );
            });
            if (collectionChanged) scheduleCollectionRepair(500);
        });
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });

        let skipOneLoopAfterRouteChange = false;
        const onRouteChange = () => {
            activeRecordKey = null;
            skipOneLoopAfterRouteChange = true;
            PlaybackUI.render();
            scheduleCollectionRepair(1600);
        };
        window.addEventListener('popstate', onRouteChange);
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        history.pushState = function (...args) { const r = originalPushState.apply(this, args); onRouteChange(); return r; };
        history.replaceState = function (...args) { const r = originalReplaceState.apply(this, args); onRouteChange(); return r; };

        let lastSeenRoute = location.pathname + location.search;
        recordTimer = setInterval(() => {
            const routeNow = location.pathname + location.search;
            if (routeNow !== lastSeenRoute) {
                lastSeenRoute = routeNow;
                activeRecordKey = null;
                skipOneLoopAfterRouteChange = true;
                PlaybackUI.render();
            }
            attachVideoEvents();
            if (skipOneLoopAfterRouteChange) {
                skipOneLoopAfterRouteChange = false;
                return;
            }
            loop(true);
        }, CONFIG.RECORD_INTERVAL);

        attachVideoEvents();
        loop();
        scheduleCollectionRepair(1600);

        window.addEventListener('pagehide', () => {
            if (lastActiveContext) savePlaybackCheckpoint(lastActiveContext, 'exit');
        }, { once: true });

        window.addEventListener('beforeunload', () => {
            if (lastActiveContext) savePlaybackCheckpoint(lastActiveContext, 'exit');
            clearInterval(recordTimer);
            if (collectionRepairTimer !== null) clearTimeout(collectionRepairTimer);
            observer.disconnect();
            window.removeEventListener('popstate', onRouteChange);
            history.pushState = originalPushState;
            history.replaceState = originalReplaceState;
        }, { once: true });
    }

    // ── 直播记录器：路由变化时记一条进入直播间的快照（直播没有进度概念） ──
    function startLiveRecorder() {
        if (!/^https:\/\/live\.bilibili\.com\//.test(location.href)) return;

        let lastKey = null;
        let lastRoute = '';

        const recordOnce = () => {
            const parsed = RecordKey.parse(window.location.href);
            if (!parsed || !parsed.isLive) return;
            const key = parsed.key;
            const route = location.pathname + location.search;
            if (key === lastKey && route === lastRoute) return;
            lastKey = key;
            lastRoute = route;

            const nowTs = TimeTool.now();
            const record = RecordNormalizer.normalize(GM_getValue(key)) || {
                title: null,
                lastTs: 0,
                lastProgress: '0%',
                watchCount: 0,
                snapshots: [],
                hasReachedWatchThreshold: false
            };
            record.title = document.title.replace('_哔哩哔哩_bilibili', '') || record.title;
            record.mediaType = '直播';
            record.watchCount = Math.max(0, Number(record.watchCount) || 0) + 1;
            record.lastTs = nowTs;
            record.lastProgress = '0%';
            record.hasReachedWatchThreshold = true;

            if (!Array.isArray(record.snapshots)) record.snapshots = [];
            record.snapshots.push({
                ts: nowTs,
                pos: null,
                progress: '0%',
                watchTimeStr: TimeTool.formatTimestamp(nowTs),
                // 直播页与播放页同属"自动获取"，显式标注，不再依赖缺省推断
                source: 'player'
            });
            record.snapshots = RecordNormalizer.keepSnapshotsWithinLimit(record.snapshots);
            RecordStore.set(key, record);
        };

        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        const onRoute = () => { lastKey = null; setTimeout(recordOnce, 300); };
        history.pushState = function (...args) { const r = originalPushState.apply(this, args); onRoute(); return r; };
        history.replaceState = function (...args) { const r = originalReplaceState.apply(this, args); onRoute(); return r; };
        window.addEventListener('popstate', onRoute);

        setTimeout(recordOnce, 800);

        window.addEventListener('beforeunload', () => {
            window.removeEventListener('popstate', onRoute);
            history.pushState = originalPushState;
            history.replaceState = originalReplaceState;
        }, { once: true });
    }

    // ── 卡片角标：IntersectionObserver 给已看过的视频卡片盖『已观看 ×N』章 ──
    // 【模块：视频卡片观看记录标记】
    // 扫描已适配页面中的视频卡片，匹配本地记录并在卡片上显示相应标记/信息。
    // 页面内容常由前端动态加载，因此需要处理后续新增的卡片；标记操作只改变展示层，不改观看记录。
    function startCardBadgeRenderer() {
        const observerOptions = { root: null, rootMargin: '100px', threshold: 0.1 };
        const cardSelector = '.bili-video-card';
        // 角标只查现有 HistoryViewIndex，不再在主页面/搜索页反复读取全部 GM 存储。
        // 索引每次重建/增量更新都会替换 _index；按索引对象缓存 BV、单集、整季映射。
        // 当前索引里没有对应条目时直接跳过，不为角标查询触发全量读取或扫描。
        const badgeIndexCache = { source: null, byBv: new Map(), byKey: new Map(), bySeason: new Map() };
        const invalidateBadgeIndex = () => { badgeIndexCache.source = null; };
        window.addEventListener(RECORD_CHANGE_EVENT, invalidateBadgeIndex);
        // 每个网页标签都有独立的脚本运行环境，不能假设历史面板已替本页初始化索引。
        // ensure() 优先读取已保存索引；缺失时只启动一次现有的后台分批重建，不在每张卡片查询时重建。
        HistoryViewIndex.ensure();

        const getBadgeIndex = () => {
            const index = HistoryViewIndex._index;
            if (!index || !index.itemsByKey || typeof index.itemsByKey !== 'object') return null;
            if (badgeIndexCache.source === index) return badgeIndexCache;

            const byBv = new Map();
            const byKey = new Map();
            const bySeason = new Map();
            const add = (map, id, item) => {
                if (!id) return;
                const normalizedId = String(id).toLowerCase();
                if (!map.has(normalizedId)) map.set(normalizedId, []);
                map.get(normalizedId).push(item);
            };
            const toBadgeRecord = item => ({
                key: item.key || '',
                title: item.partTitle || item.title || '',
                authorName: item.authorName || '',
                watchCount: Math.max(0, Number(item.watchCount) || 0),
                lastTs: Number(item.lastTs) || 0,
                // 角标必须从索引项读取真实进度；此前漏传 lastProgress，导致所有普通视频都回退成 0%。
                // 兼容旧索引项：若顶层进度缺失，再从最新快照取值。
                lastProgress: item.lastProgress || (Array.isArray(item.snapshots)
                    ? item.snapshots.slice().sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0))[0]?.progress
                    : '') || '0%',
                collectionTitle: item.collectionTitle || '',
                collectionKey: item.collectionKey || item.containerKey || item.key || '',
                snapshots: Array.isArray(item.snapshots) ? item.snapshots : [],
                mediaType: item.mediaType || '',
                seasonId: Number(item.seasonId) || 0
            });

            Object.values(index.itemsByKey).forEach(item => {
                if (!item || typeof item !== 'object') return;
                const key = String(item.key || '').toLowerCase();
                if (key) add(byKey, key, toBadgeRecord(item));

                const rawBv = String(item.bvKey || item.key || '').match(/^(BV[a-zA-Z0-9]+)/i);
                if (rawBv) add(byBv, rawBv[1], toBadgeRecord(item));

                const seasonKey = String(item.containerKey || '').match(/^ss\d+$/i)?.[0]
                    || (Number(item.seasonId) > 0 ? `ss${Number(item.seasonId)}` : '');
                if (seasonKey) add(bySeason, seasonKey, toBadgeRecord(item));
            });
            const sortRecords = map => map.forEach(items => items.sort((a, b) => Number(b.lastTs || 0) - Number(a.lastTs || 0)));
            sortRecords(byBv);
            sortRecords(byKey);
            sortRecords(bySeason);
            badgeIndexCache.source = index;
            badgeIndexCache.byBv = byBv;
            badgeIndexCache.byKey = byKey;
            badgeIndexCache.bySeason = bySeason;
            return badgeIndexCache;
        };

        const getBadgeRecordsForBv = bvid => {
            if (!bvid) return [];
            const index = getBadgeIndex();
            return index ? (index.byBv.get(String(bvid).toLowerCase()) || []).slice() : [];
        };
        const videoLinkSelector = 'a[href*="/video/BV"], a[href*="/bangumi/play/ss"], a[href*="/bangumi/play/ep"], a[href*="live.bilibili.com/"]';

        const getVideoLink = target => {
            if (target.matches?.(videoLinkSelector)) return target;
            return target.querySelector(
                '.bili-video-card__image--link[href*="/video/BV"], a[href*="/video/BV"], a[href*="/bangumi/play/ss"], a[href*="/bangumi/play/ep"], a[href*="live.bilibili.com/"]'
            );
        };

        const getCover = target => {
            if (target.matches?.('.bili-video-card__image, .pic, .cover')) return target;
            return target.querySelector('.bili-video-card__image, .pic, .cover');
        };

        const getBadgeRecordsForEpisode = epKey => {
            const index = getBadgeIndex();
            return index ? (index.byKey.get(String(epKey || '').toLowerCase()) || []).slice() : [];
        };

        const getBadgeRecordsForSeason = seasonKey => {
            const index = getBadgeIndex();
            if (!index) return [];
            const wanted = String(seasonKey || '').toLowerCase();
            const parts = (index.bySeason.get(wanted) || []).slice();
            // 兼容旧索引中整季记录本身没有展开为分集条目的情况；只读取该季的直接索引项。
            if (!parts.length) return (index.byKey.get(wanted) || []).slice();
            return parts;
        };

        const renderOneCard = target => {
            const link = getVideoLink(target);
            const parsed = link && RecordKey.parse(link.href);
            const container = getCover(target);
            if (!parsed || !container) return;

            let lookupKey = parsed.isBangumi ? parsed.key : parsed.bvid;
            let displayId = parsed.isBangumi ? parsed.key : parsed.bvid;
            let records = parsed.isBangumi
                ? (parsed.isEpisode ? getBadgeRecordsForEpisode(parsed.key) : parsed.isSeason ? getBadgeRecordsForSeason(parsed.key) : (getBadgeIndex()?.byKey.get(String(lookupKey).toLowerCase()) || []).slice())
                : getBadgeRecordsForBv(parsed.bvid);

            if (!records.length) {
                container.querySelectorAll('.bvh-tag, .bvh-progress-container').forEach(node => node.remove());
                delete target.dataset.bvhRenderSignature;
                return;
            }

            const bestRec = records[0];
            // 普通视频维持“观看次数 + 上次进度 + 封面底部进度条”；
            // 只有同 BV 的 ?p=N 分P、番剧/电视剧条目才仅显示总观看次数。
            const totalWatchCount = records.reduce((sum, item) => sum + Math.max(0, Number(item.watchCount) || 0), 0);
            const isPagedPart = /[?&]p=\d+/i.test(String(link.href || '')) || /\?p=\d+$/i.test(String(parsed.key || ''));
            const isSeriesMedia = records.some(item => /番剧|电视剧/.test(String(item.mediaType || '')))
                || records.some(item => Number(item.seasonId) > 0);
            const totalOnly = !!parsed.isBangumi || isPagedPart || isSeriesMedia;
            const progressText = bestRec.lastProgress || '0%';
            const signature = `${displayId}|${records.map(item => `${item.key}:${item.watchCount}:${item.lastTs || 0}:${item.lastProgress || '0%'}`).join(',')}|${totalWatchCount}|${totalOnly}`;
            if (target.dataset.bvhRenderSignature === signature
                && container.querySelector('.bvh-tag')
                && (totalOnly ? !container.querySelector('.bvh-progress-container') : !!container.querySelector('.bvh-progress-container'))) return;

            container.querySelectorAll('.bvh-tag, .bvh-progress-container').forEach(node => node.remove());
            container.style.position = 'relative';

            const tag = document.createElement('div');
            tag.className = 'bvh-tag';
            tag.textContent = totalOnly ? `总观看 ${totalWatchCount} 次` : `已观看 ×${Math.max(0, Number(bestRec.watchCount) || 0)} ${progressText}`;
            tag.title = totalOnly
                ? `记录：${displayId}，观看总次数：${totalWatchCount} 次${bestRec.authorName ? `，作者：${bestRec.authorName}` : ''}`
                : `记录：${displayId}，作者：${bestRec.authorName || '作者未知'}，观看次数：${Math.max(0, Number(bestRec.watchCount) || 0)}，上次进度：${progressText}`;

            container.append(tag);
            if (!totalOnly) {
                const progress = document.createElement('div');
                progress.className = 'bvh-progress-container';
                const bar = document.createElement('div');
                bar.className = 'bvh-progress-bar';
                bar.style.width = progressText;
                progress.appendChild(bar);
                container.appendChild(progress);
            }
            target.dataset.bvhRenderSignature = signature;
        };

        const refreshAllBadges = () => {
            badgeIndexCache.source = null;
            document.querySelectorAll(cardSelector).forEach(card => renderOneCard(card));
            // 兼容不在 .bili-video-card 容器内、由其他已适配页面单独识别的链接。
            document.querySelectorAll(videoLinkSelector).forEach(link => {
                if (!link.closest(cardSelector)) renderOneCard(link);
            });
        };
        window.addEventListener('bvh-history-index-updated', refreshAllBadges);

        const cardObserver = new IntersectionObserver(entries => {
            entries.forEach(({ target, isIntersecting }) => {
                if (isIntersecting) renderOneCard(target);
            });
        }, observerOptions);

        const observeCards = (root = document) => {
            if (!(root instanceof Element) && root !== document) return;
            const targets = new Set();
            if (root instanceof Element && root.matches(cardSelector)) targets.add(root);
            root.querySelectorAll?.(cardSelector).forEach(card => targets.add(card));
            const anchors = [];
            if (root instanceof Element && root.matches(videoLinkSelector)) anchors.push(root);
            root.querySelectorAll?.(videoLinkSelector).forEach(link => anchors.push(link));
            anchors.forEach(link => { if (!link.closest(cardSelector)) targets.add(link); });

            targets.forEach(target => {
                if (target.dataset.bvhObserved === 'true') return;
                target.dataset.bvhObserved = 'true';
                cardObserver.observe(target);
            });
        };

        observeCards();
        const cardMutationObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) observeCards(node);
                });
            });
        });
        cardMutationObserver.observe(document.body, { childList: true, subtree: true });

        const getSeasonKeyFromCard = (card, fallbackKey) => {
            const ssLink = card?.querySelector?.('a[href*="/bangumi/play/ss"]');
            if (ssLink) {
                const m = String(ssLink.getAttribute('href') || '').match(/\/bangumi\/play\/(ss\d+)/i);
                if (m) return m[1].toLowerCase();
            }
            return RecordKey.isSeasonKey(fallbackKey || '') ? String(fallbackKey).toLowerCase() : null;
        };
        const resolveSeasonKeyForChanged = changedKey => {
            if (RecordKey.isSeasonKey(changedKey)) return changedKey.toLowerCase();
            if (!RecordKey.isEpisodeKey(changedKey)) return null;
            const rec = RecordNormalizer.normalize(GM_getValue(changedKey));
            const sid = Number(rec?.seasonId);
            return Number.isFinite(sid) && sid > 0 ? `ss${sid}` : null;
        };
        const cardMatchesChangedKey = (target, link, changedKey) => {
            const parsed = link && RecordKey.parse(link.href);
            if (!parsed) return false;
            const cardKey = String(parsed.key || '').toLowerCase();
            const changed = String(changedKey || '').toLowerCase();
            if (cardKey === changed) return true;
            if (RecordKey.isBangumiKey(cardKey) && RecordKey.isBangumiKey(changed)) {
                const cardSeason = getSeasonKeyFromCard(target.closest?.(cardSelector) || target, parsed.key);
                const changedSeason = resolveSeasonKeyForChanged(changed);
                if (cardSeason && changedSeason && cardSeason === changedSeason) return true;
            }
            return false;
        };

        const onRecordChanged = event => {
            const changedKey = event.detail?.key || event.detail?.bvid;
            if (!changedKey) return;
            document.querySelectorAll(`${cardSelector}, ${videoLinkSelector}`).forEach(target => {
                const link = getVideoLink(target);
                if (link && cardMatchesChangedKey(target, link, changedKey)) renderOneCard(target);
            });
        };
        window.addEventListener(RECORD_CHANGE_EVENT, onRecordChanged);

        window.addEventListener('beforeunload', () => {
            cardMutationObserver.disconnect();
            cardObserver.disconnect();
            window.removeEventListener(RECORD_CHANGE_EVENT, onRecordChanged);
            window.removeEventListener(RECORD_CHANGE_EVENT, invalidateBadgeIndex);
            window.removeEventListener('bvh-history-index-updated', refreshAllBadges);
        }, { once: true });
    }

    // ── 通用拖拽：RAF 缓动 + pointer 事件 + 边界钳制，统一 makeDockableFloat 和 dragBar 的实现。
    //     options:
    //       - margin          边界留白（默认 8）
    //       - easing          缓动系数（默认 0.22）
    //       - threshold       停止缓动的距离阈值（默认 0.45）
    //       - preventDefault  是否在 pointerdown 时 preventDefault（dragBar 用 true）
    //       - animateOnEnd    pointerup 后是否缓动到目标；false 表示吸附（Dock 浮窗用 false）
    //       - suppressClickAfterDrag  拖拽后是否吞掉 click（Dock 浮窗用 true）
    //       - canStart(event, el)  自定义判断是否允许开始拖拽
    //       - onStart(callback)  pointerdown 且未命中按钮时触发
    //       - onEnd(didMove, target, el) pointerup/pointercancel 时触发
    //     返回 { isDragging, getDidMove }
    // 【模块：通用拖动交互】
    // 让指定浮层通过 handle 拖动，并按 options 处理边界、移动状态等交互细节。
    // 拖动起点与点击/跳转行为需要区分，避免用户只是点击悬浮窗时被误判为拖拽。
    function makeDraggable(el, handle, options = {}) {
        const {
            margin = 8,
            allowFlushLeft = false,
            easing = 0.22,
            threshold = 0.45,
            preventDefault = false,
            animateOnEnd = true,
            suppressClickAfterDrag = false,
            canStart = null,
            onStart = null,
            onEnd = null
        } = options;

        let drag = null;
        let didMove = false;
        let raf = 0;
        let current = null;
        let target = null;

        const clampLeft = v => Math.max(allowFlushLeft ? 0 : margin, Math.min(window.innerWidth - el.offsetWidth - margin, v));
        const clampTop = v => Math.max(margin, Math.min(window.innerHeight - el.offsetHeight - margin, v));

        const animate = () => {
            raf = 0;
            if (!current || !target) return;
            current.left += (target.left - current.left) * easing;
            current.top += (target.top - current.top) * easing;
            el.style.left = `${current.left}px`;
            el.style.top = `${current.top}px`;
            const remaining = Math.abs(target.left - current.left) + Math.abs(target.top - current.top);
            if (remaining > threshold) {
                raf = requestAnimationFrame(animate);
            } else {
                current = { ...target };
                el.style.left = `${target.left}px`;
                el.style.top = `${target.top}px`;
                if (!drag) {
                    current = null;
                    target = null;
                    el.style.transition = '';
                }
            }
        };

        handle.addEventListener('pointerdown', e => {
            if (el.dataset.bvhResizeActive === 'true') return;
            if (e.button !== 0) return;
            if (e.target.closest('button, input, textarea, select, a')) return;
            if (canStart && !canStart(e, el)) return;
            const rect = el.getBoundingClientRect();
            drag = {
                pointerId: e.pointerId,
                x: e.clientX, y: e.clientY,
                left: rect.left, top: rect.top
            };
            current = { left: rect.left, top: rect.top };
            target = { left: rect.left, top: rect.top };
            didMove = false;
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            // 先把当前屏幕坐标写回 left/top，再解除 bottom 约束；否则初次拖动时浏览器会重新计算位置，面板会闪跳。
            el.style.transition = 'none';
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.top}px`;
            el.style.bottom = 'auto';
            // 不在按下时捕获指针：整个浮窗捕获会改变链接点击的目标，导致链接被当成拖拽容器点击。
            // 真正越过拖拽阈值后才捕获，普通点击仍由原始链接接收。
            if (preventDefault) e.preventDefault();
            if (onStart) onStart(el);
        });

        handle.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.pointerId) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!didMove && Math.abs(dx) + Math.abs(dy) > 4) {
                didMove = true;
                el.classList.add('bvh-dragging');
                try { handle.setPointerCapture?.(e.pointerId); } catch (_) { /* 捕获失败不影响拖拽 */ }
            }
            if (!didMove) return;
            target.left = clampLeft(drag.left + dx);
            target.top = clampTop(drag.top + dy);
            if (!raf) raf = requestAnimationFrame(animate);
        });

        const end = e => {
            if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
            drag = null;
            el.classList.remove('bvh-dragging');
            if (animateOnEnd && target) {
                target.left = clampLeft(target.left);
                target.top = clampTop(target.top);
                if (!raf) raf = requestAnimationFrame(animate);
            } else {
                el.style.transition = 'none';
                if (target) {
                    target.left = clampLeft(target.left);
                    target.top = clampTop(target.top);
                }
            }
            if (onEnd) onEnd(didMove, target, el);
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);

        if (suppressClickAfterDrag) {
            el.addEventListener('click', e => {
                if (didMove) {
                    e.preventDefault();
                    e.stopPropagation();
                    didMove = false;
                }
            }, true);
        }

        return {
            isDragging: () => !!drag,
            getDidMove: () => didMove
        };
    }

    // 为指定卡片提供原生尺寸调整，并把用户最后一次调整的宽高保存到脚本本地设置。
    // 【模块：浮窗尺寸记忆】
    // 小入口卡片与两个历史搜索面板分别保存尺寸，避免不同页面相互覆盖。
    // 仅在用户拖动右下角调整尺寸后写入设置，普通内容变化不会覆盖用户偏好。
    function setupPersistentResize(el, storageKey, options = {}) {
        if (!el) return;
        const {
            minWidth = 240, minHeight = 180,
            maxWidth = Math.max(minWidth, window.innerWidth - 16),
            maxHeight = Math.max(minHeight, window.innerHeight - 16),
            skipWhenDocked = false
        } = options;
        // 不再使用浏览器原生 resize：原生抓手会让超长列表在每一帧跟着重排，且不同浏览器事件表现不一致。
        // 改用独立的轻量抓手；拖动期间隐藏内容树，只更新面板宽高，结束后一次性保存。
        el.style.resize = 'none';
        el.style.overflow = 'hidden';
        el.style.boxSizing = 'border-box';
        el.style.minWidth = `${minWidth}px`;
        el.style.minHeight = `${minHeight}px`;
        el.style.maxWidth = `${Math.max(minWidth, Math.min(maxWidth, window.innerWidth - 16))}px`;
        el.style.maxHeight = `${Math.max(minHeight, Math.min(maxHeight, window.innerHeight - 16))}px`;
        el.dataset.bvhResizable = 'true';

        const clampSize = (width, height) => ({
            width: Math.max(minWidth, Math.min(Number(width) || minWidth, window.innerWidth - 16, maxWidth)),
            height: Math.max(minHeight, Math.min(Number(height) || minHeight, window.innerHeight - 16, maxHeight))
        });
        try {
            const saved = GM_getValue(storageKey, null);
            if (saved && Number(saved.width) > 0 && Number(saved.height) > 0) {
                const size = clampSize(saved.width, saved.height);
                el.style.width = `${size.width}px`;
                el.style.height = `${size.height}px`;
            }
        } catch (_) { /* 读取尺寸设置失败时使用默认尺寸 */ }

        let resizeStarted = false;
        let startX = 0, startY = 0, startWidth = 0, startHeight = 0;
        let startLeft = 0, startTop = 0;
        let resizeRaf = 0;
        let pendingWidth = 0, pendingHeight = 0;
        let resizePointerId = null;
        let resizePreview = null;
        let originalVisibility = '';

        let handle = el.querySelector(':scope > .bvh-resize-handle');
        if (!handle) {
            handle = document.createElement('div');
            handle.className = 'bvh-resize-handle';
            handle.setAttribute('aria-hidden', 'true');
            el.appendChild(handle);
        }

        // 拖动期间只更新独立预览框，不逐帧改变真实面板尺寸；真正宽高只在松开时应用一次。
        const applyPendingSize = () => {
            resizeRaf = 0;
            if (!resizeStarted || !el.isConnected || !resizePreview) return;
            const size = clampSize(pendingWidth, pendingHeight);
            resizePreview.style.width = `${size.width}px`;
            resizePreview.style.height = `${size.height}px`;
            const label = resizePreview.firstElementChild;
            if (label) label.textContent = `${Math.round(size.width)} × ${Math.round(size.height)}`;
        };
        const finishResize = event => {
            if (!resizeStarted || (event?.pointerId != null && resizePointerId != null && event.pointerId !== resizePointerId)) return;
            resizeStarted = false;
            resizePointerId = null;
            if (resizeRaf) {
                cancelAnimationFrame(resizeRaf);
                resizeRaf = 0;
            }
            // pointerup 可能早于下一帧；直接应用最后一次尺寸，避免丢掉最后几像素。
            const finalSize = clampSize(pendingWidth, pendingHeight);
            el.style.width = `${finalSize.width}px`;
            el.style.height = `${finalSize.height}px`;
            el.classList.remove('bvh-resizing');
            el.style.visibility = originalVisibility;
            if (resizePreview) {
                resizePreview.remove();
                resizePreview = null;
            }
            delete el.dataset.bvhResizeActive;
            try { handle.releasePointerCapture?.(event?.pointerId); } catch (_) { /* 指针捕获可能已自动释放 */ }
            el.dispatchEvent(new CustomEvent('bvh-resize-end', { bubbles: false }));
            const rect = el.getBoundingClientRect();
            const size = clampSize(rect.width, rect.height);
            el.style.width = `${size.width}px`;
            el.style.height = `${size.height}px`;
            try { GM_setValue(storageKey, { width: Math.round(size.width), height: Math.round(size.height) }); }
            catch (_) { /* 尺寸记忆失败不影响卡片使用 */ }
        };
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || resizeStarted || (skipWhenDocked && el.classList.contains('bvh-docked'))) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = el.getBoundingClientRect();
            resizeStarted = true;
            resizePointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            startLeft = rect.left;
            startTop = rect.top;
            pendingWidth = startWidth;
            pendingHeight = startHeight;
            originalVisibility = el.style.visibility;
            resizePreview = document.createElement('div');
            resizePreview.className = 'bvh-resize-preview';
            Object.assign(resizePreview.style, {
                position: 'fixed', left: `${startLeft}px`, top: `${startTop}px`,
                width: `${startWidth}px`, height: `${startHeight}px`, boxSizing: 'border-box',
                zIndex: '2147483647', pointerEvents: 'none', overflow: 'hidden',
                border: '2px dashed rgba(225, 91, 139, .95)', borderRadius: '12px',
                background: 'rgba(245, 240, 245, .96)', boxShadow: 'none',
                backdropFilter: 'none', webkitBackdropFilter: 'none'
            });
            const previewLabel = document.createElement('div');
            previewLabel.textContent = `${Math.round(startWidth)} × ${Math.round(startHeight)}`;
            Object.assign(previewLabel.style, {
                position: 'absolute', left: '12px', top: '10px', color: '#d94f7b',
                font: '600 13px/1.4 sans-serif', whiteSpace: 'nowrap'
            });
            resizePreview.appendChild(previewLabel);
            document.body.appendChild(resizePreview);
            el.style.visibility = 'hidden';
            el.classList.add('bvh-resizing');
            if (el.id === 'bvh-history-panel') el.dataset.bvhUserPositioned = 'true';
            el.dataset.bvhResizeActive = 'true';
            handle.setPointerCapture?.(event.pointerId);
            el.dispatchEvent(new CustomEvent('bvh-resize-start', { bubbles: false }));
        });
        handle.addEventListener('pointermove', event => {
            if (!resizeStarted || event.pointerId !== resizePointerId) return;
            event.preventDefault();
            pendingWidth = startWidth + event.clientX - startX;
            pendingHeight = startHeight + event.clientY - startY;
            if (!resizeRaf) resizeRaf = requestAnimationFrame(applyPendingSize);
        });
        handle.addEventListener('pointerup', finishResize);
        handle.addEventListener('pointercancel', finishResize);
        // 兜底处理指针在拖动中离开抓手/面板的情况。
        window.addEventListener('pointerup', finishResize, true);
        window.addEventListener('pointercancel', finishResize, true);
        window.addEventListener('resize', () => {
            if (!el.isConnected || resizeStarted) return;
            const rect = el.getBoundingClientRect();
            const size = clampSize(rect.width, rect.height);
            el.style.maxWidth = `${Math.max(minWidth, Math.min(maxWidth, window.innerWidth - 16))}px`;
            el.style.maxHeight = `${Math.max(minHeight, Math.min(maxHeight, window.innerHeight - 16))}px`;
            if (rect.width > window.innerWidth - 16 || rect.height > window.innerHeight - 16) {
                el.style.width = `${size.width}px`;
                el.style.height = `${size.height}px`;
            }
        });
    }

    // 让状态浮窗能够拖动、靠边停靠，并在鼠标移入时暂时展开。
    // 【模块：悬浮窗停靠与边缘吸附】
    // 在拖动完成后处理浮窗的位置与边缘停靠效果，让悬浮窗既能自由移动，也能保持在可访问的位置。
    // 该模块只负责位置/交互，不负责判断当前视频是否有本地观看记录。
    function makeDockableFloat(dom) {
        let dockTimer = null;
        let draggable = null;

        const dockLeft = () => {
            // 历史面板打开期间保持入口当前状态；不要在面板显示时再次停靠、改写 top。
            if (!dom.isConnected || dom.dataset.bvhPanelOpen === 'true' || dom.matches(':hover') || (draggable && draggable.isDragging())) return;
            const rect = dom.getBoundingClientRect();
            if (rect.left > window.innerWidth * 0.55) {
                dom.classList.remove('bvh-docked', 'bvh-docked-right');
                return;
            }
            // 鼠标悬停时 rect.height 是展开后的高度，不能用它限制停靠位置；否则离开时会把 top 往上挤。
            const savedDockHeight = parseFloat(dom.style.getPropertyValue('--bvh-dock-height'))
                || Number(dom.dataset.bvhDockHeight) || 0;
            const dockHeight = Math.max(48, savedDockHeight || rect.height);
            dom.style.setProperty('--bvh-dock-height', `${dockHeight}px`);
            dom.dataset.bvhDockHeight = String(dockHeight);
            dom.style.transition = '';
            dom.style.bottom = 'auto';
            // 点击展开/收起会暂时改变卡片尺寸；停靠时沿用上次记录的 top，只按折叠高度校验边界。
            const rememberedTop = Number(dom.dataset.bvhDockTop);
            const alreadyDocked = dom.classList.contains('bvh-docked');
            // 已停靠入口不因 hover 展开后的实时 rect 改写坐标；只有首次停靠或视口边界校正才计算 top。
            const desiredTop = alreadyDocked && Number.isFinite(rememberedTop) && dom.dataset.bvhDockTop !== ''
                ? rememberedTop
                : (Number.isFinite(rememberedTop) && dom.dataset.bvhDockTop !== '' ? rememberedTop : rect.top);
            const dockTop = Math.max(8, Math.min(desiredTop, window.innerHeight - dockHeight - 8));
            if (!alreadyDocked || Math.abs((parseFloat(dom.style.top) || 0) - dockTop) > 1) {
                dom.style.top = `${dockTop}px`;
            }
            dom.dataset.bvhDockTop = String(dockTop);
            dom.classList.remove('bvh-docked-right');
            dom.classList.add('bvh-docked');
            dom.style.left = '0px';
        };

        const scheduleDock = (delay = 900) => {
            clearTimeout(dockTimer);
            dockTimer = null;
            if (dom.dataset.bvhPanelOpen === 'true') return;
            dockTimer = setTimeout(dockLeft, delay);
        };
        // 让打开/关闭历史面板的逻辑能暂停或恢复自动停靠计时，不必重建拖拽实例。
        dom._bvhCancelDock = () => {
            clearTimeout(dockTimer);
            dockTimer = null;
        };
        dom._bvhResumeDock = (delay = 900) => scheduleDock(delay);

        draggable = makeDraggable(dom, dom, {
            animateOnEnd: false,
            suppressClickAfterDrag: true,
            allowFlushLeft: true,
            onStart: () => {
                dom.classList.remove('bvh-docked', 'bvh-docked-right');
            },
            onEnd: (didMove, target) => {
                if (!didMove || !target) return;
                const left = target.left, top = target.top;
                dom.style.left = `${left <= window.innerWidth * .45 ? 0 : left}px`;
                dom.style.top = `${top}px`;
                dom.dataset.bvhDockTop = String(top);
                if (left <= window.innerWidth * .45) scheduleDock(700);
            }
        });

        dom.addEventListener('mouseenter', () => {
            clearTimeout(dockTimer);
            if (dom.classList.contains('bvh-docked')) dom.style.left = '0px';
        });
        dom.addEventListener('mouseleave', () => scheduleDock(900));

        scheduleDock(2600);
    }

    // 记录编辑弹窗打开时锁住背景滚轮，避免页面在黑色遮罩下意外滚动；弹窗自身仍可滚动。
    document.addEventListener('wheel', event => {
        const overlay = document.querySelector('.bvh-record-dialog-overlay');
        if (!overlay) return;
        if (event.target instanceof Node && event.target !== overlay && overlay.contains(event.target)) return;
        event.preventDefault();
    }, { capture: true, passive: false });

    // 一次性注入脚本使用的样式，避免把样式散落在各个 DOM 创建函数中。
    // 【模块：注入脚本界面样式】
    // 统一添加历史列表、卡片标记、播放页悬浮窗和相关控件的 CSS。
    // 样式与功能逻辑分离；调整视觉效果时应避免改变 DOM 身份识别或记录读写流程。
    function injectStyle() {
        GM_addStyle(`
            .bvh-tag {
                position: absolute; top: 8px; left: 8px; padding: 2px 6px;
                background: rgba(0,0,0,.75); color: #fff; font-size: 11px;
                border-radius: 4px; z-index: 10; border: 1px solid rgba(255,255,0,.2);
                backdrop-filter: blur(4px); pointer-events: none;
            }
            .bvh-progress-container {
                position: absolute; bottom: 0; left: 0; width: 100%; height: 4px;
                background: rgba(255,255,255,.2); z-index: 11;
            }
            .bvh-progress-bar { height: 100%; background: #fb7299; box-shadow: 0 0 5px #fb7299; }
            #bvh-status-float {
                position: fixed; bottom: 20px; left: 20px; box-sizing: border-box;
                background: rgba(255,255,255,.76); color: #30323a;
                border: 1px solid rgba(255,255,255,.72); border-left: 4px solid #fb7299;
                border-radius: 16px;
                box-shadow: 0 10px 34px rgba(35,25,40,.15), inset 0 1px 0 rgba(255,255,255,.8);
                backdrop-filter: blur(18px) saturate(1.35);
                -webkit-backdrop-filter: blur(18px) saturate(1.35);
                padding: 14px 16px; z-index: 10000; cursor: grab; user-select: none;
                max-width: 280px; min-width: 210px; overflow: hidden;
                transform-origin: left center;
                transition: left .42s cubic-bezier(.22,1,.36,1), top .42s cubic-bezier(.22,1,.36,1),
                    width .42s cubic-bezier(.22,1,.36,1), min-width .42s ease, max-width .42s ease,
                    padding .42s cubic-bezier(.22,1,.36,1), border-radius .42s ease,
                    transform .42s cubic-bezier(.22,1,.36,1), box-shadow .42s ease, background .42s ease;
                will-change: left, top, width, transform;
            }
            #bvh-status-float:active { cursor: grabbing; }
            #bvh-status-float.bvh-resizing { transition: none !important; cursor: nwse-resize; }
            #bvh-status-float.bvh-docked {
                resize: none;
                width: 5px !important; min-width: 5px; max-width: 5px;
                height: var(--bvh-dock-height, auto); min-height: 48px;
                padding: 0; border: 0; border-radius: 0 12px 12px 0;
                background: #fb7299; box-shadow: 0 4px 18px rgba(251,114,153,.32); cursor: pointer;
            }
            #bvh-status-float.bvh-docked:hover,
            #bvh-status-float.bvh-docked:focus-within {
                /* 展开尺寸按当前视口计算，拖拽边界也使用展开后的实际 offsetWidth。 */
                width: min(250px, calc(100vw - 16px)) !important;
                min-width: min(210px, calc(100vw - 16px)); max-width: calc(100vw - 16px); height: auto;
                padding: 14px 16px; background: rgba(255,255,255,.82);
                border: 1px solid rgba(255,255,255,.72); border-left: 4px solid #fb7299;
                border-radius: 16px; box-shadow: 0 14px 38px rgba(35,25,40,.2);
                transform: none; cursor: grab;
            }
            #bvh-status-float.bvh-docked > * { opacity: 0; pointer-events: none; transition: opacity .16s ease; }
            #bvh-status-float.bvh-docked:hover > *,
            #bvh-status-float.bvh-docked:focus-within > * { opacity: 1; pointer-events: auto; transition-delay: .08s; }

            #bvh-menu-panel {
                position: fixed; bottom: 80px; left: 20px;
                background: rgba(255,255,255,.78); color: #30323a;
                border: 1px solid rgba(255,255,255,.75); border-radius: 16px;
                box-shadow: 0 12px 36px rgba(35,25,40,.16);
                backdrop-filter: blur(18px) saturate(1.3);
                -webkit-backdrop-filter: blur(18px) saturate(1.3);
                padding: 12px; z-index: 10001; display: none; max-width: 320px;
            }
            #bvh-menu-panel button {
                display: block; width: 100%; margin: 5px 0; padding: 7px 10px;
                border: 1px solid rgba(220,220,228,.8); border-radius: 10px;
                background: rgba(255,255,255,.62); color: #3a3940; cursor: pointer;
                transition: background .2s ease, border-color .2s ease, transform .2s ease;
            }
            #bvh-menu-panel button:hover { background: #fff0f5; border-color: #ffc2d2; transform: translateY(-1px); }

            .bvh-storage-info {
                font-size: 12px; color: #555; margin-bottom: 6px;
                border-bottom: 1px solid #eee; padding-bottom: 4px;
            }

            #bvh-history-panel {
                position: fixed; bottom: 80px; left: 360px;
                width: min(480px, calc(100vw - 40px)); height: 460px; resize: both; min-width: 300px; min-height: 220px; max-width: calc(100vw - 16px);
                background: rgba(255,255,255,.80); color: #30323a;
                border: 1px solid rgba(255,255,255,.76); border-radius: 18px;
                box-shadow: 0 14px 42px rgba(35,25,40,.18);
                backdrop-filter: blur(20px) saturate(1.35);
                -webkit-backdrop-filter: blur(20px) saturate(1.35);
                padding: 42px 12px 12px; z-index: 10002; display: none; overflow: hidden;
                box-sizing: border-box; flex-direction: column;
                max-height: calc(100vh - 16px);
                animation: bvh-panel-in .32s cubic-bezier(.2,1.2,.35,1) both;
            }
            #bvh-history-panel:before {
                content: "本地观看历史"; position: absolute; left: 15px; top: 13px;
                color: #e95f89; font-size: 13px; font-weight: 700; letter-spacing: .2px;
            }
            #bvh-history-close {
                position: absolute; top: 9px; right: 10px; width: 25px; height: 25px;
                border: 0; border-radius: 50%; background: rgba(251,114,153,.14);
                color: #d94f7b; font-size: 15px; line-height: 1; cursor: pointer;
                transition: background .2s ease, transform .28s cubic-bezier(.2,1.4,.4,1);
            }
            #bvh-history-close:hover { background: rgba(251,114,153,.28); transform: rotate(90deg) scale(1.08); }
            @keyframes bvh-panel-in {
                from { opacity: 0; transform: translateY(9px) scale(.985); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }

            .bvh-search-row { position: relative; display: flex; align-items: center; gap: 6px; width: 100%; margin-bottom: 8px; flex: 0 0 auto; }
            #bvh-history-search, #bvh-hp-search {
                flex: 1 1 auto; min-width: 0; width: 0; box-sizing: border-box; padding: 9px 11px; margin-bottom: 0;
                border: 1px solid rgba(225,220,228,.85); border-radius: 11px; outline: none;
                background: rgba(255,255,255,.68); color: #30323a;
                transition: border-color .2s, box-shadow .2s;
            }
            #bvh-history-search:focus, #bvh-hp-search:focus {
                border-color: #fb7299; box-shadow: 0 0 0 3px rgba(251,114,153,.12);
            }
            .bvh-search-help-btn { flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border: 1px solid #fb7299; border-radius: 50%; background: rgba(251,114,153,.12); color: #d94f7b; font-weight: 700; cursor: pointer; }
            .bvh-search-help { position: absolute; z-index: 10020; top: calc(100% + 4px); right: 0; width: min(360px, calc(100vw - 48px)); padding: 10px 12px; border: 1px solid rgba(225,220,228,.95); border-radius: 10px; background: #fff; color: #30323a; box-shadow: 0 8px 24px rgba(35,25,40,.18); font-size: 12px; line-height: 1.65; white-space: normal; user-select: text; }

            #bvh-history-list, #bvh-hp-list {
                overflow-y: auto; border: 1px solid rgba(235,228,235,.8);
                border-radius: 12px; padding: 5px; background: rgba(255,255,255,.38);
                list-style: none; margin: 0;
            }
            #bvh-history-list { flex: 1 1 auto; min-height: 0; height: auto; }

            .bvh-history-loading {
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                gap: 9px; min-height: 112px; padding: 18px 12px; color: #777; list-style: none;
                text-align: center; font-size: 13px;
            }
            .bvh-history-loading small { color: #999; font-size: 11px; }
            .bvh-history-loading-inline { flex-direction: row; justify-content: flex-start; min-height: 0; padding: 8px 10px; font-size: 12px; color: #999; }
            .bvh-history-loading-inline .bvh-loading-spinner { width: 13px; height: 13px; border-width: 2px; }
            .bvh-loading-spinner {
                width: 22px; height: 22px; border: 2px solid rgba(251,114,153,.22);
                border-top-color: #fb7299; border-right-color: #fb7299; border-radius: 50%;
                animation: bvh-loading-spin .78s linear infinite;
            }
            @keyframes bvh-loading-spin { to { transform: rotate(360deg); } }

            .bvh-record-context-menu {
                position: fixed; z-index: 2147483647; min-width: 188px; padding: 7px;
                box-sizing: border-box; border: 1px solid rgba(255,255,255,.78);
                border-radius: 14px; color: #30323a; background: rgba(255,255,255,.84);
                box-shadow: 0 12px 34px rgba(35,25,40,.2), inset 0 1px 0 rgba(255,255,255,.85);
                backdrop-filter: blur(18px) saturate(1.35);
                -webkit-backdrop-filter: blur(18px) saturate(1.35);
                animation: bvh-panel-in .16s cubic-bezier(.2,1.2,.35,1) both;
            }
            .bvh-record-context-title {
                padding: 5px 9px 7px; margin-bottom: 4px; color: #e95f89;
                font-size: 12px; font-weight: 700; border-bottom: 1px solid rgba(235,228,235,.8);
            }
            .bvh-record-context-action {
                display: block; width: 100%; padding: 9px 10px; border: 1px solid transparent;
                border-radius: 9px; text-align: left; font-size: 13px; color: #3a3940;
                background: transparent; cursor: pointer;
                transition: background .18s ease, border-color .18s ease, transform .18s ease;
            }
            .bvh-record-context-action:hover {
                background: rgba(255,240,245,.95); border-color: rgba(255,194,210,.8); transform: translateX(2px);
            }
            .bvh-record-context-action.is-danger { color: #d94f68; }
            .bvh-record-context-action.is-danger:hover {
                background: rgba(255,235,238,.95); border-color: rgba(244,170,180,.75);
            }
            .bvh-record-dialog-overlay {
                position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: flex-start;
                justify-content: center; padding: 20px; box-sizing: border-box;
                overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
                background: rgba(35,25,40,.22); backdrop-filter: blur(5px);
                -webkit-backdrop-filter: blur(5px); animation: bvh-record-fade-in .16s ease both;
            }
            .bvh-record-dialog {
                width: min(360px, calc(100vw - 36px)); box-sizing: border-box; padding: 20px;
                border: 1px solid rgba(255,255,255,.82); border-radius: 18px;
                color: #30323a; background: rgba(255,255,255,.92);
                box-shadow: 0 18px 55px rgba(35,25,40,.24), inset 0 1px 0 rgba(255,255,255,.9);
                margin: auto 0; flex-shrink: 0;
                backdrop-filter: blur(22px) saturate(1.35); -webkit-backdrop-filter: blur(22px) saturate(1.35);
                animation: bvh-record-dialog-in .22s cubic-bezier(.2,1.2,.35,1) both;
            }
            .bvh-record-dialog-title { color: #e95f89; font-size: 16px; font-weight: 700; }
            .bvh-record-dialog-desc { margin: 8px 0 16px; color: #77727b; font-size: 12px; line-height: 1.6; }
            .bvh-record-count-label { display: block; margin-bottom: 7px; color: #514b55; font-size: 12px; }
            .bvh-record-count-input {
                display: block; width: 100%; box-sizing: border-box; padding: 10px 12px;
                border: 1px solid #e8dce3; border-radius: 10px; outline: none;
                color: #30323a; background: rgba(255,255,255,.8); font-size: 15px;
                transition: border-color .18s ease, box-shadow .18s ease;
            }
            .bvh-record-count-input:focus { border-color: #fb7299; box-shadow: 0 0 0 3px rgba(251,114,153,.14); }
            .bvh-record-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
            .bvh-record-dialog-btn {
                padding: 8px 15px; border: 1px solid #e8dce3; border-radius: 10px;
                color: #625b65; background: rgba(255,255,255,.7); font-size: 13px; cursor: pointer;
                transition: background .18s ease, transform .18s ease;
            }
            .bvh-record-dialog-btn:hover { background: #fff0f5; transform: translateY(-1px); }
            .bvh-record-dialog-btn.is-primary { border-color: #fb7299; color: #fff; background: #fb7299; }
            .bvh-record-dialog-btn.is-primary:hover { background: #ed648c; }
            @keyframes bvh-record-fade-in { from { opacity: 0; } to { opacity: 1; } }
            @keyframes bvh-record-dialog-in { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

            .bvh-history-item {
                font-size: 12px; padding: 7px 5px; border-radius: 10px;
                line-height: 1.5; cursor: pointer; list-style: none;
                transition: background-color .24s ease, box-shadow .28s ease, transform .28s cubic-bezier(.2,.75,.25,1), border-color .24s ease;
            }
            .bvh-history-item:not(.bvh-history-group-item):hover { background: rgba(245,242,246,.72); }
            .bvh-history-group-item {
                position: relative; padding: 0; margin: 0 1px 9px; overflow: hidden;
                border: 1px solid rgba(224,216,227,.82); border-radius: 12px;
                background: rgba(255,255,255,.84);
                box-shadow: 0 2px 5px rgba(52,39,58,.045), 0 1px 0 rgba(255,255,255,.9) inset;
                transform: translateY(0);
            }
            .bvh-history-group-item:hover {
                background: rgba(255,255,255,.98); border-color: rgba(214,198,215,.95);
                box-shadow: 0 7px 16px rgba(52,39,58,.09), 0 2px 4px rgba(52,39,58,.035);
                transform: translateY(-2px); z-index: 1;
            }
            .bvh-group-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 11px 8px; cursor: pointer; transition: background-color .22s ease; }
            .bvh-group-head:hover { background: rgba(251,239,249,.72); }
            .bvh-group-main { min-width: 0; flex: 1 1 auto; }
            .bvh-group-title-line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
            .bvh-group-title { font-size: 12px; font-weight: 650; color: #393640; line-height: 1.55; overflow-wrap: anywhere; transition: color .2s ease; }
            .bvh-group-head:hover .bvh-group-title { color: #b44f83; }
            .bvh-group-latest { margin-top: 6px; color: #88818d; font-size: 11px; line-height: 1.65; overflow-wrap: anywhere; }
            .bvh-group-toggle { flex: 0 0 auto; border: 1px solid rgba(220,211,223,.9); border-radius: 8px; padding: 5px 8px; background: rgba(247,244,249,.9); color: #766a7c; font-size: 11px; cursor: pointer; transition: background .22s ease, border-color .22s ease, transform .22s ease; }
            .bvh-group-toggle:hover { background: #f0eaf3; border-color: #d6c8dc; transform: translateY(-1px); }
            .bvh-group-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
            .bvh-part-label { display: inline-flex; align-items: center; padding: 2px 7px; border: 1px solid rgba(220,207,223,.9); border-radius: 6px; background: rgba(247,242,249,.95); color: #806d88; font-size: 10px; line-height: 1.45; white-space: nowrap; }
            .bvh-group-children { padding: 0 10px 10px 15px; }
            .bvh-group-children[hidden] { display: none !important; }
            .bvh-small-collection-box {
                margin: 10px 0 8px; overflow: hidden; border: 1px solid rgba(220,207,230,.92);
                border-left: 3px solid #c28fce; border-radius: 10px; background: rgba(248,243,251,.76);
                box-shadow: 0 1px 3px rgba(66,42,75,.035);
                transition: background-color .24s ease, border-color .24s ease, box-shadow .28s ease, transform .28s cubic-bezier(.2,.75,.25,1);
            }
            .bvh-small-collection-box:hover { background: rgba(252,247,255,.98); border-color: rgba(194,143,206,.78); border-left-color: #a965bd; box-shadow: 0 5px 13px rgba(101,62,115,.10); transform: translateY(-1px); }
            .bvh-small-collection-head { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 6px 9px; cursor: pointer; user-select: none; transition: background-color .2s ease, color .2s ease; }
            .bvh-small-collection-head:hover { background: rgba(229,207,239,.42); }
            .bvh-small-collection-mark { flex: 0 0 7px; width: 7px; height: 7px; border-radius: 2px; background: #bd7dce; box-shadow: 0 0 0 3px rgba(189,125,206,.12); }
            .bvh-small-collection-name { min-width: 0; flex: 1 1 auto; color: #63466f; font-size: 11px; font-weight: 700; line-height: 1.5; overflow-wrap: anywhere; }
            .bvh-small-collection-count { flex: 0 0 auto; color: #9b83a5; font-size: 10px; white-space: nowrap; }
            .bvh-small-collection-chevron { flex: 0 0 auto; color: #a27caf; font-size: 14px; transition: transform .22s ease; }
            .bvh-small-collection-box.is-collapsed .bvh-small-collection-chevron { transform: rotate(-90deg); }
            .bvh-small-collection-body { padding: 0 7px 6px 9px; }
            .bvh-small-collection-box.is-collapsed .bvh-small-collection-body { display: none; }
            .bvh-part-row {
                padding: 6px 8px 6px 9px; margin-top: 4px; border: 1px solid transparent;
                border-left: 2px solid rgba(196,177,207,.58); border-radius: 7px;
                background: rgba(255,255,255,.56); cursor: pointer;
                transition: background-color .2s ease, border-color .2s ease, box-shadow .22s ease, transform .22s cubic-bezier(.2,.75,.25,1);
            }
            .bvh-part-row:hover { background: #fff; border-color: rgba(220,185,231,.92); border-left-color: #bd79ce; box-shadow: 0 3px 9px rgba(91,56,104,.085); transform: translateX(2px) scale(1.003); }
            .bvh-part-row.is-detail-open { background: rgba(255,255,255,.96); border-color: rgba(220,185,231,.8); }
            .bvh-part-main-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
            .bvh-part-title { min-width: 0; flex: 1 1 auto; color: #393640; font-size: 11px; font-weight: 550; line-height: 1.55; overflow-wrap: anywhere; }
            .bvh-part-row:hover .bvh-part-title { color: #a54ebd; }
            .bvh-part-detail-toggle { flex: 0 0 auto; padding: 2px 5px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: #9b8ba2; font-size: 10px; cursor: pointer; transition: background .18s ease, color .18s ease, border-color .18s ease; }
            .bvh-part-detail-toggle:hover { color: #a54ebd; border-color: #e7c9ef; background: #fbf1ff; }
            .bvh-part-quick-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin: 3px 0 0 28px; color: #928896; font-size: 10px; line-height: 1.5; }
            .bvh-part-quick-meta strong { color: #74617d; font-weight: 650; }
            .bvh-part-quick-time { min-width: 0; overflow-wrap: anywhere; }
            .bvh-part-details { margin: 7px 0 2px 28px; padding: 6px 8px; border-top: 1px solid rgba(226,210,233,.8); border-radius: 0 0 5px 5px; background: rgba(248,242,251,.52); cursor: default; }
            .bvh-part-details[hidden] { display: none !important; }
            .bvh-part-detail-line { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; color: #8f8394; font-size: 10px; line-height: 1.6; }
            .bvh-part-snapshots { margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(228,220,232,.85); font-size: 10px; line-height: 1.55; }
            .bvh-part-section-title { margin-bottom: 6px; color: #8c8191; font-size: 10px; letter-spacing: .04em; }
            .bvh-snapshot-item { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; padding: 4px 0; color: #766d7b; }
            .bvh-snapshot-item + .bvh-snapshot-item { border-top: 1px dashed rgba(226,218,230,.72); }
            .bvh-snapshot-time { min-width: 0; flex: 1 1 130px; overflow-wrap: anywhere; }
            .bvh-snapshot-progress { flex: 0 0 auto; color: #8b7b94; }
            .bvh-snapshot-empty { color: #aaa2ad; padding: 3px 0; }
            .bvh-history-header {
                font-weight: bold; color: #fb7299; background: #fef4f7;
                border-radius: 9px; padding: 7px 6px; list-style: none;
            }
            .bvh-history-header-green { color: #27ae60; background: #f0f9f3; }
            .bvh-history-divider {
                height: 2px; background: #f1f1f1; margin: 8px 4px;
                border-radius: 2px; pointer-events: none; list-style: none;
            }

            .bvh-exp-mark { color: #f56c6c; }
            .bvh-count-mark { color: #27ae60; font-weight: bold; }
            .bvh-warn-text { color: #e67e22; font-weight: bold; }

            #bvh-history-page-entry { position: fixed; left: 24px; bottom: 24px; z-index: 9999; }
            /* 历史页入口卡片只增加高度，不开放尺寸拖拽，保持与视频页相同的收起/展开逻辑。 */
            #bvh-history-page-entry #bvh-status-float {
                min-height: 66px; padding-top: 17px; padding-bottom: 17px;
                display: flex; flex-direction: column; justify-content: center;
            }
            #bvh-history-page-panel {
                position: fixed; left: 24px; bottom: 92px;
                width: 480px; height: 440px; resize: both; min-width: 320px; min-height: 240px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); border-radius: 20px;
                background: rgba(255,255,255,.78); color: #30323a;
                box-shadow: 0 18px 48px rgba(35,25,40,.18), inset 0 1px 0 rgba(255,255,255,.8);
                backdrop-filter: blur(22px) saturate(1.35);
                -webkit-backdrop-filter: blur(22px) saturate(1.35);
                z-index: 9998; display: none; overflow: hidden; box-sizing: border-box;
                border: 1px solid rgba(255,255,255,.78);
                transition: opacity .32s ease, transform .52s cubic-bezier(.22,1,.36,1);
            }
            #bvh-history-page-panel.bvh-hp-show {
                display: block; animation: bvh-panel-in .38s cubic-bezier(.22,1,.36,1) both;
            }
            /* 调整尺寸时暂停昂贵的毛玻璃与子树绘制；半透明遮罩只负责遮住内容，不再执行 backdrop-filter。 */
            #bvh-history-panel.bvh-resizing,
            #bvh-history-page-panel.bvh-resizing {
                transition: none !important;
                animation: none !important;
                backdrop-filter: none !important;
                -webkit-backdrop-filter: none !important;
                box-shadow: none !important;
                background: rgba(245,240,245,.96) !important;
                contain: strict !important;
                isolation: isolate !important;
            }
            /* 拖动搜索面板时临时切换为轻量预览：不让超长结果列表和毛玻璃每帧重绘；松手后完整恢复。 */
            #bvh-history-panel.bvh-dragging,
            #bvh-history-page-panel.bvh-dragging {
                transition: none !important;
                animation: none !important;
                backdrop-filter: none !important;
                -webkit-backdrop-filter: none !important;
                box-shadow: 0 8px 24px rgba(35,25,40,.14) !important;
                background: rgba(245,240,245,.94) !important;
                contain: strict !important;
                isolation: isolate !important;
                will-change: left, top;
            }
            #bvh-history-panel.bvh-dragging > *,
            #bvh-history-page-panel.bvh-dragging > * { visibility: hidden !important; }
            #bvh-history-panel.bvh-dragging::before,
            #bvh-history-page-panel.bvh-dragging::before {
                content: "移动搜索卡片";
                position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
                color: #d94f7b; font-size: 13px; font-weight: 600; pointer-events: none;
            }
            /* 调整期间直接移除列表与控件子树，避免超长列表继续参与每一帧布局；结束后自动恢复。 */
            #bvh-history-panel.bvh-resizing > *,
            #bvh-history-page-panel.bvh-resizing > * { display: none !important; }
            .bvh-resize-handle {
                position: absolute; right: 2px; bottom: 2px; z-index: 2147483001;
                width: 18px; height: 18px; cursor: nwse-resize; touch-action: none;
                border-radius: 4px 0 12px 0;
                background: linear-gradient(135deg, transparent 0 42%, rgba(190,130,155,.55) 43% 49%, transparent 50% 61%, rgba(190,130,155,.72) 62% 68%, transparent 69%);
            }
            .bvh-resizing > .bvh-resize-handle { display: block !important; }
            #bvh-history-panel.bvh-resizing > .bvh-resize-handle,
            #bvh-history-page-panel.bvh-resizing > .bvh-resize-handle { display: block !important; }
            #bvh-history-panel.bvh-resizing::before { content: "正在调整大小…"; position:absolute; left:14px; top:13px; color:#e95f89; font-size:13px; font-weight:700; }
            #bvh-history-panel.bvh-resizing::after,
            #bvh-history-page-panel.bvh-resizing::after {
                content: ""; position: absolute; inset: 0; z-index: 2147483000;
                border-radius: inherit; pointer-events: none;
                background: rgba(245,240,245,.08);
                backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
            }
            #bvh-hp-drag-bar {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 14px;
                background: linear-gradient(135deg, rgba(251,114,153,.94) 0%, rgba(255,158,187,.88) 100%);
                color: #fff; border-radius: 18px 18px 0 0; font-size: 13px; font-weight: 600;
                cursor: grab; user-select: none;
            }
            #bvh-hp-drag-bar:active { cursor: grabbing; }
            #bvh-hp-close-btn {
                background: rgba(255,255,255,.28); color: #fff; border: none;
                width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
                font-size: 12px; line-height: 1;
            }
            #bvh-hp-close-btn:hover { background: rgba(255,255,255,.48); }
            #bvh-hp-inner {
                padding: 12px; height: calc(100% - 44px); box-sizing: border-box;
                display: flex; flex-direction: column; gap: 10px;
            }
            #bvh-hp-storage { margin: 0; padding-bottom: 5px; font-size: 11px; }
            .bvh-hp-actions { display: flex; gap: 8px; }
            .bvh-hp-actions button {
                flex: 1; padding: 6px; border: 1px solid rgba(225,220,228,.8);
                border-radius: 11px; background: rgba(255,255,255,.64); color: #3a3940;
                transition: transform .22s ease, background .22s ease, border-color .22s ease;
                font-size: 11px; cursor: pointer;
            }
            .bvh-hp-actions button:hover {
                background: rgba(255,240,245,.9); border-color: #ffc2d2; transform: translateY(-1px);
            }
            #bvh-hp-list { flex: 1; }
            #bvh-history-list.bvh-list-rendering,
            #bvh-hp-list.bvh-list-rendering {
                position: relative;
            }
            #bvh-history-list.bvh-list-rendering::before,
            #bvh-hp-list.bvh-list-rendering::before {
                content: "";
                position: absolute;
                inset: 0;
                z-index: 2;
                border-radius: 12px;
                background: rgba(255,255,255,.82);
                pointer-events: none; touch-action: pan-y;
            }
        `);
    }

    // 播放页浮窗内容：existingFloat 分支和新建分支共用同一份 HTML 生成
    // 【模块：构建播放页悬浮窗内容】
    // 根据传入的历史信息生成悬浮窗的展示结构，包括记录状态和可供用户操作的内容。
    // 这里负责生成界面，不单独决定记录是否存在；记录判断应由统一的解析/读取逻辑提供。
    function buildPlaybackFloatHtml(history) {
        const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
        const snapshots = Array.isArray(history.snapshots) ? history.snapshots : [];
        const latest = snapshots.reduce((best, snap) => !best || Number(snap.ts || 0) > Number(best.ts || 0) ? snap : best, null);
        const lastWatchDate = latest?.watchTimeStr || '无记录';
        const mediaType = String(history.mediaType || '').trim();
        const collectionTitle = String(history.collectionTitle || '').trim();
        const partTitle = String(history.partTitle || history.title || '').trim();
        const partNumber = Number(history.partNumber || history.p) || 0;
        const contextTitle = collectionTitle && collectionTitle !== partTitle ? collectionTitle : '';
        const detailTitle = partTitle || (partNumber ? `第${partNumber}集` : '当前分集');
        return `
            ${mediaType ? `<div style="font-size:11px; color:#8b6f82;">${escapeHtml(mediaType)}</div>` : ''}
            ${contextTitle ? `<div style="font-size:12px; color:#666;">${escapeHtml(contextTitle)}</div>` : ''}
            <div style="font-size:12px; color:#555;">${escapeHtml(detailTitle)}</div>
            <div style="font-weight:bold; color:#fb7299;">上次进度: ${escapeHtml(history.lastProgress || '0%')}</div>
            <div style="font-size:12px; color:#27ae60;">观看次数: ${Number(history.watchCount) || 0}</div>
            <div style="font-size:12px; color:#666;">UP：${escapeHtml(history.authorName || '作者未知')}</div>
            <div style="font-size:12px; color:#666;">上次观看：${escapeHtml(lastWatchDate)}</div>
        `;
    }

    // 根据当前真实播放地址解析悬浮窗记录。番剧必须以 ep 为单集身份，不能把 ss 的第 1 个 part 当成当前集。
    // 【模块：解析当前播放视频对应的本地历史】
    // 根据当前 URL 解析结果，从统一存储中找到普通视频、合集分集或番剧分集的正确记录。
    // 重点是让悬浮窗读取身份与写入身份保持一致，避免因 ep/ss、BV 分 P 或合集键格式不同而误报无记录。
    function resolvePlaybackHistory(parsed) {
        if (!parsed) return null;
        const p = Math.max(1, Number(parsed.p) || 1);
        const asPlaybackRecord = (part, container = null) => {
            if (!part) return null;
            return {
                ...part,
                key: part.bv || part.key || '',
                title: part.title || part.partTitle || (Number(part.p) > 0 ? `第${Number(part.p)}集` : container?.title || ''),
                partTitle: part.title || part.partTitle || (Number(part.p) > 0 ? `第${Number(part.p)}集` : ''),
                partNumber: Number(part.p || part.partNumber || 0) || 0,
                collectionTitle: part.collectionTitle || container?.title || '',
                collectionKey: part.collectionKey || container?.collectionKey || '',
                authorName: part.authorName || container?.authorName || '',
                mediaType: part.mediaType || container?.mediaType || '视频'
            };
        };

        // ss 地址本身只代表整季，无法确定正在看的哪一集。
        // 只有选集面板明确标出当前集时，才从该集 ep 地址读取记录；并排除“预告”等其他面板。
        if (parsed.type === 'bangumi' && RecordKey.isSeasonKey(parsed.key)) {
            const panels = Array.from(document.querySelectorAll('.SectionPanel_panel__rImmk'));
            for (const panel of panels) {
                const heading = String(panel.querySelector('.SectionHeader_titleWrap__n0F38 h3')?.textContent || '').trim();
                if (/预告|预览|预热视频|PV/i.test(heading)) continue;
                const active = panel.querySelector(
                    '.EpisodeVirtualList_activeNumber__Sm49O, .EpisodeVirtualList_numberItem__GLWgO[aria-current="page"], .EpisodeVirtualList_listItem__QZXPZ[aria-current="page"], .EpisodeVirtualList_numberItem__GLWgO.active, .EpisodeVirtualList_listItem__QZXPZ.active'
                );
                const activeLink = active?.matches?.('a[href*="/bangumi/play/ep"]')
                    ? active
                    : active?.closest?.('a[href*="/bangumi/play/ep"]') || active?.querySelector?.('a[href*="/bangumi/play/ep"]');
                const epMatch = String(activeLink?.getAttribute('href') || '').match(/\/bangumi\/play\/(ep\d+)/i);
                if (epMatch) {
                    const epKey = epMatch[1].toLowerCase();
                    return resolvePlaybackHistory({ ...parsed, key: epKey, bvid: epKey, isEpisode: true, isSeason: false });
                }
            }
            // 没有明确的当前集时不显示 ss 的浮窗，避免误把第一集记录显示成当前记录。
            return null;
        }

        const direct = RecordNormalizer.normalize(GM_getValue(parsed.key, null));
        if (parsed.type === 'bangumi' && RecordKey.isEpisodeKey(parsed.key)) {
            const wantedEp = String(parsed.key).trim().toLowerCase();

            // 悬浮窗必须实时读取当前 ep 的精确身份；不能在渲染阶段调用会按 p 回填并改写存储的 readSyncRecord。
            let exactStored = null;
            try { exactStored = RecordStore.readEpisodeExact(wantedEp); } catch (_) {}
            if (exactStored?.flat) {
                return asPlaybackRecord({
                    ...exactStored.flat,
                    key: wantedEp,
                    title: exactStored.flat.title || exactStored.part?.title || '',
                    collectionTitle: exactStored.container?.title || exactStored.container?.collectionTitle || '',
                    collectionKey: exactStored.container?.collectionKey || exactStored.flat.collectionKey || exactStored.seasonKey || ''
                }, exactStored.container || null);
            }

            // 兼容仅保存在 ep 顶层键中的旧扁平记录，不把 ss 或 p 序号猜成当前 ep。
            if (direct && direct.type !== 'collection' && (
                Number(direct.watchCount) > 0 || Number(direct.lastTs) > 0 ||
                (Array.isArray(direct.snapshots) && direct.snapshots.length > 0) ||
                direct.officialHistorySeen === true || direct.hasReachedWatchThreshold === true
            )) {
                return asPlaybackRecord({ ...direct, key: wantedEp });
            }
            return null;
        }
        if (direct && direct.type === 'collection') {
            const exact = direct.parts.find(part => Number(part.p) === p);
            if (exact) return asPlaybackRecord(exact, direct);
        } else if (direct) {
            return direct;
        }

        if (parsed.type === 'video' && parsed.bvid) {
            const base = RecordNormalizer.normalize(GM_getValue(parsed.bvid, null));
            if (base && base.type === 'collection') {
                const exact = base.parts.find(part => Number(part.p) === p && (!part.bv || String(part.bv).split('?')[0].toUpperCase() === parsed.bvid.toUpperCase()));
                if (exact) return asPlaybackRecord(exact, base);
            }

            // 跨BV合集的存储键可能是标题或合集标识，不能用 BV 正则反推出容器键。
            // 逐个检查容器的真实分集元数据，先匹配 BV+p，再在该 BV 只有一项时降级匹配 BV。
            for (const key of GM_listValues()) {
                if (!RecordKey.isRecordKey(key) || key === parsed.bvid) continue;
                const rec = RecordNormalizer.normalize(GM_getValue(key, null));
                if (!rec || rec.type !== 'collection') continue;
                const matching = rec.parts.filter(part => String(part.bv || '').trim().split('?')[0].toUpperCase() === String(parsed.bvid).toUpperCase());
                const exact = matching.find(part => Number(part.p) === p);
                if (exact) return asPlaybackRecord(exact, rec);
                if (matching.length === 1) return asPlaybackRecord(matching[0], rec);
            }
        }
        return null;
    }

    // 根据视口和锚点位置自动安排播放页历史面板；空间不足时压缩面板高度，由列表内部滚动。
    function autoPositionPlaybackPanel(panel, anchor) {
        if (!panel?.isConnected || panel.style.display === 'none' || !panel.style.display) return;
        // 用户拖动或调整过尺寸后保留用户位置，避免列表 MutationObserver/浮窗 ResizeObserver 再把面板推回左侧。
        if (panel.dataset.bvhUserPositioned === 'true') return;
        const margin = 8;
        const gap = 12;
        const viewportW = Math.max(1, window.innerWidth);
        const viewportH = Math.max(1, window.innerHeight);
        const maxWidth = Math.max(220, Math.min(480, viewportW - margin * 2));
        const desiredHeight = Math.max(160, Math.min(460, viewportH - margin * 2));
        const anchorRect = anchor?.getBoundingClientRect();
        const candidates = [];

        // 左右位置可使用完整视口高度；上下位置受锚点与视口边缘之间的实际空间限制。
        if (anchorRect) {
            const rightSpace = viewportW - margin - (anchorRect.right + gap);
            const leftSpace = anchorRect.left - gap - margin;
            const aboveSpace = anchorRect.top - gap - margin;
            const belowSpace = viewportH - margin - (anchorRect.bottom + gap);
            if (rightSpace >= 220) candidates.push({ side: 'right', left: anchorRect.right + gap, top: margin, width: Math.min(maxWidth, rightSpace), maxHeight: viewportH - margin * 2, availableArea: rightSpace * (viewportH - margin * 2) });
            if (leftSpace >= 220) candidates.push({ side: 'left', left: anchorRect.left - gap - Math.min(maxWidth, leftSpace), top: margin, width: Math.min(maxWidth, leftSpace), maxHeight: viewportH - margin * 2, availableArea: leftSpace * (viewportH - margin * 2) });
            if (aboveSpace >= 160) candidates.push({ side: 'above', left: anchorRect.left, top: margin, width: maxWidth, maxHeight: aboveSpace, availableArea: maxWidth * aboveSpace });
            if (belowSpace >= 160) candidates.push({ side: 'below', left: anchorRect.left, top: anchorRect.bottom + gap, width: maxWidth, maxHeight: belowSpace, availableArea: maxWidth * belowSpace });
        }

        // 锚点周围没有足够空间时，回退到视口四角，避免面板被固定在狭小缝隙里。
        candidates.push(
            { side: 'top-left', left: margin, top: margin, width: maxWidth, maxHeight: viewportH - margin * 2, availableArea: maxWidth * (viewportH - margin * 2) },
            { side: 'top-right', left: viewportW - maxWidth - margin, top: margin, width: maxWidth, maxHeight: viewportH - margin * 2, availableArea: maxWidth * (viewportH - margin * 2) },
            { side: 'bottom-left', left: margin, top: viewportH - desiredHeight - margin, width: maxWidth, maxHeight: viewportH - margin * 2, availableArea: maxWidth * (viewportH - margin * 2) },
            { side: 'bottom-right', left: viewportW - maxWidth - margin, top: viewportH - desiredHeight - margin, width: maxWidth, maxHeight: viewportH - margin * 2, availableArea: maxWidth * (viewportH - margin * 2) }
        );

        const scoreCandidate = candidate => {
            const width = Math.max(220, Math.min(maxWidth, candidate.width));
            const availableHeight = Math.max(120, Math.min(viewportH - margin * 2, candidate.maxHeight));
            const height = Math.min(desiredHeight, availableHeight);
            const left = Math.max(margin, Math.min(viewportW - width - margin, candidate.left));
            const top = Math.max(margin, Math.min(viewportH - height - margin, candidate.top));
            const overlap = anchorRect
                ? Math.max(0, Math.min(left + width, anchorRect.right) - Math.max(left, anchorRect.left))
                    * Math.max(0, Math.min(top + height, anchorRect.bottom) - Math.max(top, anchorRect.top))
                : 0;
            const fitsDesiredHeight = availableHeight >= desiredHeight;
            const fitsDesiredWidth = width >= maxWidth - 1;
            const clipped = Math.max(0, desiredHeight - height);
            const score = (fitsDesiredHeight ? 1000000 : 0)
                + (fitsDesiredWidth ? 100000 : width * 100)
                + height * width
                - overlap * 20
                - clipped * 1000;
            return { ...candidate, left, top, width, height, maxHeight: availableHeight, overlap, score };
        };
        const best = candidates.map(scoreCandidate).sort((a, b) => b.score - a.score)[0];
        if (!best) return;

        // 列表承担滚动，外层面板按候选位置的可用高度收缩；下次内容/视口变化时再重新计算。
        panel.style.width = `${best.width}px`;
        panel.style.height = `${best.height}px`;
        panel.style.maxHeight = `${best.maxHeight}px`;
        panel.style.left = `${best.left}px`;
        panel.style.top = `${best.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transition = 'left .32s cubic-bezier(.22,1,.36,1), top .32s cubic-bezier(.22,1,.36,1), width .25s ease, height .25s ease, max-height .25s ease';
    }

    // ── 播放页 UI：左下角悬浮窗（单击续播 / 右键菜单 / 历史面板） ──
    // 【模块：播放页面悬浮窗 UI】
    // 负责在播放页面初始化、更新和显示历史悬浮窗，并把当前视频的历史查询结果交给内容构建函数。
    // UI 的显示状态与数据是否存在必须分开判断，不能用某次 DOM 文本状态替代存储查询结果。
    const PlaybackUI = {
        // 创建或更新播放页浮窗和相关菜单、历史面板，并绑定操作事件。
        render() {
            if (!window.location.href.includes('/video/') && !window.location.href.includes('/bangumi/play/')) return;
            const parsed = RecordKey.parse(window.location.href);
            if (!parsed) return;
            const key = parsed.key;

            // 历史读取与 UI 创建解耦：旧数据读取异常时也必须先保留悬浮窗入口，不能让 render 整体中断。
            let history = null;
            try {
                history = resolvePlaybackHistory(parsed);
            } catch (error) {
                console.warn(`${TAG} [播放悬浮窗] 读取历史失败，先显示悬浮窗入口：${key}`, error);
            }

            const existingFloat = document.getElementById('bvh-status-float');
            if (existingFloat) {
                existingFloat.dataset.recordKey = key;
                existingFloat.dataset.hasRecord = history ? 'true' : 'false';
                existingFloat.innerHTML = history
                    ? buildPlaybackFloatHtml(history)
                    : `
                        <div style="font-weight:bold; color:#fb7299;">当前视频暂无本地记录</div>
                        <div style="font-size:12px; color:#666;">${key}</div>
                    `;
                requestAnimationFrame(() => autoPositionPlaybackPanel(
                    document.getElementById('bvh-history-panel'), existingFloat
                ));
                return;
            }

            const menuPanel = document.createElement('div');
            menuPanel.id = 'bvh-menu-panel';
            const usedByte = ByteTool.calcStorageSize();
            const usedStr = ByteTool.format(usedByte);
            const freeStr = ByteTool.format(CONFIG.STORAGE_MAX_BYTE - usedByte);
            const recordCount = ByteTool._cache.recordCount;
            const warnHtml = usedByte > CONFIG.STORAGE_WARN_THRESHOLD ? `<div class="bvh-warn-text">⚠️ 存储快满</div>` : '';
            menuPanel.innerHTML = `
                <div class="bvh-storage-info">存储：已用 ${usedStr} / 剩余 ${freeStr} / 总条数 ${recordCount}</div>
                ${warnHtml}
                <button id="bvh-show-history">打开历史列表</button>
                <button id="bvh-export">导出全部JSON备份</button>
                <button id="bvh-export-csv">导出CSV表格</button>
                <button id="bvh-import">导入JSON备份</button>
                <button id="bvh-clean-expire">清理已备份过期记录（${CONFIG.EXPIRE_DAY}天）</button>
                <button id="bvh-del-current">删除本条(p)记录</button>
                <button id="bvh-del-all">清空全部记录</button>
            `;
            document.body.appendChild(menuPanel);

            const historyPanel = document.createElement('div');
            historyPanel.id = 'bvh-history-panel';
            historyPanel.innerHTML = `
                <button id="bvh-history-close" type="button" title="关闭历史记录" aria-label="关闭历史记录">×</button>
                <div class="bvh-search-row">
                    <input id="bvh-history-search" placeholder="搜索标题、作者、BV号或条件…" aria-label="搜索本地观看历史">
                    <button class="bvh-search-help-btn" type="button" aria-label="查看搜索规则" aria-expanded="false">!</button>
                    <div class="bvh-search-help" hidden>普通搜索：标题、作者、BV号、标签、分集等任意字段包含关键词即可；多个词用空格分开，全部满足才显示。次数>=3、总观看>=10、总次数>5、观看<5、count:!=2；也支持 合集观看>=20；进度>50、progress:<=80；时间可写 2024、2024-05、2024-05-01、05-01；快照:45%、snap:2024-05。条件之间用空格分隔。比较符支持 >、<、>=、<=、=、!=；不认识的写法会按普通关键词搜索。</div>
                </div>
                <ul id="bvh-history-list"></ul>
            `;
            document.body.appendChild(historyPanel);
            setupPersistentResize(historyPanel, 'BVH_PANEL_SIZE_PLAYBACK_V1', { minWidth: 300, minHeight: 220, maxWidth: 760, maxHeight: 900 });
            historyPanel.addEventListener('bvh-resize-start', () => {
                historyPanel.dataset.bvhUserPositioned = 'true';
            });
            historyPanel.addEventListener('bvh-resize-end', () => {
                historyPanel.dataset.bvhUserPositioned = 'true';
                requestAnimationFrame(() => {
                    if (historyPanel.dataset.bvhRefreshPending === 'true') {
                        delete historyPanel.dataset.bvhRefreshPending;
                        const list = historyPanel.querySelector('#bvh-history-list');
                        const search = historyPanel.querySelector('#bvh-history-search');
                        if (list) HistoryListRenderer.renderInto(list, search?.value || '', 'playback', { preserveScrollTop: list.scrollTop });
                    }
                });
            });

            // 搜索规则放在输入框旁边，点“!”展开说明；点击面板其他位置时不额外干扰搜索。
            const playbackSearch = historyPanel.querySelector('#bvh-history-search');
            playbackSearch.addEventListener('input', () => {
                HistoryListRenderer.renderInto(document.getElementById('bvh-history-list'), playbackSearch.value, 'playback');
                requestAnimationFrame(() => autoPositionPlaybackPanel(historyPanel, document.getElementById('bvh-status-float')));
            });
            historyPanel.querySelector('.bvh-search-help-btn').addEventListener('click', e => {
                const button = e.currentTarget;
                const help = historyPanel.querySelector('.bvh-search-help');
                help.hidden = !help.hidden;
                button.setAttribute('aria-expanded', String(!help.hidden));
            });

            historyPanel.querySelector('#bvh-history-close').addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                historyPanel.style.display = 'none';
                const floatBox = document.getElementById('bvh-status-float');
                if (floatBox) {
                    const menu = document.getElementById('bvh-menu-panel');
                    const menuOpen = !!(menu && menu.style.display && menu.style.display !== 'none');
                    floatBox.dataset.bvhPanelOpen = menuOpen ? 'true' : 'false';
                    if (menuOpen) floatBox._bvhCancelDock?.();
                    else floatBox._bvhResumeDock?.(900);
                }
            });

            // 播放页搜索窗口复用历史页的 makeDraggable：同样使用 easing=1 直接跟手、松手不补间。
            // 仍只允许拖动窗口顶部 38px 的空白区域，搜索框、按钮和结果列表不触发拖拽。
            let playbackPanelDragging = false;
            let playbackPanelLayoutTimer = null;
            const schedulePlaybackPanelLayout = () => {
                if (playbackPanelDragging) return;
                clearTimeout(playbackPanelLayoutTimer);
                playbackPanelLayoutTimer = setTimeout(() => {
                    if (!playbackPanelDragging) autoPositionPlaybackPanel(historyPanel, document.getElementById('bvh-status-float'));
                }, 80);
            };
            makeDraggable(historyPanel, historyPanel, {
                preventDefault: true,
                easing: 1,
                animateOnEnd: false,
                canStart: (e, el) => {
                    if (el.dataset.bvhResizeActive === 'true') return false;
                    if (e.target.closest('input, button, ul, li, a, textarea, select')) return false;
                    const rect = el.getBoundingClientRect();
                    return e.clientY <= rect.top + 38;
                },
                onStart: () => { playbackPanelDragging = true; },
                onEnd: didMove => {
                    playbackPanelDragging = false;
                    if (didMove) historyPanel.dataset.bvhUserPositioned = 'true';
                    historyPanel.style.transition = '';
                    schedulePlaybackPanelLayout();
                }
            });
            window.addEventListener('resize', schedulePlaybackPanelLayout);
            const playbackListObserver = new MutationObserver(schedulePlaybackPanelLayout);
            playbackListObserver.observe(historyPanel.querySelector('#bvh-history-list'), { childList: true, subtree: true });

            document.addEventListener('click', function globalClosePanels(e) {
                if (e.button === 2) return;
                const menu = document.getElementById('bvh-menu-panel');
                const hist = document.getElementById('bvh-history-panel');
                const floatBox = document.getElementById('bvh-status-float');
                if (!floatBox || !menu || !hist) return;
                if (floatBox.contains(e.target) || menu.contains(e.target) || hist.contains(e.target)) return;
                menu.style.display = 'none';
                hist.style.display = 'none';
                floatBox.dataset.bvhPanelOpen = 'false';
                floatBox._bvhResumeDock?.(900);
            });

            {
                // 悬浮窗始终创建；无记录时显示明确提示，避免首次打开 ep 页面时因为 history=null 而完全没有入口。
                const floatBox = document.createElement('div');
                floatBox.id = 'bvh-status-float';
                floatBox.dataset.hasRecord = history ? 'true' : 'false';
                floatBox.innerHTML = history
                    ? buildPlaybackFloatHtml(history)
                    : `<div style="font-weight:bold; color:#fb7299;">当前视频暂无本地记录</div><div style="font-size:12px; color:#666;">${key}</div>`;

                let isClick = false;
                let downX = 0, downY = 0;
                // 位移超过该阈值才算拖拽；轻微抖动不取消单击，避免点一下被误判成拖动而不续播。
                const DRAG_THRESHOLD = 4;
                floatBox.addEventListener('mousedown', e => {
                    if (e.button !== 0) return;
                    isClick = true;
                    downX = e.clientX;
                    downY = e.clientY;
                });
                floatBox.addEventListener('mousemove', e => {
                    if (!isClick) return;
                    if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_THRESHOLD) isClick = false;
                });
                floatBox.dataset.recordKey = key;
                floatBox.addEventListener('mouseup', e => {
                    if (e.button !== 0 || !isClick) return;
                    // 优先复用本次渲染已读到的记录。
                    let currentHistory = history;
                    if (!currentHistory) {
                        const current = RecordKey.parse(window.location.href);
                        currentHistory = current ? resolvePlaybackHistory(current) : null;
                    }
                    const video = document.querySelector('video');
                    const snaps = Array.isArray(currentHistory?.snapshots) ? currentHistory.snapshots : [];
                    const lastSnap = snaps.reduce((best, snap) => !best || Number(snap.ts || 0) > Number(best.ts || 0) ? snap : best, null);
                    if (video && lastSnap && lastSnap.pos != null && Number.isFinite(Number(lastSnap.pos))) {
                        video.currentTime = Number(lastSnap.pos);
                        video.play();
                    }
                });

                floatBox.oncontextmenu = e => {
                    e.preventDefault();
                    const panel = document.getElementById('bvh-menu-panel');
                    const hp = document.getElementById('bvh-history-panel');
                    const ub = ByteTool.calcStorageSize();
                    const us = ByteTool.format(ub);
                    const fs = ByteTool.format(CONFIG.STORAGE_MAX_BYTE - ub);
                    const recordCount = ByteTool._cache.recordCount;
                    const warn = ub > CONFIG.STORAGE_WARN_THRESHOLD ? `<div class="bvh-warn-text">⚠️ 存储快满</div>` : '';
                    panel.querySelector('.bvh-storage-info').innerText = `存储：已用 ${us} / 剩余 ${fs} / 总条数 ${recordCount}`;
                    panel.querySelector('.bvh-warn-text')?.remove();
                    if (warn) panel.insertAdjacentHTML('afterbegin', warn);
                    hp.style.display = 'none';
                    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
                    syncPlaybackDockLock();
                };

                document.body.appendChild(floatBox);
                if (typeof ResizeObserver === 'function') {
                    const playbackFloatResizeObserver = new ResizeObserver(() => {
                        requestAnimationFrame(() => autoPositionPlaybackPanel(
                            document.getElementById('bvh-history-panel'), floatBox
                        ));
                    });
                    playbackFloatResizeObserver.observe(floatBox);
                }
                makeDockableFloat(floatBox);
                floatBox.classList.remove('bvh-docked', 'bvh-docked-right');
                // 播放页入口也必须锁定停靠计时；此前只有历史页入口接入了这个状态，
                // 导致播放页的 mouseleave 定时器仍会在面板打开后改写入口位置。
                const syncPlaybackDockLock = () => {
                    const hp = document.getElementById('bvh-history-panel');
                    const menu = document.getElementById('bvh-menu-panel');
                    const opened = !!((hp && hp.style.display && hp.style.display !== 'none')
                        || (menu && menu.style.display && menu.style.display !== 'none'));
                    floatBox.dataset.bvhPanelOpen = opened ? 'true' : 'false';
                    if (opened) floatBox._bvhCancelDock?.();
                    else floatBox._bvhResumeDock?.(900);
                };

                document.getElementById('bvh-show-history').onclick = () => {
                    const hp = document.getElementById('bvh-history-panel');
                    const menu = document.getElementById('bvh-menu-panel');
                    menu.style.display = 'none';
                    hp.style.display = hp.style.display !== 'none' && hp.style.display ? 'none' : 'flex';
                    syncPlaybackDockLock();
                    if (hp.style.display !== 'none') {
                        autoPositionPlaybackPanel(hp, document.getElementById('bvh-status-float'));
                        requestAnimationFrame(() => autoPositionPlaybackPanel(hp, document.getElementById('bvh-status-float')));
                    }
                    HistoryListRenderer.renderInto(document.getElementById('bvh-history-list'), document.getElementById('bvh-history-search')?.value || '', 'playback');
                    if (hp.style.display !== 'none') requestAnimationFrame(() => autoPositionPlaybackPanel(hp, document.getElementById('bvh-status-float')));
                };
                document.getElementById('bvh-export').onclick = StorageApi.exportAllRecords;
                document.getElementById('bvh-export-csv').onclick = StorageApi.exportCSVRecords;
                document.getElementById('bvh-import').onclick = StorageApi.importRecords;
                document.getElementById('bvh-clean-expire').onclick = StorageApi.cleanExpireRecords;
                document.getElementById('bvh-del-current').onclick = StorageApi.deleteCurrentRecord;
                document.getElementById('bvh-del-all').onclick = StorageApi.deleteAllRecords;
            }
        }
    };

    // ── 官方历史页 UI：左下角入口 + 可拖拽大面板（同步/导出/导入/清理/重置按钮） ──
    // 【模块：历史记录页面 UI】
    // 初始化历史记录页面的脚本面板，连接列表渲染、搜索、记录管理和最近快照展示。
    // 具体记录筛选与分组复用 HistoryListRenderer，存储变化时通过统一刷新机制更新视图。
    const HistoryPageUI = {
        // 创建官方历史页入口和面板，绑定搜索、拖动、同步及数据管理操作。
        init() {
            if (document.getElementById('bvh-history-page-entry')) return;

            const entry = document.createElement('div');
            entry.id = 'bvh-history-page-entry';
            entry.innerHTML = `
                <div id="bvh-status-float" style="cursor:pointer;">
                    <div style="font-weight:bold;color:#fb7299;font-size:13px;">📂 本地记录</div>
                    <div style="font-size:11px;color:#888;margin-top:2px;">点击打开历史面板</div>
                </div>
            `;
            document.body.appendChild(entry);

            const panel = document.createElement('div');
            panel.id = 'bvh-history-page-panel';
            panel.innerHTML = `
                <div id="bvh-hp-drag-bar">
                    <span>本地观看记录</span>
                    <button id="bvh-hp-close-btn" title="关闭">✕</button>
                </div>
                <div id="bvh-hp-inner">
                    <div id="bvh-hp-storage" class="bvh-storage-info">存储：计算中...</div>
                    <div class="bvh-search-row">
                        <input id="bvh-hp-search" placeholder="搜索标题、作者、BV号或条件…" aria-label="搜索本地观看历史">
                        <button class="bvh-search-help-btn" type="button" aria-label="查看搜索规则" aria-expanded="false">!</button>
                        <div class="bvh-search-help" hidden>普通搜索：标题、作者、BV号、标签、分集等任意字段包含关键词即可；多个词用空格分开，全部满足才显示。次数>=3、总观看>=10、总次数>5、观看<5、count:!=2；也支持 合集观看>=20；进度>50、progress:<=80；时间可写 2024、2024-05、2024-05-01、05-01；快照:45%、snap:2024-05。条件之间用空格分隔。比较符支持 >、<、>=、<=、=、!=；不认识的写法会按普通关键词搜索。</div>
                    </div>
                    <div class="bvh-hp-actions">
                        <button id="hp-sync">同步官方历史</button>
                        <button id="hp-export">导出JSON</button>
                        <button id="hp-export-csv">导出CSV</button>
                        <button id="hp-import">导入JSON</button>
                        <button id="hp-clean">清理已备份过期记录（${CONFIG.EXPIRE_DAY}天）</button>
                        <button id="hp-clearall">清空全部</button>
                    </div>
                    <ul id="bvh-hp-list"></ul>
                </div>
            `;
            document.body.appendChild(panel);
            setupPersistentResize(panel, 'BVH_PANEL_SIZE_HISTORY_PAGE_V1', { minWidth: 320, minHeight: 240, maxWidth: 900, maxHeight: 1000 });
            panel.addEventListener('bvh-resize-end', () => {
                requestAnimationFrame(() => {
                    if (panel.dataset.bvhRefreshPending === 'true') {
                        delete panel.dataset.bvhRefreshPending;
                        const list = panel.querySelector('#bvh-hp-list');
                        const search = panel.querySelector('#bvh-hp-search');
                        if (list) HistoryListRenderer.renderInto(list, search?.value || '', 'history-page', { preserveScrollTop: list.scrollTop });
                    }
                });
            });

            // 官方历史页和播放页共用同一套搜索语法；帮助内容仅在用户主动点击时展开。
            panel.querySelector('.bvh-search-help-btn').addEventListener('click', e => {
                const button = e.currentTarget;
                const help = panel.querySelector('.bvh-search-help');
                help.hidden = !help.hidden;
                button.setAttribute('aria-expanded', String(!help.hidden));
            });

            const pageFloat = entry.querySelector('#bvh-status-float');
            makeDockableFloat(pageFloat);
            const setHistoryPanelOpen = open => {
                pageFloat.dataset.bvhPanelOpen = open ? 'true' : 'false';
                if (open) {
                    // 打开面板时保留入口原有停靠状态和坐标，不移除 bvh-docked，也不重设 left/top/bottom。
                    pageFloat._bvhCancelDock?.();
                } else {
                    // 面板关闭后再恢复自动停靠计时；位置只在正常停靠时校验一次。
                    pageFloat._bvhResumeDock?.(900);
                }
            };
            pageFloat.onclick = () => {
                const isOpen = !panel.classList.contains('bvh-hp-show');
                panel.classList.toggle('bvh-hp-show', isOpen);
                setHistoryPanelOpen(isOpen);
                if (isOpen) {
                    HistoryListRenderer.renderInto(document.getElementById('bvh-hp-list'), document.getElementById('bvh-hp-search')?.value || '', 'history-page');
                }
            };

            document.getElementById('bvh-hp-close-btn').onclick = e => {
                e.stopPropagation();
                panel.classList.remove('bvh-hp-show');
                setHistoryPanelOpen(false);
            };

            document.getElementById('hp-export').onclick = StorageApi.exportAllRecords;
            document.getElementById('hp-export-csv').onclick = StorageApi.exportCSVRecords;
            document.getElementById('hp-import').onclick = StorageApi.importRecords;
            document.getElementById('hp-clean').onclick = StorageApi.cleanExpireRecords;
            document.getElementById('hp-clearall').onclick = StorageApi.deleteAllRecords;
            document.getElementById('hp-sync').onclick = () => OfficialHistorySync.sync(false);

            document.getElementById('bvh-hp-search').oninput = e => {
                HistoryListRenderer.renderInto(document.getElementById('bvh-hp-list'), e.target.value, 'history-page');
            };

            document.addEventListener('keydown', e => {
                if (e.key !== 'Escape' || !panel.classList.contains('bvh-hp-show')) return;
                panel.classList.remove('bvh-hp-show');
                setHistoryPanelOpen(false);
            });

            makeDraggable(panel, document.getElementById('bvh-hp-drag-bar'), { preventDefault: true, easing: 1, animateOnEnd: false });
        }
    };

    // 在官方历史页监听卡片变化，延迟合并同步，避免每次 DOM 更新都立即扫描。
    // 【模块：官方历史自动同步调度】
    // 在适当的页面条件下触发官方历史同步，并使用防抖/状态保护避免短时间重复启动。
    // 自动同步与手动同步共用同步核心逻辑，避免两套路径产生不同的去重和写入结果。
    function startHistoryAutoSync() {
        if (!location.href.startsWith('https://www.bilibili.com/history')) return;
        let timer = null;
        let lastCount = document.querySelectorAll('.history-card__main .bili-video-card').length;
        let lastSyncAt = 0;
        const MIN_SYNC_INTERVAL = 8000;

        // 只在官方历史卡片数量确实增加时安排同步；同一批卡片的属性/子节点反复变化不重启任务。
        const scheduleSync = () => {
            if (timer || OfficialHistorySync._syncing) return;
            const wait = Math.max(CONFIG.AUTO_SYNC_DEBOUNCE, MIN_SYNC_INTERVAL - (Date.now() - lastSyncAt));
            timer = setTimeout(async () => {
                timer = null;
                if (OfficialHistorySync._syncing) return;
                lastSyncAt = Date.now();
                await OfficialHistorySync.sync(true);
            }, wait);
        };

        const observer = new MutationObserver(() => {
            const count = document.querySelectorAll('.history-card__main .bili-video-card').length;
            if (count > lastCount) {
                lastCount = count;
                scheduleSync();
            } else if (count < lastCount) {
                // 页面切换分组或清理历史时更新基准，但不因此启动全量同步。
                lastCount = count;
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('beforeunload', () => {
            clearTimeout(timer);
            observer.disconnect();
        });

        if (lastCount > 0) scheduleSync();
    }

    // ── 加载用户设置：启动时把 GM 里持久化的配置覆盖到 CONFIG ──
    // 【模块：读取并应用用户设置】
    // 从 GM 存储读取过期天数、同步页数、最近快照数量/来源配额、短观看阈值和连续观看间隔等设置，
    // 对缺失或不合法的值回退到配置默认值，保证后续功能使用一致的参数。
    function loadSettings() {
        const expire = GM_getValue(EXPIRE_SETTINGS_KEY, null);
        if (expire && Number.isFinite(Number(expire.days)) && Number(expire.days) >= 1) {
            CONFIG.EXPIRE_DAY = Math.floor(Number(expire.days));
            CONFIG.EXPIRE_MS = CONFIG.EXPIRE_DAY * 24 * 3600 * 1000;
        }

        const sync = GM_getValue(HISTORY_SYNC_SETTINGS_KEY, null);
        const pages = Number(sync?.pages);
        if (Number.isFinite(pages) && pages >= 1) {
            CONFIG.HISTORY_SYNC_PAGES = Math.min(100, Math.floor(pages));
        }

        const recent = GM_getValue(RECENT_SNAPSHOT_SETTINGS_KEY, null);
        const recentCount = Number(recent?.count);
        if (Number.isFinite(recentCount) && recentCount >= 1) {
            CONFIG.RECENT_SNAPSHOT_COUNT = Math.min(CONFIG.RECENT_SNAPSHOT_MAX, Math.floor(recentCount));
        }

        const quotaSetting = GM_getValue(RECENT_SNAPSHOT_QUOTA_SETTINGS_KEY, null);
        const quotaValue = Number(quotaSetting?.quota);
        if (Number.isFinite(quotaValue)) {
            CONFIG.RECENT_SNAPSHOT_PLAYER_QUOTA = Math.max(
                CONFIG.RECENT_SNAPSHOT_QUOTA_MIN,
                Math.min(CONFIG.RECENT_SNAPSHOT_QUOTA_MAX, quotaValue)
            );
        }

        const gap = GM_getValue(CONTINUOUS_GAP_SETTINGS_KEY, null);
        const gapMin = Number(gap?.minutes);
        if (Number.isFinite(gapMin) && gapMin >= 1) {
            CONFIG.CONTINUOUS_GAP_MIN = Math.min(24 * 60, Math.floor(gapMin));
        }

        const short = GM_getValue(SHORT_WATCH_SETTINGS_KEY, null);
        if (short && typeof short === 'object') {
            if (Number.isFinite(Number(short.days))) {
                CONFIG.SHORT_WATCH_EXPIRE_DAY = Math.max(0, Math.floor(Number(short.days)));
            }
            if (Number.isFinite(Number(short.seconds))) {
                CONFIG.SHORT_WATCH_MAX_POS_SEC = Math.max(0, Number(short.seconds));
            }
        }
    }

    // ── 油猴菜单：过期天数/翻页次数/快照条数/短观看阈值/连续间隔/归并/次数重置 ──
    // 【模块：注册油猴菜单命令】
    // 将可调整的记录管理参数暴露到用户脚本菜单中。各菜单负责读取当前值、接收输入、校验范围并保存设置，
    // 保存后由对应功能在后续运行中读取；菜单只调整设置，不直接改写观看记录。
    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        GM_registerMenuCommand('设置长期记录过期天数', function configureExpireDays() {
            const input = prompt(
                `设置"长期未更新记录"的过期天数。可选：30、60、90、180、365；也可输入其他正整数。\n只有已导出备份且超过该天数的记录才会被标记为可清理。`,
                String(CONFIG.EXPIRE_DAY)
            );
            if (input === null) return;
            const days = Number(input.trim());
            if (!Number.isFinite(days) || days < 1 || !Number.isInteger(days)) {
                alert('过期天数必须是大于或等于 1 的整数，设置未更改。');
                return;
            }
            CONFIG.EXPIRE_DAY = days;
            CONFIG.EXPIRE_MS = days * 24 * 3600 * 1000;
            RecordStore.set(EXPIRE_SETTINGS_KEY, { days, updatedAt: Date.now() });
            updateCleanupButtonLabels();
            refreshOpenHistoryLists();
            alert(`已设置为 ${days} 天。清理按钮文字和历史列表标记已更新。`);
        });

        GM_registerMenuCommand('设置官方历史翻页次数', function configureSyncPages() {
            const input = prompt(
                '设置同步官方历史时的自动翻页/加载次数（1–100）。次数越大，读取的历史越多，耗时也越长。',
                String(CONFIG.HISTORY_SYNC_PAGES)
            );
            if (input === null) return;
            const pages = Number(input);
            if (!Number.isInteger(pages) || pages < 1 || pages > 100) {
                alert('请输入 1 到 100 之间的整数，设置未更改。');
                return;
            }
            CONFIG.HISTORY_SYNC_PAGES = pages;
            RecordStore.set(HISTORY_SYNC_SETTINGS_KEY, { pages, updatedAt: Date.now() });
            alert(`官方历史同步加载次数已设为 ${pages} 次。`);
        });

        GM_registerMenuCommand('设置最近快照条数', function configureRecentSnapshotCount() {
            const input = prompt(
                `历史面板"最近N次快照"显示的条数 N（1–${CONFIG.RECENT_SNAPSHOT_MAX}）。\n只影响面板顶部这个跨视频快照列表，不改变每个视频自己的快照上限（仍是 5 条）。\n面板从常驻热池中取用：自动获取与官方历史同步各留最近 N 条，合计 2N 条候选，按观看时间优先取新的，只显示最新的 N 条。\n池容量 = 2N，与本地历史总量无关，所以 N 越大候选越多但仍是常数级，不会卡顿。`,
                String(CONFIG.RECENT_SNAPSHOT_COUNT)
            );
            if (input === null) return;
            const count = Number(input);
            if (!Number.isInteger(count) || count < 1 || count > CONFIG.RECENT_SNAPSHOT_MAX) {
                alert(`请输入 1 到 ${CONFIG.RECENT_SNAPSHOT_MAX} 之间的整数，设置未更改。`);
                return;
            }
            CONFIG.RECENT_SNAPSHOT_COUNT = count;
            RecordStore.set(RECENT_SNAPSHOT_SETTINGS_KEY, { count, updatedAt: Date.now() });
            if (HistoryViewIndex._index) {
                HistoryViewIndex._rebuild(HistoryViewIndex._index.itemsByKey, true);
            }
            refreshOpenHistoryLists();
            alert(`已设置为最近 ${count} 次快照。`);
        });

        GM_registerMenuCommand('设置最近快照来源配额（player 占比）', function configureRecentSnapshotQuota() {
            const current = Number.isFinite(Number(CONFIG.RECENT_SNAPSHOT_PLAYER_QUOTA))
            ? Number(CONFIG.RECENT_SNAPSHOT_PLAYER_QUOTA) : 0.5;
            const input = window.prompt(
                `最近 N 条里『播放页自动获取』来源至少占的比例（0 到 1 之间的小数）。\n` +
                `0.5 = 两来源平分；0 = 只显示官方同步；1 = 只显示自动获取。\n` +
                `候选池仍是两桶各 N 条（合计 2N），配额只决定 N 个显示名额怎么分。\n` +
                `当前值：${current}`,
                String(current)
            );
            if (input === null) return;
            const quota = Number(String(input).trim());
            if (!Number.isFinite(quota) || quota < CONFIG.RECENT_SNAPSHOT_QUOTA_MIN
                || quota > CONFIG.RECENT_SNAPSHOT_QUOTA_MAX) {
                alert(`请输入 ${CONFIG.RECENT_SNAPSHOT_QUOTA_MIN} 到 ${CONFIG.RECENT_SNAPSHOT_QUOTA_MAX} 之间的小数，设置未更改。`);
                return;
            }
            CONFIG.RECENT_SNAPSHOT_PLAYER_QUOTA = quota;
            RecordStore.set(RECENT_SNAPSHOT_QUOTA_SETTINGS_KEY, { quota, updatedAt: Date.now() });
        });

        GM_registerMenuCommand('设置短观看阈值（秒）', function configureShortThreshold() {
            const input = prompt('短观看阈值（秒）：观看位置严格小于该值的记录会按保留天数清理。', String(CONFIG.SHORT_WATCH_MAX_POS_SEC));
            if (input === null) return;
            const seconds = Number(input);
            if (!Number.isFinite(seconds) || seconds < 0) {
                alert('阈值必须是大于或等于 0 的数字。未修改设置。');
                return;
            }
            CONFIG.SHORT_WATCH_MAX_POS_SEC = seconds;
            RecordStore.set(SHORT_WATCH_SETTINGS_KEY, {
                seconds: CONFIG.SHORT_WATCH_MAX_POS_SEC,
                days: CONFIG.SHORT_WATCH_EXPIRE_DAY
            });
            StorageApi.cleanShortWatchRecords();
            alert(`已保存：短观看阈值为 ${seconds} 秒；保留天数仍为 ${CONFIG.SHORT_WATCH_EXPIRE_DAY} 天。`);
        });

        GM_registerMenuCommand('设置短观看保留天数（天）', function configureShortRetention() {
            const input = prompt('短观看记录保留天数：0 表示立即清理，1 表示满 1 天后清理。', String(CONFIG.SHORT_WATCH_EXPIRE_DAY));
            if (input === null) return;
            const days = Number(input);
            if (!Number.isFinite(days) || days < 0) {
                alert('保留天数必须是大于或等于 0 的数字。未修改设置。');
                return;
            }
            CONFIG.SHORT_WATCH_EXPIRE_DAY = Math.floor(days);
            RecordStore.set(SHORT_WATCH_SETTINGS_KEY, {
                seconds: CONFIG.SHORT_WATCH_MAX_POS_SEC,
                days: CONFIG.SHORT_WATCH_EXPIRE_DAY
            });
            StorageApi.cleanShortWatchRecords();
            alert(`已保存：短观看记录保留 ${CONFIG.SHORT_WATCH_EXPIRE_DAY} 天后清理；阈值仍为 ${CONFIG.SHORT_WATCH_MAX_POS_SEC} 秒。`);
        });

        GM_registerMenuCommand('重置所有观看次数为 1', () => StorageApi.resetAllWatchCounts());

        GM_registerMenuCommand('设置连续观看判定间隔（分钟）', function configureContinuousGap() {
            const input = prompt(
                `判定"挂着持续播放仍算同一次观看"的最大时间间隔（分钟）。\n` +
                `官方历史卡片在该间隔内持续更新、且进度向前推进时，视为同一次观看，不累加次数；\n` +
                `间隔超过该值或进度回退，才算新的一次观看。`,
                String(CONFIG.CONTINUOUS_GAP_MIN)
            );
            if (input === null) return;
            const minutes = Number(input);
            if (!Number.isInteger(minutes) || minutes < 1) {
                alert('请输入大于或等于 1 的整数，设置未更改。');
                return;
            }
            CONFIG.CONTINUOUS_GAP_MIN = minutes;
            RecordStore.set(CONTINUOUS_GAP_SETTINGS_KEY, { minutes, updatedAt: Date.now() });
            alert(`连续观看判定间隔已设为 ${minutes} 分钟。`);
        });

        GM_registerMenuCommand('归并单集残留到整季', () => StorageApi.mergeEpIntoSeason());
        GM_registerMenuCommand('整合本地分集数据并修复完整键', () => StorageApi.repairBangumiIdentityFromLocalData());

        // 5.3.0：手动触发"更新本地历史数据结构"——把旧扁平记录迁移到合集容器。
        GM_registerMenuCommand('更新本地数据结构（迁移到合集容器）', () => StorageApi.migrateToContainerStructure());
    }

    // 启动时检查本地记录格式，只在归一化结果确有变化时写回。
    // 【模块：批量规范化本地记录】
    // 遍历现有本地记录并使用统一规范化规则修整旧字段、快照结构和容器/分集形态。
    // 该过程服务于兼容性维护，不能把索引缓存当作原始记录来源。
    function normalizeAllLocalRecords() {
        let fixed = 0;
        GM_listValues().filter(k => RecordKey.isRecordKey(k)).forEach(key => {
            const oldValue = GM_getValue(key);
            const current = RecordNormalizer.normalize(oldValue);
            if (!current) return;
            if (JSON.stringify(oldValue) !== JSON.stringify(current)) {
                RecordStore.set(key, current);
                fixed++;
            }
        });
        return fixed;
    }

    // 启动时自动整理本地记录，但绝不自动删除记录。
    // 没有观看事实的记录只标记 emptyRecord=true，保留原始键、标题、作者和合集信息，
    // 供后续合集扫描与本地分集匹配使用。是否删除必须由用户在设置/清理操作中主动决定。
    // 【模块：启动阶段的本地数据修复与清理】
    // 执行有版本标记保护的一次性修复，以及必要的无效/过期数据整理，避免每次启动重复执行同一迁移。
    // 清理条件应与长期记录、短观看记录各自的保留规则一致。
    function repairAndCleanLocalRecords() {
        const doneVersion = Number(GM_getValue(LOCAL_DATA_REPAIR_VERSION_KEY, 0)) || 0;
        if (doneVersion >= 2) return { skipped: true, deletedEmpty: 0, markedEmpty: 0 };

        let markedEmpty = 0;
        let normalizedCount = 0;
        const keys = GM_listValues().filter(key => RecordKey.isRecordKey(key));
        try {
            for (const key of keys) {
                const raw = GM_getValue(key, null);
                const record = RecordNormalizer.normalize(raw);
                if (!record) continue;

                if (record.emptyRecord) markedEmpty++;
                if (JSON.stringify(raw) !== JSON.stringify(record)) {
                    RecordStore.set(key, record);
                    normalizedCount++;
                }
            }

            HistoryViewIndex.reset();
            RecordStore.clearIndex();
            GM_setValue(LOCAL_DATA_REPAIR_VERSION_KEY, 2);
            const result = { skipped: false, scanned: keys.length, deletedEmpty: 0, markedEmpty, normalized: normalizedCount };
            console.info(`${TAG} [本地数据整理] 扫描=${result.scanned}，标记空记录=${markedEmpty}，删除记录=0，格式归一=${normalizedCount}`);
            return result;
        } catch (error) {
            console.error(`${TAG} [本地数据整理] 未完整完成，下次启动会重试：`, error);
            return { skipped: false, deletedEmpty: 0, markedEmpty, normalized: normalizedCount, error };
        }
    }

    // ── 入口：注入样式 → 加载设置 → 注册菜单 → 归一化存量记录 → 启动各子系统 ──
    // 【模块：脚本启动入口】
    // 在页面 DOM 可用后按顺序加载设置、注入样式、初始化存储/索引、执行必要的数据修复，
    // 再根据当前页面类型启动播放采集、卡片标记、悬浮窗或历史页面 UI。
    // 页面专属功能由这里统一调度，避免在不相关页面重复安装监听器或渲染界面。
    function mainInit() {
        injectStyle();
        loadSettings();
        registerMenus();

        normalizeAllLocalRecords();
        repairAndCleanLocalRecords();
        updateCleanupButtonLabels();

        StorageApi.cleanShortWatchRecords();
        setInterval(() => StorageApi.cleanShortWatchRecords(), 6 * 3600 * 1000);

        RecordStore.initRemoteListener();

        if (location.href.startsWith('https://www.bilibili.com/history')) {
            HistoryPageUI.init();
            startHistoryAutoSync();
            return;
        }

        startCardBadgeRenderer();
        // 先初始化播放页悬浮窗，再启动播放器记录器；避免记录器首轮识别/读取异常时跳过入口创建。
        try {
            PlaybackUI.render();
        } catch (error) {
            console.error(`${TAG} [播放悬浮窗] 初始创建失败：`, error);
        }
        startPlaybackRecorder();
        startLiveRecorder();
    }

    mainInit();
})();
