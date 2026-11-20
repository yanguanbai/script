import { createServer } from 'node:http';
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { renderPng, renderPdf } from './exporter.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const exportDir = join(root, '.export-tmp');
const execFileAsync = promisify(execFile);

// 找备份的目录：用户指定过就优先用它（长期记住，存在用户配置里），没指定就扫这台机器默认会放文件的位置。
// 不写死任何人的私人路径：默认只认 Downloads / Desktop / Documents / OneDrive。
const configDir = process.env.APPDATA ? join(process.env.APPDATA, 'HistoryInsights') : join(root, '.config');
const configFile = join(configDir, 'config.json');
const backupPatterns = [/^bvh_history_backup.*\.json$/i, /^.*history.*\.json$/i];

function defaultBackupDirs() {
  const home = homedir();
  return [
    process.env.HISTORY_DIR,
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'OneDrive', 'Downloads'),
    join(home, 'OneDrive', 'Desktop')
  ].filter(Boolean);
}

async function readConfig() {
  try { return JSON.parse(await readFile(configFile, 'utf8')); } catch { return {}; }
}

async function saveConfig(patch) {
  const next = { ...(await readConfig()), ...patch };
  await mkdir(configDir, { recursive: true });
  await writeFile(configFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

async function backupDirs() {
  const { backupDir } = await readConfig();
  const saved = typeof backupDir === 'string' ? backupDir.trim() : '';
  return [...new Set([saved, ...defaultBackupDirs()].filter(Boolean))];
}

// 让用户选一个长期存放备份的文件夹（Windows 原生选择框），路径记进配置，下次自动用这个目录。
async function pickBackupDir() {
  if (process.platform !== 'win32') throw new Error('这个按钮目前只在 Windows 上可用，其他系统把目录填进配置文件的 backupDir 即可');
  const resultFile = join(tmpdir(), `history-insights-pick-${Date.now()}.txt`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择存放观看历史备份的文件夹'",
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    `  [IO.File]::WriteAllText('${resultFile.replace(/\\/g, '\\\\')}', $dialog.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))`,
    '}'
  ].join('; ');
  try {
    await execFileAsync('powershell.exe', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 180000 });
  } catch { /* 用户点取消或窗口被关掉，当作没选 */ }
  const chosen = await readFile(resultFile, 'utf8').catch(() => '');
  await rm(resultFile, { force: true }).catch(() => {});
  return chosen.trim();
}

async function findLatestBackup() {
  const dirs = await backupDirs();
  for (const pattern of backupPatterns) {
    let best = null;
    for (const dir of dirs) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !pattern.test(entry.name)) continue;
        const file = join(dir, entry.name);
        try {
          const info = await stat(file);
          if (!best || info.mtimeMs > best.mtimeMs) best = { file, name: entry.name, dir, size: info.size, mtimeMs: info.mtimeMs };
        } catch { /* 文件刚好被移走，跳过 */ }
      }
    }
    if (best) return best;
  }
  return null;
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try { spawn(command, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打不开浏览器就留着地址让人自己点 */ }
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' };

// 导出接口：前端把导入的原始文件内容连同主题一起发过来，这里写一份临时副本，
// 再让一台干净的浏览器去渲染。页面本身不参与排版，所以不会抖、也不会带上插件挂件。
async function readBody(request, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('数据过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleExport(request, response, mode) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`导出参数不合法：${error.message}`);
    return;
  }
  const { text, texts, names = [], theme = 'light', print = false, width = 1440 } = payload || {};
  const sources = Array.isArray(texts) && texts.length ? texts : text ? [text] : [];
  if (!sources.length) { response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('缺少数据内容'); return; }

  // 多个备份（比如不同日期导出的历史）先在这里合并去重，再交给渲染浏览器，
  // 这样导出结果和页面上看到的完全一致。
  let content = sources[0];
  if (sources.length > 1) {
    const { loadHistory, mergeHistories } = await import('./analytics.mjs');
    const parts = sources.map((source, index) => loadHistory(source, String(names[index] || '')));
    content = JSON.stringify({ records: mergeHistories(parts).records });
  }

  await mkdir(exportDir, { recursive: true });
  const token = randomUUID();
  const dataFile = join(exportDir, `${token}.json`);
  await writeFile(dataFile, content, 'utf8');

  const params = new URLSearchParams({ autoload: `/export-tmp/${token}.json`, theme: String(theme), export: mode });
  // 把原名带进页面：否则导出稿的标题栏会显示临时文件的那串 uuid
  const displayName = String((payload.names && payload.names[0]) || payload.filename || 'history.json');
  params.set('name', displayName);
  if (print) params.set('print', '1');
  const url = `http://127.0.0.1:${port}/index.html?${params.toString()}`;

  try {
    const buffer = mode === 'pdf'
      ? await renderPdf(url, { width: Number(width), height: 1000 })
      : await renderPng(url, { width: Number(width), height: Number(payload.height) || 900 });
    const subtype = mode === 'pdf' ? 'application/pdf' : 'image/png';
    const stamp = new Date().toISOString().slice(0, 10);
    response.writeHead(200, {
      'Content-Type': subtype,
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="history-insights-${stamp}.${mode === 'pdf' ? 'pdf' : 'png'}"`,
      'Cache-Control': 'no-store'
    });
    response.end(buffer);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`导出失败：${error.message}`);
  } finally {
    await rm(dataFile, { force: true }).catch(() => {});
  }
}

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);

  if (request.method === 'POST' && (pathname === '/export/png' || pathname === '/export/poster')) { await handleExport(request, response, 'png'); return; }
  if (request.method === 'POST' && pathname === '/export/pdf') { await handleExport(request, response, 'pdf'); return; }

  // 导出用的临时数据副本，只在渲染期间存在
  if (pathname.startsWith('/export-tmp/')) {
    const name = pathname.slice('/export-tmp/'.length);
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) { response.writeHead(403).end('Forbidden'); return; }
    try {
      const file = join(exportDir, name);
      await stat(file);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(await readFile(file));
    } catch { response.writeHead(404).end('Not found'); }
    return;
  }

  // 一键启动用：告诉页面最新备份叫什么、在哪；内容本身走 /local/latest.json
  if (pathname === '/local/info') {
    const latest = await findLatestBackup();
    const config = await readConfig();
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({
      ...(latest ? { found: true, name: latest.name, dir: latest.dir, size: latest.size, mtime: latest.mtimeMs } : { found: false }),
      savedDir: config.backupDir || '',
      configFile,
      searched: await backupDirs()
    }));
    return;
  }

  // 记住用户选的长期目录；也可以直接传 dir 字符串（其他系统走这条路）
  if (request.method === 'POST' && pathname === '/local/config') {
    try {
      let dir = '';
      if ((request.headers['content-type'] || '').includes('application/json')) {
        dir = String(JSON.parse(await readBody(request, 1024 * 1024)).dir || '').trim();
      }
      if (dir) {
        const info = await stat(dir).catch(() => null);
        if (!info || !info.isDirectory()) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: '这个路径不是文件夹' }));
          return;
        }
      }
      await saveConfig({ backupDir: dir });
      const latest = await findLatestBackup();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, savedDir: dir, ...(latest ? { found: true, name: latest.name, dir: latest.dir } : { found: false }) }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  // 弹一个原生文件夹选择框，选完就记下来
  if (request.method === 'POST' && pathname === '/local/pick') {
    try {
      const dir = await pickBackupDir();
      if (!dir) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, cancelled: true }));
        return;
      }
      await saveConfig({ backupDir: dir });
      const latest = await findLatestBackup();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, savedDir: dir, ...(latest ? { found: true, name: latest.name, dir: latest.dir } : { found: false }) }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (pathname === '/local/latest.json') {
    const latest = await findLatestBackup();
    if (!latest) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ found: false, searched: await backupDirs() }));
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Backup-Name': encodeURIComponent(latest.name),
      'X-Backup-Dir': encodeURIComponent(latest.dir)
    });
    response.end(await readFile(latest.file));
    return;
  }

  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(root, requested);
  if (target !== root && !target.startsWith(root + sep)) { response.writeHead(403).end('Forbidden'); return; }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

const port = Number(process.env.PORT || 4173);
const shouldOpen = process.argv.includes('--open') || process.env.OPEN === '1';
const baseUrl = `http://127.0.0.1:${port}`;

async function openDashboard() {
  const latest = await findLatestBackup().catch(() => null);
  const url = latest ? `${baseUrl}/index.html?autoload=/local/latest.json` : `${baseUrl}/index.html`;
  openBrowser(url);
  console.log(`已在浏览器打开：${url}`);
  if (!latest) {
    const dirs = await backupDirs();
    console.log(`还没找到备份文件，页面里可以指定一个长期存放的文件夹。找过的位置：${dirs.join('、')}`);
  }
}

server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    console.log(`端口 ${port} 已经在用，说明服务早就在跑，直接打开页面就行：${baseUrl}`);
    if (shouldOpen) await openDashboard();
    process.exit(0);
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`History Insights: ${baseUrl}`);
  if (shouldOpen) openDashboard();
});
