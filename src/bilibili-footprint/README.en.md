# Bilibili Browsing Footprint

Version `10.3.1` · Author: Bart · [中文文档](README.md)

This userscript records videos that actually enter the viewport on Bilibili list pages. It is useful when you saw a video while scrolling but did not open it and want to find it again later.

## Features

- Uses `IntersectionObserver` so off-screen cards are not recorded merely because they exist in the DOM.
- Stores BV ID, title, cover, uploader, duration, and URL; one record is kept per BV ID.
- Provides a floating local panel with keyword search, title/uploader highlighting, and new-tab navigation.
- Adds an optional “Viewed” badge after a video card is pressed.
- Supports dragging the floating button, edge snapping, and a long-press light/dark theme switch.
- Keeps up to 100 records by default and allows a menu setting from `0` to `3000`.

## Install and Configure

Install Tampermonkey or Violentmonkey, open the install link in the root README, confirm it, and refresh a Bilibili list page. Use the userscript menu to change the retention limit, count bubble, and viewed badge.

`0` means session-only storage. A positive value persists records through page changes and removes the oldest records after the limit is exceeded.

## Scope and Limits

The script matches Bilibili list and search pages, while excluding video playback, favorites, and official history pages. It reads card data locally and does not upload the footprint. Bilibili markup changes may require future selector updates.
