// 用一台干净的浏览器把页面渲染成图片 / PDF。
//
// 为什么不在页面里用 canvas 重画、也不用 window.print()：
//  - canvas 重画要重新算一遍布局，页面会跟着抖一下，而且中文字距、图表渐变很难和屏幕一致；
//  - window.print() 打印的是当前这个窗口，浏览器插件注入的挂件、悬浮球会一起被印进去，
//    还要求用户在打印对话框里手动打开「背景图形」，暗色才出得来。
// 这里改成：另起一个临时的无插件浏览器进程，加载同一份数据，按当前主题渲染后截图或导出 PDF。
// 页面本身不动，导出的东西也不会带上任何插件界面。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function findBrowser() {
  return CANDIDATES.find(item => item && existsSync(item)) || '';
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function connect(url) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolveSocket(socket);
    socket.onerror = () => reject(new Error('无法连接浏览器调试通道'));
  });
}

async function withPage(url, viewport, run) {  const browser = findBrowser();
  if (!browser) throw new Error('没有找到 Chrome / Edge，无法渲染导出');
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'hi-export-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });

  let socket = null;
  const cleanup = async () => {
    try { socket?.close(); } catch { /* 已经关了 */ }
    try { child.kill(); } catch { /* 已经退出 */ }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { /* 还没起来 */ }
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error('浏览器没有在预期时间内启动');

    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    socket = await connect(target.webSocketDebuggerUrl);

    let seq = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    const send = (method, params = {}) => {
      seq += 1;
      const id = seq;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise(resolve => pending.set(id, resolve));
    };
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || '页面脚本出错');
      return result.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    // PDF 不能锁视口宽度：一锁，页面就按 1440 排版，A4 纸只会裁掉右边半截。
    // 不设 device metrics 时，printToPDF 会按纸张可用宽度重新排版。
    if (viewport) {
      await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    }

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const state = await evaluate("(() => { const d = document.querySelector('#dashboard'); return !!d && d.hidden === false && !document.querySelector('#status')?.dataset?.busy; })()");
      if (state) break;
      await sleep(250);
    }
    // 留出图表动画结束的时间，否则截到半透明的入场帧。
    await sleep(1600);
    return await run({ send, evaluate });
  } finally {
    await cleanup();
  }
}

export async function renderPng(url, { width = 1440, height = 900, maxHeight = 12000 } = {}) {
  return withPage(url, { width, height }, async ({ send }) => {
    const metrics = await send('Page.getLayoutMetrics');
    const size = metrics.result.cssContentSize || metrics.result.contentSize;
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: Math.min(Math.round(size.height), maxHeight), scale: 1 }
    });
    return Buffer.from(shot.result.data, 'base64');
  });
}

export async function renderPdf(url) {
  // 不锁视口、也不让 Chrome 自己按 @page 折中：直接把纸张尺寸写成 794×1123 CSS 像素（A4 @96dpi），
  // 页边距由打印样式里的 body 内边距提供。这样纸张内容宽度和页面排版宽度完全一致，
  // 图表不会被拉伸，也不会被裁掉右边半截。
  return withPage(url, null, async ({ send }) => {
    const pdf = await send('Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27, paperHeight: 11.69,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0
    });
    return Buffer.from(pdf.result.data, 'base64');
  });
}
