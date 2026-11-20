# Bart's Userscripts

[![CI](https://github.com/yanguanbai/script/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yanguanbai/script/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-16705a)](LICENSE) [![Release](https://img.shields.io/github/v/release/yanguanbai/script?label=release)](https://github.com/yanguanbai/script/releases/latest)

Small browser userscripts for Bilibili. Each public script has its own source file, version, documentation, and direct installation link.

中文入口：[README.md](README.md)

> **Want a desktop report of your own watch history?** [History Insights installer (Windows)](https://github.com/yanguanbai/script/releases/latest/download/HistoryInsights-Setup.exe) · [portable zip / all releases](https://github.com/yanguanbai/script/releases/latest) - drop in the backup exported by the Watch History script and get a locally generated annual report. Data never leaves the machine.

## Public Scripts

No userscript manager yet? Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/get-it/), refresh the browser, then use the Install links in the table below.

| Script | What it does | Version | Documentation & Install |
|---|---|---:|---|
| Watch History | Stores local watch times, progress, snapshots, search results, backups, and restores | 5.10.20 | [中文](src/bilibili-history/README.md) · [English](src/bilibili-history/README.en.md) · [Install](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-history/bilibili-history.user.js) · [Changelog](https://github.com/yanguanbai/script/commits/main/src/bilibili-history/bilibili-history.user.js) |
| Browsing Footprint | Records videos seen on list pages and makes them searchable later | 10.3.1 | [中文](src/bilibili-footprint/README.md) · [English](src/bilibili-footprint/README.en.md) · [Install](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-footprint/bilibili-footprint.user.js) · [Changelog](https://github.com/yanguanbai/script/commits/main/src/bilibili-footprint/bilibili-footprint.user.js) |
| Clean Links | Removes known tracking and sharing parameters from Bilibili URLs | 3.3.0 | [中文](src/bilibili-clean-link/README.md) · [English](src/bilibili-clean-link/README.en.md) · [Install](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-clean-link/bilibili-clean-link.user.js) · [Changelog](https://github.com/yanguanbai/script/commits/main/src/bilibili-clean-link/bilibili-clean-link.user.js) |

## Local Analysis Tool

[History Insights](tools/history-insights/README.en.md) ([简体中文](tools/history-insights/README.md)) turns the JSON backup exported by Watch History into an interactive viewing report, entirely on your machine: daily/monthly waveforms, a 24-hour × 7-day heatmap, a six-domain radar with share donut, a keyword nebula, creator leaderboards and most-rewatched videos. No login, no network calls, no uploads.

Easiest start: double-click `看我的观看历史.cmd` in the repository root. It launches the local server, finds the newest `bvh_history_backup_*.json` in Downloads / Desktop / Documents / the Bilibili backup folder, and opens the report with that file already loaded. Manually, run `node tools/history-insights/server.mjs` and click the `读最新备份` button or pick a file yourself.

Two independent designs: a paper-like light theme (flat rules, no cards) and an observatory dark theme (glass panels, neon ramps). Export-to-image and print-to-PDF are rendered by a separate clean browser process, so no extension overlays leak in and a dark theme exports as dark. Sample gallery: [docs/展示.md](tools/history-insights/docs/展示.md).

## Install

1. Install Tampermonkey or Violentmonkey.
2. Open an **Install** link above and confirm the browser extension prompt.
3. Refresh the matching Bilibili page.

The scripts store preferences and records locally through the userscript manager. Export important history before clearing extension data or moving browsers.

## Project Layout

- `src/` contains the three public userscripts and their documentation.
- `src/bilibili-history/tests/` contains isolated tests and JSON fixtures for the history script.
- `tools/` contains History Insights, a local analysis tool that runs on its own and is not installed with the userscripts.
- `tools/sync-readme-versions.mjs` fills the version column of the table above from each script's `@version`; CI runs it with `--check` and fails when the two drift apart.
- The keyboard-control script is private and excluded from the public release set.

## License

This repository is released under the [MIT license](LICENSE). The three public userscripts also declare `@license MIT` in their metadata, and `tools/history-insights/` (page, build and installer scripts included) falls under the same MIT terms. Bundled third-party files keep their own licenses: ECharts (Apache-2.0) and segmentit (MIT). Source notes and the verification checklist are in [DISTRIBUTION.md](DISTRIBUTION.md).
