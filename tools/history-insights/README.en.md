# History Insights

[简体中文](README.md)

History Insights is a local viewing-history dashboard. It turns an exported backup into daily activity, viewing-time, keyword, content-type, creator, and most-watched views. Analysis runs in a browser Web Worker; no account, API key, or analytics service is required.

## Run locally

Requires Node.js 18 or later. You do not need to run `npm install`.

1. Open a terminal at the repository root.
**Install the release (no terminal, no Node)** : grab `HistoryInsights-Setup.exe` from [Releases](https://github.com/yanguanbai/script/releases/latest) (or the `-portable.zip` on the same page if you prefer no installer) and double-click it; it installs into the location you pick, adds a Start-menu and desktop shortcut, registers a normal uninstall entry, and ships a portable Node so image / PDF export works out of the box. Windows SmartScreen may warn because the build is unsigned - choose *More info -> Run anyway*.

**You choose where it goes**: the first install opens a folder picker pre-filled with `%LOCALAPPDATA%\Programs\HistoryInsights` - confirm it, or pick any parent folder (say `D:\Apps`) and it creates a `HistoryInsights` subfolder inside, so nothing is scattered into the folder you picked; cancelling writes nothing. Later upgrades reuse that location without asking again. Scripted installs can pass the full path: `-Dir "D:\Apps\HistoryInsights"`.

The installed shortcut launches the local server first (silently, in the background), then opens `http://127.0.0.1:4173`. That is deliberate: *read newest backup*, *choose backup folder*, *export image* and *print / PDF* all need the local service. If you open `app\report.html` directly instead, those controls are disabled with a note - it is the offline single-file build.

**Upgrading** is just installing again. The installer stops any service still listening on port 4173, rebuilds the whole `app` directory (so stale files from older versions are gone) and updates `version.txt` plus the version shown in *Settings → Apps*. Your own backup folder setting in `%APPDATA%\HistoryInsights\config.json` is left untouched.

**Run from the repository**

2. Double-click `一键看报告.cmd` in this folder: it starts the server, locates the newest backup, and opens the page with it loaded. To do it by hand, run `node tools/history-insights/server.mjs` instead and click the `读最新备份` button.
3. Open the local address printed by the server (default: `http://127.0.0.1:4173`).
4. Select a viewing-history JSON backup or CSV export. The page analyzes all time after import; adjust the date range as needed.

You can also drop a file onto the import area. Date controls include **All**, **Last 30 days**, **Last 7 days**, and custom start/end dates. The page ships two independent design languages (paper / observatory); see the sample gallery at [docs/展示.md](docs/展示.md).

**Where it looks for backups**: until you pick a folder yourself, *read newest backup* scans `HISTORY_DIR`, `Downloads`, `Desktop`, `Documents`, the OneDrive copies of the last two, **and the download folder your browser is configured to use** - it reads `download.default_directory` from the `Preferences` file of Chrome / Edge / Brave / Vivaldi / Chromium / 360Chrome profiles, and `browser.download.dir` from each Firefox profile's `prefs.js`. So a backup that landed in your browser's usual download folder (even on another drive) is found without any setup. Those preference files are only read, never written, and nothing leaves the machine. In browser folders only strictly named `bvh_history_backup*.json` files are accepted, so unrelated JSON there is not mistaken for a backup.

**Export image** and **Print / PDF** never re-layout the current page: the page posts the raw backup to the local server, which launches a separate clean Chrome (temporary profile, no extensions), renders it, and returns a PNG or PDF. The page therefore never jumps, extension overlays never appear in the output, and a dark theme exports as a dark PDF.

## Dashboard

- **Overview**: distinct video/episode entries, cumulative watches for included records, snapshots in range, and named creators. The four mini charts show daily distinct videos with snapshots, video watch-count distribution, daily snapshot trend, and daily distinct creators with snapshots.
- **Viewing trend**: daily or monthly snapshot counts.
- **Viewing times**: weekday-by-hour heatmap based on snapshot timestamps, not watch duration.
- **Six-domain preference radar**: six fixed axes (Music, Games, Knowledge, Tech, Media & Anime, Life & Entertainment) measured in cumulative watches, so time ranges stay comparable; the panel badge shows classifier coverage.
- **Domain share donut**: video entries per domain (classified entries only), with the panel badge showing coverage and the unclassified count. The centre label is fixed and never covered by a tooltip.
- **Keyword nebula**: the top ten terms, with a continuously scaled font size driven by cumulative watches and the entry count inside each bubble. Selecting a term filters the video list; selecting it again clears the filter.
- **Record highlights**: day with most snapshots, video with the highest cumulative count in the backup, and earliest identifiable snapshot. Missing source data is shown as unavailable.
- **Creators and videos**: creators ranked by cumulative watches of their associated videos, with a "repeat viewers" (count ≥ 2) ratio. Video entries show title, ID, creator, domain, keywords, progress, snapshot count, and expandable snapshot details. A Bilibili page opens only when its title is clicked.

## Data semantics

Date filtering uses timestamps from snapshots. Cumulative watches come from each video's cumulative backup field. After filtering, this is still the historical cumulative sum for included videos, not the number of plays during that period. Snapshots cannot reveal actual watch duration. The creator repeat ratio uses named distinct video records as its denominator and records with cumulative count above one as its numerator; it is not a count of user-level play events.

The parser supports `bvh-history-backup` v2, top-level arrays, and common JSON collections named `records`, `items`, `history`, or `data`, plus CSV files. Collection parts are expanded; duplicate video keys are merged, retaining the larger cumulative count and deduplicating snapshots by timestamp, position, source, and progress. All-time analysis includes records without a recognized timestamp; date-limited analysis excludes undated records.

Chinese keywords are produced locally by the `segmentit` tokenizer, keeping nouns, verbs, adjectives, place names, and Latin words while dropping pronouns, particles, adverbs, conjunctions, and numerals, then layered with a bundled topic list and a stop-word filter. Content domains come from a fixed vocabulary in `content-domains.mjs`, scored by matched terms and term length; zero-score records are counted as "Unclassified" and the coverage ratio is shown on the radar badge. Both are rule-based counts, not AI semantic analysis.

## Layout and compatibility

The page ships two separate design languages rather than one palette with the glow removed: **space** is black + aurora glow + glass panels + neon accents, while **paper** is ivory paper + ink hairlines + serif headings + square cards + low-saturation pine, ink-blue and wisteria, with buttons, milestone icons, keyword bubbles and donut colours retuned for print. `<html data-theme>` holds the user's choice and `<html data-palette>` holds the palette actually in effect (`space` / `paper`), resolved from `prefers-color-scheme` in system mode.

The page uses a 12-column grid: trend and heatmap each take a full row, radar / donut / nebula are 4:4:4, creators and records are 5:7, two columns below 1024px, a single column below 860px, and tighter type below 560px. Charts listen to both window and container size, so resizing or zooming does not clip content.

Heatmap colours are bucketed by quantiles (zero, median, 75th, 90th, 95th) instead of a linear ramp: when snapshots cluster in a few slots, a linear scale flattens every non-peak cell into one colour.

Printing follows the current theme and disables every entrance animation (otherwise panels carrying the `rise` animation stay at `opacity: 0` and print as blank pages). The print layout fixes a 700px text column with charts redrawn at 660px, and `print-color-adjust: exact` keeps backgrounds without asking the user to tick "Background graphics" in the print dialog. A dark theme therefore prints as dark, not as an inverted white page.

## Privacy and dependencies

JSON/CSV files are read and analyzed by a local Web Worker and are not sent to a server. The page, Apache ECharts 5.5.0, and the `segmentit` 2.0.3 tokenizer are bundled in the repository, so no CDN is needed; the Apache-2.0 and MIT license texts are in `vendor/echarts.LICENSE` and `vendor/segmentit.LICENSE`. The local server binds to `127.0.0.1`. A Bilibili video link is contacted only after the user clicks it.

Imported history is not stored after the page is closed. The theme choice is saved in the browser's `localStorage`.

## File responsibilities

- `index.html` and `observatory.css`: dashboard structure and themes.
- `app.js`: charts, filters, video details, and page interactions.
- `worker.js`: local file reading and background normalization/analysis.
- `analytics.mjs`: field aliases, deduplication, tokenization, keywords, and metric semantics.
- `content-domains.mjs`: the six-domain vocabulary and scoring function.
- `server.mjs`: serves local static files only.
- `vendor/`: offline ECharts and segmentit builds with their licenses.
