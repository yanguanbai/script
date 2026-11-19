# Bart's Userscripts

Small browser userscripts for Bilibili. Each public script has its own source file, version, documentation, and direct installation link.

中文入口：[README.md](README.md)

## Public Scripts

| Script | What it does | Version | Documentation | Install |
|---|---|---:|---|---|
| Watch History | Stores local watch times, progress, snapshots, search results, backups, and restores | 5.10.20 | [中文](src/bilibili-history/README.md) · [English](src/bilibili-history/README.en.md) | [Install](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-history/bilibili-history.user.js) |
| Browsing Footprint | Records videos seen on list pages and makes them searchable later | 10.3.1 | [中文](src/bilibili-footprint/README.md) · [English](src/bilibili-footprint/README.en.md) | [Install](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-footprint/bilibili-footprint.user.js) |
| Clean Links | Removes known tracking and sharing parameters from Bilibili URLs | 3.3.0 | [中文](src/bilibili-clean-link/README.md) · [English](src/bilibili-clean-link/README.en.md) | [Install](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-clean-link/bilibili-clean-link.user.js) |

## Install

1. Install Tampermonkey or Violentmonkey.
2. Open an **Install** link above and confirm the browser extension prompt.
3. Refresh the matching Bilibili page.

The scripts store preferences and records locally through the userscript manager. Export important history before clearing extension data or moving browsers.

## Project Layout

- `src/` contains the three public userscripts and their documentation.
- `src/bilibili-history/tests/` contains isolated tests and JSON fixtures for the history script.
- `tools/` contains repository maintenance utilities, not installable scripts.
- The keyboard-control script is private and excluded from the public release set.

## License and Source Notes

The repository does not declare one license for every file. Existing per-script metadata is preserved while authorship and third-party source checks are completed. See [DISTRIBUTION.md](DISTRIBUTION.md).
