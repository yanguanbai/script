// ==UserScript==
// @name         Bilibili 干净链接 + 分享净化
// @namespace    https://greasyfork.org/
// @version      3.3.0
// @description  清理 B 站链接追踪参数，统一净化地址栏、页面链接和复制链接
// @author       Bart
// @match        *://*.bilibili.com/*
// @grant        none
// @run-at       document-start
// @icon         https://www.bilibili.com/favicon.ico
// @license      MIT
// ==/UserScript==

(() => {
    'use strict';

    // 只删除明确属于追踪、来源或分享标记的参数。
    // 不要把 p、t、tab 等可能有实际用途的参数一概删除。
    const REMOVE_PARAMS = new Set([
        'spm_id_from',
        'from_source',
        'from_spmid',
        'msource',
        'bsource',
        'seid',
        'source',
        'session_id',
        'visit_id',
        'sourcefrom',
        'share_source',
        'share_medium',
        'share_plat',
        'share_session_id',
        'share_tag',
        'unique_k',
        'csource',
        'vd_source',
        'is_story_h5',
        'share_from',
        'plat_id',
        '-arouter',
        'spmid',
        'trackid'
    ]);

    // 清理 URL，保留未知参数，避免破坏正常功能。
    function cleanURL(input) {
        try {
            const url = new URL(input, location.href);

            // 修复旧域名。
            if (url.hostname.toLowerCase() === 'bilibili.tv' ||
                url.hostname.toLowerCase().endsWith('.bilibili.tv')) {
                url.hostname = url.hostname.replace(/bilibili\.tv$/i, 'bilibili.com');
            }

            for (const key of [...url.searchParams.keys()]) {
                if (REMOVE_PARAMS.has(key.toLowerCase())) {
                    url.searchParams.delete(key);
                }
            }

            return url.href;
        } catch {
            return input;
        }
    }

    // 清理文本中的 URL，同时保留 URL 外部的文字。
    function cleanText(text) {
        if (typeof text !== 'string' || !text.includes('bilibili')) {
            return text;
        }

        return text.replace(
            /https?:\/\/[^\s<>"']+/gi,
            (rawURL) => {
                // 避免把句末标点一起当成 URL 的一部分。
                const match = rawURL.match(/[.,!?;)\]】。，！？；]+$/);
                const suffix = match ? match[0] : '';
                const url = suffix
                ? rawURL.slice(0, -suffix.length)
                : rawURL;

                if (!/bilibili\.(com|tv)(?=[:/?#]|$)/i.test(url)) {
                    return rawURL;
                }

                return cleanURL(url) + suffix;
            }
        );
    }

    function cleanLocation() {
        const cleaned = cleanURL(location.href);

        if (location.href !== cleaned) {
            history.replaceState(history.state, '', cleaned);
        }
    }

    // 拦截 B 站切换页面时重新写入的 URL
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (state, title, url) {
        if (url != null) url = cleanURL(new URL(url, location.href).href);
        return originalPushState.call(this, state, title, url);
    };

    history.replaceState = function (state, title, url) {
        if (url != null) url = cleanURL(new URL(url, location.href).href);
        return originalReplaceState.call(this, state, title, url);
    };

    // 页面切换后再次清理
    window.addEventListener('popstate', cleanLocation);
    window.addEventListener('load', cleanLocation);

    cleanLocation();

    // 清理页面链接。
    function cleanAnchors(root = document) {
        const anchors = [];

        if (root.nodeType === Node.ELEMENT_NODE &&
            root.matches?.('a[href]')) {
            anchors.push(root);
        }

        if (root.querySelectorAll) {
            anchors.push(...root.querySelectorAll('a[href]'));
        }

        for (const anchor of anchors) {
            const raw = anchor.getAttribute('href');
            if (!raw) continue;

            // 只处理 B 站链接，避免干扰其他网站。
            let parsed;
            try {
                parsed = new URL(raw, location.href);
            } catch {
                continue;
            }

            if (!/(^|\.)bilibili\.(com|tv)$/i.test(parsed.hostname)) {
                continue;
            }

            const cleaned = cleanURL(parsed.href);

            if (anchor.href !== cleaned) {
                anchor.href = cleaned;
            }
        }
    }

    // 点击和右键前再次清理目标链接。
    function handleLinkEvent(event) {
        const target = event.target;
        const anchor = target?.closest?.('a[href]');

        if (anchor) {
            cleanAnchors(anchor);
        }
    }

    window.addEventListener('click', handleLinkEvent, true);
    window.addEventListener('contextmenu', handleLinkEvent, true);

    // 监听动态渲染的页面链接。
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === 'attributes') {
                cleanAnchors(record.target);
            } else {
                for (const node of record.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        cleanAnchors(node);
                    }
                }
            }
        }
    });

    function startObserver() {
        if (!document.documentElement) return;

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href']
        });

        cleanLocation();
        cleanAnchors();
    }

    if (document.documentElement) {
        startObserver();
    } else {
        const startupObserver = new MutationObserver(() => {
            if (!document.documentElement) return;

            startupObserver.disconnect();
            startObserver();
        });

        startupObserver.observe(document, {
            childList: true,
            subtree: true
        });
    }

    // SPA 页面切换后再次清理。
    window.addEventListener('popstate', cleanLocation);

    // 兼容 Clipboard API。
    try {
        const clipboard = navigator.clipboard;

        if (clipboard &&
            typeof clipboard.writeText === 'function') {
            const originalWriteText = clipboard.writeText.bind(clipboard);

            clipboard.writeText = function (text) {
                return originalWriteText(cleanText(text));
            };
        }
    } catch (error) {
        console.warn('[Bilibili Clean URL] Clipboard API 不可修改：', error);
    }

    window.addEventListener('load', () => {
        cleanLocation();
        cleanAnchors();
    });

    console.log('[Bilibili Clean URL] 3.3.0 已加载');
})();
