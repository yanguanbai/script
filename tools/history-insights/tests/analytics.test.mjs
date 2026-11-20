import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, loadHistory, mergeHistories, parseCsv } from '../analytics.mjs';

test('reads a full JSON backup and flattens collection parts', () => {
  const fixture = {
    format: 'bvh-history-backup', version: 2,
    records: {
      ordinary: { data: { key: 'BV1abc', title: '城市纪录片', authorName: 'Creator A', mediaType: '视频', mediaTags: ['旅行'], lastTs: 1700000000, watchCount: 3, snapshots: [{ ts: 1700000000, pos: 30 }] } },
      season: { data: { type: 'collection', title: '科学系列', authorName: 'Creator B', mediaType: '番剧', parts: [{ epKey: 'EP1', p: 1, title: '量子世界', watchCount: 2, lastTs: 1700000100, snapshots: [{ ts: 1700000100 }] }] } }
    }
  };
  const loaded = loadHistory(JSON.stringify(fixture), 'backup.json');
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.records[1].key, 'EP1');
  assert.equal(loaded.records[1].author, 'Creator B');
  assert.equal(loaded.range.min, 1700000000000);
});

test('parses CSV quoted commas, escaped quotes, CRLF, and deduplicates snapshot rows', () => {
  const csv = '\uFEFFbv_key,title,author_name,media_type,watch_count,last_ts,snapshot_ts,snapshot_completed\r\nBV1,"A, \"\"great\"\" title",Creator A,video,4,2024-01-04 12:00:00,2024-01-02 10:00:00,false\r\nBV1,"A, \"\"great\"\" title",Creator A,video,4,2024-01-04 12:00:00,2024-01-03 10:00:00,true\r\n';
  assert.equal(parseCsv(csv).length, 2);
  const loaded = loadHistory(csv, 'backup.csv');
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].snapshots.length, 2);
  assert.equal(loaded.records[0].title, 'A, "great" title');
  assert.equal(loaded.records[0].count, 4);
});

test('time filter counts snapshots in range without inventing period watch counts', () => {
  const jan2 = Date.parse('2024-01-02T10:00:00');
  const jan3 = Date.parse('2024-01-03T10:00:00');
  const source = [{ key: 'BV1', title: '旅行城市记录', author: 'Creator A', mediaType: '视频', tags: [], count: 7, lastTs: jan3, snapshots: [{ ts: jan2, completed: false }, { ts: jan3, completed: true }] }];
  const result = analyze(source, jan2, jan2 + 86400000 - 1);
  assert.equal(result.summary.videos, 1);
  assert.equal(result.summary.watches, 7);
  assert.equal(result.summary.snapshots, 1);
  assert.equal(result.months[0].count, 1);
});

test('rejects unrelated JSON instead of presenting an empty dashboard', () => {
  assert.throws(() => loadHistory('{"hello":"world"}', 'other.json'), /records/);
});

test('normalizes common array fields, merges duplicate IDs, deduplicates snapshots, and retains undated all-time rows', () => {
  const source = [
    { bvid: 'BV1abc12345', title: '音乐现场', up_name: 'Creator A', watch_count: 4, view_at: 1700000000, snapshots: [{ timestamp: 1700000000, position: 30, source: 'player' }] },
    { bvid: 'BV1abc12345', title: '音乐现场', up_name: 'Creator A', watch_count: 3, view_at: 1700000000, snapshots: [{ timestamp: 1700000000, position: 30, source: 'player' }] },
    { avid: 99, name: '无日期视频', author: 'Creator B', playCount: 2 }
  ];
  const { records } = loadHistory(JSON.stringify(source), 'array.json');
  assert.equal(records.length, 2);
  assert.equal(records[0].key, 'BV1abc12345');
  assert.equal(records[0].count, 4);
  assert.equal(records[0].snapshots.length, 1);
  assert.equal(analyze(records).summary.videos, 2);
  assert.equal(analyze(records).summary.watches, 6);
  assert.equal(analyze(records, 1700000000000, 1700000000000).summary.videos, 1);
});

test('does not show missing author as a creator', () => {
  const result = analyze([
    { key: 'BV1', title: 'A video', author: '', mediaType: '视频', tags: [], count: 2, lastTs: 1700000000000, snapshots: [] },
    { key: 'BV2', title: 'Another video', author: 'Creator A', mediaType: '视频', tags: [], count: 1, lastTs: 1700000000000, snapshots: [] }
  ]);
  assert.equal(result.summary.creators, 1);
  assert.deepEqual(result.creators.map(item => item.name), ['Creator A']);
});

test('ranks title and tag keywords by cumulative watches', () => {
  const result = analyze([
    { key: 'BV1', title: '城市旅行漫步', author: 'Creator A', mediaType: '视频', tags: ['旅行'], count: 3, lastTs: 1700000000000, snapshots: [] },
    { key: 'BV2', title: '旅行路线攻略', author: 'Creator B', mediaType: '视频', tags: ['旅行'], count: 2, lastTs: 1700000000000, snapshots: [] },
    { key: 'BV3', title: '城市建筑记录', author: 'Creator C', mediaType: '纪录片', tags: ['建筑'], count: 1, lastTs: 1700000000000, snapshots: [] }
  ]);
  // 同分词的先后顺序由分词器决定，这里只断言「入选词集」与「次数分布」，不锁死并列名次。
  assert.deepEqual(result.terms.slice(0, 6).map(item => item.name).sort(), ['城市', '建筑', '攻略', '旅行', '漫步', '路线'].sort());
  assert.deepEqual(result.terms.slice(0, 6).map(item => item.watches), [5, 4, 3, 2, 2, 1]);
  assert.equal(result.terms[0].videos, 2);
});

test('preserves a small keyword set without inventing chart dimensions', () => {
  const result = analyze([{ key: 'BV1', title: 'Travel', author: '', mediaType: '视频', tags: [], count: 3, lastTs: 1700000000000, snapshots: [] }]);
  assert.equal(result.terms.length, 1);
});

test('preserves progress, labels, collection details, and snapshot metadata for browsing', () => {
  const payload = { records: { video: { data: {
    key: 'BV1abc', title: '山地徒步', authorName: 'Creator A', mediaType: '视频', mediaTags: ['旅行', '户外'],
    mediaSubtitle: '春季路线', collectionTitle: '周末远足', partNumber: 2, partTotal: 4, watchCount: 3,
    lastTs: 1700000000, lastProgress: '72%', snapshots: [{ ts: 1700000000, pos: 320, progress: '72%', source: 'player', completed: false }]
  } } } };
  const record = loadHistory(JSON.stringify(payload), 'watch.json').records[0];
  assert.equal(record.lastProgress, '72%');
  assert.deepEqual(record.tags, ['旅行', '户外']);
  assert.equal(record.collectionTitle, '周末远足');
  assert.equal(record.partNumber, 2);
  assert.equal(record.partTotal, 4);
  assert.equal(record.snapshots[0].pos, 320);
  assert.equal(record.snapshots[0].source, 'player');
});

test('derives record highlights from snapshots and cumulative backup counts', () => {
  const result = analyze([
    { key: 'BV1', title: '城市漫步', author: 'Creator A', mediaType: '视频', tags: [], count: 3, lastTs: 1704153600000, snapshots: [{ ts: 1704067200000 }, { ts: 1704153600000 }] },
    { key: 'BV2', title: '旅行路线', author: 'Creator B', mediaType: '视频', tags: [], count: 1, lastTs: 1704153600000, snapshots: [{ ts: 1704153600000 }, { ts: 1704157200000 }] }
  ]);
  assert.deepEqual(result.milestones.peakDay, { name: '2024-01-02', snapshots: 3 });
  assert.equal(result.milestones.topReplay.title, '城市漫步');
  assert.equal(result.milestones.topReplay.watches, 3);
  assert.equal(result.milestones.earliest.title, '城市漫步');
  assert.equal(result.milestones.earliest.ts, 1704067200000);
  assert.equal(result.milestones.repeatVideos, 1);
});

test('does not mistake playback or collection states for content types and keywords', () => {
  const { records } = loadHistory(JSON.stringify([
    { key: 'BV1abc12345', title: '音乐现场', mediaType: '已收藏', tags: ['已收藏', '音乐'], watchCount: 1 },
    { key: 'live12345', title: '直播回放', mediaType: '未开播', tags: ['未开播'], watchCount: 1 }
  ]), 'states.json');
  const result = analyze(records);
  assert.deepEqual(records.map(item => item.mediaType), ['视频', '直播']);
  assert.deepEqual(records.map(item => item.tags), [['音乐'], []]);
  assert.deepEqual(result.types.map(item => item.name), ['视频', '直播']);
  assert.equal(result.terms.some(item => ['已收藏', '未开播'].includes(item.name)), false);
});

test('merges several backups and deduplicates the same video', () => {
  const record = { data: { key: 'BV1dup', title: '同一视频', authorName: 'A', lastTs: 1700000200, watchCount: 4, snapshots: [{ ts: 1700000200, pos: 40 }, { ts: 1700000100, pos: 10 }] } };
  const older = { records: { a: record } };
  const newer = { records: { a: record, b: { data: { key: 'BV1new', title: '新视频', authorName: 'B', lastTs: 1700000300, watchCount: 1, snapshots: [{ ts: 1700000300, pos: 5 }] } } } };

  const merged = mergeHistories([loadHistory(JSON.stringify(older), 'old.json'), loadHistory(JSON.stringify(newer), 'new.json')]);
  assert.equal(merged.records.length, 2, '重复视频只保留一条');
  assert.equal(merged.duplicates, 1, '重复条数要如实报告');
  assert.equal(merged.range.max, 1700000300000, '时间范围取并集（内部按毫秒）');
  const dup = merged.records.find(item => item.key === 'BV1dup');
  assert.equal(dup.snapshots.length, 2, '两份备份里的快照不能丢');
  assert.equal(dup.count, 4, '观看次数取最大值');
});

test('keeps two snapshots with the same timestamp but different progress', () => {
  const make = progress => ({ records: { a: { data: { key: 'BV1snap', title: '视频', lastTs: 1700000400, watchCount: 2, snapshots: [{ ts: 1700000400, pos: 1, progress }] } } } });
  const merged = mergeHistories([loadHistory(JSON.stringify(make('30%')), 'a.json'), loadHistory(JSON.stringify(make('70%')), 'b.json')]);
  assert.equal(merged.records[0].snapshots.length, 2, '同秒不同进度不是同一条快照');
});

test('uses the collection name as the author when a season has no uploader', () => {
  const fixture = { records: {
    season: { data: { type: 'collection', title: '孤独摇滚', mediaType: '番剧', parts: [
      { epKey: 'EP1', p: 1, title: '第1话', watchCount: 3, lastTs: 1700000100, snapshots: [{ ts: 1700000100 }] },
      { epKey: 'EP2', p: 2, title: '第2话', watchCount: 5, lastTs: 1700000200, snapshots: [{ ts: 1700000200 }] }
    ] } },
    movie: { data: { key: 'EP9', title: '某部电影', mediaType: '电影', watchCount: 4, lastTs: 1700000300, snapshots: [{ ts: 1700000300 }] } }
  } };
  const { records } = loadHistory(JSON.stringify(fixture), 'season.json');
  assert.deepEqual(records.map(item => item.author), ['孤独摇滚', '孤独摇滚', '某部电影'], '番剧作者栏不该是空的');
  assert.deepEqual(records.map(item => item.mediaType), ['番剧', '番剧', '电影'], '分集要继承合集的类型');
  assert.deepEqual(records.map(item => item.series), ['孤独摇滚', '孤独摇滚', '某部电影']);
});

test('aggregates a season as one work instead of ranking single episodes', () => {
  const fixture = { records: {
    season: { data: { type: 'collection', title: '孤独摇滚', mediaType: '番剧', parts: [
      { epKey: 'EP1', p: 1, title: '第1话', watchCount: 12, lastTs: 1700000100, snapshots: [{ ts: 1700000100 }] },
      { epKey: 'EP2', p: 2, title: '第2话', watchCount: 8, lastTs: 1700000200, snapshots: [{ ts: 1700000200 }] }
    ] } },
    video: { data: { key: 'BV1', title: '单条视频', authorName: 'UP', mediaType: '视频', watchCount: 15, lastTs: 1700000300, snapshots: [{ ts: 1700000300 }] } }
  } };
  const result = analyze(loadHistory(JSON.stringify(fixture), 'season.json').records);
  assert.equal(result.series.length, 1, '单集不单独进榜单');
  const row = result.series[0];
  assert.equal(row.name, '孤独摇滚');
  assert.equal(row.watches, 20, '播放数是整部累计（12+8），不是单集');
  assert.equal(row.parts, 2);
  assert.equal(row.partTotal, 2);
});
