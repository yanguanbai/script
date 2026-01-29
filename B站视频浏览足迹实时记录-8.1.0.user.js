// ==UserScript==
// @name          B站视频浏览足迹实时记录
// @namespace     https://greasyfork.org/
// @version       8.1.0
// @description   修复清空按钮溢出问题。固定搜索框和清空按钮，只有列表可滚动。
// @author        Bart
// @match         *://www.bilibili.com/*
// @grant         GM_setValue
// @grant         GM_getValue
// @grant         GM_addStyle
// @run-at        document-end
// @icon         https://www.bilibili.com/favicon.ico
// ==/UserScript==

(function() {
    'use strict';

    // 1. 样式重构：使用 Flex 布局固定头尾
    GM_addStyle(`
        #footprint-panel { position: fixed; right: 20px; bottom: 100px; z-index: 100000; }
        .foot-btn {
            width: 48px; height: 48px; background: #fff; border: 1px solid #e3e5e7;
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.1); font-size: 22px;
        }

        #footprint-list {
            position: fixed; right: 80px; bottom: 100px; width: 340px; height: 600px; /* 固定高度 */
            background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.2);
            display: none; flex-direction: column; overflow: hidden; border: 1px solid #fb7299; z-index: 100001;
        }

        /* 顶部固定：标题 + 搜索 */
        .list-header { background: #fb7299; color: #fff; padding: 12px; flex-shrink: 0; }
        .header-top { font-weight: bold; margin-bottom: 8px; font-size: 14px; }
        .search-box { width: 100%; padding: 8px; border-radius: 6px; border: none; outline: none; font-size: 12px; box-sizing: border-box; }

        /* 中间：可滚动列表 */
        .list-content { flex-grow: 1; overflow-y: auto; padding: 8px; background: #f6f7f8; }
        .list-content::-webkit-scrollbar { width: 4px; }
        .list-content::-webkit-scrollbar-thumb { background: #fb7299; border-radius: 2px; }

        /* 底部固定：操作栏 */
        .list-footer { padding: 8px; background: #fff; border-top: 1px solid #e3e5e7; text-align: center; flex-shrink: 0; }
        .clear-all-btn {
            width: 100%; padding: 6px; background: #f1f2f3; color: #61666d;
            border: none; border-radius: 4px; cursor: pointer; font-size: 12px; transition: 0.2s;
        }
        .clear-all-btn:hover { background: #ff4d4f; color: #fff; }

        /* 列表项样式 */
        .foot-item { display: flex; gap: 10px; padding: 10px; border-bottom: 1px solid #eee; text-decoration: none; color: #18191c; background: #fff; margin-bottom: 6px; border-radius: 6px; }
        .foot-item img { width: 110px; height: 68px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
        .highlight { color: #fb7299; font-weight: bold; }
        .viewed-tag { position: absolute; top: 6px; left: 6px; background: #fb7299; color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px; z-index: 20; font-weight: bold; pointer-events: none; }
    `);

    let footprint = [];
    let searchTerm = "";

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => { if (entry.isIntersecting) recordTrace(entry.target); });
    }, { threshold: 0.1 });

    const recordTrace = (el) => {
        const a = el.querySelector('a[href*="/video/BV"]');
        if (!a) return;
        const bv = a.href.match(/BV[a-zA-Z0-9]+/)?.[0];
        if (bv && !footprint.some(item => item.bv === bv)) {
            const titleEl = el.querySelector('.bili-video-card__info--tit, .title, h3');
            const img = el.querySelector('img');
            footprint.unshift({ bv, title: titleEl ? titleEl.innerText : "视频", pic: img ? (img.currentSrc || img.src) : "", url: a.href });
            if (footprint.length > 100) footprint.pop();
            updateListUI();
        }
    };

    const updateListUI = () => {
        const content = document.querySelector('.list-content');
        if (!content) return;
        let filtered = searchTerm ? footprint.filter(i => i.title.toLowerCase().includes(searchTerm.toLowerCase()) || i.bv.toLowerCase().includes(searchTerm.toLowerCase())) : footprint;

        if (filtered.length === 0) {
            content.innerHTML = `<div style="text-align:center;padding:40px;color:#9499a0;">${searchTerm ? '未找到结果' : '暂无足迹'}</div>`;
            return;
        }

        content.innerHTML = filtered.map(item => {
            let displayTitle = searchTerm ? item.title.replace(new RegExp(`(${searchTerm})`, "gi"), '<span class="highlight">$1</span>') : item.title;
            return `<a href="${item.url}" target="_blank" class="foot-item">
                <img src="${item.pic}" onerror="this.src='https://static.hdslb.com/images/transparent.gif'">
                <div class="foot-item-info">
                    <div style="font-weight:500;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${displayTitle}</div>
                    <div style="font-size:10px;color:#9499a0;margin-top:6px;">${item.bv}</div>
                </div>
            </a>`;
        }).join('');
    };

    const init = () => {
        const panel = document.createElement('div');
        panel.id = 'footprint-panel';
        panel.innerHTML = `
            <div id="footprint-list">
                <div class="list-header">
                    <div class="header-top">浏览足迹</div>
                    <input type="text" class="search-box" id="foot-search" placeholder="搜索标题关键词或BV号...">
                </div>
                <div class="list-content"></div>
                <div class="list-footer">
                    <button class="clear-all-btn" id="clear-trace">清空全部足迹</button>
                </div>
            </div>
            <div class="foot-btn" id="toggle-list" title="足迹">👣</div>
        `;
        document.body.appendChild(panel);

        const searchInput = document.getElementById('foot-search');
        searchInput.oninput = (e) => { searchTerm = e.target.value; updateListUI(); };

        document.getElementById('toggle-list').onclick = (e) => {
            e.stopPropagation();
            const list = document.getElementById('footprint-list');
            const show = list.style.display !== 'flex';
            list.style.display = show ? 'flex' : 'none';
            if (show) setTimeout(() => searchInput.focus(), 100);
        };

        document.getElementById('clear-trace').onclick = (e) => {
            e.stopPropagation();
            if(confirm("确定清空列表？")) { footprint = []; updateListUI(); }
        };

        document.addEventListener('click', () => { document.getElementById('footprint-list').style.display = 'none'; });
        document.getElementById('footprint-list').onclick = (e) => e.stopPropagation();

        setInterval(() => {
            document.querySelectorAll('.bili-video-card, .feed-card').forEach(card => {
                if (!card.dataset.bvhObs) { card.dataset.bvhObs = "true"; observer.observe(card); }
                const a = card.querySelector('a[href*="/video/BV"]');
                const bv = a?.href.match(/BV[a-zA-Z0-9]+/)?.[0];
                if (bv && GM_getValue('v_'+bv)) {
                    const pic = card.querySelector('.bili-video-card__image--wrap, .pic, .cover, .b-img');
                    if (pic && !card.querySelector('.viewed-tag')) {
                        pic.style.position = 'relative';
                        pic.insertAdjacentHTML('afterbegin', '<div class="viewed-tag">已看</div>');
                    }
                }
            });
        }, 600);
    };

    document.addEventListener('mousedown', (e) => {
        const card = e.target.closest('.bili-video-card, .feed-card');
        if (card) {
            const bv = card.querySelector('a[href*="/video/BV"]')?.href.match(/BV[a-zA-Z0-9]+/)?.[0];
            if (bv) GM_setValue('v_'+bv, true);
        }
    });

    setTimeout(init, 1000);
})();