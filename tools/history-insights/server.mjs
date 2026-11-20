import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const configDir = process.env.APPDATA ? join(process.env.APPDATA, 'HistoryInsights') : join(root, '.config');
const configFile = join(configDir, 'config.json');
const backupPatterns = [/^bvh_history_backup.*\.json$/i, /^.*history.*\.json$/i];

// 浏览器自己设的下载目录：Chromium 系记在 User Data\<Profile>\Preferences 的 download.default_directory，
// Firefox 记在 prefs.js 的 browser.download.dir。只读配置文件，读不到就安静跳过。
// 结果缓存一次，findLatestBackup 每次调用时不必重复读这些大文件。
let browserDirsCache = null;
function browserDownloadDirs() {
  if (browserDirsCache) return browserDirsCache;
  if (process.platform !== 'win32') { browserDirsCache = []; return browserDirsCache; }
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const found = [];

  const chromiumPrefs = [];
  const userDataRoots = [
    join(local, 'Google', 'Chrome', 'User Data'),
    join(local, 'Microsoft', 'Edge', 'User Data'),
    join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    join(local, 'Vivaldi', 'User Data'),
    join(local, 'Chromium', 'User Data'),
    join(local, '360Chrome', 'Chrome', 'User Data'),
  ];
  for (const userData of userDataRoots) {
    if (!existsSync(userData)) continue;
    let profiles = [];
    try {
      profiles = readdirSync(userData, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
    } catch { continue; }
    for (const profile of profiles) chromiumPrefs.push(join(userData, profile, 'Preferences'));
  }
  // Opera 的 Preferences 直接放在 Opera Stable 目录里，没有 Default 这一层
  const operaPrefs = join(roaming, 'Opera Software', 'Opera Stable', 'Preferences');
  if (existsSync(operaPrefs)) chromiumPrefs.push(operaPrefs);

  for (const file of chromiumPrefs) {
    if (!existsSync(file)) continue;
    try {
      const prefs = JSON.parse(readFileSync(file, 'utf8'));
      for (const key of ['download', 'savefile']) {
        const dir = prefs?.[key]?.default_directory;
        if (typeof dir === 'string' && dir.trim()) found.push(dir.trim());
      }
    } catch { /* 浏览器正在写这个文件时可能是半截 JSON，忽略 */ }
  }

  const firefoxRoot = join(roaming, 'Mozilla', 'Firefox', 'Profiles');
  if (existsSync(firefoxRoot)) {
    let profiles = [];
    try { profiles = readdirSync(firefoxRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { profiles = []; }
    for (const profile of profiles) {
      const prefsJs = join(firefoxRoot, profile, 'prefs.js');
      if (!existsSync(prefsJs)) continue;
      try {
        const text = readFileSync(prefsJs, 'utf8');
        const m = text.match(/user_pref\("browser\.download\.dir",\s*("(?:[^"\\]|\\.)*")\)/);
        if (m) {
          const dir = JSON.parse(m[1]);
          if (typeof dir === 'string' && dir.trim()) found.push(dir.trim());
        }
      } catch { /* prefs.js 里出现异常行时忽略 */ }
    }
  }

  browserDirsCache = found.filter((dir) => {
    try { return existsSync(dir); } catch { return false; }
  });
  return browserDirsCache;
}

// 浏览器下载目录里可能混着别的 json，只有严格命名的备份才认（宽松的 *history*.json 只用于标准目录）
function isBrowserDir(dir) {
  return browserDownloadDirs().includes(dir);
}

// 找备份的目录：用户指定过就优先用它（长期记住，存在用户配置里），没指定就扫这台机器默认会放文件的位置。
// 不写死任何人的私人路径：默认认 Downloads / Desktop / Documents / OneDrive，再加浏览器自己设的下载目录。
function defaultBackupDirs() {
  const home = homedir();
  return [
    process.env.HISTORY_DIR,
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'OneDrive', 'Downloads'),
    join(home, 'OneDrive', 'Desktop'),
    ...browserDownloadDirs()
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

// 让用户选一个长期存放备份的文件夹，路径记进配置，下次自动用这个目录。
// 用的是和「选文件」同一个资源管理器对话框（IFileDialog）的「选文件夹」模式：有地址栏、能直接粘路径，
// 并且从当前找到备份的位置打开，不用在旧式树形框里一层层点。
const pickScript = String.raw`
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;

public class HiFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);

    public static string Pick(string initial, string title)
    {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        // FOS_PICKFOLDERS(0x20) | FOS_FORCEFILESYSTEM(0x40) | FOS_PATHMUSTEXIST(0x800)
        dialog.SetOptions(options | 0x20u | 0x40u | 0x800u);
        if (title != null && title.Length > 0) dialog.SetTitle(title);
        if (initial != null && initial.Length > 0)
        {
            try
            {
                Guid iid = typeof(IShellItem).GUID;
                IShellItem folder;
                SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
                dialog.SetFolder(folder);
                Marshal.ReleaseComObject(folder);
            }
            catch { }
        }
        if (dialog.Show(IntPtr.Zero) != 0)
        {
            Marshal.ReleaseComObject(dialog);
            return null;
        }
        IShellItem result;
        dialog.GetResult(out result);
        string path = "";
        if (result != null)
        {
            // SIGDN_FILESYSPATH
            result.GetDisplayName(0x80058000u, out path);
            Marshal.ReleaseComObject(result);
        }
        Marshal.ReleaseComObject(dialog);
        return path;
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
$path = [HiFolderPicker]::Pick($env:HI_PICK_INIT, $env:HI_PICK_TITLE)
if ($path) { [IO.File]::WriteAllText($env:HI_PICK_OUT, $path, (New-Object System.Text.UTF8Encoding($false))) }
`;

async function pickBackupDir(initialDir) {
  if (process.platform !== 'win32') throw new Error('这个按钮目前只在 Windows 上可用，其他系统把目录填进配置文件的 backupDir 即可');
  const stamp = Date.now();
  const resultFile = join(tmpdir(), `history-insights-pick-${stamp}.txt`);
  const scriptFile = join(tmpdir(), `history-insights-pick-${stamp}.ps1`);
  await writeFile(scriptFile, `\uFEFF${pickScript}`, 'utf8');
  try {
    await execFileAsync('powershell.exe', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      timeout: 300000,
      env: {
        ...process.env,
        HI_PICK_INIT: initialDir || '',
        HI_PICK_TITLE: '选择存放观看历史备份的文件夹',
        HI_PICK_OUT: resultFile
      }
    });
  } catch { /* 用户点取消或窗口被关掉，当作没选 */ } finally {
    await rm(scriptFile, { force: true }).catch(() => {});
  }
  const chosen = await readFile(resultFile, 'utf8').catch(() => '');
  await rm(resultFile, { force: true }).catch(() => {});
  return chosen.trim();
}

async function findLatestBackup() {
  const dirs = await backupDirs();
  // 第一轮按严格命名找（bvh_history_backup*.json），第二轮才用宽松的 *history*.json，
  // 且宽松匹配跳过浏览器下载目录，免得把那里无关的 json 当成备份。
  for (let i = 0; i < backupPatterns.length; i += 1) {
    const pattern = backupPatterns[i];
    const loose = i > 0;
    let best = null;
    for (const dir of dirs) {
      if (loose && isBrowserDir(dir)) continue;
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

// 扫到的所有备份（新的在前），给「本机文件」那张勾选表用。
async function listBackups() {
  const dirs = await backupDirs();
  const seen = new Set();
  const items = [];
  for (let i = 0; i < backupPatterns.length; i += 1) {
    const pattern = backupPatterns[i];
    const loose = i > 0;
    for (const dir of dirs) {
      if (loose && isBrowserDir(dir)) continue;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !pattern.test(entry.name)) continue;
        const file = join(dir, entry.name);
        if (seen.has(file)) continue;
        try {
          const info = await stat(file);
          seen.add(file);
          items.push({ file, name: entry.name, dir, size: info.size, mtimeMs: info.mtimeMs });
        } catch { /* 读不到就跳过 */ }
      }
    }
  }
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs);
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

  // 弹一个原生文件夹选择框，选完就记下来；打开时定位到当前备份所在的目录
  if (request.method === 'POST' && pathname === '/local/pick') {
    try {
      const config = await readConfig();
      const before = await findLatestBackup();
      const startDir = (config.backupDir || '').trim() || (before ? before.dir : join(homedir(), 'Downloads'));
      const dir = await pickBackupDir(startDir);
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

  // 扫到的全部备份，给页面上的勾选表用
  if (pathname === '/local/list.json') {
    const items = await listBackups();
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ items, searched: await backupDirs() }));
    return;
  }

  // 按路径取其中一份（只允许取扫描结果里出现过的文件，不做任意路径读取）
  if (pathname === '/local/backup') {
    const here = new URL(request.url, 'http://localhost');
    const wanted = decodeURIComponent(here.searchParams.get('path') || '');
    const items = await listBackups();
    const hit = items.find(item => item.file === wanted);
    if (!hit) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Backup-Name': encodeURIComponent(hit.name),
      'X-Backup-Dir': encodeURIComponent(hit.dir)
    });
    response.end(await readFile(hit.file));
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
