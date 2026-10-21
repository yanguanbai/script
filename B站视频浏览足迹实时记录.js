// ==UserScript==
// @name         B站视频浏览足迹
// @namespace    https://greasyfork.org/
// @version      10.1.0
// @description  抓取所有出现的视频,可搜索回溯查找,记录持久化到GM;菜单可设最大保留条数(0-3000,0=仅本次浏览不储存)
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
// @run-at       document-end
// @icon         https://www.bilibili.com/favicon.ico
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    /* ═══════════════════════════════════════════════════════════════════
     * 常量与配置
     *
     * 集中管理 GM 键名与上限参数。修改默认值、范围只改这里。
     * ═══════════════════════════════════════════════════════════════════ */

    // 足迹列表的持久化键：整个数组存为一个键，结构简单、读写开销小
    const FOOTPRINT_STORAGE_KEY = 'bvh_footprint_list_v1';
    // 上限设置独立存储，绝不与足迹数据混在同一键里
    const FOOTPRINT_LIMIT_SETTINGS_KEY = 'bvh_footprint_limit_settings_v1';
    // 主题模式沿用旧键，兼容老用户已有配置
    const MODE_SETTINGS_KEY = 'footprint_mode';

    const CONFIG = {
        MAX_FOOTPRINT: 100,   // 默认最大保留条数，可在油猴菜单里修改
        MIN_LIMIT: 0,         // 0 = 不储存：仅本次浏览有效，刷新页面清空（同 v9 行为）
        MAX_LIMIT: 3000,      // 硬上限，防止误输入超大值撑爆存储
    };

    /* ═══════════════════════════════════════════════════════════════════
     * 设置加载与菜单
     *
     * 启动时读 GM 里的用户设置覆盖默认值；
     * 注册油猴菜单命令，随时修改最大保留条数。
     * ═══════════════════════════════════════════════════════════════════ */

    function loadSettings() {
        try {
            const saved = GM_getValue(FOOTPRINT_LIMIT_SETTINGS_KEY, null);
            const n = Number(saved && saved.limit);
            if (Number.isFinite(n) && n >= CONFIG.MIN_LIMIT && n <= CONFIG.MAX_LIMIT) {
                CONFIG.MAX_FOOTPRINT = Math.floor(n);
            }
        } catch (e) { /* 设置损坏时用默认值 */ }
    }

    function saveLimitSettings() {
        GM_setValue(FOOTPRINT_LIMIT_SETTINGS_KEY, {
            limit: CONFIG.MAX_FOOTPRINT,
            updatedAt: Date.now()
        });
    }

    // 上限的展示文案：0 显示"本次"，其余显示数字
    function limitLabel() {
        return CONFIG.MAX_FOOTPRINT === 0 ? '本次' : CONFIG.MAX_FOOTPRINT;
    }

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        GM_registerMenuCommand(`设置最大保留条数（当前：${limitLabel()}）`, function configureLimit() {
            const input = prompt(
                `设置足迹最大保留条数（${CONFIG.MIN_LIMIT} - ${CONFIG.MAX_LIMIT}）。\n` +
                `· 新记录在最上面，超过上限会自动删除最旧的记录；\n` +
                `· 输入 0 = 不储存：记录只在本次浏览有效，刷新页面后清空（同旧版）。`,
                String(CONFIG.MAX_FOOTPRINT)
            );
            if (input === null) return; // 用户取消

            const n = Number(input.trim());
            if (!Number.isInteger(n) || n < CONFIG.MIN_LIMIT || n > CONFIG.MAX_LIMIT) {
                alert(`请输入 ${CONFIG.MIN_LIMIT} 到 ${CONFIG.MAX_LIMIT} 之间的整数，设置未更改。`);
                return;
            }

            const oldLimit = CONFIG.MAX_FOOTPRINT;
            CONFIG.MAX_FOOTPRINT = n;
            saveLimitSettings();

            if (n === 0) {
                // 切到"不储存"：清空内存，并把 GM 里的旧数据删掉，避免回流
                footprint = [];
                try { GM_deleteValue(FOOTPRINT_STORAGE_KEY); } catch (e) {}
            } else {
                if (oldLimit === 0) {
                    // 从"不储存"切回来：本次已抓的记录转为持久化，避免误以为丢了
                    trimFootprint();
                    persistFootprint();
                } else {
                    trimFootprint();
                    persistFootprint();
                }
            }
            updateHeaderCount();
            updateListUI();
            alert(n === 0
                ? '已设为"不储存"：记录仅本次浏览有效，刷新页面后清空，GM 中已有的旧记录已删除。'
                : `已设置最大保留条数为 ${n} 条，超出将自动删除最旧的记录。`);
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 足迹持久化
     *
     * MAX_FOOTPRINT = 0 时不读不写 GM（纯内存，刷新即丢）；
     * 大于 0 时新增/清空/改设置都写回 GM。
     * 加载时做结构校验与 BV 去重，坏数据不拖垮脚本。
     * ═══════════════════════════════════════════════════════════════════ */

    let footprint = [];

    function loadFootprint() {
        footprint = [];
        // 0 = 不储存模式：不读 GM，完全等同旧版内存行为
        if (CONFIG.MAX_FOOTPRINT === 0) return;

        try {
            const raw = GM_getValue(FOOTPRINT_STORAGE_KEY, []);
            if (!Array.isArray(raw)) return;
            // 逐条校验，丢弃损坏项；按 bv 去重，防止历史脏数据重复
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
                    duration: String(item.duration || '')
                });
            }
            trimFootprint(); // 启动时兜底裁剪一次（用户可能在别处把设置改小了）
        } catch (e) {
            footprint = [];
        }
    }

    function persistFootprint() {
        // 0 = 不储存模式：不写 GM
        if (CONFIG.MAX_FOOTPRINT === 0) return;
        try {
            GM_setValue(FOOTPRINT_STORAGE_KEY, footprint);
        } catch (e) {
            console.warn('[B站浏览足迹] 写入GM存储失败：', e);
        }
    }

    // 超限裁剪：新的记录 unshift 在数组头部，尾部是最旧的，从尾部删
    // 0 = 不储存模式不裁剪（本次浏览内无上限）
    function trimFootprint() {
        if (CONFIG.MAX_FOOTPRINT > 0 && footprint.length > CONFIG.MAX_FOOTPRINT) {
            footprint.splice(CONFIG.MAX_FOOTPRINT);
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 样式与面板
     *
     * UI 风格学习"观看历史记录"脚本：毛玻璃(backdrop-filter)、粉色渐变
     * 标题栏、圆角卡片、hover 抬升、聚焦光环。浅色/深色两套主题。
     * ═══════════════════════════════════════════════════════════════════ */

    let currentMode = GM_getValue(MODE_SETTINGS_KEY, 'light');
    let searchTerm = "";

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

        /* ── 头部：粉色渐变标题栏（沿用B站粉 #fb7299） ── */
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

    // 同步头部计数徽标 + 悬浮球气泡
    function updateHeaderCount() {
        const badge = document.querySelector('.fp-count-badge');
        if (badge) badge.textContent = `${footprint.length} / ${limitLabel()}`;
        const bubble = document.querySelector('.foot-count');
        if (bubble) {
            bubble.textContent = footprint.length > 99 ? '99+' : footprint.length;
            bubble.style.display = footprint.length ? 'block' : 'none';
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 采集逻辑
     * ═══════════════════════════════════════════════════════════════════ */

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => { if (entry.isIntersecting) recordTrace(entry.target); });
    }, { threshold: 0.1 });

    const recordTrace = (el) => {
        // 增加对搜索页 a 标签的支持
        const a = el.querySelector('a[href*="/video/BV"]');
        if (!a) return;
        const bv = a.href.match(/BV[a-zA-Z0-9]+/)?.[0];
        if (!bv || footprint.some(item => item.bv === bv)) return;

        let title = "";
        // 增加搜索页标题选择器 .v-img + .info .title
        const targetTitleEl = el.querySelector('.bili-video-card__title, .bili-video-card__info--tit, .title, .h-title');
        if (targetTitleEl) {
            title = targetTitleEl.getAttribute('title') || targetTitleEl.innerText.replace(/<em.*?\/em>/g, '').trim();
        }
        if (!title) {
            title = a.getAttribute('title') || a.innerText.trim();
        }
        // 清理搜索页可能残留的 em 标签文本内容
        title = title.replace(/\n/g, '').trim();
        if (/^\d+(\.\d+)?[万次]?播放$/.test(title) || /^\d+弹幕$/.test(title)) {
            title = "";
        }

        // 增加搜索页作者选择器
        const authorEl = el.querySelector('.bili-video-card__info--author, .up-name, .author, .up, .up-info-name, a[href*="space.bilibili.com"]');
        let author = "未知作者";
        if (authorEl) {
            author = authorEl.innerText.trim() || authorEl.getAttribute('title') || "";
        }

        const img = el.querySelector('img');
        const durationEl = el.querySelector('.bili-video-card__stats__duration, .duration, .time, .length, .bili-video-card__duration');

        footprint.unshift({
            bv,
            title: title || "视频名称",
            pic: img ? (img.currentSrc || img.src) : "",
            url: a.href,
            author: author,
            duration: durationEl ? durationEl.innerText.trim() : ""
        });
        trimFootprint();    // 超过上限自动删除最旧的（0=不储存模式下不裁剪）
        persistFootprint(); // 立即写回 GM（0=不储存模式下不写）
        updateHeaderCount();
        updateListUI();
    };

    /* ═══════════════════════════════════════════════════════════════════
     * 列表渲染
     * ═══════════════════════════════════════════════════════════════════ */

    const updateListUI = () => {
        const content = document.querySelector('.list-content');
        if (!content) return;
        let filtered = searchTerm ? footprint.filter(i =>
            i.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
            i.bv.toLowerCase().includes(searchTerm.toLowerCase()) ||
            i.author.toLowerCase().includes(searchTerm.toLowerCase())
        ) : footprint;

        content.innerHTML = filtered.length === 0 ? `<div style="text-align:center;padding:40px;color:#9499a0;">暂无记录</div>` :
        filtered.map(item => {
            let displayTitle = item.title;
            let displayAuthor = item.author;
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
            </a>`}).join('');
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

        const autoStick = () => {
            const screenWidth = window.innerWidth;
            const rect = panel.getBoundingClientRect();
            panel.style.transition = 'all 0.3s ease';
            if (rect.left + rect.width / 2 < screenWidth / 2) {
                panel.style.left = '10px'; panel.style.right = 'auto';
                list.style.right = 'auto'; list.style.left = '60px';
            } else {
                panel.style.left = (screenWidth - rect.width - 10) + 'px'; panel.style.right = 'auto';
                list.style.left = 'auto'; list.style.right = '60px';
            }
            setTimeout(() => { panel.style.transition = ''; }, 300);
        };
        autoStick();

        let isDragging = false, startX, startY, initialX, initialY, moveDistance = 0, pressTimer;

        panel.onmousedown = (e) => {
            isDragging = false; moveDistance = 0;
            startX = e.clientX; startY = e.clientY;
            initialX = panel.offsetLeft; initialY = panel.offsetTop;
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
                moveDistance = Math.sqrt(dx*dx + dy*dy);
                if (moveDistance > 5) {
                    isDragging = true; clearTimeout(pressTimer);
                    panel.style.left = initialX + dx + 'px';
                    panel.style.top = initialY + dy + 'px';
                    list.style.display = 'none';
                }
            };
            document.onmouseup = () => {
                clearTimeout(pressTimer);
                document.onmousemove = null; document.onmouseup = null;
                if (isDragging) autoStick();
            };
        };

        btn.onclick = (e) => {
            if (isDragging || moveDistance > 5) return;
            e.stopPropagation();
            if (list.style.display !== 'flex') {
                const rect = panel.getBoundingClientRect();
                const screenHeight = window.innerHeight;
                if (rect.top > screenHeight / 2) {
                    list.style.bottom = '0px'; list.style.top = 'auto';
                    list.style.maxHeight = (rect.top - 20) + 'px';
                } else {
                    list.style.top = '0px'; list.style.bottom = 'auto';
                    list.style.maxHeight = (screenHeight - rect.bottom - 20) + 'px';
                }
                list.style.display = 'flex';
                setTimeout(() => searchInput.focus(), 100);
            } else { list.style.display = 'none'; }
        };

        document.getElementById('clear-trace').onclick = (e) => {
            e.stopPropagation();
            if(confirm("确定清空全部记录？")) {
                footprint = [];
                persistFootprint(); // 清空也写回 GM（0=不储存模式下不写）
                updateHeaderCount();
                updateListUI();
            }
        };

        // 防抖搜索，避免每输入一个字符都全量重绘（学习长脚本的 SEARCH_DEBOUNCE）
        let searchTimer = null;
        searchInput.oninput = (e) => {
            clearTimeout(searchTimer);
            const value = e.target.value;
            searchTimer = setTimeout(() => { searchTerm = value; updateListUI(); }, 200);
        };
        document.addEventListener('click', () => list.style.display = 'none');
        list.onclick = (e) => e.stopPropagation();

        setInterval(() => {
            // 重点修改：增加了 .video-like-card, .video-item 等搜索页常用的类名
            document.querySelectorAll('.bili-video-card, .feed-card, .video-card, .v-card, .rank-item, .item, .spread-module, .video-like-card, .video-item').forEach(card => {
                if (!card.dataset.bvhObs) { card.dataset.bvhObs = "true"; observer.observe(card); }
                const a = card.querySelector('a[href*="/video/BV"]');
                const bv = a?.href.match(/BV[a-zA-Z0-9]+/)?.[0];
                if (bv && GM_getValue('v_'+bv)) {
                    const pic = card.querySelector('.bili-video-card__image--wrap, .pic, .cover, .img, .thumb, .v-img');
                    if (pic && !card.querySelector('.viewed-tag')) {
                        pic.style.position = 'relative';
                        pic.insertAdjacentHTML('afterbegin', '<div class="viewed-tag" style="position:absolute;top:6px;left:6px;background:#fb7299;color:white;padding:2px 6px;border-radius:4px;font-size:11px;z-index:20;font-weight:bold;pointer-events:none;">已看</div>');
                    }
                }
            });
        }, 800);
    };

    document.addEventListener('mousedown', (e) => {
        const card = e.target.closest('.bili-video-card, .feed-card, .video-card, .v-card, .rank-item, .item, .spread-module, .video-like-card, .video-item');
        if (card) {
            const bv = card.querySelector('a[href*="/video/BV"]')?.href.match(/BV[a-zA-Z0-9]+/)?.[0];
            if (bv) GM_setValue('v_'+bv, true);
        }
    });

    /* ═══════════════════════════════════════════════════════════════════
     * 入口
     * ═══════════════════════════════════════════════════════════════════ */

    loadSettings();
    registerMenus();
    loadFootprint();

    setTimeout(init, 1000);
})();
