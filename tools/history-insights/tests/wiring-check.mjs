import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const ids = new Set(Array.from(html.matchAll(/id="([^"]+)"/g), match => match[1]));
const refs = new Set(Array.from(app.matchAll(/\$\('#([\w-]+)'\)/g), match => match[1]));

const missing = Array.from(refs).filter(id => !ids.has(id));
if (missing.length) {
  console.error('app.js 引用了 index.html 中不存在的 id:', missing);
  process.exitCode = 1;
} else {
  console.log(`页面接线正常：app.js 引用 ${refs.size} 个 id，全部存在于 index.html（共 ${ids.size} 个）。`);
}

// 单文件版最容易变成“旧构建”：一旦落后于 index.html / app.js，用户双击看到的还是写死的旧文案。
const standalonePath = path.join(root, '观看报告.html');
const standaloneTokens = ['id="heatmap-legend-note"', '格子颜色越亮', 'mergeHistories', 'loadLatestBackup', 'id="pick-dir"'];
if (fs.existsSync(standalonePath)) {
  const built = fs.readFileSync(standalonePath, 'utf8');
  const stale = standaloneTokens.filter(token => !built.includes(token));
  if (stale.length) {
    console.error('单文件版落后于源码，请重跑 node build-standalone.mjs，缺:', stale);
    process.exitCode = 1;
  } else {
    console.log('单文件版与源码同步。');
  }
}

const css = fs.readFileSync(path.join(root, 'observatory.css'), 'utf8');
const balance = (css.match(/{/g) || []).length - (css.match(/}/g) || []).length;
if (balance !== 0) {
  console.error('observatory.css 花括号不配对，差值:', balance);
  process.exitCode = 1;
} else {
  console.log('observatory.css 花括号配对正常。');
}
