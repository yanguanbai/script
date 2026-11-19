# Bart 的用户脚本

面向 Bilibili 的浏览器用户脚本。项目按可独立安装和维护的脚本划分；本仓库继续作为总目录和发行源，不需要额外克隆子仓库。

## 脚本

| 脚本 | 用途 | 版本 | 安装 |
|---|---|---:|---|
| [观看历史可回溯](src/bilibili-history/README.md) | 本地记录观看时间、进度和历史快照，支持搜索、备份与恢复 | 5.10.20 | [安装地址（推送后生效）](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-history/bilibili-history.user.js) |
| [浏览足迹](src/bilibili-footprint/README.md) | 记录列表页出现过的视频并支持搜索回溯 | 10.3.1 | [安装地址（推送后生效）](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-footprint/bilibili-footprint.user.js) |
| [干净链接](src/bilibili-clean-link/bilibili-clean-link.user.js) | 清理 Bilibili 链接中的追踪参数 | 3.3.0 | [安装地址（推送后生效）](https://raw.githubusercontent.com/yanguanbai/script/main/src/bilibili-clean-link/bilibili-clean-link.user.js) |

## 安装

1. 安装 Tampermonkey 或 Violentmonkey 浏览器扩展。
2. 点击上表对应的“安装”链接，并在扩展弹出的安装页确认。
3. 安装后刷新匹配的网站页面。

脚本偏好和记录保存在浏览器的用户脚本管理器本地存储中。卸载扩展或清除扩展数据前，请先用脚本提供的导出功能备份重要记录。

## 配置

普通用户不需要编辑脚本源码。浏览足迹与观看历史的常用选项可从脚本面板或扩展菜单调整。配置只保存在本机，不上传到本仓库。

## 发行与更新

脚本以独立版本号维护，完整源码保存在各自 `src/` 子目录。上表 Raw 地址对应重构后的目标路径，必须先将本地改动推送到 `main` 后才能安装；在推送前这些地址可能返回 404。浏览器中的更新可由用户脚本管理器按脚本元数据检查；Greasy Fork 上的安装和更新继续由 Greasy Fork 管理。

当前仓库保留原仓库历史；`tools/` 是仓库维护工具，不属于四个独立脚本项目。

## 许可证与来源

键盘控制脚本是维护者私用内容，不属于本仓库的公开发行集合。其他三个脚本暂不声明仓库级统一许可证；各脚本保留原有元数据，详见 [发行来源说明](DISTRIBUTION.md)。
