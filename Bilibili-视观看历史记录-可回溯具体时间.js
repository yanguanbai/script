// ==UserScript==
// @name         Bilibili 视频观看历史记录 可回溯具体时间
// @namespace    Bilibili-video-History-Pro
// @version      5.1.1
// @description  通用采集B站卡片原始标签；支持视频/番剧/直播历史、快速最近快照、流式搜索、导出备份与安全清理；
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
(function () {
    'use strict';

    // ============================================================================
    // 播放页和官方历史页共同维护本地观看记录；每条记录以视频、番剧或直播标识为键，
    // 快照保存观看时间与进度，所有读写经过统一归一化和存储接口。
    // HistoryViewIndex 提供排序与搜索；最近快照使用独立小缓存优先显示，完整索引在后台整理。
    // 搜索采用流式筛选和分帧渲染，避免一次性扫描和创建大量列表节点阻塞页面。
    // ============================================================================

    const RECORD_CHANGE_EVENT = 'bvh-record-storage-changed';
    const RECORD_CHANGE_SIGNAL_KEY = 'bvh_internal_record_change_signal_v1';

    const HISTORY_VIEW_INDEX_KEY = 'bvh_history_view_index_v1';
    // 独立保存少量最近快照，避免首次打开面板时为了显示顶部 N 条而先读取整个大索引。
    const RECENT_SNAPSHOT_CACHE_KEY = 'bvh_recent_snapshot_cache_v1';
    // 最近快照按来源配额选取，并用全局时间顺序补足空缺；同一观看的跨来源快照按时间窗口去重。
    //      两轮取数，面板 N 个名额里 player 至少占 ceil(N*quota)；(b) source 缺失/非法的快照判为
    const HISTORY_VIEW_INDEX_VERSION = 13;

    const EXPIRE_SETTINGS_KEY = 'bvh_expire_settings_v1';
    const EXPORTED_RECORDS_KEY = 'bvh_exported_record_keys_v1';
    const SHORT_WATCH_SETTINGS_KEY = 'bvh_short_watch_settings_v1';
    const HISTORY_SYNC_SETTINGS_KEY = 'bvh_history_sync_settings_v1';
    const RECENT_SNAPSHOT_SETTINGS_KEY = 'bvh_recent_snapshot_settings_v1';
    const RECENT_SNAPSHOT_QUOTA_SETTINGS_KEY = 'bvh_recent_snapshot_quota_settings_v1';
    const CONTINUOUS_GAP_SETTINGS_KEY = 'bvh_continuous_gap_settings_v1';

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

    const CSV_COLUMNS = [
        ['bv_key', '视频BV号'],
        ['title', '视频标题'],
        ['author_name', '作者名字'],
        ['media_type', '内容类型'],
        ['media_tags', '卡片标签'],
        ['media_subtitle', '分集/副标题'],
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

    // ── 记录键工具：从任意 URL 提取/校验记录键（BV… / ss… / ep… / live…） ──
    const RecordKey = {
        // 判断字符串是否属于脚本支持的视频、番剧或直播记录键。
        isRecordKey(key) {
            return typeof key === 'string' && (
                /^BV[a-zA-Z0-9]+(?:\?p=\d+)?$/.test(key) ||
                /^(?:ss|ep)\d+$/i.test(key) ||
                /^live\d+$/i.test(key)
            );
        },
        // 把分 P 视频、番剧或直播记录映射到用于归组的统一键。
        getGroupKey(key) {
            if (typeof key !== 'string') return null;
            const videoMatch = key.match(/^(BV[a-zA-Z0-9]+)/);
            if (videoMatch) return videoMatch[1];
            const bangumiMatch = key.match(/^(ss|ep)(\d+)$/i);
            if (bangumiMatch) return `${bangumiMatch[1].toLowerCase()}${bangumiMatch[2]}`;
            const liveMatch = key.match(/^live(\d+)$/i);
            if (liveMatch) return `live${liveMatch[1]}`;
            return null;
        },
        // 判断记录键是否为番剧单集或整季格式。
        isBangumiKey(key) { return /^(?:ss|ep)\d+$/i.test(key); },
        // 判断记录键是否为番剧单集 ep 格式。
        isEpisodeKey(key) { return /^ep\d+$/i.test(key); },
        // 判断记录键是否为番剧整季 ss 格式。
        isSeasonKey(key) { return /^ss\d+$/i.test(key); },
        // 判断记录键是否为直播间格式。
        isLiveKey(key) { return /^live\d+$/i.test(key); },
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
    const PageData = {
        // 从 B 站页面初始化数据中有限深度地查找 seasonId，避免循环引用导致递归失控。
        resolveBangumiSeasonId() {
            try {
                const visited = new Set();
                const search = (obj, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 8) return null;
                    if (visited.has(obj)) return null;
                    visited.add(obj);
                    for (const k of Object.keys(obj)) {
                        if (k === 'seasonId' || k === 'season_id') {
                            const v = obj[k];
                            if (typeof v === 'number' && Number.isFinite(v) && v >= 1000) return v;
                        }
                    }
                    for (const k of Object.keys(obj)) {
                        const r = search(obj[k], depth + 1);
                        if (r) return r;
                    }
                    return null;
                };
                return search(window.__INITIAL_STATE__ || window.__pinia || window.__BILI_SSR_DATA__, 0);
            } catch (e) {
                return null;
            }
        }
    };

    // ── 旧格式迁移：把 4.x 早期的数组格式 / 简单对象格式升级成当前快照结构 ──
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
        //   1. 补齐 authorName；
        //   2. 进度为 100% 时自动打 completed 标记（官方卡片可能不显式给 completed）；
        //   3. completed 快照顶掉旧的 completed（保持"永久名额"只留最近一条）；
        //   4. 统一走 keepSnapshotsWithinLimit，然后刷新 lastTs / lastProgress。
        appendSnapshot(record, snapshot) {
            if (!Array.isArray(record.snapshots)) record.snapshots = [];
            if (!snapshot.authorName && record.authorName) snapshot.authorName = record.authorName;
            if (snapshot.authorName && typeof snapshot.authorName === 'string') snapshot.authorName = snapshot.authorName.trim();
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

            const normalized = {
                title: typeof rec.title === 'string' ? rec.title : (rec.title == null ? null : String(rec.title)),
                // 具体视频标题与官方卡片上的合集/系列标题分开保存，避免不同来源互相覆盖。
                collectionTitle: typeof rec.collectionTitle === 'string' ? rec.collectionTitle : '',
                // 大合集下面的子合集标题；单视频项为空，避免把视频名误当子合集名。
                smallCollectionTitle: typeof rec.smallCollectionTitle === 'string' ? rec.smallCollectionTitle : '',
                collectionOrder: Number.isFinite(Number(rec.collectionOrder)) && Number(rec.collectionOrder) >= 0 ? Math.floor(Number(rec.collectionOrder)) : 0,
                titleSource: rec.titleSource === 'player' || rec.titleSource === 'official' ? rec.titleSource : '',
                // 从播放页合集列表提取的稳定归组信息；不参与记录键和观看次数计算。
                collectionKey: typeof rec.collectionKey === 'string' ? rec.collectionKey : '',
                partTitle: typeof rec.partTitle === 'string' ? rec.partTitle : '',
                partNumber: Number.isFinite(Number(rec.partNumber)) && Number(rec.partNumber) > 0 ? Math.floor(Number(rec.partNumber)) : 0,
                partTotal: Number.isFinite(Number(rec.partTotal)) && Number(rec.partTotal) > 0 ? Math.floor(Number(rec.partTotal)) : 0,
                lastTs: Number.isFinite(Number(rec.lastTs)) && Number(rec.lastTs) > 0 ? Number(rec.lastTs) : 0,
                lastProgress: typeof rec.lastProgress === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(rec.lastProgress)
                ? rec.lastProgress : '0%',
                watchCount: Number.isFinite(Number(rec.watchCount)) && Number(rec.watchCount) >= 0
                ? Math.floor(Number(rec.watchCount)) : 0,
                snapshots: [],
                hasReachedWatchThreshold: rec.hasReachedWatchThreshold === true,
                officialHistorySeen: rec.officialHistorySeen === true,
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
                        authorName: typeof s.authorName === 'string' && s.authorName.trim()
                        ? s.authorName.trim() : normalized.authorName,
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
            return normalized;
        },

        // 提取列表索引需要的字段，避免索引缓存携带无关数据。
        toIndexRecord(key, raw) {
            const rec = this.normalize(raw);
            if (!rec) return null;
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
        }
    };

    // ── 历史视图索引：全量记录的有序镜像，后台分批构建 + 防抖落盘，供面板快速渲染 ──
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
                        authorName: snap.authorName || it.authorName || '',
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
                if (elapsed >= 200) { doRefresh(false); return; }
                if (refreshTimer) return;
                refreshTimer = setTimeout(() => {
                    refreshTimer = null;
                    doRefresh(false);
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
                        const item = RecordNormalizer.toIndexRecord(key, GM_getValue(key));
                        if (item) {
                            itemsByKey[key] = item;
                            newKeys.push(key);
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
                    this._scheduleRecentCacheSave();
                    throttledRefresh();
                    runWhenIdle(processBatch, 1000);
                    return;
                }

                for (const [changedKey, change] of this._pendingChanges) {
                    if (change.deleted) delete itemsByKey[changedKey];
                    else {
                        const changedItem = RecordNormalizer.toIndexRecord(changedKey, change.value);
                        if (changedItem) itemsByKey[changedKey] = changedItem;
                        else delete itemsByKey[changedKey];
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
            if (deleted) {
                delete this._index.itemsByKey[key];
            } else {
                const item = RecordNormalizer.toIndexRecord(key, rawValue);
                if (item) this._index.itemsByKey[key] = item;
                else delete this._index.itemsByKey[key];
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
    function refreshOpenHistoryLists(preserveScroll = false) {
        const pagePanel = document.getElementById('bvh-history-page-panel');
        if (pagePanel && pagePanel.classList.contains('bvh-hp-show')) {
            const listDom = document.getElementById('bvh-hp-list');
            const searchInput = document.getElementById('bvh-hp-search');
            if (listDom) {
                HistoryListRenderer.renderInto(listDom, searchInput?.value || '', 'history-page', {
                    preserveScrollTop: preserveScroll ? listDom.scrollTop : null
                });
            }
        }
        const legacyPanel = document.getElementById('bvh-history-panel');
        if (legacyPanel && legacyPanel.style.display === 'block') {
            const listDom = document.getElementById('bvh-history-list');
            const searchInput = document.getElementById('bvh-history-search');
            if (listDom) {
                HistoryListRenderer.renderInto(listDom, searchInput?.value || '', 'playback', {
                    preserveScrollTop: preserveScroll ? listDom.scrollTop : null
                });
            }
        }
    }
    // ── 记录存取：GM_setValue/GM_getValue 的统一封装，负责索引维护与跨标签页广播 ──
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
            if (this._keyIndex) this._keyIndex.clear();
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
        delete(key) {
            GM_deleteValue(key);
            this._removeFromIndex(key);
            HistoryViewIndex.updateKey(key, null, true);
            this._clearExportedMark(key);
            this._broadcast(key);
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
    const StorageApi = {
        // 按油猴设置清理未达到观看阈值且满足保留期限的短观看记录。
        cleanShortWatchRecords() {
            const keepMs = CONFIG.SHORT_WATCH_EXPIRE_DAY * 24 * 3600 * 1000;
            const nowTs = TimeTool.now();
            let deletedRecords = 0;
            let deletedSnapshots = 0;

            GM_listValues().forEach(key => {
                const rec = LegacyMigration.migrateAny(GM_getValue(key));
                if (!rec || typeof rec !== 'object' || !Array.isArray(rec.snapshots)) return;
                const oldLength = rec.snapshots.length;
                if (oldLength === 0) return;

                let hasReachedThreshold = rec.hasReachedWatchThreshold === true;
                let allValidAndShort = true;

                for (const snap of rec.snapshots) {
                    const pos = snap && snap.pos;
                    if (pos === null || pos === undefined || pos === '' || !Number.isFinite(Number(pos)) || Number(pos) < 0) {
                        allValidAndShort = false;
                        continue;
                    }
                    if (Number(pos) >= CONFIG.SHORT_WATCH_MAX_POS_SEC) {
                        hasReachedThreshold = true;
                        allValidAndShort = false;
                    }
                }

                if (hasReachedThreshold && rec.hasReachedWatchThreshold !== true) {
                    rec.hasReachedWatchThreshold = true;
                    RecordStore.set(key, rec);
                }

                if (hasReachedThreshold || !allValidAndShort) return;

                rec.snapshots = rec.snapshots.filter(snap => {
                    const ts = snap && snap.ts;
                    const validTimestamp = ts !== null && ts !== undefined && ts !== '' && Number.isFinite(Number(ts)) && Number(ts) > 0;
                    const isDue = validTimestamp && (CONFIG.SHORT_WATCH_EXPIRE_DAY === 0 || nowTs - Number(ts) >= keepMs);
                    if (isDue) {
                        deletedSnapshots++;
                        return false;
                    }
                    return true;
                });

                if (rec.snapshots.length !== oldLength) {
                    if (rec.snapshots.length === 0) {
                        RecordStore.delete(key);
                        deletedRecords++;
                    } else {
                        const latest = rec.snapshots.reduce((a, b) => (Number(a.ts || 0) >= Number(b.ts || 0) ? a : b));
                        rec.lastTs = Number(latest.ts || rec.lastTs || 0);
                        rec.lastProgress = latest.progress || rec.lastProgress || '0%';
                        RecordStore.set(key, rec);
                    }
                }
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
            const rec = RecordNormalizer.normalize(GM_getValue(key));
            if (!rec) {
                alert('这条观看记录已不存在。');
                return false;
            }
            const currentCount = Math.max(0, Math.floor(Number(rec.watchCount) || 0));
            const nextCount = Number(targetCount);
            if (!Number.isInteger(nextCount) || nextCount < 0 || nextCount > 10000) {
                alert(`请输入 0 到 ${10000} 之间的整数。`);
                return false;
            }
            rec.watchCount = nextCount;
            RecordStore.set(key, rec);
            refreshOpenHistoryLists(true);
            return true;
        },

        // 删除单条记录，并同步更新索引与备份标记。
        deleteSingleRecord(key) {
            if (!RecordKey.isRecordKey(key) || GM_getValue(key, null) === null) {
                alert('这条观看记录已不存在。');
                return false;
            }
            const rec = RecordNormalizer.normalize(GM_getValue(key));
            const title = rec?.title || key;
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
                const epRec = RecordNormalizer.normalize(GM_getValue(epKey));
                if (!epRec || !Array.isArray(epRec.snapshots) || !epRec.snapshots.length) {
                    skipped.push(epKey);
                    return;
                }

                let target = null;
                if (epRec.seasonId) {
                    target = ssCandidates.find(s => s.key === `ss${epRec.seasonId}`) || null;
                }
                if (!target) {
                    const epTitle = String(epRec.title || '').replace(/-.*$/, '').trim();
                    target = ssCandidates.find(s => {
                        const t = String(s.rec?.title || '').trim();
                        return t && epTitle.startsWith(t);
                    }) || null;
                }
                if (!target) {
                    skipped.push(epKey);
                    return;
                }

                const targetRec = RecordNormalizer.normalize(GM_getValue(target.key))
                || { title: epRec.title, watchCount: 0, snapshots: [] };

                // 快照身份只看"分钟"：同一次观看在播放页会留下多条不同进度的快照，
                // 但必然落在同一批分钟里；跨来源（播放页/官方历史）对账只按分钟判重，
                // 否则同一次观看会被重复合并，watchCount 虚高。
                const snapshotKey = snap => `${minuteKeyOf(snap && snap.ts)}`;

                const seen = new Set((targetRec.snapshots || []).map(snapshotKey));
                let duplicateCount = 0;
                (epRec.snapshots || []).forEach(s => {
                    const key = snapshotKey(s);
                    if (seen.has(key)) {
                        duplicateCount++;
                        return;
                    }
                    seen.add(key);
                    targetRec.snapshots.push(s);
                });

                // watchCount = 两边之和 - 可确认的重复观看；再兜底不低于快照条数
                targetRec.watchCount = Math.max(
                    0,
                    (Number(targetRec.watchCount) || 0) + (Number(epRec.watchCount) || 0) - duplicateCount,
                    targetRec.snapshots.length
                );
                if (!targetRec.lastTs || Number(epRec.lastTs) > Number(targetRec.lastTs)) {
                    targetRec.lastTs = epRec.lastTs;
                    targetRec.lastProgress = epRec.lastProgress;
                }
                targetRec.mediaType = targetRec.mediaType && targetRec.mediaType !== '视频'
                    ? targetRec.mediaType
                : epRec.mediaType || '番剧';
                targetRec.mediaTags = targetRec.mediaTags?.length ? targetRec.mediaTags : epRec.mediaTags;
                targetRec.mediaSubtitle = targetRec.mediaSubtitle || epRec.mediaSubtitle;

                const finalRec = RecordNormalizer.normalize({
                    ...targetRec,
                    snapshots: targetRec.snapshots,
                    watchCount: targetRec.watchCount
                });
                RecordStore.set(target.key, finalRec || targetRec);
                RecordStore.delete(epKey);
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
                if (normalized) records.push({ key, normalized });
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
                        snapshot_author: snap ? (snap.authorName || normalized.authorName || '') : ''
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
                                if (existing) {
                                    ['authorName', 'mediaType', 'mediaSubtitle', 'collectionTitle', 'smallCollectionTitle'].forEach(field => {
                                        const incoming = normalized[field];
                                        const local = existing[field];
                                        const incomingEmpty = incoming == null || (typeof incoming === 'string' && !incoming.trim());
                                        if (incomingEmpty && local) normalized[field] = local;
                                    });
                                    // 旧记录没有 titleSource 时按已有本地标题处理：导入不能用另一个来源的标题覆盖它。
                                    if (existing.title && normalized.title && existing.title !== normalized.title) {
                                        normalized.collectionTitle = normalized.collectionTitle || normalized.title;
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
            if (parsed.isEpisode) {
                const sid = PageData.resolveBangumiSeasonId();
                if (sid) {
                    const ssKey = `ss${sid}`;
                    if (ssKey !== parsed.key && GM_getValue(ssKey, null) !== null) RecordStore.delete(ssKey);
                }
            }
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
                rec.watchCount = 1;
                RecordStore.set(key, rec);
            });
            // 次数变了，排序索引需要重建（索引按 watchCount 排序）
            HistoryViewIndex.reset();
            RecordStore.clearIndex();
            HistoryViewIndex.ensure();
            alert(`重置完成，共处理 ${keys.length} 条记录，观看次数已全部变为 1。`);
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
            // 观看次数：次数>=3 / 观看>5 / count:<=2
            if ((m = token.match(/^(?:次数|观看(?:次数)?|count|watchcount)\s*[:：]?\s*(>=|<=|>|<|!=|=)\s*(\d+)$/i))) {
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
            const parts = { count: [], progress: [], time: [], snapshot: [] };
            for (const cond of (query.conditions || [])) {
                if (parts[cond.type]) parts[cond.type].push(cond);
            }
            return parts;
        },

        // 快照行的判定器。没有关键词时完全跳过 _buildHaystack（那是逐条最贵的一步）。
        _buildSnapMatcher(query) {
            const parts = this._splitConditions(query);
            const keywords = (query.keywords || []).length > 0;
            return snap => {
                if (keywords && !SearchQuery.matchKeywords(query, this._buildHaystack(snap))) return false;
                if (parts.count.length && !SearchQuery.matchCount(query, snap.watchCount)) return false;
                if (parts.progress.length && !SearchQuery.matchProgress(query, snap.progress)) return false;
                if (parts.time.length && !SearchQuery.matchTime(query, snap.watchTimeStr, snap.ts)) return false;
                return true;
            };
        },

        // 整记录行的判定器。时间条件不存在时不做 formatTimestamp，
        // 快照条件不存在时不拼接快照文本 —— 两者原本每次输入都对全部记录各跑一遍。
        _buildRecordMatcher(query) {
            const parts = this._splitConditions(query);
            const keywords = (query.keywords || []).length > 0;
            return it => {
                if (keywords && !SearchQuery.matchKeywords(query, this._buildHaystack(it))) return false;
                if (parts.count.length && !SearchQuery.matchCount(query, it.watchCount)) return false;
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
                const bv = String(item.key || '').match(/^(BV[a-zA-Z0-9]+)(?:\?p=\d+)?$/i);
                if (!bv) return null;
                const collectionKey = item.collectionKey || collectionByBv.get(bv[1]);
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
            if (itemOrKey && typeof itemOrKey === 'object') {
                if (itemOrKey.collectionKey && Number(itemOrKey.partNumber) > 0) {
                    return `第${Number(itemOrKey.partNumber)}集`;
                }
                itemOrKey = itemOrKey.key;
            }
            const match = String(itemOrKey || '').match(/\?p=(\d+)/i);
            return `P${match ? Number(match[1]) : 1}`;
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
            ? (isCollectionGroup && Number(latest.item.partTotal || 0) <= 1 ? '视频' : this._partLabel(latest.item))
            : '';
            const collectionVideoCount = isCollectionGroup
            ? new Set(allParts.map(item => (String(item.key || '').match(/^(BV[a-zA-Z0-9]+)/i) || [])[1]).filter(Boolean)).size
            : 0;
            const latestTime = latest?.snap?.watchTimeStr || (latest?.ts ? TimeTool.formatTimestamp(latest.ts) : '无记录');
            const latestProgress = latest?.snap?.progress || latest?.item?.lastProgress || '0%';
            const title = isCollectionGroup
            ? (allParts.find(item => String(item.collectionTitle || '').trim())?.collectionTitle || '未命名合集')
            : (latest?.item?.title || allParts.find(item => item.title)?.title || '无标题');
            const stableGroupKey = isCollectionGroup ? `collection:${allParts.find(item => item.collectionKey)?.collectionKey}` : `bv:${RecordKey.getGroupKey(allParts[0].key)}`;
            const expanded = this._expandedGroups.has(stableGroupKey);

            const head = document.createElement('div');
            head.className = 'bvh-group-head';
            const sortLabel = this._groupSortMode === 'watch' ? '按观看' : '按合集';
            head.innerHTML = `
    <div class="bvh-group-main">
        <div class="bvh-group-title-line">
            <span class="bvh-count-mark">[总观看${totalCount}次]</span>
            <span class="bvh-part-label">${isCollectionGroup ? `${collectionVideoCount} 个视频有记录` : `${allParts.length} 个分 P`}</span>
        </div>
        <div class="bvh-group-title">${this._escapeHtml(title)}</div>
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
                row.innerHTML = `
                    <div class="bvh-part-main-line">
                        <span class="bvh-part-label">${isCollectionGroup && Number(part.partTotal || 0) <= 1 ? '视频' : this._partLabel(part)}</span>
                        <span class="bvh-part-title">${this._escapeHtml(part.title || '无标题')}</span>
                        <button type="button" class="bvh-part-detail-toggle" aria-expanded="false" title="查看观看详情">详情⌄</button>
                    </div>
                    <div class="bvh-part-quick-meta">
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
                    const url = RecordKey.buildUrl(part.key);
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
                entity.mediaType, entity.mediaSubtitle
            ];
            if (Array.isArray(entity.mediaTags)) parts.push(entity.mediaTags.join(' '));
            if (Array.isArray(entity.snapshots)) {
                entity.snapshots.forEach(s => parts.push(s.watchTimeStr, s.progress));
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
            const snapMatcher = this._buildSnapMatcher(query);
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
                    stream = this._recordStream(index, this._buildRecordMatcher(query), exportedMap, nowTs);
                }
                return stream();
            };
            this.renderTasks(listDom, source, options);
        }
    };

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

                    if (ident.type === 'bangumi' && RecordKey.isEpisodeKey(ident.key)) {
                        const ssLink = card.querySelector('a[href*="/bangumi/play/ss"]');
                        const ssMatch = ssLink && String(ssLink.getAttribute('href') || '').match(/\/bangumi\/play\/(ss\d+)/i);
                        if (ssMatch) ident = { type: 'bangumi', key: ssMatch[1].toLowerCase() };
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
                    return { ident, title, mediaTags, subtitle, mediaType, progress, posSec, dateText, authorName };
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
                    const { ident, title, mediaTags, subtitle, mediaType, progress, posSec, dateText, authorName } = data;
                    const key = ident.key;
                    bvid = key;

                    const parsedOfficialTime = TimeTool.parseWatchTime(dateText, nowTs);
                    if (!parsedOfficialTime.valid || !parsedOfficialTime.ts) {
                        skipCount++;
                        console.warn(`${TAG} [写入] 时间解析失败跳过：${key} 原文="${dateText}"`);
                        continue;
                    }
                    const officialTs = parsedOfficialTime.ts;
                    const watchTimeStr = TimeTool.formatTimestamp(officialTs);
                    const isCompleted = progress === '100%';

                    let localRecord = GM_getValue(key);
                    localRecord = LegacyMigration.migrateAny(localRecord);
                    if (localRecord && typeof localRecord === 'object' && !Array.isArray(localRecord)) {
                        localRecord = RecordNormalizer.normalize(localRecord) || localRecord;
                        if (!Array.isArray(localRecord.snapshots)) localRecord.snapshots = [];
                        if (!Number.isFinite(Number(localRecord.watchCount))) localRecord.watchCount = localRecord.snapshots.length;
                    }

                    if (!localRecord || typeof localRecord !== 'object') {
                        // 首次创建：直接用官方卡片信息，watchCount=1
                        RecordStore.set(key, {
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
                        });
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

                        RecordStore.set(key, localRecord);
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
    function startPlaybackRecorder() {
        let recordTimer = null;
        let activeRecordKey = null;
        let hasCountedThisSession = false;
        let hasSavedSnapshotThisSession = false;
        let endingWasVisible = false;
        let lastEndingSavedKey = null;
        let lastVideoElement = null;

        const resetForVideo = key => {
            activeRecordKey = key;
            hasCountedThisSession = false;
            hasSavedSnapshotThisSession = false;
            endingWasVisible = false;
            lastEndingSavedKey = null;
        };

        const getCurrentContext = () => {
            const parsed = RecordKey.parse(window.location.href);
            const isVideoPage = window.location.pathname.includes('/video/');
            const isBangumiPage = window.location.pathname.includes('/bangumi/play/');
            if (!parsed || (!isVideoPage && !isBangumiPage)) return null;
            const video = document.querySelector('video') || document.querySelector('bwp-video');
            if (!video) return null;

            let key = parsed.key;
            let seasonId = null;
            if (isBangumiPage) {
                const sid = PageData.resolveBangumiSeasonId();
                if (sid) {
                    seasonId = sid;
                    key = `ss${sid}`;
                }
            }
            return { ...parsed, key, seasonId, video };
        };

        // 合集元数据只从合集框本身读取；具体视频标题始终按 BV/分 P 读取。
        // 兼容单 BV 多 P、合集内多个 BV、没有 ?p= 的单 P BV，以及页面中并列/嵌套的合集框。
        const getCurrentCollectionInfo = () => {
            const clean = value => String(value || '').replace(/_哔哩哔哩_bilibili$/, '').replace(/\s+/g, ' ').trim();
            const currentBv = (location.pathname.match(/\/(BV[a-zA-Z0-9]+)(?:\/|$)/i) || [])[1] || '';
            const urlPart = Math.max(1, Number(new URLSearchParams(location.search).get('p')) || 1);
            const pods = Array.from(document.querySelectorAll('.video-pod'));
            if (!pods.length) return null;

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
                const collectionTitle = clean(headerLink?.getAttribute('title'));
                const href = String(headerLink?.getAttribute('href') || '');
                const sid = (href.match(/[?&]sid=(\d+)/i) || [])[1] || '';
                const seasonId = (href.match(/[?&]season_id=(\d+)/i) || [])[1] || '';

                const videos = rows.map((row, rowIndex) => {
                    const bvId = clean(row.getAttribute('data-key') || '');
                    const multiPod = row.querySelector(':scope > .multi-p');
                    const head = row.querySelector('.multi-p > .head, .simple-base-item.head, .simple-base-item.normal');
                    const headTitle = clean(head?.querySelector('.title')?.getAttribute('title')
                                            || head?.querySelector('.title-txt')?.textContent
                                            || head?.getAttribute('title'));
                    // multi-p 的 head 是大合集内的“小合集/课程”名称；single-p 的 head 本身就是具体视频名。
                    const smallCollectionTitle = multiPod ? headTitle : '';
                    const videoTitle = multiPod ? '' : (headTitle
                                                        || clean(row.querySelector(':scope .single-p .title')?.getAttribute('title')
                                                                 || row.querySelector(':scope .single-p .title-txt')?.textContent));
                    const pageNodes = Array.from(row.querySelectorAll('.page-list .page-item.sub'));
                    const pages = pageNodes.map((node, index) => ({
                        title: clean(node.querySelector('.title')?.getAttribute('title')
                                     || node.querySelector('.title-txt')?.textContent
                                     || node.getAttribute('title')),
                        pageNumber: index + 1,
                        active: node.classList.contains('active')
                        || !!node.querySelector('.simple-base-item.active')
                    })).filter(page => page.title);

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
                const identity = sid ? `sid:${sid}` : seasonId ? `season:${seasonId}` :
                videos.map(video => `${video.bvId || video.videoTitle}:${video.pages.map(page => page.title).join('|')}`).join('||');
                let hash = 2166136261;
                for (let i = 0; i < identity.length; i++) {
                    hash ^= identity.charCodeAt(i);
                    hash = Math.imul(hash, 16777619);
                }
                const collectionKey = `pod-${(hash >>> 0).toString(36)}-${videos.length}`;
                const allParts = videos.flatMap(video => video.pages.map(page => ({
                    title: page.title,
                    bvId: video.bvId,
                    smallCollectionTitle: video.smallCollectionTitle || '',
                    collectionOrder: video.collectionOrder,
                    index: page.pageNumber,
                    partTotal: video.pages.length
                })));
                return { pod, collectionTitle, collectionKey, videos, allParts };
            };

            const parsedPods = pods.map(parsePod).filter(Boolean);
            if (!parsedPods.length) return null;

            let currentPod = currentBv
            ? parsedPods.find(info => info.videos.some(video => video.bvId.toLowerCase() === currentBv.toLowerCase()))
            : null;
            if (!currentPod) {
                currentPod = parsedPods.find(info => info.videos.some(video => video.active)) || null;
            }
            if (!currentPod) return null;

            let currentVideo = currentBv
            ? currentPod.videos.find(video => video.bvId.toLowerCase() === currentBv.toLowerCase())
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
        const getCurrentPlayerTitle = () => {
            const collectionInfo = getCurrentCollectionInfo();
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

        // 每次本地播放记录写入时同步保存合集指纹和集序号；这只增加元数据，不改变 key/快照/次数。
        const applyCollectionInfo = (record, info = getCurrentCollectionInfo()) => {
            if (!info) return;
            record.collectionKey = info.collectionKey;
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

        // 当前页的选集列表还包含同一 BV 其他 P 的真实标题；顺手修复已经被旧版本写成合集名的旧记录。
        // 仅更新已存在记录的标题与合集元数据，不创建记录、不改观看次数和快照。
        const repairedPlaylistSignatures = new Set();
        const repairKnownPlaylistPartTitles = (currentKey, info) => {
            if (!info || !Array.isArray(info.parts) || !info.parts.length) return;
            const signature = `${String(currentKey || '').match(/^(BV[a-zA-Z0-9]+)/i)?.[1] || currentKey}:${info.collectionKey}`;
            if (repairedPlaylistSignatures.has(signature)) return;
            repairedPlaylistSignatures.add(signature);

            for (const part of info.parts) {
                const bvId = String(part.bvId || '').trim();
                const pageNumber = Number(part.index) || 1;
                if (!bvId || !part.title) continue;
                const key = pageNumber === 1 ? bvId : `${bvId}?p=${pageNumber}`;
                const raw = GM_getValue(key);
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
                const record = RecordNormalizer.normalize(raw);
                if (!record) continue;
                let changed = false;

                // 旧记录如果被官方合集标题污染，使用当前页面选集 DOM 中的具体分 P 标题修复。
                if (record.title !== part.title) {
                    record.title = part.title;
                    record.titleSource = 'player';
                    changed = true;
                }
                if (record.partTitle !== part.title) { record.partTitle = part.title; changed = true; }
                const smallCollectionTitle = part.smallCollectionTitle || '';
                if (record.smallCollectionTitle !== smallCollectionTitle) { record.smallCollectionTitle = smallCollectionTitle; changed = true; }
                const collectionOrder = Number(part.collectionOrder) || 0;
                if (record.collectionOrder !== collectionOrder) { record.collectionOrder = collectionOrder; changed = true; }
                if (record.collectionKey !== info.collectionKey) { record.collectionKey = info.collectionKey; changed = true; }
                if (record.partNumber !== pageNumber) { record.partNumber = pageNumber; changed = true; }
                if (record.partTotal !== part.partTotal) { record.partTotal = part.partTotal; changed = true; }
                const collectionTitle = info.collectionTitle || '';
                if (record.collectionTitle !== collectionTitle) {
                    record.collectionTitle = collectionTitle;
                    changed = true;
                }
                if (changed) RecordStore.set(key, record);
            }
        };

        const readRecord = key => {
            const rec = LegacyMigration.migrateAny(GM_getValue(key));
            if (!rec || typeof rec !== 'object') {
                return { title: null, lastTs: 0, lastProgress: '0%', watchCount: 0, snapshots: [], hasReachedWatchThreshold: false };
            }
            if (!Array.isArray(rec.snapshots)) rec.snapshots = [];
            if (!Number.isFinite(Number(rec.watchCount))) rec.watchCount = rec.snapshots.length;
            return rec;
        };

        const saveCompletionSnapshot = context => {
            const { key, video } = context;
            const nowTs = TimeTool.now();
            const collectionInfo = getCurrentCollectionInfo();
            repairKnownPlaylistPartTitles(key, collectionInfo);
            const titleInfo = getCurrentPlayerTitle();
            const record = readRecord(key);
            if (context.seasonId) record.seasonId = context.seasonId;
            if (context.isBangumi) record.mediaType = (record.mediaType && record.mediaType !== '视频') ? record.mediaType : '番剧';

            const duration = Number(video.duration);
            const pos = Number.isFinite(duration) && duration > 0 ? duration : (Number(video.currentTime) || 0);
            const snapshot = {
                ts: nowTs,
                pos,
                progress: '100%',
                watchTimeStr: TimeTool.formatTimestamp(nowTs),
                completed: true,
                source: 'player'
            };

            applyPlayerTitle(record, titleInfo);
            applyCollectionInfo(record, collectionInfo);
            CardDom.mergeAuthorMetadata(record, CardDom.extractAuthorFromVideoPage());
            record.watchCount = Math.max(1, Number(record.watchCount) || 0);
            record.hasReachedWatchThreshold = true;
            RecordNormalizer.appendSnapshot(record, snapshot);
            RecordStore.set(key, record);

            lastEndingSavedKey = key;
            hasSavedSnapshotThisSession = true;
        };

        const loop = () => {
            const context = getCurrentContext();
            if (!context) {
                activeRecordKey = null;
                hasCountedThisSession = false;
                hasSavedSnapshotThisSession = false;
                endingWasVisible = false;
                return;
            }

            const { key, video } = context;
            if (activeRecordKey !== key) resetForVideo(key);
            lastVideoElement = video;

            const ending = document.querySelector('.bpx-player-ending');
            const endingVisible = !!ending && ending.getClientRects().length > 0
            && getComputedStyle(ending).display !== 'none'
            && getComputedStyle(ending).visibility !== 'hidden';

            if (endingVisible && (!endingWasVisible || lastEndingSavedKey !== key)) {
                saveCompletionSnapshot(context);
            }
            if (!endingVisible && endingWasVisible) {
                endingWasVisible = false;
                hasCountedThisSession = false;
                hasSavedSnapshotThisSession = false;
                lastEndingSavedKey = null;
            } else if (endingVisible) {
                endingWasVisible = true;
            }

            if (!Number.isFinite(Number(video.duration)) || Number(video.duration) <= 0) return;
            if (video.paused === true || video.ended === true || (typeof video.readyState === 'number' && video.readyState < 2)) return;

            const curTime = Number(video.currentTime);
            const duration = Number(video.duration);
            if (!Number.isFinite(curTime) || curTime < 0 || !Number.isFinite(duration) || duration <= 0) return;

            const percent = Math.min(99, Math.max(0, Math.floor((curTime / duration) * 100))) + '%';
            const nowTs = TimeTool.now();
            const collectionInfo = getCurrentCollectionInfo();
            repairKnownPlaylistPartTitles(key, collectionInfo);
            const titleInfo = getCurrentPlayerTitle();
            const record = readRecord(key);
            if (context.seasonId) record.seasonId = context.seasonId;
            if (context.isBangumi) record.mediaType = (record.mediaType && record.mediaType !== '视频') ? record.mediaType : '番剧';
            if (curTime >= CONFIG.SHORT_WATCH_MAX_POS_SEC) record.hasReachedWatchThreshold = true;

            if (!hasCountedThisSession) {
                record.watchCount += 1;
                hasCountedThisSession = true;
                StorageApi.checkStorageWarn();
            }
            applyPlayerTitle(record, titleInfo);
            applyCollectionInfo(record, collectionInfo);
            CardDom.mergeAuthorMetadata(record, CardDom.extractAuthorFromVideoPage());

            if (!hasSavedSnapshotThisSession) {
                RecordNormalizer.appendSnapshot(record, {
                    ts: nowTs,
                    pos: curTime,
                    progress: percent,
                    watchTimeStr: TimeTool.formatTimestamp(nowTs),
                    authorName: record.authorName || '',
                    source: 'player'
                });
                hasSavedSnapshotThisSession = true;
            }
            record.lastTs = nowTs;
            record.lastProgress = percent;
            RecordStore.set(key, record);
        };

        const attachVideoEvents = () => {
            const video = document.querySelector('video');
            if (!video || (video === lastVideoElement && video.dataset.bvhEventsAttached === 'true')) return;
            video.dataset.bvhEventsAttached = 'true';
            video.addEventListener('playing', loop);
            video.addEventListener('timeupdate', loop);
            video.addEventListener('ended', loop);
            lastVideoElement = video;
        };

        const observer = new MutationObserver(() => {
            attachVideoEvents();
            loop();
        });
        if (document.body) observer.observe(document.body, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
        });

        let skipOneLoopAfterRouteChange = false;
        const onRouteChange = () => {
            activeRecordKey = null;
            skipOneLoopAfterRouteChange = true;
            PlaybackUI.render();
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
            loop();
        }, CONFIG.RECORD_INTERVAL);

        attachVideoEvents();
        loop();

        window.addEventListener('beforeunload', () => {
            clearInterval(recordTimer);
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
                authorName: record.authorName || '',
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
    function startCardBadgeRenderer() {
        const observerOptions = { root: null, rootMargin: '100px', threshold: 0.1 };
        const cardSelector = '.bili-video-card';
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

        const renderOneCard = target => {
            const link = getVideoLink(target);
            const parsed = link && RecordKey.parse(link.href);
            const container = getCover(target);
            if (!parsed || !container) return;

            let lookupKey = parsed.isBangumi ? parsed.key : parsed.bvid;
            let displayId = parsed.isBangumi ? parsed.key : parsed.bvid;
            let records = RecordStore.getGroupRecords(lookupKey);

            if (!records.length && parsed.isEpisode) {
                const ssLink = target.querySelector?.('a[href*="/bangumi/play/ss"]')
                || target.closest?.('.bili-video-card')?.querySelector?.('a[href*="/bangumi/play/ss"]');
                const ssMatch = ssLink && String(ssLink.getAttribute('href') || '').match(/\/bangumi\/play\/(ss\d+)/i);
                if (ssMatch) {
                    lookupKey = ssMatch[1].toLowerCase();
                    displayId = lookupKey;
                    records = RecordStore.getGroupRecords(lookupKey);
                }
            }

            if (!records.length) {
                container.querySelectorAll('.bvh-tag, .bvh-progress-container').forEach(node => node.remove());
                delete target.dataset.bvhRenderSignature;
                return;
            }

            const bestRec = records[0];
            const latestSnap = Array.isArray(bestRec.snapshots) && bestRec.snapshots.length
            ? bestRec.snapshots.reduce((a, b) => Number(a.ts || 0) >= Number(b.ts || 0) ? a : b)
            : null;

            const signature = `${displayId}|${bestRec.key}|${bestRec.watchCount}|${bestRec.lastProgress}|${bestRec.authorName || ''}|${bestRec.lastTs || 0}|${latestSnap?.watchTimeStr || ''}`;
            if (target.dataset.bvhRenderSignature === signature
                && container.querySelector('.bvh-tag')
                && container.querySelector('.bvh-progress-container')) return;

            container.querySelectorAll('.bvh-tag, .bvh-progress-container').forEach(node => node.remove());
            container.style.position = 'relative';

            const tag = document.createElement('div');
            tag.className = 'bvh-tag';
            tag.textContent = `已观看 ×${bestRec.watchCount} ${bestRec.lastProgress}`;
            tag.title = `记录：${displayId}，作者：${bestRec.authorName || '作者未知'}，最近记录：${bestRec.key}，观看次数：${bestRec.watchCount}，上次进度：${bestRec.lastProgress}`;

            const progress = document.createElement('div');
            progress.className = 'bvh-progress-container';
            const bar = document.createElement('div');
            bar.className = 'bvh-progress-bar';
            bar.style.width = bestRec.lastProgress;
            progress.appendChild(bar);

            container.append(tag, progress);
            target.dataset.bvhRenderSignature = signature;
        };

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
    //       - onStart(callback)  pointerdown 且未命中按钮时触发
    //       - onEnd(didMove, target, el) pointerup/pointercancel 时触发
    //     返回 { isDragging, getDidMove }
    function makeDraggable(el, handle, options = {}) {
        const {
            margin = 8,
            easing = 0.22,
            threshold = 0.45,
            preventDefault = false,
            animateOnEnd = true,
            suppressClickAfterDrag = false,
            onStart = null,
            onEnd = null
        } = options;

        let drag = null;
        let didMove = false;
        let raf = 0;
        let current = null;
        let target = null;

        const clampLeft = v => Math.max(margin, Math.min(window.innerWidth - el.offsetWidth - margin, v));
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
            if (e.button !== 0) return;
            if (e.target.closest('button, input, textarea, select, a')) return;
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
            handle.setPointerCapture?.(e.pointerId);
            if (preventDefault) e.preventDefault();
            if (onStart) onStart(el);
        });

        handle.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.pointerId) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) didMove = true;
            if (!didMove) return;
            target.left = clampLeft(drag.left + dx);
            target.top = clampTop(drag.top + dy);
            if (!raf) raf = requestAnimationFrame(animate);
        });

        const end = e => {
            if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
            drag = null;
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

    // 让状态浮窗能够拖动、靠边停靠，并在鼠标移入时暂时展开。
    function makeDockableFloat(dom) {
        let dockTimer = null;
        let draggable = null;

        const dockLeft = () => {
            if (!dom.isConnected || dom.matches(':hover') || (draggable && draggable.isDragging())) return;
            const rect = dom.getBoundingClientRect();
            if (rect.left > window.innerWidth * 0.55) {
                dom.classList.remove('bvh-docked', 'bvh-docked-right');
                return;
            }
            dom.style.setProperty('--bvh-dock-height', `${Math.max(48, rect.height)}px`);
            dom.style.transition = '';
            dom.style.bottom = 'auto';
            dom.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - Math.max(48, rect.height) - 8))}px`;
            dom.classList.remove('bvh-docked-right');
            dom.classList.add('bvh-docked');
            dom.style.left = '0px';
        };

        const scheduleDock = (delay = 900) => {
            clearTimeout(dockTimer);
            dockTimer = setTimeout(dockLeft, delay);
        };

        draggable = makeDraggable(dom, dom, {
            animateOnEnd: false,
            suppressClickAfterDrag: true,
            onStart: () => {
                dom.classList.remove('bvh-docked', 'bvh-docked-right');
            },
            onEnd: (didMove, target) => {
                if (!didMove || !target) return;
                const left = target.left, top = target.top;
                dom.style.left = `${left <= window.innerWidth * .45 ? 8 : left}px`;
                dom.style.top = `${top}px`;
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

    // 一次性注入脚本使用的样式，避免把样式散落在各个 DOM 创建函数中。
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
                padding: 12px 14px; z-index: 10000; cursor: grab; user-select: none;
                max-width: 260px; min-width: 190px; overflow: hidden;
                transform-origin: left center;
                transition: left .42s cubic-bezier(.22,1,.36,1), top .42s cubic-bezier(.22,1,.36,1),
                    width .42s cubic-bezier(.22,1,.36,1), min-width .42s ease, max-width .42s ease,
                    padding .42s cubic-bezier(.22,1,.36,1), border-radius .42s ease,
                    transform .42s cubic-bezier(.22,1,.36,1), box-shadow .42s ease, background .42s ease;
                will-change: left, top, width, transform;
            }
            #bvh-status-float:active { cursor: grabbing; }
            #bvh-status-float.bvh-docked {
                width: 5px !important; min-width: 5px; max-width: 5px;
                height: var(--bvh-dock-height, auto); min-height: 48px;
                padding: 0; border: 0; border-radius: 0 12px 12px 0;
                background: #fb7299; box-shadow: 0 4px 18px rgba(251,114,153,.32); cursor: pointer;
            }
            #bvh-status-float.bvh-docked:hover,
            #bvh-status-float.bvh-docked:focus-within {
                width: 240px !important; min-width: 190px; max-width: 260px; height: auto;
                padding: 12px 14px; background: rgba(255,255,255,.82);
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
                width: min(480px, calc(100vw - 40px)); height: 460px;
                background: rgba(255,255,255,.80); color: #30323a;
                border: 1px solid rgba(255,255,255,.76); border-radius: 18px;
                box-shadow: 0 14px 42px rgba(35,25,40,.18);
                backdrop-filter: blur(20px) saturate(1.35);
                -webkit-backdrop-filter: blur(20px) saturate(1.35);
                padding: 42px 12px 12px; z-index: 10002; display: none; overflow: hidden;
                box-sizing: border-box;
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
            #bvh-history-list { height: calc(100% - 50px); }

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
                position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center;
                justify-content: center; padding: 20px; box-sizing: border-box;
                background: rgba(35,25,40,.22); backdrop-filter: blur(5px);
                -webkit-backdrop-filter: blur(5px); animation: bvh-record-fade-in .16s ease both;
            }
            .bvh-record-dialog {
                width: min(360px, calc(100vw - 36px)); box-sizing: border-box; padding: 20px;
                border: 1px solid rgba(255,255,255,.82); border-radius: 18px;
                color: #30323a; background: rgba(255,255,255,.92);
                box-shadow: 0 18px 55px rgba(35,25,40,.24), inset 0 1px 0 rgba(255,255,255,.9);
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
            #bvh-history-page-panel {
                position: fixed; left: 24px; bottom: 92px;
                width: 480px; height: 440px; border-radius: 20px;
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
                pointer-events: none;
            }
        `);
    }

    // 播放页浮窗内容：existingFloat 分支和新建分支共用同一份 HTML 生成
    function buildPlaybackFloatHtml(history) {
        const snapshots = Array.isArray(history.snapshots) ? history.snapshots : [];
        const latest = snapshots.reduce((best, snap) => !best || Number(snap.ts || 0) > Number(best.ts || 0) ? snap : best, null);
        const lastWatchDate = latest?.watchTimeStr || '无记录';
        return `
            <div style="font-weight:bold; color:#fb7299;">上次进度: ${history.lastProgress || '0%'}</div>
            <div style="font-size:12px; color:#27ae60;">总观看次数: ${Number(history.watchCount) || 0}</div>
            <div style="font-size:12px; color:#666;">UP：${history.authorName || '作者未知'}</div>
            <div style="font-size:12px; color:#666;">上次观看：${lastWatchDate}</div>
        `;
    }

    // ── 播放页 UI：左下角悬浮窗（单击续播 / 右键菜单 / 历史面板） ──
    const PlaybackUI = {
        // 创建或更新播放页浮窗和相关菜单、历史面板，并绑定操作事件。
        render() {
            if (!window.location.href.includes('/video/') && !window.location.href.includes('/bangumi/play/')) return;
            const parsed = RecordKey.parse(window.location.href);
            if (!parsed) return;
            const key = parsed.key;

            let history = GM_getValue(key);
            history = LegacyMigration.migrateAny(history);

            const existingFloat = document.getElementById('bvh-status-float');
            if (existingFloat) {
                existingFloat.dataset.recordKey = key;
                existingFloat.innerHTML = history
                    ? buildPlaybackFloatHtml(history)
                : `
                        <div style="font-weight:bold; color:#fb7299;">当前视频暂无本地记录</div>
                        <div style="font-size:12px; color:#666;">${key}</div>
                    `;
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
                    <div class="bvh-search-help" hidden>普通搜索：标题、作者、BV号、标签、分集等任意字段包含关键词即可；多个词用空格分开，全部满足才显示。次数>=3、观看<5、count:!=2；进度>50、progress:<=80；时间可写 2024、2024-05、2024-05-01、05-01；快照:45%、snap:2024-05。条件之间用空格分隔。比较符支持 >、<、>=、<=、=、!=；不认识的写法会按普通关键词搜索。</div>
                </div>
                <ul id="bvh-history-list"></ul>
            `;
            document.body.appendChild(historyPanel);

            // 搜索规则放在输入框旁边，点“!”展开说明；点击面板其他位置时不额外干扰搜索。
            const playbackSearch = historyPanel.querySelector('#bvh-history-search');
            playbackSearch.addEventListener('input', () => HistoryListRenderer.renderInto(
                document.getElementById('bvh-history-list'), playbackSearch.value, 'playback'
            ));
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
            });

            let panelDrag = null;
            historyPanel.addEventListener('pointerdown', e => {
                if (e.button !== 0 || e.target.closest('input, button, ul, li')) return;
                const rect = historyPanel.getBoundingClientRect();
                if (e.clientY > rect.top + 38) return;
                panelDrag = {
                    pointerId: e.pointerId, x: e.clientX, y: e.clientY,
                    left: rect.left, top: rect.top
                };
                // 先固定当前实际位置，再切换定位方式，避免第一次拖动时 bottom→top 转换造成闪跳。
                historyPanel.style.left = `${rect.left}px`;
                historyPanel.style.top = `${rect.top}px`;
                historyPanel.style.bottom = 'auto';
                historyPanel.style.transition = 'none';
                historyPanel.setPointerCapture?.(e.pointerId);
                e.preventDefault();
            });
            historyPanel.addEventListener('pointermove', e => {
                if (!panelDrag || e.pointerId !== panelDrag.pointerId) return;
                const dx = e.clientX - panelDrag.x, dy = e.clientY - panelDrag.y;
                historyPanel.style.left = `${Math.max(8, Math.min(window.innerWidth - historyPanel.offsetWidth - 8, panelDrag.left + dx))}px`;
                historyPanel.style.top = `${Math.max(8, Math.min(window.innerHeight - historyPanel.offsetHeight - 8, panelDrag.top + dy))}px`;
            });
            const endPanelDrag = e => {
                if (!panelDrag || (e?.pointerId != null && e.pointerId !== panelDrag.pointerId)) return;
                panelDrag = null;
                historyPanel.style.transition = '';
            };
            historyPanel.addEventListener('pointerup', endPanelDrag);
            historyPanel.addEventListener('pointercancel', endPanelDrag);

            document.addEventListener('click', function globalClosePanels(e) {
                if (e.button === 2) return;
                const menu = document.getElementById('bvh-menu-panel');
                const hist = document.getElementById('bvh-history-panel');
                const floatBox = document.getElementById('bvh-status-float');
                if (!floatBox || !menu || !hist) return;
                if (floatBox.contains(e.target) || menu.contains(e.target) || hist.contains(e.target)) return;
                menu.style.display = 'none';
                hist.style.display = 'none';
            });

            if (history) {
                const floatBox = document.createElement('div');
                floatBox.id = 'bvh-status-float';
                floatBox.innerHTML = buildPlaybackFloatHtml(history);

                let isClick = false;
                floatBox.addEventListener('mousedown', e => { if (e.button === 0) isClick = true; });
                floatBox.addEventListener('mousemove', () => { isClick = false; });
                floatBox.dataset.recordKey = key;
                floatBox.addEventListener('mouseup', e => {
                    if (e.button !== 0 || !isClick) return;
                    const current = RecordKey.parse(window.location.href);
                    if (!current) return;
                    let currentHistory = GM_getValue(current.key);
                    currentHistory = LegacyMigration.migrateAny(currentHistory);
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
                };

                document.body.appendChild(floatBox);
                makeDockableFloat(floatBox);
                floatBox.classList.remove('bvh-docked', 'bvh-docked-right');

                document.getElementById('bvh-show-history').onclick = () => {
                    const hp = document.getElementById('bvh-history-panel');
                    const menu = document.getElementById('bvh-menu-panel');
                    menu.style.display = 'none';
                    hp.style.display = hp.style.display === 'block' ? 'none' : 'block';
                    HistoryListRenderer.renderInto(document.getElementById('bvh-history-list'), document.getElementById('bvh-history-search')?.value || '', 'playback');
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
                        <div class="bvh-search-help" hidden>普通搜索：标题、作者、BV号、标签、分集等任意字段包含关键词即可；多个词用空格分开，全部满足才显示。次数>=3、观看<5、count:!=2；进度>50、progress:<=80；时间可写 2024、2024-05、2024-05-01、05-01；快照:45%、snap:2024-05。条件之间用空格分隔。比较符支持 >、<、>=、<=、=、!=；不认识的写法会按普通关键词搜索。</div>
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

            // 官方历史页和播放页共用同一套搜索语法；帮助内容仅在用户主动点击时展开。
            panel.querySelector('.bvh-search-help-btn').addEventListener('click', e => {
                const button = e.currentTarget;
                const help = panel.querySelector('.bvh-search-help');
                help.hidden = !help.hidden;
                button.setAttribute('aria-expanded', String(!help.hidden));
            });

            const pageFloat = entry.querySelector('#bvh-status-float');
            makeDockableFloat(pageFloat);
            pageFloat.onclick = () => {
                if (pageFloat.classList.contains('bvh-docked')) {
                    pageFloat.classList.remove('bvh-docked', 'bvh-docked-right');
                    pageFloat.style.left = '24px';
                    pageFloat.style.bottom = '24px';
                    pageFloat.style.top = 'auto';
                }
                panel.classList.toggle('bvh-hp-show');
                if (panel.classList.contains('bvh-hp-show')) {
                    HistoryListRenderer.renderInto(document.getElementById('bvh-hp-list'), document.getElementById('bvh-hp-search')?.value || '', 'history-page');
                }
            };

            document.getElementById('bvh-hp-close-btn').onclick = e => {
                e.stopPropagation();
                panel.classList.remove('bvh-hp-show');
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

            makeDraggable(panel, document.getElementById('bvh-hp-drag-bar'), { preventDefault: true });
        }
    };

    // 在官方历史页监听卡片变化，延迟合并同步，避免每次 DOM 更新都立即扫描。
    function startHistoryAutoSync() {
        if (!location.href.startsWith('https://www.bilibili.com/history')) return;
        let timer = null;
        let lastCount = document.querySelectorAll('.history-card__main .bili-video-card').length;

        const scheduleSync = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                OfficialHistorySync.sync(true);
            }, CONFIG.AUTO_SYNC_DEBOUNCE);
        };

        const observer = new MutationObserver(mutations => {
            const count = document.querySelectorAll('.history-card__main .bili-video-card').length;
            const cardChanged = mutations.some(m =>
                                               [...m.addedNodes].some(node => {
                if (node.nodeType !== Node.ELEMENT_NODE) return false;
                return node.matches?.('.history-card__main .bili-video-card, .bili-video-card')
                || !!node.querySelector?.('.history-card__main .bili-video-card, .bili-video-card');
            })
                                              );
            if (count !== lastCount || cardChanged) {
                lastCount = count;
                scheduleSync();
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
    }

    // 启动时检查本地记录格式，只在归一化结果确有变化时写回。
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

    // ── 入口：注入样式 → 加载设置 → 注册菜单 → 归一化存量记录 → 启动各子系统 ──
    function mainInit() {
        injectStyle();
        loadSettings();
        registerMenus();

        normalizeAllLocalRecords();
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
        startPlaybackRecorder();
        startLiveRecorder();
        PlaybackUI.render();
    }

    mainInit();
})();
