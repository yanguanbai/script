# Bilibili Clean Links

Version `3.3.0` · Author: Bart · [中文文档](README.md)

This userscript removes known tracking and sharing parameters from Bilibili URLs. It cleans the address bar, page anchors, navigation updates, and copied text without deleting every query parameter indiscriminately.

## Features

- Cleans the current URL at startup and after SPA navigation.
- Rewrites Bilibili links already on the page and links added by dynamic rendering.
- Cleans a target again before click or context-menu handling.
- Wraps `navigator.clipboard.writeText` when the browser permits it, preserving surrounding text and punctuation.
- Converts legacy `bilibili.tv` hostnames to the corresponding `bilibili.com` form.

## Install

Install Tampermonkey or Violentmonkey, open the Clean Links install link in the root README, confirm it, and refresh Bilibili. There are no user settings.

## Safety Boundary

Only an explicit allowlist of tracking, source, and sharing parameters is removed. Parameters that may affect content selection or playback are preserved. Non-Bilibili URLs are left untouched.
