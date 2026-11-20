// 用无头 Chrome 把 docs/banner*.html 渲染成同名 png（1x）与 @2x。
// 用法：node docs/build-banner.mjs [banner|banner-dark|banner-alt]  不带参数则只出 banner
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const bases = names.length ? names : ['banner'];

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'google-chrome',
  'chromium',
].filter(Boolean);

const chrome = candidates.find((p) => {
  if (path.isAbsolute(p)) return fs.existsSync(p);
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [p], { stdio: 'ignore' }); return true; } catch { return false; }
});

if (!chrome) {
  console.error('找不到 Chrome，可用 CHROME_PATH 指定可执行文件路径');
  process.exit(1);
}

for (const base of bases) {
  const html = path.join(here, `${base}.html`);
  if (!fs.existsSync(html)) {
    console.error(`缺少源文件：${base}.html`);
    process.exit(1);
  }
  const shots = [
    { file: `${base}.png`, scale: 1 },
    { file: `${base}@2x.png`, scale: 2 },
  ];
  for (const shot of shots) {
    const out = path.join(here, shot.file);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hi-banner-'));
    try {
      execFileSync(chrome, [
        '--headless=new',
        '--hide-scrollbars',
        '--disable-gpu',
        `--force-device-scale-factor=${shot.scale}`,
        '--window-size=1200,630',
        `--screenshot=${out}`,
        '--user-data-dir=' + profile,
        '--no-first-run',
        '--disable-extensions',
        'file:///' + html.replace(/\\/g, '/'),
      ], { stdio: 'ignore', timeout: 60000 });
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
    if (!fs.existsSync(out)) {
      console.error(`渲染失败：${shot.file}`);
      process.exit(1);
    }
    console.log(`${path.basename(out)}  ${fs.statSync(out).size} B`);
  }
}

console.log(`已渲染：${bases.join(' / ')}`);
