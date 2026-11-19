// Exercise the actual userscript importer against an isolated GM mock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-history.user.js'), 'utf8');
assert.match(source, /\bmainInit\(\)\.catch\(error => console\.error\([^\n]+\)\);\s*\}\)\(GM_getValue,\s*GM_setValue,\s*GM_deleteValue,\s*GM_listValues\);\s*$/);
const script = source.replace(/\bmainInit\(\)\.catch\(error => console\.error\([^\n]+\)\);\s*\}\)\(GM_getValue,\s*GM_setValue,\s*GM_deleteValue,\s*GM_listValues\);\s*$/, 'globalThis.bvhTest = { StorageApi, RecordStore, RecordNormalizer, RecordKey, SearchQuery, HistoryListRenderer, mergeContainers, collectionPartIdentity, ColdArchiveStore, ColdArchiveApi, StorageRouter };\n})(GM_getValue, GM_setValue, GM_deleteValue, GM_listValues);');
const records = new Map();
const databases = new Map();
let failWrites = false;
let importCompletion = Promise.resolve();
const later = callback => queueMicrotask(callback);
const indexedDB = {
  async databases() { return [...databases.keys()].map(name => ({ name })); },
  open(name) {
    const request = {};
    later(() => {
      let db = databases.get(name);
      if (!db) {
        db = mockDatabase({ id: name.slice('bvh_cold_'.length), name, createdAt: Date.now(), archivedAt: 0, count: 0, minTs: 0, maxTs: 0 }, []);
        databases.set(name, db);
        let aborted = false;
        request.result = db;
        request.transaction = { abort() { aborted = true; } };
        request.onupgradeneeded?.();
        if (aborted) {
          databases.delete(name);
          request.error = new Error('aborted');
          request.onerror?.();
          return;
        }
      }
      request.result = db;
      request.onsuccess?.();
    });
    return request;
  },
  deleteDatabase(name) {
    const request = {};
    later(() => { databases.delete(name); request.onsuccess?.(); });
    return request;
  }
};
function mockDatabase(meta, rows = []) {
  const stores = {
    metadata: new Map([['database', { key: 'database', ...meta }]]),
    records: new Map(rows.map(row => [row.key, row]))
  };
  return {
    objectStoreNames: { contains(name) { return Object.hasOwn(stores, name); } },
    createObjectStore(name) { stores[name] = new Map(); return {}; },
    transaction(names) {
      const tx = { oncomplete: null, onerror: null, onabort: null, pending: 0, completionQueued: false };
      const checkComplete = () => {
        if (tx.pending || tx.completionQueued) return;
        tx.completionQueued = true;
        later(() => { tx.completionQueued = false; if (!tx.pending) tx.oncomplete?.(); });
      };
      const schedule = callback => {
        tx.pending++;
        later(() => {
          try { callback(); } finally { tx.pending--; checkComplete(); }
        });
      };
      tx.objectStore = name => {
        const store = stores[name];
        return {
          get(key) {
            const request = {};
            schedule(() => { request.result = store.get(key) || null; request.onsuccess?.(); });
            return request;
          },
          count() {
            const request = {};
            schedule(() => { request.result = store.size; request.onsuccess?.(); });
            return request;
          },
          put(value) {
            const request = {};
            if (failWrites) {
              request.error = new Error('mock quota failure');
              schedule(() => { request.onerror?.(); tx.onerror?.(); });
              return request;
            }
            store.set(value.key, value);
            schedule(() => { request.result = value.key; request.onsuccess?.(); });
            return request;
          },
          add(value) {
            const request = {};
            store.set(value.key, value);
            schedule(() => { request.result = value.key; request.onsuccess?.(); });
            return request;
          },
          delete(key) {
            const request = {};
            store.delete(key);
            schedule(() => { request.onsuccess?.(); });
            return request;
          },
          openCursor() {
            const request = {};
            const keys = [...store.keys()];
            let index = 0;
            const advance = () => schedule(() => {
              if (index >= keys.length) { request.result = null; request.onsuccess?.(); return; }
              const key = keys[index];
              request.result = { value: store.get(key), continue() { index++; advance(); } };
              request.onsuccess?.();
            });
            advance();
            return request;
          }
        };
      };
      return tx;
    },
    close() {}
  };
}
let fixture = null;
let lastMessage = '';
const ctx = {
  GM_getValue(key, fallback = undefined) { return records.has(key) ? structuredClone(records.get(key)) : fallback; },
  GM_setValue(key, value) { records.set(key, structuredClone(value)); },
  GM_deleteValue(key) { records.delete(key); },
  GM_listValues() { return [...records.keys()]; },
  GM_addValueChangeListener() {},
  confirm() { return true; },
  alert(message) { lastMessage = message; },
  console,
  Date, Math, JSON, Set, Map, Promise, URL, crypto: webcrypto,
  location: { hostname: 'www.bilibili.com', pathname: '/history', href: 'https://www.bilibili.com/history' },
  indexedDB,
  window: { indexedDB, dispatchEvent() {}, addEventListener() {}, requestAnimationFrame: cb => cb() },
  document: {
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      assert.equal(tag, 'input');
      return { click() { this.onchange({ target: { files: [{}] } }); } };
    },
    getElementById() { return null; }
  },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  FileReader: class {
    readAsText() { importCompletion = Promise.resolve(this.onload({ target: { result: JSON.stringify(fixture) } })); }
  },
  setTimeout() {}, clearTimeout() {},
  requestAnimationFrame() {},
};
vm.createContext(ctx);
vm.runInContext(script, ctx, { filename: 'Bilibili-history.user.js' });
const { StorageApi, RecordStore, RecordNormalizer, SearchQuery, HistoryListRenderer, collectionPartIdentity, mergeContainers, ColdArchiveStore, ColdArchiveApi, StorageRouter } = ctx.bvhTest;

const hotSearchFixture = { sortedKeys: ['BVHOT12345'], itemsByKey: {
  BVHOT12345: { key: 'BVHOT12345', title: '热层命中视频', authorName: '测试作者', snapshots: [], lastProgress: '0%', watchCount: 1 }
} };
assert.equal(HistoryListRenderer._shouldAutoSearchCold('热层命中视频', hotSearchFixture), false,
  'automatic cold search stays off when the hot tier has a match');
assert.equal(HistoryListRenderer._shouldAutoSearchCold('只在冷库里的标题', hotSearchFixture), true,
  'automatic cold search runs when a non-empty query has no hot-tier match');
assert.equal(HistoryListRenderer._shouldAutoSearchCold('', hotSearchFixture), false,
  'an empty query never starts an automatic full cold database scan');

 (async () => {
const ts = 1760000000000;
const rec = (title, collectionKey, partNumber, watchCount = 1, when = ts) => ({
  title, collectionTitle: '共同合集', collectionKey, authorName: '同一作者',
  partNumber, partTotal: 3, watchCount, lastTs: when, lastProgress: '60%',
  snapshots: [{ ts: when, pos: 100, progress: '60%', source: 'player' }]
});
async function backup(entries) {
  fixture = { format: 'bvh-history-backup', version: 2, records: Object.fromEntries(
    entries.map(([key, data]) => [key, { key, data }])
  ) };
  StorageApi.importRecords();
  await importCompletion;
}
const get = key => records.get(key);
const keys = ['BVAAA111111', 'BVBBB222222', 'BVAAA111111?p=2'];
// Different BV with the same part number must survive in the same container.
await backup([[keys[0], rec('A', 'playlist-1', 1)], [keys[1], rec('B', 'playlist-1', 1)], [keys[2], rec('A-2', 'playlist-1', 2)]]);
let container = RecordNormalizer.normalize(get(keys[0]));
assert.equal(container.type, 'collection', lastMessage);
assert.equal(container.parts.length, 3, 'two p=1 BVs and one p=2 must remain distinct');
assert.deepEqual(new Set(container.parts.map(part => collectionPartIdentity(part.bv, part))),
  new Set(['bvaaa111111?p=1', 'bvbbb222222?p=1', 'bvaaa111111?p=2']));
assert.equal(get(keys[1]), undefined, 'flat key removed only after container verification');
await backup([[keys[2], rec('A-2', 'playlist-1', 2)], [keys[1], rec('B', 'playlist-1', 1)], [keys[0], rec('A', 'playlist-1', 1)]]);
container = RecordNormalizer.normalize(get(keys[0]));
assert.equal(container.parts.length, 3, 'repeat and reverse-order import is idempotent');

// Existing flat watch history must be merged, not overwritten by older backup.
records.clear();
records.set(keys[1], rec('B', 'playlist-1', 1, 4, ts + 1000));
await backup([[keys[0], rec('A', 'playlist-1', 1)], [keys[1], rec('B', 'playlist-1', 1)]]);
container = RecordNormalizer.normalize(get(keys[0]));
assert.equal(container?.type, 'collection', `repeat import retained container: ${lastMessage}`);
const bPart = container.parts.find(part => part.bv === keys[1]);
assert.ok(bPart, lastMessage);
assert.equal(bPart.watchCount, 4);
assert.equal(bPart.lastTs, ts + 1000);
assert.equal(get(keys[1]), undefined);

// A missing stable collection identity must not guess from matching titles alone.
records.clear();
await backup([[keys[0], { ...rec('A', '', 1), collectionKey: '', collectionTitle: '', partNumber: 1, partTotal: 1 }],
  [keys[1], { ...rec('B', '', 1), collectionKey: '', collectionTitle: '', partNumber: 1, partTotal: 1 }]]);
assert.notEqual(get(keys[0])?.type, 'collection');
assert.notEqual(get(keys[1])?.type, 'collection');

// The shared merge helper must not equate different BVs at the same sequence number.
const merged = mergeContainers({ type: 'collection', key: 'group', parts: [{ p: 1, bv: keys[0], snapshots: [] }] },
  { type: 'collection', key: 'group', parts: [{ p: 1, bv: keys[1], snapshots: [] }] });
assert.equal(merged.parts.length, 2);
console.log('Actual userscript collection import cases passed');

async function verifyLockedCorrectionCommit() {
  records.clear();
  const targetKey = 'BVFIXED12345';
  const sourceKey = 'BVFIXED12345?p=2';
  const source = { title: '待整理扁平记录', watchCount: 1, lastTs: ts, snapshots: [] };
  records.set(targetKey, { type: 'collection', key: targetKey, title: '合集', collectionKey: 'playlist-1', parts: [
    { p: 1, bv: targetKey, title: '第一集', watchCount: 1, lastTs: ts, snapshots: [] },
    { p: 2, bv: sourceKey, title: '旧标题', watchCount: 2, lastTs: ts + 1, snapshots: [{ ts: ts + 1, pos: 20 }] }
  ] });
  records.set(sourceKey, source);
  const latest = await RecordStore.updateCommitted(targetKey, current => {
    const part = current.parts.find(item => item.p === 2);
    part.title = '修正标题';
    return current;
  }, [{ key: sourceKey, serialized: JSON.stringify(source) }]);
  assert.equal(latest.parts.find(item => item.p === 2).title, '修正标题', 'explicit correction applies to the latest committed container');
  assert.equal(latest.parts.find(item => item.p === 2).snapshots.length, 1, 'correction preserves existing watch snapshots');
  assert.equal(records.has(sourceKey), false, 'unchanged flat source is removed only after target verification');

  const changedSource = { title: '更新中的源记录', watchCount: 3, lastTs: ts + 2, snapshots: [] };
  records.set(sourceKey, changedSource);
  await assert.rejects(() => RecordStore.updateCommitted(targetKey, current => current,
    [{ key: sourceKey, serialized: JSON.stringify(source) }]), /整理来源已变化/);
  assert.deepEqual(records.get(sourceKey), changedSource, 'changed source is retained');
  console.log('Actual userscript locked correction and source verification cases passed');
}

const coldPrefix = 'bvh_cold_';
const coldMeta = (id, count = 0) => ({ id, name: `${coldPrefix}${id}`, createdAt: 1000, archivedAt: 0, count, minTs: 0, maxTs: 0 });
async function verifyColdDatabaseManagement() {
  const discovered = coldMeta('discovered');
  const invalid = { ...coldMeta('invalid'), id: 'wrong-id' };
  const empty = coldMeta('empty');
  const populated = coldMeta('populated', 1);
  const olderCold = { title: '冷库同键记录', watchCount: 2, lastTs: 1760000000000, lastProgress: '30%',
    snapshots: [{ ts: 1760000000000, pos: 90, progress: '30%', source: 'player' }] };
  const hotCopy = { title: 'GM 同键记录', watchCount: 4, lastTs: 1760000120000, lastProgress: '40%',
    snapshots: [{ ts: 1760000120000, pos: 120, progress: '40%', source: 'official' }] };
  databases.set(discovered.name, mockDatabase(discovered, [{ key: 'BVDiscover1', data: olderCold }]));
  databases.set(invalid.name, mockDatabase(invalid));
  databases.set('unrelated-database', mockDatabase(coldMeta('unrelated')));
  records.set('bvh_cold_database_directory_v1', []);

  let found = await ColdArchiveStore.reconcileDirectory();
  assert.deepEqual(found.map(meta => meta.id).sort(), ['discovered', 'invalid'], 'prefixed DBs are discovered and metadata mismatches are reported');
  assert.equal(found.find(meta => meta.id === 'invalid')?.unavailable, true, 'a database with mismatched identity is not treated as reusable');

  databases.set(empty.name, mockDatabase(empty));
  databases.set(populated.name, mockDatabase(populated, [{ key: 'BVKeep12345', data: {} }]));
  records.set('bvh_cold_database_directory_v1', [empty, populated, discovered]);
  records.set('bvh_cold_archive_settings_v1', { targetId: empty.id });
  records.set('BVDiscover1', hotCopy);
  const result = await ColdArchiveStore.deleteEmptyDatabases();
  assert.equal(Array.from(result.removed).join(','), 'empty', 'only the actually empty DB is deleted');
  assert.equal(Array.from(result.remaining, meta => meta.id).sort().join(','), 'discovered,invalid,populated', 'unavailable databases stay listed and are never treated as empty');
  assert.equal(databases.has(empty.name), false);
  assert.equal(databases.has(populated.name), true, 'non-empty DB remains intact');
  assert.equal(records.get('bvh_cold_archive_settings_v1').targetId, 'populated', 'default target moves to a remaining DB');
  const beforeEnsure = databases.size;
  const autoMeta = await ColdArchiveApi.ensureDefault();
  assert.equal(autoMeta.id, 'populated', 'automatic cold storage reuses an existing valid database');
  assert.equal(databases.size, beforeEnsure, 'automatic cold storage does not create a duplicate database');
  ColdArchiveApi._ensurePromise = null;
  const parallelTargets = await Promise.all([ColdArchiveApi.ensureDefault(), ColdArchiveApi.ensureDefault(), ColdArchiveApi.ensureDefault()]);
  assert.equal(new Set(parallelTargets.map(meta => meta.id)).size, 1, 'concurrent callers share the same automatic database selection');
  assert.equal(databases.size, beforeEnsure, 'concurrent callers do not create additional databases');
  const imported = await ColdArchiveStore.importFile('discovered', {
    async text() { return JSON.stringify({
      format: 'bvh-cold-backup', version: 1, records: {
        BVDiscover1: { key: 'BVDiscover1', data: {
          title: '旧导入副本', watchCount: 1, lastTs: 1759999800000, lastProgress: '10%',
          snapshots: [{ ts: 1759999800000, pos: 10, progress: '10%', source: 'player' }]
        } }
      }
    }); }
  });
  assert.equal(imported.merged, 1, 'cold import merges an existing key instead of skipping it');
  const importedRow = await ColdArchiveStore.getRecord('discovered', 'BVDiscover1');
  assert.equal(importedRow.data.watchCount, 2, 'cold import keeps the larger watch count');
  assert.equal(importedRow.data.lastTs, 1760000000000, 'cold import keeps the newer timestamp');
  assert.equal(importedRow.data.snapshots.length, 2, 'cold import preserves snapshots from both copies');
  const multiKey = 'BVMULTI12345';
  const multiOld = { title: '多库搜索记录', watchCount: 2, lastTs: 1760000000100, lastProgress: '20%',
    snapshots: [{ ts: 1760000000100, pos: 20, progress: '20%', source: 'player' }] };
  const multiNew = { title: '多库搜索记录', watchCount: 5, lastTs: 1760000120200, lastProgress: '50%',
    snapshots: [{ ts: 1760000120200, pos: 50, progress: '50%', source: 'official' }] };
  await ColdArchiveStore.putRecords('discovered', [{ key: multiKey, data: multiOld, lastTs: multiOld.lastTs }]);
  await ColdArchiveStore.putRecords('populated', [{ key: multiKey, data: multiNew, lastTs: multiNew.lastTs }]);
  const deepResult = await ColdArchiveStore.search(SearchQuery.parse('多库搜索记录'));
  const deepItem = deepResult.index.itemsByKey[multiKey];
  assert.equal(deepResult.matchedCount, 1, 'deep search renders one merged item for duplicate rows across cold databases');
  assert.equal(deepItem.watchCount, 5, 'deep search keeps the larger watch count from duplicate rows');
  assert.equal(deepItem.snapshots.length, 2, 'deep search keeps snapshots from every duplicate row');
  assert.deepEqual(Array.from(deepItem._coldDatabaseIds).sort(), ['discovered', 'populated']);
  await ColdArchiveStore.updateMergedRecord(deepItem._coldDatabaseIds, multiKey, data => ({ ...data, watchCount: 7 }));
  assert.equal((await ColdArchiveStore.getRecord('discovered', multiKey)).data.watchCount, 7, 'editing a merged deep-search row updates every source DB');
  assert.equal((await ColdArchiveStore.getRecord('populated', multiKey)).data.watchCount, 7, 'duplicate cold copies cannot restore an old edit');
  await ColdArchiveStore.deleteMergedRecord(deepItem._coldDatabaseIds, multiKey);
  assert.equal(await ColdArchiveStore.getRecord('discovered', multiKey), null);
  assert.equal(await ColdArchiveStore.getRecord('populated', multiKey), null);
  const backup = await StorageApi.buildFullBackupPayload();
  assert.equal(backup.payload.format, 'bvh-history-backup');
  assert.equal(backup.payload.version, 2, 'full local export uses the existing GM import format');
  assert.equal(backup.payload.records.BVDiscover1.data.watchCount, 4, 'same-key GM/cold rows are merged into the backup');
  assert.equal(backup.payload.records.BVDiscover1.data.snapshots.length, 3, 'the backup retains snapshots from both tiers');
  assert.equal(records.has('BVDiscover1'), true, 'building a full backup leaves the GM source untouched');
  assert.equal(databases.has(discovered.name), true, 'building a full backup leaves cold sources untouched');

  ctx.location.hostname = 'www.bilibili.com';
  records.delete('BVDiscover1');
  const rewatch = { title: '重新观看', watchCount: 1, lastTs: 1760000300000, lastProgress: '10%',
    snapshots: [{ ts: 1760000300000, pos: 30, progress: '10%', source: 'player' }] };
  StorageRouter.setValue('BVDiscover1', rewatch);
  await StorageRouter._pendingWrites.get('BVDiscover1');
  const promoted = RecordNormalizer.normalize(records.get('BVDiscover1'));
  assert.equal(promoted.watchCount, 2, 'rewatching an archived item preserves the larger historical count');
  assert.equal(promoted.snapshots.length, 3, 'rewatching an archived item merges its older snapshots into the hot record');
  assert.equal(await ColdArchiveStore.getRecord('discovered', 'BVDiscover1'), null,
    'the cold duplicate is removed only after the merged hot row is verified');

  const missingEmpty = coldMeta('missing-empty');
  records.set('bvh_cold_database_directory_v1', [populated, discovered, missingEmpty]);
  const afterMissingEmpty = await ColdArchiveStore.reconcileDirectory();
  assert.equal(afterMissingEmpty.some(meta => meta.id === missingEmpty.id), false,
    'a confirmed missing DB with zero recorded rows is removed from the directory');

  const stale = coldMeta('missing-db', 2);
  records.set('bvh_cold_database_directory_v1', [populated, discovered, stale]);
  const reconciledWithStale = await ColdArchiveStore.reconcileDirectory();
  assert.equal(reconciledWithStale.find(meta => meta.id === stale.id)?.unavailable, true,
    'a missing DB that may contain records stays marked unavailable');
  const archiveKey = 'BVARCHIVE123';
  records.delete('BVDiscover1');
  const oldArchiveCopy = { title: '旧冷库副本', watchCount: 2, lastTs: 1699999000000, lastProgress: '10%',
    snapshots: [{ ts: 1699999000000, pos: 10, progress: '10%', source: 'player' }] };
  await ColdArchiveStore.putRecords(discovered.id, [{ key: archiveKey, data: oldArchiveCopy, lastTs: oldArchiveCopy.lastTs }]);
  records.set(archiveKey, { title: '待归档热层记录', watchCount: 1, lastTs: 1700000000000, lastProgress: '25%',
    snapshots: [{ ts: 1700000000000, pos: 25, progress: '25%', source: 'player' }] });
  const archived = await ColdArchiveStore.archiveOldRecords({ ageDays: 30, targetId: discovered.id });
  assert.ok(archived.archived >= 1, 'an unavailable legacy DB does not block archiving hot records');
  assert.deepEqual(Array.from(archived.unavailableDatabases).sort(), [invalid.name, stale.name].sort(),
    'missing and structurally invalid databases are both reported as unavailable');
  assert.equal(records.has(archiveKey), false, 'the hot source is removed after the target DB readback succeeds');
  const archivedRow = await ColdArchiveStore.getRecord(discovered.id, archiveKey);
  assert.equal(archivedRow?.data.title, '待归档热层记录');
  assert.equal(archivedRow.data.watchCount, 2, 'archiving over a same-key cold row merges the larger watch count');
  assert.equal(archivedRow.data.snapshots.length, 2, 'archiving over a same-key cold row preserves both snapshots');
  await assert.rejects(() => StorageApi.buildFullBackupPayload(), /数据库已丢失|冷库结构缺失|冷库无法打开/,
    'a missing non-empty cold DB still aborts the entire backup');
  console.log('Actual userscript cold database discovery and empty cleanup cases passed');
}
async function verifyIrreversiblePrimaryModeAndQueue() {
  records.clear();
  databases.clear();
  ctx.location.hostname = 'www.bilibili.com';
  const oldKey = 'BVMAIN12345';
  const queuedKey = 'BVQUEU12345';
  const oldRecord = { title: '从 GM 迁移', lastTs: 1760000000000, lastProgress: '35%', watchCount: 2,
    snapshots: [{ ts: 1760000000000, pos: 120, progress: '35%', source: 'player' }] };
  records.set(oldKey, structuredClone(oldRecord));
  StorageRouter._cache = new Map();
  StorageRouter._ready = false;
  StorageRouter._degraded = false;
  StorageRouter._activeId = '';

  const failureMeta = coldMeta('migration-target');
  databases.set(failureMeta.name, mockDatabase(failureMeta));
  records.set('bvh_cold_database_directory_v1', [failureMeta]);
  failWrites = true;
  await assert.rejects(() => StorageRouter.enablePrimaryMode(), /mock quota failure|迁移核验失败|写入冷库事务失败/);
  assert.equal(records.has(oldKey), true, 'failed migration retains the original GM record');
  assert.equal(records.get('bvh_cold_primary_mode_v1'), undefined, 'failed migration does not lock the irreversible mode');
  failWrites = false;

  const migrated = await StorageRouter.enablePrimaryMode();
  assert.equal(migrated.count, 1);
  assert.equal(records.has(oldKey), false, 'GM source is removed only after DB write/readback verification');
  assert.equal(StorageRouter.isPrimaryMode(), true, 'primary mode is persistently irreversible');
  assert.equal(StorageRouter.getValue(oldKey, null).watchCount, 2);

  const legacyMeta = coldMeta('legacy-after-primary');
  const staleDuplicate = { ...oldRecord, title: '旧库陈旧副本', watchCount: 99, lastTs: oldRecord.lastTs - 1000 };
  const legacyDeleted = { ...oldRecord, title: '已删除后残留的副本', watchCount: 8 };
  databases.set(legacyMeta.name, mockDatabase(legacyMeta, [
    { key: oldKey, data: staleDuplicate }, { key: 'BVLEGACYDEL1', data: legacyDeleted }
  ]));
  records.set('bvh_cold_database_directory_v1', [...records.get('bvh_cold_database_directory_v1'), legacyMeta]);
  await StorageRouter.initialize();
  assert.equal(StorageRouter.getValue(oldKey, null).watchCount, 2, 'startup treats the primary DB as authoritative over stale legacy copies');
  assert.equal(StorageRouter.getValue('BVLEGACYDEL1', null), null, 'startup does not resurrect a key that exists only in a legacy DB');
  assert.equal((await ColdArchiveStore.getRecord(legacyMeta.id, oldKey)).data.watchCount, 99, 'legacy DB remains untouched as a recoverable source');
  const primaryBackup = await StorageApi.buildFullBackupPayload();
  assert.equal(primaryBackup.payload.records[oldKey].data.watchCount, 2, 'primary-mode backup excludes stale legacy duplicates');
  assert.equal(primaryBackup.payload.records.BVLEGACYDEL1, undefined, 'primary-mode backup excludes legacy-only deleted keys');

  records.set('bvh_cold_cross_origin_write_queue_v1', {
    BVLEGACYDEL1: { type: 'delete', queuedAt: Date.now() }
  });
  await StorageRouter.initialize();
  assert.equal(StorageRouter.getValue('BVLEGACYDEL1', null), null, 'queued deletion stays deleted even when a legacy copy exists');
  assert.equal(await ColdArchiveStore.getRecord(migrated.targetId, 'BVLEGACYDEL1'), null, 'queued deletion is applied to the primary DB');
  assert.equal(await ColdArchiveStore.getRecord(legacyMeta.id, 'BVLEGACYDEL1') !== null, true, 'legacy copy is retained but never restored as active data');

  const degradedKey = 'BVDEGRADE1';
  StorageRouter._degraded = true;
  StorageRouter.setValue(degradedKey, { title: '故障期间新记录', lastTs: 1760000000500, watchCount: 1, snapshots: [] });
  StorageRouter.deleteValue(oldKey);
  assert.equal(records.has(degradedKey), false, 'degraded primary writes do not fall back to an untracked GM record');
  assert.equal(records.get('bvh_cold_cross_origin_write_queue_v1')[degradedKey].type, 'set', 'degraded primary write is recoverable from the queue');
  assert.equal(records.get('bvh_cold_cross_origin_write_queue_v1')[oldKey].type, 'delete', 'degraded primary deletion is recoverable from the queue');
  StorageRouter._degraded = false;
  await StorageRouter.initialize();
  assert.equal(StorageRouter.getValue(degradedKey, null).title, '故障期间新记录', 'recovery flushes degraded writes into the primary DB');
  assert.equal(StorageRouter.getValue(oldKey, null), null, 'recovery applies degraded deletions to the primary DB');

  StorageRouter.setValue(queuedKey, { title: 'DB 新记录', lastTs: 1760000001000, watchCount: 1, snapshots: [] });
  await StorageRouter._pendingWrites.get(queuedKey);
  assert.equal(records.has(queuedKey), false, 'same-origin primary writes do not store record payloads in GM');
  assert.equal(StorageRouter.getValue(queuedKey, null).title, 'DB 新记录');

  ctx.location.hostname = 'live.bilibili.com';
  const remoteRecord = { title: '跨域排队', lastTs: 1760000002000, watchCount: 1, snapshots: [] };
  StorageRouter.setValue('BVREMOTE123', remoteRecord);
  assert.equal(records.has('BVREMOTE123'), false);
  assert.equal(records.get('bvh_cold_cross_origin_write_queue_v1')['BVREMOTE123'].type, 'set');

  ctx.location.hostname = 'www.bilibili.com';
  await StorageRouter.initialize();
  assert.equal(StorageRouter.getValue('BVREMOTE123', null).title, '跨域排队', 'history origin flushes queued writes into the primary DB');
  assert.equal(records.has('bvh_cold_cross_origin_write_queue_v1'), false, 'queue clears only after successful migration/readback');
  console.log('Actual userscript DB-primary migration and cross-origin queue cases passed');
}
await verifyLockedCorrectionCommit();
await verifyColdDatabaseManagement();
await verifyIrreversiblePrimaryModeAndQueue();
})().catch(error => { console.error(error); process.exitCode = 1; });
