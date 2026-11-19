// ==UserScript==
// @name         bilibili视频键盘控制
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  鼠标位于视频上时启用快捷键：0=0.5x 1=2x 3=3x 5=暂停/播放 7=上一集 9=下一集；全屏视频内滚轮调音量
// @match        *://www.youtube.com/*
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://live.bilibili.com/*
// @match        *://t.bilibili.com/*
// @grant        none
// ==/UserScript==
// 2.4：全屏滚轮音量改为按当前音量自适应步长，低音量小步调整，高音量大步调整。

(function () {
    'use strict';

    /* ==================== 提示浮窗 ==================== */
    let toast = null;
    let toastTimer = 0;

    function showToast(text, duration = 800) {
        if (!toast || !document.body.contains(toast)) {
            toast = document.createElement('div');
            Object.assign(toast.style, {
                position: 'fixed',
                zIndex: '2147483647',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                padding: '10px 20px',
                borderRadius: '8px',
                background: 'rgba(0,0,0,.7)',
                color: '#fff',
                fontSize: '24px',
                fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
                lineHeight: '1.2',
                opacity: '0',
                transition: 'opacity .3s',
                pointerEvents: 'none',
                userSelect: 'none',
                whiteSpace: 'nowrap',
            });
        }

        const fullscreenElement =
            document.fullscreenElement || document.webkitFullscreenElement;
        const parent = fullscreenElement || document.body;

        if (toast.parentNode !== parent) parent.appendChild(toast);

        toast.textContent = text;
        toast.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.style.opacity = '0';
        }, duration);
    }

    /* ==================== 视频定位 ==================== */
    function getVideo() {
        let best = null;
        let bestArea = 0;

        for (const video of document.querySelectorAll('video')) {
            const rect = video.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 60) continue;

            const style = getComputedStyle(video);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = video;
            }
        }

        return best;
    }

    function isMouseInVideo(video) {
        const rect = video.getBoundingClientRect();
        return mouseX >= rect.left && mouseX <= rect.right &&
               mouseY >= rect.top && mouseY <= rect.bottom;
    }

    /* ==================== 输入框判断 ==================== */
    function isEditable(el) {
        if (!el || el.nodeType !== 1) return false;

        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;

        return !!(
            el.closest &&
            el.closest('[contenteditable="true"], [contenteditable=""]')
        );
    }

    /* ==================== 播放控制 ==================== */
    function setRate(video, rate) {
        video.playbackRate = rate;
        showToast(`${rate}x`);
    }

    function togglePlay(video) {
        if (video.paused) {
            const promise = video.play();
            if (promise && typeof promise.catch === 'function') promise.catch(() => {});
            showToast('▶ 播放');
        } else {
            video.pause();
            showToast('⏸ 暂停');
        }
    }

    function toggleFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            try {
                const promise = document.exitFullscreen
                    ? document.exitFullscreen()
                    : document.webkitExitFullscreen();

                if (promise && typeof promise.catch === 'function') promise.catch(() => {});
            } catch (_) {}
            return;
        }

        const biliButton = document.querySelector('.bpx-player-ctrl-full');
        if (biliButton) {
            biliButton.click();
            return;
        }

        const youtubeButton = document.querySelector('.ytp-fullscreen-button');
        if (youtubeButton) {
            youtubeButton.click();
            return;
        }

        const target =
            document.querySelector('#bilibili-player, .bpx-player-container, #movie_player') ||
            getVideo();

        if (!target) return;

        try {
            const request = target.requestFullscreen || target.webkitRequestFullscreen;
            if (!request) return;

            const promise = request.call(target);
            if (promise && typeof promise.catch === 'function') promise.catch(() => {});
        } catch (_) {}
    }

    function clickPlayerButton(selectors) {
        for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (!button || button.disabled) continue;
            if (button.classList.contains('bpx-state-disabled')) continue;
            if (button.getAttribute('aria-disabled') === 'true') continue;

            button.click();
            return true;
        }

        return false;
    }

    function nextEpisode() {
        const ok = clickPlayerButton(['.bpx-player-ctrl-next', '.ytp-next-button']);
        showToast(ok ? '下一集' : '没有下一集');
    }

    function prevEpisode() {
        const ok = clickPlayerButton(['.bpx-player-ctrl-prev', '.ytp-prev-button']);
        showToast(ok ? '上一集' : '没有上一集');
    }

    // 音量采用相对步长：当前音量越低，单次变化越小；最低保留 1% 步长，避免无法微调。
    function getVolumeStep(volume) {
        return Math.max(0.01, Math.min(0.1, Number(volume) * 0.1));
    }

    /* ==================== 鼠标位置 ==================== */
    let mouseX = -1;
    let mouseY = -1;

    window.addEventListener('mousemove', (event) => {
        mouseX = event.clientX;
        mouseY = event.clientY;
    }, { passive: true });

    /* ==================== 全屏时滚轮调音量 ==================== */
    window.addEventListener('wheel', (event) => {
        const fullscreenElement =
            document.fullscreenElement || document.webkitFullscreenElement;

        if (!fullscreenElement) return;

        const video = getVideo();
        if (!video || !isMouseInVideo(video)) return;

        // 确认鼠标实际命中视频，避免在控件或覆盖层上滚动时误调音量
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        if (hit !== video && !(video.contains && video.contains(hit))) return;
        if (event.deltaY === 0) return;

        event.preventDefault();
        event.stopPropagation();

        const step = getVolumeStep(video.volume) * (event.deltaY < 0 ? 1 : -1);
        const volume = Math.min(
            1,
            Math.max(0, Math.round((video.volume + step) * 100) / 100)
        );

        if (volume === video.volume) return;

        video.volume = volume;
        if (video.muted && volume > 0) video.muted = false;
        showToast(`音量 ${Math.round(volume * 100)}%`, 600);
    }, { passive: false, capture: true });

    /* ==================== 键盘 ==================== */
    const RATE_MAP = {
        Digit0: 0.5,
        Numpad0: 0.5,
        Digit1: 2.0,
        Numpad1: 2.0,
        Digit3: 3.0,
        Numpad3: 3.0,
    };

    window.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.repeat) return;
        if (isEditable(event.target)) return;

        const video = getVideo();
        if (!video || !isMouseInVideo(video)) return;

        const code = event.code;

        if (RATE_MAP[code] !== undefined) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setRate(video, RATE_MAP[code]);
            return;
        }

        switch (code) {
            case 'Digit5':
            case 'Numpad5':
                event.preventDefault();
                event.stopImmediatePropagation();
                togglePlay(video);
                break;

            case 'Digit7':
            case 'Numpad7':
                event.preventDefault();
                event.stopImmediatePropagation();
                prevEpisode();
                break;

            case 'Digit9':
            case 'Numpad9':
                event.preventDefault();
                event.stopImmediatePropagation();
                nextEpisode();
                break;

            // case 'KeyF':
            //     event.preventDefault();
            //     event.stopImmediatePropagation();
            //     toggleFullscreen();
            //     break;
        }
    }, true);
})();
