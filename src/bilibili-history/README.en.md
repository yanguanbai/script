# Bilibili Watch History

Version `5.10.20` · Author: Bart · [中文文档](README.md)

This userscript keeps a local, time-aware watch history for Bilibili. It records watch counts, playback progress, watch timestamps, and multiple snapshots for a video or episode. It helps answer “when did I watch this?” rather than relying only on Bilibili's latest official history entry.

## What It Provides

- Records supported video, bangumi, and live activity through the userscript manager's local storage APIs.
- Keeps recent snapshots with playback position, progress, timestamp, source, and completion state.
- Adds local history panels to playback and history pages, with sorting, deletion, cleanup, and detailed search.
- Marks supported video cards with local watch count and recent progress.
- Synchronizes Bilibili official history into local records without treating it as the only source of truth.
- Exports and imports JSON backups, including compatibility handling for older formats.
- Supports ordinary videos, multi-page collections, bangumi seasons, episodes, and legacy aggregate data.
- Provides optional IndexedDB cold storage and database-primary migration for large local histories.

## Install

1. Install Tampermonkey or Violentmonkey.
2. Open the Watch History install link in the repository root README.
3. Confirm the extension installation and refresh Bilibili.

The script is a single `.user.js` file. Normal settings are changed from the history panel; users do not need to edit the source.

## Supported Pages

The script matches the Bilibili home page, video pages, bangumi playback, live pages, dynamic pages, space/search pages, and `/history` pages. Matching a URL does not guarantee every future Bilibili card layout will remain compatible.

## Data Model

Ordinary videos are stored by BV identity. Collections use a container with `parts[]`; bangumi seasons use season identity and episode identity rather than merging unrelated seasons by title. Imports merge metadata conservatively so a missing field does not erase useful local data.

## Search and Management

The history panel supports ordinary keyword search and structured filters for watch count, grouped count, progress, dates, and snapshot content. It also shows backup and cleanup state. Bulk cleanup is user initiated and should be preceded by a backup export.

## Storage and Privacy

Records are stored locally through the userscript manager and optional local IndexedDB storage. The history script also reads Bilibili pages and official endpoints when collecting or synchronizing history; local storage does not mean that the browser makes no network requests. This is not a cloud sync service. Clearing extension data, changing browser profiles, or uninstalling the manager can remove local records; export a JSON backup before migration or cleanup.

## Reading Your Backup

The exported JSON backup is itself a usable archive: every record carries a watch count, the last progress, and up to five snapshot timestamps. [History Insights](../../tools/history-insights/README.en.md) turns that file into an interactive report, entirely on your machine — no login, no uploads.

Double-click `看我的观看历史.cmd` in the repository root: it starts the server, finds the newest backup on its own, and opens the report already loaded. Manually, run `node tools/history-insights/server.mjs` and click the `读最新备份` button (or pick the file yourself).

It answers: what rhythm did my year follow (daily/monthly waveform, 24-hour × 7-day heatmap), where did my attention go (six content domains with share donut), what did I rewatch (creator leaderboard, most-watched videos, keyword nebula), and when was I most absorbed (peak day, highest rewatch count, earliest record).

Measurements are snapshots: "cumulative watches" is a field carried by the backup, not the number of plays inside the selected range, and snapshots cannot reconstruct watch duration. Sample gallery: [docs/展示.md](../../tools/history-insights/docs/展示.md).

## Testing

The repository keeps isolated Node.js checks under `tests/`. They exercise collection import, title correction, cold database handling, migration, and queue behavior. They do not replace real browser verification against the current Bilibili site.
