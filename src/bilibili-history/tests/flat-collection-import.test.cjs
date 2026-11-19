// Minimal targeted self-checks for flattened collection import grouping.
const assert = require('node:assert/strict');

const flatIdentity = (key, part = {}) => {
  const match = String(key || '').trim().match(/^(BV[a-zA-Z0-9]+)(?:\?p=(\d+))?$/i);
  if (!match) return '';
  const page = Number(match[2]) || Number(part.p) || Number(part.partNumber) || 1;
  return `${match[1].toLowerCase()}?p=${page}`;
};

const mergeFlatGroup = (members, existingRows = new Map(), { failWrite = false } = {}) => {
  const identities = members.map(row => flatIdentity(row.key, row.data));
  if (identities.some(id => !id) || new Set(identities).size !== identities.length) return { grouped: false, existingRows };
  const containerParts = new Map();
  for (const row of members) {
    const id = flatIdentity(row.key, row.data);
    const previous = existingRows.get(row.key);
    const source = previous ? {
      ...row.data,
      watchCount: Math.max(Number(row.data.watchCount) || 0, Number(previous.watchCount) || 0),
      lastTs: Math.max(Number(row.data.lastTs) || 0, Number(previous.lastTs) || 0),
      snapshots: [...(previous.snapshots || []), ...(row.data.snapshots || [])]
    } : row.data;
    containerParts.set(id, { key: row.key, source });
  }
  if (failWrite) return { grouped: false, remainingRows: existingRows };
  const persistedIds = new Set(containerParts.keys());
  if (identities.some(id => !persistedIds.has(id))) return { grouped: false, remainingRows: existingRows };
  const nextRows = new Map(existingRows);
  members.forEach(row => nextRows.delete(row.key));
  return { grouped: true, target: [...containerParts.values()], remainingRows: nextRows };
};

const rows = [
  { key: 'BVAlpha12345', data: { collectionKey: 'season:feed-7', collectionTitle: '合集', authorName: 'UP', partNumber: 1, watchCount: 1 } },
  { key: 'BVBeta23456', data: { collectionKey: 'season:feed-7', collectionTitle: '合集', authorName: 'UP', partNumber: 1, watchCount: 2 } },
  { key: 'BVAlpha12345?p=2', data: { collectionKey: 'season:feed-7', collectionTitle: '合集', authorName: 'UP', partNumber: 2, watchCount: 3 } },
];
const grouped = mergeFlatGroup(rows);
assert.equal(grouped.grouped, true);
assert.deepEqual(new Set(grouped.target.map(row => flatIdentity(row.key, row.source))), new Set([
  'bvalpha12345?p=1', 'bvbeta23456?p=1', 'bvalpha12345?p=2'
]), 'cross-BV p=1 items stay separate while same-BV pages remain distinct');

const original = new Map([['BVAlpha12345', { watchCount: 4, lastTs: 100, snapshots: [{ ts: 100 }] }]]);
const migrated = mergeFlatGroup([rows[0]], original);
assert.equal(migrated.target[0].source.watchCount, 4, 'pre-existing hot facts merge before migration');
assert.equal(migrated.remainingRows.has('BVAlpha12345'), false, 'source row can be removed after successful verified write');
const failed = mergeFlatGroup([rows[0]], original, { failWrite: true });
assert.equal(failed.remainingRows.has('BVAlpha12345'), true, 'failed container write retains original hot row');
assert.equal(flatIdentity('ep12345', { partNumber: 1 }), '', 'bangumi episode IDs do not enter ordinary BV grouping');
assert.equal(flatIdentity('BVAlpha12345', { partNumber: 1 }), 'bvalpha12345?p=1');
console.log('flattened collection import safety checks passed');
