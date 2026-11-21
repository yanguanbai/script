// 备份确认闸门的回归测试：验证“没确认保存就不登记、不删数据”。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-history.user.js'), 'utf8');
const script = source.replace(
  /\bmainInit\(\)\.catch\(error => console\.error\([^\n]+\)\);\s*\}\)\(GM_getValue,\s*GM_setValue,\s*GM_deleteValue,\s*GM_listValues\);\s*$/,
  'globalThis.bvhTest = { StorageApi, RecordStore, RecordNormalizer, RecordKey, ErrorLog };\n})(GM_getValue, GM_setValue, GM_deleteValue, GM_listValues);'
);
assert.match(source, /bvhTest|mainInit\(\)/, 'userscript tail is still the IIFE entry');

const records = new Map();
let lastMessage = '';
const appended = [];
const later = fn => queueMicrotask(fn);
const emptyIndexedDB = {
  async databases() { return []; },
  open(name) {
    const request = {};
    later(() => { request.error = new Error(`no mock database for ${name}`); request.onerror?.(); });
    return request;
  },
  deleteDatabase(name) {
    const request = {};
    later(() => request.onsuccess?.());
    return request;
  }
};

const ctx = {
  GM_getValue(key, fallback = undefined) { return records.has(key) ? structuredClone(records.get(key)) : fallback; },
  GM_setValue(key, value) { records.set(key, structuredClone(value)); },
  GM_deleteValue(key) { records.delete(key); },
  GM_listValues() { return [...records.keys()]; },
  GM_addValueChangeListener() {},
  confirm() { return true; },
  alert(message) { lastMessage = String(message); },
  console,
  Date, Math, JSON, Set, Map, Promise, URL, Blob, crypto: webcrypto,
  location: { hostname: 'www.bilibili.com', pathname: '/history', href: 'https://www.bilibili.com/history', protocol: 'https:' },
  navigator: {},
  indexedDB: emptyIndexedDB,
  window: {
    indexedDB: emptyIndexedDB,
    dispatchEvent() {}, addEventListener() {}, requestAnimationFrame: cb => cb(),
    // 测试里不提供系统保存对话框，确保走“无法确认保存”的降级路径。
    showSaveFilePicker: undefined
  },
  document: {
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: { setProperty() {} } },
    body: { appendChild(node) { appended.push(node); } },
    createElement(tag) {
      return {
        tag,
        style: {},
        href: '', download: '',
        click() { this.clicked = true; },
        remove() {},
        setAttribute() {},
        addEventListener() {}
      };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  FileReader: class { readAsText() {} },
  setTimeout() {}, clearTimeout() {},
  requestAnimationFrame() {},
};
vm.createContext(ctx);
vm.runInContext(script, ctx, { filename: 'Bilibili-history.user.js' });
const { StorageApi, RecordStore, RecordNormalizer, ErrorLog } = ctx.bvhTest;

const EXPORTED_KEY = 'bvh_exported_record_keys_v1';
const CONFIRM_KEY = 'bvh_backup_confirm_v1';
const LOG_KEY = 'bvh_error_log_v1';
const dayMs = 24 * 3600 * 1000;
const record = (title, watchCount = 2, when = Date.now() - 100 * dayMs) => ({
  title, authorName: '测试作者', watchCount, lastTs: when, lastProgress: '50%',
  snapshots: [{ ts: when, pos: 60, progress: '50%', source: 'player' }]
});

(async () => {
  // 1) prepare 阶段绝不写“已备份”标记：这是“下载不等于保存”的核心约束。
  records.clear();
  records.set('BVGATE00001', record('闸门测试视频', 3));
  const prep = await StorageApi.prepareFullBackup();
  assert.equal(records.has(EXPORTED_KEY), false, 'preparing a backup must not write the exported map');
  assert.equal(records.has(CONFIRM_KEY), false, 'preparing a backup must not write the confirm marker');
  assert.equal(prep.count, 1);
  assert.match(prep.json, /"format": "bvh-history-backup"/, 'payload keeps the existing import format');
  assert.ok(prep.filename.endsWith('.json') && prep.bytes > 0, 'prepare must report file name and size');
  console.log('prepare leaves the exported map untouched');

  // 2) 走普通下载（无法确认保存）：不登记，清理也找不到可删项。
  const download = await StorageApi.saveBackupVerified(prep);
  assert.equal(download.ok, false, 'a plain download cannot be confirmed');
  assert.equal(download.pending, true, 'plain download returns a pending confirmation');
  assert.equal(download.code, 'E2004', 'unconfirmed save is reported as E2004');
  assert.equal(records.has(EXPORTED_KEY), false, 'download alone must not register the backup');
  StorageApi.cleanExpireRecords();
  assert.match(lastMessage, /没有可清理的已备份记录/, 'unconfirmed backup leaves nothing cleanable');
  assert.match(lastMessage, /不在已确认备份内/, 'cleanup explains why expired records are kept');
  console.log('unconfirmed download registers nothing and blocks cleanup');

  // 3) 确认保存后才登记，并写入可读的确认信息。
  const confirmed = StorageApi.confirmBackup(prep, 'download');
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.marked, 1, 'confirming registers exactly the prepared records');
  assert.equal(records.get(EXPORTED_KEY)['BVGATE00001'], prep.exportedAt, 'exported map stores the prepare timestamp');
  const meta = records.get(CONFIRM_KEY);
  assert.equal(meta.count, 1);
  assert.equal(meta.method, 'download');
  assert.equal(StorageApi.hasConfirmedBackup(), true, 'confirmed backup unlocks destructive operations');
  console.log('confirming writes the marker and the readable metadata');

  // 4) prepare 之后被改动的记录不能算进这份备份：登记前逐键比对当前值。
  records.clear();
  records.set('BVGATE00002', record('先生成后改动', 1));
  const prep2 = await StorageApi.prepareFullBackup();
  records.set('BVGATE00002', record('先生成后改动', 9));
  const result2 = StorageApi.confirmBackup(prep2, 'download');
  assert.equal(result2.marked, 0, 'a record changed after prepare is not marked as backed up');
  assert.equal(result2.stale, 1, 'the changed record is reported as stale');
  assert.equal(records.get(EXPORTED_KEY)['BVGATE00002'], undefined, 'the stale key is excluded from the exported map');
  console.log('records modified between prepare and confirm are excluded');

  // 5) 范围导出只登记范围内的键；范围外的记录不会被误标。
  records.clear();
  records.set('BVGATE00003', record('视频记录', 1));
  records.set('ss33001', { type: 'collection', seasonId: 33001, title: '番剧', parts: [] });
  const scoped = await StorageApi.prepareFullBackup({ kind: 'video' });
  assert.equal(scoped.count, 1, 'video scope exports only the video record');
  assert.equal(scoped.payload.records.ss33001, undefined, 'bangumi record stays out of the video scope');
  StorageApi.confirmBackup(scoped, 'download');
  assert.equal(records.get(EXPORTED_KEY).ss33001, undefined, 'out-of-scope records are never marked as backed up');
  console.log('scope export only marks the records it contains');

  // 6) 没有已确认备份时，结构迁移必须中止，并且不写入任何数据。
  records.clear();
  records.set('BVGATE00004', record('迁移前检查', 1));
  // 迁移中止后不应写入任何业务键；诊断日志本身允许增加。
  const snapshotOfData = () => JSON.stringify([...records.entries()].filter(([key]) => key !== LOG_KEY));
  const before = snapshotOfData();
  await StorageApi.migrateToContainerStructure();
  assert.match(lastMessage, /E2004/, 'migration aborts with the "backup not confirmed" code');
  assert.equal(snapshotOfData(), before, 'aborted migration writes nothing');
  console.log('migration refuses to run without a confirmed backup');

  // 7) 运行日志按错误码归类，并限制为最近 50 条。
  records.delete(LOG_KEY);
  for (let i = 0; i < 60; i++) ErrorLog.report('E3005', `第 ${i} 次写入失败`, { where: 'test' });
  const log = ErrorLog.read();
  assert.equal(log.length, ErrorLog.MAX, 'error log keeps only the newest entries');
  const summary = ErrorLog.summarize(log);
  assert.equal(summary[0].code, 'E3005');
  assert.equal(summary[0].count, ErrorLog.MAX, 'same code collapses into one bucket');
  console.log('error log is capped and grouped by code');

  // 8) GM_download 档：下载完成回调才算保存；成功即自动登记，报错则退回普通下载。
  records.clear();
  records.set('BVGATE00005', record('GM下载成功', 1));
  let seenUrl = '';
  let seenName = '';
  ctx.GM_download = options => {
    seenUrl = options.url;
    seenName = options.name;
    queueMicrotask(options.onload);
  };
  const gmSave = await StorageApi.saveBackupVerified(await StorageApi.prepareFullBackup(), null, { pickerTried: true });
  assert.equal(gmSave.ok, true, 'a completed GM_download counts as saved');
  assert.equal(gmSave.method, 'gm_download');
  assert.ok(!gmSave.pending, 'a verified GM_download is not left pending');
  assert.match(seenUrl, /^data:application\/json/, 'GM_download receives a data: URL');
  assert.ok(seenName.endsWith('.json'), 'GM_download receives the prepared file name');
  assert.equal(records.has(EXPORTED_KEY), false, 'saving alone still registers nothing');
  console.log('GM_download completion is treated as a confirmed save');

  // 9) 完整链路：GM_download 成功 → 自动登记为已备份，清理可以正常工作。
  records.clear();
  records.set('BVGATE00006', record('GM自动登记', 1));
  const exported = await StorageApi.exportAllRecords();
  assert.equal(exported, true, 'exportAllRecords returns true once the save is confirmed');
  assert.ok(records.get(EXPORTED_KEY)?.BVGATE00006, 'a verified GM_download registers the record automatically');
  assert.equal(records.get(CONFIRM_KEY)?.method, 'gm_download', 'confirm metadata records the save method');
  console.log('exportAllRecords auto-registers after a verified GM_download');

  // 10) GM_download 报错：不登记，继续退回普通下载（pending），等待用户手动确认。
  records.clear();
  records.set('BVGATE00007', record('GM下载失败', 1));
  ctx.GM_download = options => queueMicrotask(() => options.onerror({ error: 'disk full' }));
  const gmFail = await StorageApi.saveBackupVerified(await StorageApi.prepareFullBackup(), null, { pickerTried: true });
  assert.equal(gmFail.ok, false, 'a failed GM_download is not a confirmed save');
  assert.equal(gmFail.pending, true, 'after GM failure the plain download fallback still runs');
  assert.equal(gmFail.code, 'E2004');
  assert.equal(records.has(EXPORTED_KEY), false, 'no registration after a failed download');
  delete ctx.GM_download;
  console.log('a failed GM_download falls back without registering');

  console.log('backup confirmation gate checks passed');
})().catch(error => { console.error(error); process.exit(1); });
