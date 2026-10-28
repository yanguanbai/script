// ==UserScript==
// @name         B站视频浏览足迹
// @namespace    https://greasyfork.org/
// @version      10.3.1
// @description  抓取列表中出现的视频，可搜索回溯；记录可持久化到GM；菜单可设置最大保留条数、悬浮球计数气泡开关、已看标记开关
// @author       Bart
// @match        *://www.bilibili.com/*
// @match        *://search.bilibili.com/*
// @exclude      *://www.bilibili.com/video/*
// @exclude      *://www.bilibili.com/list/ml*
// @exclude      *://www.bilibili.com/history*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-end
// @icon         https://www.bilibili.com/favicon.ico
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/564445/B%E7%AB%99%E8%A7%86%E9%A2%91%E6%B5%8F%E8%A7%88%E8%B6%B3%E8%BF%B9.user.js
// @updateURL https://update.greasyfork.org/scripts/564445/B%E7%AB%99%E8%A7%86%E9%A2%91%E6%B5%8F%E8%A7%88%E8%B6%B3%E8%BF%B9.meta.js
// ==/UserScript==

(function () {
    'use strict';

    /* ═══════════════════════════════════════════════════════════════════
     * 功能总览
     * ═══════════════════════════════════════════════════════════════════
     *
     * 脚本运行在 B 站的"列表类"页面（首页、搜索结果页、频道页等），
     * 已在 @exclude 中排除播放页 / 收藏列表 / 历史记录页。
     * 一共做两件事：
     *
     * 【浏览足迹】
     *   · 用 IntersectionObserver 监听页面上的视频卡片，
     *     卡片真正滚进视口（可见度 ≥ 10%）时才记一笔，
     *     而不是把整个 DOM 里的视频一次性全抓下来。
     *   · 每条记录包含：BV 号、标题、封面、UP 主、时长、跳转链接。
     *   · 新记录插在列表最前面；同一个 BV 号只保留一份。
     *   · 记录显示在右下角悬浮球弹出的面板里，支持：
     *       - 关键词搜索（标题 / BV 号 / UP 主，命中片段高亮）
     *       - 点击条目新标签页跳转
     *       - 一键清空
     *       - 长按悬浮球切换浅色 / 深色主题
     *       - 拖动悬浮球换位置，松手后自动吸附到最近的屏幕边缘
     *   · 记录可选择持久化到 GM 存储（跨页面、跨会话保留），
     *     也可以设为"不储存"，此时只在当前页面生命周期内有效。
     *
     * 【已看标记】
     *   · 在列表页用鼠标按下某个视频卡片时，把它的 BV 号记成"已看过"。
     *   · 之后刷新或重新滚动到该卡片时，封面左上角会出现粉色的"已看"角标，
     *     方便一眼跳过刷到过的内容。
     *   · 该功能可以在油猴菜单里一键关闭：关闭后既不写入"已看"状态，
     *     也不显示角标，页面上已画出的角标会被立即清除。
     *
     * ═══════════════════════════════════════════════════════════════════
     * 可配置项（全部通过油猴菜单修改，改完立即生效并写入 GM）
     * ═══════════════════════════════════════════════════════════════════
     *
     *   · 最大保留条数      范围 0 - 3000，默认 100。
     *                       0 = 不储存：记录只在本次浏览有效，刷新后清空；
     *                       大于 0 时超出上限会自动删除最旧的记录。
     *
     *   · 悬浮球计数气泡    开 / 关，默认开。
     *                       开启时：悬浮球右上角显示记录条数，
     *                               超过 99 条则显示 "99+"，避免数字撑破气泡；
     *                       关闭时：整个计数气泡隐藏，悬浮球只保留图标。
     *
     *   · 已看标记          开 / 关，默认开。
     *                       关闭后不再记录"已看"状态，也不再显示角标。
     *
     * 菜单文案里的"当前：xxx"会尽量即时刷新，机制见 registerMenus 的注释。
     */

    /* ═══════════════════════════════════════════════════════════════════
     * 存储键与默认值
     *
     * 集中管理所有 GM 键名与参数，改默认值、改范围只需要动这里。
     * ═══════════════════════════════════════════════════════════════════ */

    // 足迹数组的存储键：整个数组作为一个值存取，结构简单、读写开销小
    const FOOTPRINT_STORAGE_KEY = 'bvh_footprint_list_v1';

    // 用户设置的存储键。键名沿用旧版本的名字，
    // 这样老用户升级后原来的设置不会丢失。
    const SETTINGS_KEY = 'bvh_footprint_limit_settings_v1';

    // 主题模式沿用旧键，兼容老用户已有配置
    const MODE_SETTINGS_KEY = 'footprint_mode';

    // "已看"状态的存储键前缀：每个视频一个键（v_<BV号> = true）
    const VIEWED_KEY_PREFIX = 'v_';

    // 悬浮球气泡显示 "N+" 的阈值。固定值，不开放给用户填数字，
    // 开关只决定"要不要显示计数气泡"。
    const BUBBLE_CAP = 99;

    // 用户设置的默认值
    const DEFAULT_SETTINGS = {
        limit: 100,       // 最大保留条数（0 = 仅本次浏览，不写 GM）
        bubbleCap: true,  // 悬浮球是否显示计数气泡（true = 显示，超 99 显示 "99+"）
        viewedTag: true,  // 是否启用"已看"角标
    };

    // 数值型设置的合法区间：用于菜单输入校验 + 加载时的脏数据兜底
    const RANGE = {
        limit: { min: 0, max: 3000 },
    };

    // 运行时真正生效的设置，由 loadSettings() 从 GM 中填充
    const settings = Object.assign({}, DEFAULT_SETTINGS);

    /* ═══════════════════════════════════════════════════════════════════
     * 设置的读取 / 保存
     * ═══════════════════════════════════════════════════════════════════ */

    // 判断一个值是否是该区间内的合法整数
    function isValidNumber(value, range) {
        return typeof value === 'number'
            && Number.isInteger(value)
            && value >= range.min
            && value <= range.max;
    }

    // 从 GM 读取用户设置，逐项校验；任何一项非法都回退到默认值，
    // 避免一条脏数据把整个配置带偏。
    // 旧版本存过数字型的 bubbleMax，这里不再读取，直接落到默认的 bubbleCap。
    function loadSettings() {
        let saved = null;
        try {
            saved = GM_getValue(SETTINGS_KEY, null);
        } catch (e) {
            return; // 读取失败就用默认值
        }
        if (!saved || typeof saved !== 'object') return;

        if (isValidNumber(saved.limit, RANGE.limit)) {
            settings.limit = saved.limit;
        }
        if (typeof saved.bubbleCap === 'boolean') {
            settings.bubbleCap = saved.bubbleCap;
        }
        if (typeof saved.viewedTag === 'boolean') {
            settings.viewedTag = saved.viewedTag;
        }
    }

    // 把当前设置整体写回 GM
    function saveSettings() {
        try {
            GM_setValue(SETTINGS_KEY, {
                limit: settings.limit,
                bubbleCap: settings.bubbleCap,
                viewedTag: settings.viewedTag,
                updatedAt: Date.now(),
            });
        } catch (e) {
            console.warn('[B站浏览足迹] 保存设置失败：', e);
        }
    }

    // 面板 / 菜单里展示"最大保留条数"的文案：0 显示成"本次"
    function limitLabel() {
        return settings.limit === 0 ? '本次' : settings.limit;
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 菜单注册
     *
     * 关键点：GM_registerMenuCommand 的文案在注册那一刻就被固定成字符串，
     * 之后脚本内部修改设置，油猴不会自动重绘菜单——这就是"菜单不更新"的原因。
     *
     * 解决办法是"注销旧的 + 用新文案重新注册"：
     *   · Tampermonkey / Violentmonkey 支持 GM_unregisterMenuCommand(id)，
     *     可以即时刷新菜单文案；
     *   · Greasemonkey 4 没有该 API，返回的 id 也是 undefined，
     *     此时只能等下次页面加载（脚本重跑、重新注册）时更新，
     *     这里会避免重复注册，防止菜单项越堆越多。
     * ═══════════════════════════════════════════════════════════════════ */

    // 已注册菜单项的 id 列表，用于注销后重新注册
    let menuCommandIds = [];
    // 当前管理器是否支持注销菜单（取决于 GM_registerMenuCommand 是否返回 id）
    let canUnregisterMenus = false;

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        // 先注销上一轮注册的菜单项，避免重复堆积
        if (typeof GM_unregisterMenuCommand === 'function') {
            for (const id of menuCommandIds) {
                try { GM_unregisterMenuCommand(id); } catch (e) {}
            }
        }
        menuCommandIds = [];

        const add = (label, handler) => {
            const id = GM_registerMenuCommand(label, handler);
            // Tampermonkey / Violentmonkey 返回 id；GM4 返回 undefined
            if (id !== undefined && id !== null) {
                menuCommandIds.push(id);
                canUnregisterMenus = true;
            }
        };

        add(`最大保留条数（当前：${limitLabel()}）`, configureLimit);
        add(`悬浮球计数气泡（当前：${settings.bubbleCap ? '开' : '关'}）`, toggleBubbleCap);
        add(`已看标记（当前：${settings.viewedTag ? '开' : '关'}）`, toggleViewedTag);
    }

    // 设置变更后调用：让菜单文案尽量即时反映新值。
    // 不支持注销的管理器无法刷新，这里不做任何事，避免重复注册；
    // 文案会在下次页面加载时变成新值。
    function refreshMenus() {
        if (canUnregisterMenus) registerMenus();
    }

    // 菜单：设置最大保留条数
    function configureLimit() {
        const input = prompt(
            `设置足迹最大保留条数（${RANGE.limit.min} - ${RANGE.limit.max}）。\n` +
            `· 新记录在最上面，超过上限会自动删除最旧的记录；\n` +
            `· 输入 0 = 不储存：记录只在本次浏览有效，刷新页面后清空。`,
            String(settings.limit)
        );
        if (input === null) return; // 用户点了取消

        const n = Number(input.trim());
        if (!isValidNumber(n, RANGE.limit)) {
            alert(`请输入 ${RANGE.limit.min} 到 ${RANGE.limit.max} 之间的整数，设置未更改。`);
            return;
        }

        settings.limit = n;
        saveSettings();

        if (n === 0) {
            // 切到"不储存"：清空内存中的记录，并删掉 GM 里的旧数据，
            // 否则下次启动会把旧数据重新读回来，等于没切。
            footprint = [];
            try { GM_deleteValue(FOOTPRINT_STORAGE_KEY); } catch (e) {}
        } else {
            // 从"不储存"切回来、或者把上限调小：
            // 立即裁剪一次并落盘，本次已抓到的记录不会凭空消失。
            trimFootprint();
            persistFootprint();
        }
        updateHeaderCount();
        updateListUI();
        refreshMenus(); // 让菜单上的"当前：xxx"立刻变成新值

        alert(n === 0
            ? '已设为"不储存"：记录仅本次浏览有效，刷新页面后清空，GM 中已有的旧记录已删除。'
            : `已设置最大保留条数为 ${n} 条，超出将自动删除最旧的记录。`);
    }

    // 菜单：开关"悬浮球计数气泡"
    function toggleBubbleCap() {
        settings.bubbleCap = !settings.bubbleCap;
        saveSettings();
        updateHeaderCount(); // 立刻刷新气泡
        refreshMenus();      // 立刻刷新菜单文案

        alert(settings.bubbleCap
            ? `已开启：悬浮球显示记录数，超过 ${BUBBLE_CAP} 条时显示 "${BUBBLE_CAP}+"。`
            : '已关闭：悬浮球不再显示计数气泡。');
    }

    // 菜单：开关"已看"标记
    function toggleViewedTag() {
        settings.viewedTag = !settings.viewedTag;
        saveSettings();
        refreshMenus();

        if (settings.viewedTag) {
            // 重新开启：GM 里已有的"已看"记录还在，
            // 下一轮扫描（800ms 内）会自动把角标补回来。
            alert('已看标记：已开启。鼠标按下过的视频会在列表页显示"已看"角标。');
        } else {
            // 关闭时顺手清掉页面上已经画出来的角标，避免视觉残留。
            document.querySelectorAll('.viewed-tag').forEach(tag => tag.remove());
            alert('已看标记：已关闭。不再记录"已看"状态，也不再显示角标。');
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 足迹的持久化
     *
     * settings.limit = 0 时不读不写 GM（纯内存，刷新即丢）；
     * 大于 0 时，新增 / 清空 / 改设置都会写回 GM。
     * 加载时做结构校验与 BV 去重，坏数据不会拖垮脚本。
     * ═══════════════════════════════════════════════════════════════════ */

    let footprint = [];

    function loadFootprint() {
        footprint = [];
        // 0 = 不储存模式：不读 GM，完全等同旧版的内存行为
        if (settings.limit === 0) return;

        try {
            const raw = GM_getValue(FOOTPRINT_STORAGE_KEY, []);
            if (!Array.isArray(raw)) return;

            // 逐条校验，丢弃损坏项；按 BV 去重，防止历史脏数据重复
            const seen = new Set();
            for (const item of raw) {
                if (!item || typeof item !== 'object') continue;
                const bv = String(item.bv || '');
                if (!bv || seen.has(bv)) continue;
                seen.add(bv);
                footprint.push({
                    bv,
                    title: String(item.title || '视频名称'),
                    pic: String(item.pic || ''),
                    url: String(item.url || ''),
                    author: String(item.author || '未知作者'),
                    duration: String(item.duration || ''),
                });
            }
            trimFootprint(); // 启动时兜底裁剪一次（用户可能在别处把上限改小了）
        } catch (e) {
            footprint = [];
        }
    }

    function persistFootprint() {
        // 0 = 不储存模式：不写 GM
        if (settings.limit === 0) return;
        try {
            GM_setValue(FOOTPRINT_STORAGE_KEY, footprint);
        } catch (e) {
            console.warn('[B站浏览足迹] 写入 GM 存储失败：', e);
        }
    }

    // 超限裁剪：新记录 unshift 在数组头部，尾部是最旧的，从尾部删。
    // 0 = 不储存模式不裁剪（本次浏览内不设上限）。
    function trimFootprint() {
        if (settings.limit > 0 && footprint.length > settings.limit) {
            footprint.splice(settings.limit);
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 样式
     *
     * 风格参考:毛玻璃(backdrop-filter)、粉色渐变标题栏、
     * 圆角卡片、hover 抬升、聚焦光环。浅色 / 深色两套主题。
     * ═══════════════════════════════════════════════════════════════════ */

    let currentMode = GM_getValue(MODE_SETTINGS_KEY, 'light');
    let searchTerm = '';

    GM_addStyle(`
        #footprint-panel { position: fixed; right: 20px; bottom: 100px; z-index: 200000; touch-action: none; user-select: none; }

        /* ── 悬浮球：毛玻璃 + 计数气泡 ── */
        .foot-btn {
            width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
            cursor: move; font-size: 24px; position: relative;
            backdrop-filter: blur(12px) saturate(1.3);
            -webkit-backdrop-filter: blur(12px) saturate(1.3);
            transition: transform .28s cubic-bezier(.2,1.4,.4,1), box-shadow .28s ease;
        }
        .foot-btn:hover { transform: scale(1.1); }
        .foot-count {
            position: absolute; top: -4px; right: -6px; min-width: 18px; height: 18px;
            padding: 0 4px; box-sizing: border-box; border-radius: 9px;
            background: #fb7299; color: #fff; font-size: 10px; line-height: 18px;
            text-align: center; font-weight: 700; border: 2px solid #fff;
            box-shadow: 0 2px 8px rgba(251,114,153,.5); pointer-events: none;
        }

        /* ── 列表面板：毛玻璃圆角大卡片 ── */
        #footprint-list {
            position: absolute; width: 360px; border-radius: 18px;
            display: none; flex-direction: column; overflow: hidden; z-index: 200001;
            backdrop-filter: blur(20px) saturate(1.35);
            -webkit-backdrop-filter: blur(20px) saturate(1.35);
            animation: fp-panel-in .32s cubic-bezier(.2,1.2,.35,1) both;
        }
        @keyframes fp-panel-in {
            from { opacity: 0; transform: translateY(9px) scale(.985); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .list-content { flex-grow: 1; overflow-y: auto; padding: 10px; height: 450px; }
        .list-content::-webkit-scrollbar { width: 5px; }
        .list-content::-webkit-scrollbar-thumb { border-radius: 10px; }

        /* ── 头部：粉色渐变标题栏（沿用 B 站粉 #fb7299） ── */
        .list-header { padding: 12px 14px 12px; flex-shrink: 0; }
        .list-header-title {
            font-weight: 700; margin-bottom: 10px; font-size: 13px; letter-spacing: .2px;
            display: flex; align-items: center; justify-content: space-between;
        }
        .fp-count-badge {
            font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 9px;
            background: rgba(255,255,255,.28);
        }

        /* ── 搜索框：聚焦光环 ── */
        .search-box {
            width: 100%; padding: 9px 11px; border-radius: 11px; outline: none;
            font-size: 12px; box-sizing: border-box;
            transition: border-color .2s ease, box-shadow .2s ease;
        }

        /* ── 条目与按钮 ── */
        .foot-item {
            display: flex; gap: 12px; padding: 10px; text-decoration: none !important;
            border-radius: 10px; margin-bottom: 4px;
            transition: background .2s ease, transform .2s ease;
        }
        .foot-item:hover { transform: translateY(-1px); }
        .foot-item img { width: 110px; height: 68px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
        .foot-item-info { flex: 1; min-width: 0; }
        .foot-item-title { font-weight: 500; font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
        .clear-all-btn {
            width: 100%; padding: 8px; border: none; border-radius: 11px; cursor: pointer;
            font-size: 12px; transition: background .2s ease, transform .2s ease;
        }
        .clear-all-btn:hover { transform: translateY(-1px); }

        /* ═══ 浅色主题 ═══ */
        .mode-light .foot-btn {
            background: rgba(255,255,255,.85) !important; border: 1px solid rgba(251,114,153,.28); color: #fb7299;
            box-shadow: 0 8px 22px rgba(251,114,153,.25), inset 0 1px 0 rgba(255,255,255,.9);
        }
        .mode-light .foot-btn:hover { box-shadow: 0 10px 28px rgba(251,114,153,.35); }
        .mode-light #footprint-list {
            background: rgba(255,255,255,.82) !important; border: 1px solid rgba(255,255,255,.75);
            box-shadow: 0 14px 42px rgba(35,25,40,.18), inset 0 1px 0 rgba(255,255,255,.8);
        }
        .mode-light .list-header {
            background: linear-gradient(135deg, rgba(251,114,153,.96) 0%, rgba(255,158,187,.9) 100%) !important;
            color: #fff !important;
        }
        .mode-light .foot-item { color: #18191c !important; border-bottom: 1px solid rgba(235,228,235,.7); }
        .mode-light .foot-item:hover { background: rgba(255,240,245,.9); }
        .mode-light .list-content::-webkit-scrollbar-thumb { background: rgba(251,114,153,.35); }
        .mode-light .search-box {
            background: rgba(255,255,255,.7); border: 1px solid rgba(225,220,228,.85); color: #30323a;
        }
        .mode-light .search-box:focus { border-color: #fb7299; box-shadow: 0 0 0 3px rgba(251,114,153,.12); }
        .mode-light .clear-all-btn { background: rgba(241,242,243,.9); color: #61666d; }
        .mode-light .clear-all-btn:hover { background: #ffe4ec; color: #fb7299; }
        .mode-light .highlight { color: #fb7299; font-weight: bold; }

        /* ═══ 深色主题 ═══ */
        .mode-dark .foot-btn {
            background: rgba(42,42,42,.88) !important; border: 1px solid rgba(255,215,0,.28); color: #ffd700 !important;
            box-shadow: 0 8px 22px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08);
        }
        .mode-dark .foot-count { border-color: #2a2a2a; }
        .mode-dark #footprint-list {
            background: rgba(24,24,24,.88) !important; border: 1px solid rgba(255,255,255,.09);
            box-shadow: 0 16px 46px rgba(0,0,0,.55);
        }
        .mode-dark .list-header {
            background: linear-gradient(135deg, rgba(190,55,105,.96) 0%, rgba(150,35,80,.92) 100%) !important;
            color: #fff !important; border-bottom: 1px solid rgba(255,255,255,.08);
        }
        .mode-dark .foot-item { color: #ccc !important; border-bottom: 1px solid rgba(255,255,255,.06); }
        .mode-dark .foot-item:hover { background: rgba(251,114,153,.14); }
        .mode-dark .list-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); }
        .mode-dark .search-box {
            background: rgba(255,255,255,.07) !important; border: 1px solid rgba(255,255,255,.14); color: #eee;
        }
        .mode-dark .search-box:focus { border-color: #fb7299; box-shadow: 0 0 0 3px rgba(251,114,153,.22); }
        .mode-dark .clear-all-btn { background: rgba(255,255,255,.07); color: #a5a5a5; }
        .mode-dark .clear-all-btn:hover { background: rgba(251,114,153,.18); color: #ffd700; }
        .mode-dark .highlight { color: #ffd700; font-weight: bold; }
    `);

    // 同步头部计数徽标（"12 / 100"）和悬浮球气泡
    function updateHeaderCount() {
        const badge = document.querySelector('.fp-count-badge');
        if (badge) badge.textContent = `${footprint.length} / ${limitLabel()}`;

        const bubble = document.querySelector('.foot-count');
        if (bubble) {
            // 开关关闭，或没有记录时，整个气泡隐藏
            const show = settings.bubbleCap && footprint.length > 0;
            bubble.style.display = show ? 'block' : 'none';
            if (show) {
                // 超过阈值才截断为 "99+"，否则显示真实条数
                bubble.textContent = footprint.length > BUBBLE_CAP
                    ? BUBBLE_CAP + '+'
                    : footprint.length;
            }
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 采集逻辑
     *
     * 卡片滚动进入视口（可见度 ≥ 10%）时才记录，避免把懒加载列表里
     * 一堆还没真正露面的视频也抓进来。
     * ═══════════════════════════════════════════════════════════════════ */

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) recordTrace(entry.target);
        });
    }, { threshold: 0.1 });

    const recordTrace = (el) => {
        // 卡片里找第一个指向视频页的链接，从中提取 BV 号
        const a = el.querySelector('a[href*="/video/BV"]');
        if (!a) return;
        const bv = a.href.match(/BV[a-zA-Z0-9]+/)?.[0];
        if (!bv || footprint.some(item => item.bv === bv)) return; // 重复的不再记录

        // ── 标题：优先用卡片标题元素的 title 属性，其次取文本 ──
        let title = '';
        const targetTitleEl = el.querySelector('.bili-video-card__title, .bili-video-card__info--tit, .title, .h-title');
        if (targetTitleEl) {
            title = targetTitleEl.getAttribute('title') || targetTitleEl.innerText.replace(/<em.*?\/em>/g, '').trim();
        }
        if (!title) {
            title = a.getAttribute('title') || a.innerText.trim();
        }
        title = title.replace(/\n/g, '').trim();
        // 搜索页有些卡片会把播放量/弹幕数当标题，这里过滤掉
        if (/^\d+(\.\d+)?[万次]?播放$/.test(title) || /^\d+弹幕$/.test(title)) {
            title = '';
        }

        // ── UP 主 ──
        const authorEl = el.querySelector('.bili-video-card__info--author, .up-name, .author, .up, .up-info-name, a[href*="space.bilibili.com"]');
        let author = '未知作者';
        if (authorEl) {
            author = authorEl.innerText.trim() || authorEl.getAttribute('title') || '';
        }

        const img = el.querySelector('img');
        const durationEl = el.querySelector('.bili-video-card__stats__duration, .duration, .time, .length, .bili-video-card__duration');

        footprint.unshift({
            bv,
            title: title || '视频名称',
            pic: img ? (img.currentSrc || img.src) : '',
            url: a.href,
            author: author,
            duration: durationEl ? durationEl.innerText.trim() : '',
        });
        trimFootprint();    // 超过上限自动删除最旧的（0 = 不储存模式下不裁剪）
        persistFootprint(); // 立即写回 GM（0 = 不储存模式下不写）
        updateHeaderCount();
        updateListUI();
    };

    /* ═══════════════════════════════════════════════════════════════════
     * "已看"标记
     *
     * 记录：在列表页用鼠标按下某个视频卡片时，把 v_<BV号> 写进 GM。
     * 展示：定时扫描页面上的卡片，若该 BV 号已被记录，
     *       就在封面左上角插一个"已看"角标（每张卡片最多一个）。
     * 开关：settings.viewedTag 为 false 时，记录与展示都不执行。
     * ═══════════════════════════════════════════════════════════════════ */

    // 从卡片里提取 BV 号
    function extractBv(card) {
        const a = card.querySelector('a[href*="/video/BV"]');
        return a?.href.match(/BV[a-zA-Z0-9]+/)?.[0] || '';
    }

    // 若该卡片对应的视频已被标记为"已看"，就在封面左上角盖上角标
    function markViewedCard(card) {
        const bv = extractBv(card);
        if (!bv || card.querySelector('.viewed-tag')) return; // 没有 BV 或已经盖过章
        if (!GM_getValue(VIEWED_KEY_PREFIX + bv)) return;     // 没看过，跳过

        const pic = card.querySelector('.bili-video-card__image--wrap, .pic, .cover, .img, .thumb, .v-img');
        if (!pic) return;

        // 角标用绝对定位，封面容器需要成为定位参照
        pic.style.position = 'relative';
        pic.insertAdjacentHTML('afterbegin',
            '<div class="viewed-tag" style="position:absolute;top:6px;left:6px;background:#fb7299;color:white;padding:2px 6px;border-radius:4px;font-size:11px;z-index:20;font-weight:bold;pointer-events:none;">已看</div>');
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 列表渲染
     * ═══════════════════════════════════════════════════════════════════ */

    const updateListUI = () => {
        const content = document.querySelector('.list-content');
        if (!content) return;

        const filtered = searchTerm
            ? footprint.filter(i =>
                i.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                i.bv.toLowerCase().includes(searchTerm.toLowerCase()) ||
                i.author.toLowerCase().includes(searchTerm.toLowerCase()))
            : footprint;

        content.innerHTML = filtered.length === 0
            ? `<div style="text-align:center;padding:40px;color:#9499a0;">暂无记录</div>`
            : filtered.map(item => {
                let displayTitle = item.title;
                let displayAuthor = item.author;
                // 搜索时把命中的片段包上高亮标签
                if (searchTerm) {
                    const reg = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                    displayTitle = item.title.replace(reg, '<span class="highlight">$1</span>');
                    displayAuthor = item.author.replace(reg, '<span class="highlight">$1</span>');
                }
                return `
                <a href="${item.url}" target="_blank" class="foot-item">
                    <img src="${item.pic}" onerror="this.src='https://static.hdslb.com/images/transparent.gif'">
                    <div class="foot-item-info">
                        <div class="foot-item-title">${displayTitle}</div>
                        <div style="font-size:11px; color:#888; display:flex; justify-content:space-between;">
                            <span>👤 ${displayAuthor}</span>
                            ${item.duration ? `<span>${item.duration}</span>` : ''}
                        </div>
                    </div>
                </a>`;
            }).join('');
    };

    /* ═══════════════════════════════════════════════════════════════════
     * 面板初始化
     * ═══════════════════════════════════════════════════════════════════ */

    const init = () => {
        const panel = document.createElement('div');
        panel.id = 'footprint-panel';
        panel.className = `mode-${currentMode}`;
        panel.innerHTML = `
            <div id="footprint-list">
                <div class="list-header">
                    <div class="list-header-title">
                        <span>📌 浏览足迹</span>
                        <span class="fp-count-badge">0 / ${limitLabel()}</span>
                    </div>
                    <input type="text" class="search-box" id="foot-search" placeholder="搜索关键词...">
                </div>
                <div class="list-content"></div>
                <div style="padding:10px; border-top: 1px solid rgba(128,128,128,0.15);" class="footer-box">
                    <button class="clear-all-btn" id="clear-trace">清空全部足迹</button>
                </div>
            </div>
            <div class="foot-btn" id="toggle-list">${currentMode === 'light' ? '⭐' : '🌟'}<span class="foot-count" style="display:none;">0</span></div>
        `;
        document.body.appendChild(panel);
        updateHeaderCount();

        const list = document.getElementById('footprint-list');
        const btn = document.getElementById('toggle-list');
        const searchInput = document.getElementById('foot-search');

        // 拖动结束后，自动吸附到离悬浮球最近的屏幕侧边，并让面板朝屏幕内侧展开
        const autoStick = () => {
            const screenWidth = window.innerWidth;
            const rect = panel.getBoundingClientRect();
            panel.style.transition = 'all 0.3s ease';
            if (rect.left + rect.width / 2 < screenWidth / 2) {
                panel.style.left = '10px';
                panel.style.right = 'auto';
                list.style.right = 'auto';
                list.style.left = '60px';
            } else {
                panel.style.left = (screenWidth - rect.width - 10) + 'px';
                panel.style.right = 'auto';
                list.style.left = 'auto';
                list.style.right = '60px';
            }
            setTimeout(() => { panel.style.transition = ''; }, 300);
        };
        autoStick();

        /* ── 拖动 + 长按切主题 ── */
        let isDragging = false, startX, startY, initialX, initialY, moveDistance = 0, pressTimer;

        panel.onmousedown = (e) => {
            isDragging = false;
            moveDistance = 0;
            startX = e.clientX;
            startY = e.clientY;
            initialX = panel.offsetLeft;
            initialY = panel.offsetTop;

            // 长按 800ms 且没有明显位移 → 切换浅色/深色主题
            pressTimer = setTimeout(() => {
                if (!isDragging && moveDistance < 5) {
                    currentMode = currentMode === 'light' ? 'dark' : 'light';
                    panel.className = `mode-${currentMode}`;
                    btn.innerText = currentMode === 'light' ? '⭐' : '🌟';
                    GM_setValue(MODE_SETTINGS_KEY, currentMode);
                    updateListUI();
                }
            }, 800);

            document.onmousemove = (ev) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                moveDistance = Math.sqrt(dx * dx + dy * dy);
                if (moveDistance > 5) {
                    isDragging = true;
                    clearTimeout(pressTimer);
                    panel.style.left = initialX + dx + 'px';
                    panel.style.top = initialY + dy + 'px';
                    list.style.display = 'none';
                }
            };
            document.onmouseup = () => {
                clearTimeout(pressTimer);
                document.onmousemove = null;
                document.onmouseup = null;
                if (isDragging) autoStick();
            };
        };

        /* ── 点击悬浮球：展开 / 收起面板 ── */
        btn.onclick = (e) => {
            if (isDragging || moveDistance > 5) return;
            e.stopPropagation();
            if (list.style.display !== 'flex') {
                // 根据悬浮球位置决定面板向上还是向下展开，并限制最大高度不超出屏幕
                const rect = panel.getBoundingClientRect();
                const screenHeight = window.innerHeight;
                if (rect.top > screenHeight / 2) {
                    list.style.bottom = '0px';
                    list.style.top = 'auto';
                    list.style.maxHeight = (rect.top - 20) + 'px';
                } else {
                    list.style.top = '0px';
                    list.style.bottom = 'auto';
                    list.style.maxHeight = (screenHeight - rect.bottom - 20) + 'px';
                }
                list.style.display = 'flex';
                setTimeout(() => searchInput.focus(), 100);
            } else {
                list.style.display = 'none';
            }
        };

        /* ── 清空全部足迹 ── */
        document.getElementById('clear-trace').onclick = (e) => {
            e.stopPropagation();
            if (confirm('确定清空全部记录？')) {
                footprint = [];
                persistFootprint(); // 清空也写回 GM（0 = 不储存模式下不写）
                updateHeaderCount();
                updateListUI();
            }
        };

        /* ── 防抖搜索：停止输入 200ms 后才重绘，避免逐字符全量渲染 ── */
        let searchTimer = null;
        searchInput.oninput = (e) => {
            clearTimeout(searchTimer);
            const value = e.target.value;
            searchTimer = setTimeout(() => {
                searchTerm = value;
                updateListUI();
            }, 200);
        };

        // 点击面板外部收起面板
        document.addEventListener('click', () => list.style.display = 'none');
        list.onclick = (e) => e.stopPropagation();

        /* ── 轮询：观察新出现的卡片 + 盖"已看"角标 ──
         * 两件事必须分开判断：
         *   观察卡片是核心功能，无论"已看标记"开关如何都要执行；
         *   盖角标则只在 settings.viewedTag 为 true 时执行。
         */
        setInterval(() => {
            document.querySelectorAll('.bili-video-card, .feed-card, .video-card, .v-card, .rank-item, .item, .spread-module, .video-like-card, .video-item').forEach(card => {
                if (!card.dataset.bvhObs) {
                    card.dataset.bvhObs = 'true'; // 标记已观察，避免重复 observe
                    observer.observe(card);
                }
                if (settings.viewedTag) {
                    markViewedCard(card);
                }
            });
        }, 800);
    };

    /* ── 记录"已看"：鼠标按下卡片时写入 GM（功能关闭时直接跳过） ── */
    document.addEventListener('mousedown', (e) => {
        if (!settings.viewedTag) return;

        const card = e.target.closest('.bili-video-card, .feed-card, .video-card, .v-card, .rank-item, .item, .spread-module, .video-like-card, .video-item');
        if (!card) return;

        const bv = extractBv(card);
        if (bv) GM_setValue(VIEWED_KEY_PREFIX + bv, true);
    });

    /* ═══════════════════════════════════════════════════════════════════
     * 入口
     * ═══════════════════════════════════════════════════════════════════ */

    loadSettings();   // 先读用户设置，后续逻辑都依赖它
    registerMenus();  // 注册油猴菜单命令
    loadFootprint();  // 再读足迹数据

    // 稍等 B 站自身的 DOM 渲染完，再插入面板
    setTimeout(init, 1000);
})();