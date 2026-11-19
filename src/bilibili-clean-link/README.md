# Bilibili 干净链接与分享净化

当前版本：`3.3.0` · 作者：Bart · [English](README.en.md)

这个脚本专门处理 Bilibili 链接中的追踪和分享来源参数，让地址栏、页面链接和复制出来的链接更干净。它只删除明确列入规则的参数，不会把所有查询参数一股脑删掉。

## 功能

- 页面加载和 SPA 路由切换时清理当前地址栏。
- 清理页面中动态生成的 Bilibili `<a>` 链接。
- 点击或右键链接前再次清理目标地址，减少页面脚本重新写入追踪参数的影响。
- 处理动态 DOM 新增或修改的链接。
- 包装 Clipboard API 的 `writeText`，复制包含 Bilibili URL 的文本时清理其中的追踪参数，同时保留 URL 外的文字和标点。
- 将旧的 `bilibili.tv` 地址修正为对应的 `bilibili.com` 域名形式。

## 安装

1. 安装 Tampermonkey 或 Violentmonkey。
2. 点击根目录 README 中的安装链接并确认。
3. 刷新 Bilibili 页面。

脚本没有用户设置项，安装后自动运行。

## 保留规则

脚本只删除明确属于来源、分享或追踪的参数，例如 `spm_id_from`、`from_source`、`share_source`、`vd_source`、`spmid` 和 `trackid`。可能影响内容定位或播放状态的参数不会因为“看起来像参数”就被删除。

## 限制

脚本只处理 Bilibili 域名；它不会改写其他网站的链接。剪贴板包装是否生效取决于浏览器对 Clipboard API 的实现和权限。
