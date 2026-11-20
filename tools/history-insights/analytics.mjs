import { Segment, useDefault } from './vendor/segmentit.mjs';
import { DOMAINS, classifyContent, domainFromMediaType } from './content-domains.mjs';

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '就', '都', '而', '被', '把', '让', '为', '有', '有的', '一个', '这个', '那个', '这些', '那些', '什么', '为什么', '怎么', '怎样', '如何', '哪种', '什么样', '怎么样',
  '我', '我们', '你', '你们', '你的', '他', '他们', '她', '她们', '自己', '大家', '别人', '人们', '时候', '现在', '已经', '还是', '不是', '没有', '可以', '应该', '需要', '觉得', '感觉', '看到', '发现', '里面', '出来', '起来', '一下', '一样', '这样', '那样', '而且', '但是', '所以', '因为', '如果', '其实', '真的', '非常', '比较', '可能', '还有', '就是', '然后', '以及', '或者', '不过', '只是', '终于', '直接', '到底', '到底是', '这么', '都是', '告诉', '教你', '带你', '给你',
  '视频', '哔哩哔哩', 'bilibili', 'b站', 'up主', 'up', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'video', 'official', '中字', '完整版', '全集', '合集', '转载', '高能', '推荐', '分享', '记录', '日常', '最新', '高清', '字幕', '封面', '片段', 'part', 'vol', 'episode', '收藏', '已收藏', '未开播', '直播中', '我的', '使用', '分钟', 'tv', 'official',
  '热门', '点赞', '关注', '评论', '弹幕', '播放', '观看', '喜欢', '知道', '认为', '觉得', '不', '一', '上', '也', '很', '到', '说', '要', '去', '人', '都', '有', '在', '我', '你', '他', '她',
  '才是', '世界', '中国', '美国', '日本', '俄罗斯', '兄弟', '朋友', '网友', '有人', '问题', '时间', '地方', '一切', '最大', '不能', '不用', '不会', '根本', '值得', '看看', '开始', '进入', '遇到', '结果', '以为', '变成', '成为', '还有', '这么', '那种', '这种', '整个', '真的', '基本', '完全', '居然', '竟然', '果然', '反正', '随便', '一般', '确实', '突然', '瞬间', '之前', '之后', '以前', '以后', '今天', '昨天', '明天', '今年', '去年'
]);
const TOPIC_WORDS = [
  'hi-res无损', 'hi-res', '无损音乐', '音乐现场', '纯音乐', '背景音乐', '钢琴演奏', '钢琴曲', '古风歌曲', '流行歌曲', '民谣歌曲', '歌曲推荐',
  '动画短片', '动漫音乐', '动漫歌曲', '游戏实况', '游戏攻略', '游戏音乐', '影视剪辑', '影视解说', '纪录片', '知识分享', '知识科普',
  '生活记录', '旅行攻略', '数码评测', '科技测评', '舞蹈翻跳', '鬼畜视频', '音乐推荐', '翻唱歌曲', '歌曲', '歌词', '小曲',
  '滚动歌词', '演唱会', '混剪', '纯享版', '高音质', '动态歌词', '中文翻译', '单曲循环', '视频解析', '教程', '攻略', '科普'
].sort((a, b) => b.length - a.length);

// segmentit 的词性用位标记表示：保留名词、动词、形容词、地名与英文词，丢弃代词、助词、副词、连词与数词。
const POS_KEEP = 1048576 | 8 | 64 | 4096 | 1073741824 | 16;
const POS_DROP = 65536 | 8192 | 134217728 | 268435456 | 4194304;

// 这些类型是「一整部作品」按集拆开记录的，统计时要回到整部去看。
// 国创 / 少儿这些同样是番剧式的连载，不能只认「番剧」两个字。
const SERIES_TYPES = new Set(['番剧', '国创', '电视剧', '电影', '纪录片', '综艺', '动画', '少儿', '影视']);

let dictionary = null;
function segmenter() {
  if (!dictionary) dictionary = useDefault(new Segment());
  return dictionary;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value.replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = number(value);
  return parsed > 0 ? (parsed < 1e11 ? parsed * 1000 : parsed) : 0;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some(value => value !== '')) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.replace(/^\uFEFF/, '').trim());
  const aliases = new Map([
    ['视频BV号', 'bv_key'], ['视频标题', 'title'], ['作者名字', 'author_name'], ['内容类型', 'media_type'],
    ['卡片标签', 'media_tags'], ['分集/副标题', 'media_subtitle'], ['合集标题', 'collection_title'],
    ['小合集标题', 'small_collection_title'], ['分集序号', 'part_number'], ['分集总数', 'part_total'],
    ['最后播放时间', 'last_ts'], ['最后播放进度', 'last_progress'], ['观看次数', 'watch_count'],
    ['快照时间', 'snapshot_ts'], ['快照播放位置', 'snapshot_pos'], ['快照进度', 'snapshot_progress'],
    ['快照观看时长说明', 'snapshot_watch_time'], ['快照是否看完', 'snapshot_completed'], ['快照作者', 'snapshot_author']
  ]);
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [aliases.get(header) || header, values[index] ?? ''])));
}

function first(record, keys, fallback = '') {
  for (const key of keys) if (record?.[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  return fallback;
}

function normalizeRecord(raw, key, parent = {}) {
  const record = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const rawId = first(record, ['key', 'bvKey', 'bvid', 'bv', 'epKey', 'avid', 'aid'], key);
  const page = number(first(record, ['partNumber', 'page', 'p'], 0));
  const stableId = String(rawId || `${first(record, ['title', 'name'], 'record')}:${key}`);
  const id = /^BV/i.test(stableId) && page > 1 ? `${stableId}?p=${page}` : stableId;
  const rawAuthor = first(record, ['authorName', 'author_name', 'up_name', 'author', 'owner'], first(parent, ['authorName', 'author_name', 'up_name', 'author'], ''));
  const author = typeof rawAuthor === 'object' ? first(rawAuthor, ['name', 'uname'], '') : rawAuthor;
  const tags = first(record, ['mediaTags', 'tags', 'keywords'], []);
  const snapshots = first(record, ['snapshots', 'events', 'watchHistory'], []);
  const lastTs = timestamp(first(record, ['lastTs', 'last_ts', 'view_at', 'timestamp', 'lastPlayTime', 'date'], 0));
  const normalizedSnapshots = Array.isArray(snapshots) ? snapshots.map(snapshot => ({
    ...snapshot,
    ts: timestamp(first(snapshot, ['ts', 'timestamp', 'view_at', 'time', 'date'], 0)),
    pos: number(first(snapshot, ['pos', 'position', 'progressSeconds'], 0)),
    progress: String(first(snapshot, ['progress', 'lastProgress'], ''))
  })).filter(snapshot => snapshot.ts) : [];
  if (!normalizedSnapshots.length && lastTs && (record.view_at || record.timestamp || record.lastTs || record.last_ts)) normalizedSnapshots.push({ ts: lastTs, pos: 0, progress: String(first(record, ['progress', 'lastProgress', 'last_progress'], '')) });
  // 分集自己不一定带 mediaType，缺省时沿用合集（父级）的类型，否则番剧的分集会被当成普通视频
  const ownType = String(first(record, ['mediaType', 'media_type', 'typeName', 'category'], ''));
  const parentType = String(first(parent, ['mediaType', 'media_type'], ''));
  const rawMediaType = ownType || parentType || '视频';
  const liveRecord = /^live/i.test(stableId) || ['未开播', '直播中'].includes(rawMediaType);
  const mediaType = rawMediaType === 'collection'
    ? (parentType || '番剧')
    : ['已收藏', '未开播', '直播中'].includes(rawMediaType) ? (liveRecord ? '直播' : '视频') : liveRecord ? '直播' : rawMediaType;
  const statusTags = new Set(['已收藏', '未开播', '直播中']);
  const title = String(first(record, ['title', 'name', 'videoTitle'], first(parent, ['title', 'name'], '')));
  const collectionTitle = String(first(record, ['collectionTitle', 'seasonTitle'], first(parent, ['title'], '')));
  // 番剧 / 电视剧 / 电影这些合集条目本来就没有 UP 主，作者栏是空的。
  // 直接拿合集名（没有合集名就用标题）当作者，排行和明细里才不会出现一片「未填写」。
  const seriesLike = SERIES_TYPES.has(mediaType);
  const authorName = String(author || '').trim();
  const seriesName = cleanSeriesName(collectionTitle || (seriesLike ? title : ''));
  const fallbackAuthor = seriesName;
  return {
    key: id,
    title,
    author: authorName || fallbackAuthor,
    mediaType,
    tags: (Array.isArray(tags) ? tags.map(String) : String(tags || '').split(/[、,，]/).filter(Boolean)).filter(tag => !statusTags.has(tag)),
    subtitle: String(first(record, ['mediaSubtitle', 'subtitle', 'partTitle'], '')),
    collectionTitle,
    // 合集条目按「整部剧」聚合：有合集名就用合集名，单集的番剧 / 电视剧就用标题
    series: seriesName,
    partNumber: page,
    partTotal: number(first(record, ['partTotal', 'part_total'], 0)),
    count: number(first(record, ['watchCount', 'watch_count', 'viewCount', 'playCount', 'views', 'count'], 0)),
    lastTs: Math.max(lastTs, ...normalizedSnapshots.map(snapshot => snapshot.ts)),
    lastProgress: String(first(record, ['lastProgress', 'last_progress', 'progress'], '0%')),
    snapshots: normalizedSnapshots
  };
}

function uniqueRecords(records) {
  const byKey = new Map();
  for (const record of records) {
    if (!record) continue;
    const current = byKey.get(record.key);
    if (!current) { byKey.set(record.key, record); continue; }
    // 同一条快照的判定要带上位置、进度、作者等细节：只按时间戳去重会把同一秒的不同进度误当成重复。
    const snapshots = new Map([...current.snapshots, ...record.snapshots].map(snapshot => [
      [snapshot.ts, snapshot.pos, snapshot.progress || '', snapshot.source || '', snapshot.author || '', snapshot.watchTimeStr || '', snapshot.completed ? 1 : 0].join('|'),
      snapshot
    ]));
    byKey.set(record.key, { ...current, ...record, count: Math.max(current.count, record.count), lastTs: Math.max(current.lastTs, record.lastTs), snapshots: [...snapshots.values()] });
  }
  return [...byKey.values()];
}

function jsonRecords(payload, onProgress = () => {}) {
  const source = Array.isArray(payload) ? payload : first(payload, ['records', 'items', 'history', 'data'], null);
  if (!source || typeof source !== 'object') throw new Error('找不到记录列表。支持 records、items、history 或数组格式。');
  const entries = Array.isArray(source) ? source.map((value, index) => [String(index), value]) : Object.entries(source);
  const result = [];
  entries.forEach(([key, wrapper], index) => {
    const record = wrapper?.data || wrapper;
    if (record?.type === 'collection' && Array.isArray(record.parts)) {
      for (const [partIndex, part] of record.parts.entries()) {
        const normalized = normalizeRecord({ ...part, epKey: part.epKey || part.bv || `${key}#part-${part.p || partIndex + 1}`, partNumber: part.p, partTotal: part.partTotal || record.parts.length }, key, record);
        if (normalized) result.push(normalized);
      }
      if (record.legacyAggregate) {
        const legacy = normalizeRecord({ ...record.legacyAggregate, key: `${key}#legacy`, title: record.legacyAggregate.title || record.title, mediaType: record.mediaType }, key, record);
        if (legacy) result.push(legacy);
      }
    } else {
      const normalized = normalizeRecord(record, key);
      if (normalized) result.push(normalized);
    }
    if (index % 500 === 0 || index === entries.length - 1) onProgress(index + 1, entries.length);
  });
  return uniqueRecords(result);
}

function csvRecords(text) {
  const rows = parseCsv(text), records = new Map();
  for (const row of rows) {
    const key = row.bv_key || `${row.title || 'record'}:${row.author_name || ''}`;
    let item = records.get(key);
    if (!item) {
      const mediaType = row.media_type || '视频';
      const collectionTitle = row.collection_title || '';
      const series = collectionTitle || (SERIES_TYPES.has(mediaType) ? (row.title || '') : '');
      item = { key, title: row.title || '', author: row.author_name || series, mediaType, tags: String(row.media_tags || '').split(/[、,，]/).filter(Boolean), subtitle: row.media_subtitle || row.small_collection_title || '', collectionTitle, series, partNumber: number(row.part_number), partTotal: number(row.part_total), count: number(row.watch_count), lastTs: timestamp(row.last_ts), lastProgress: row.last_progress || '0%', snapshots: [] };
      records.set(key, item);
    }
    const snapTs = timestamp(row.snapshot_ts);
    if (snapTs) item.snapshots.push({ ts: snapTs, pos: number(row.snapshot_pos), progress: row.snapshot_progress || '', watchTimeStr: row.snapshot_watch_time || '', completed: /^(true|1|是|yes)$/i.test(String(row.snapshot_completed || '')), author: row.snapshot_author || '', source: row.snapshot_source || '' });
  }
  return uniqueRecords([...records.values()]);
}

const TITLE_SUFFIX = /\s*[_\-|·]\s*哔哩哔哩[^\s]*|\s*bilibili\s*$/gi;

function cleanTitle(title) {
  return String(title || '').replace(TITLE_SUFFIX, '').replace(/\s+/g, ' ').trim();
}

// 有的番剧 / 电视剧条目把整段网页标题当合集名带了进来
// （「良医 第七季第9集-电视剧-全集-高清正版在线观看-bilibili-哔哩哔哩」），
// 这里只截掉「-电视剧-全集…」这截尾巴，让同一部剧能并到一行。
function cleanSeriesName(title) {
  return cleanTitle(title).replace(/[-_|·]\s*(?:电视剧|剧集|番剧|国创|电影|综艺|纪录片|全集|高清|正版)[-－].*$/, '').trim();
}

function flagsOf(segment) {
  const value = segment.p;
  if (Array.isArray(value)) return value.reduce((all, item) => all | (Number(item) || 0), 0);
  return Number(value) || 0;
}

/**
 * 用 segmentit 做带词性的分词，再叠加本地主题词表与停用词过滤。
 * 比单纯按标点切分更稳：助词、代词、副词、数词会被词性标记直接过滤掉。
 */
export function keywordsFor(record, limit = 8) {
  const title = cleanTitle(record.title);
  const combined = [title, ...(record.tags || [])].join(' ');
  const tokens = [];
  let segments;
  try {
    segments = segmenter().doSegment(combined, { stripPunctuation: true, simple: false });
  } catch {
    segments = [];
  }
  for (const segment of segments) {
    const word = String(segment.w || '').toLowerCase().trim();
    if (!word || word.length < 2) continue;
    if (!/[\p{Script=Han}a-z]/u.test(word)) continue;
    if (STOP_WORDS.has(word)) continue;
    if (/[的了呢吗呀吧啊哦]/.test(word) && word.length <= 2) continue;
    const flags = flagsOf(segment);
    if (flags) {
      if (flags & POS_DROP) continue;
      if (!(flags & POS_KEEP)) continue;
    } else if (!/\p{Script=Han}/u.test(word) || word.length > 5) {
      continue;
    }
    if (word.length > 12) continue;
    tokens.push(word);
  }
  const enriched = [];
  const lower = combined.toLowerCase();
  const claimed = [];
  for (const term of TOPIC_WORDS) {
    let offset = 0;
    while ((offset = lower.indexOf(term, offset)) !== -1) {
      const end = offset + term.length;
      if (!claimed.some(([start, stop]) => offset < stop && end > start)) {
        enriched.push(term);
        claimed.push([offset, end]);
      }
      offset += term.length;
    }
  }
  for (const term of enriched) {
    const compact = term.replace(/[^\p{Script=Han}a-z0-9+#.-]/giu, '');
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].includes(compact) || compact.includes(tokens[i])) tokens.splice(i, 1);
    }
  }
  const merged = [...enriched, ...tokens];
  const unique = [];
  for (const word of merged) {
    if (!unique.includes(word)) unique.push(word);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** 给记录补上关键词与内容域；导入时算一次，后续时间筛选直接复用。 */
export function enrichRecord(record) {
  if (!Array.isArray(record.keywords)) record.keywords = keywordsFor(record);
  if (record.domain === undefined) {
    const text = [record.title, record.subtitle, record.collectionTitle, ...(record.tags || [])].filter(Boolean).join(' ');
    const domain = classifyContent(text) || domainFromMediaType(record.mediaType);
    record.domain = domain ? domain.id : null;
    record.domainName = domain ? domain.name : '';
  }
  return record;
}

export function loadHistory(text, filename = '', onProgress = () => {}) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  let records;
  if (/\.csv$/i.test(filename) || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) records = csvRecords(trimmed);
  else {
    let payload;
    try { payload = JSON.parse(trimmed); } catch { throw new Error('JSON 格式无法读取。'); }
    records = jsonRecords(payload, onProgress);
  }
  if (!records.length) throw new Error('文件中没有可分析的记录。');
  for (const record of records) enrichRecord(record);
  let min = Infinity, max = 0;
  for (const record of records) for (const value of [record.lastTs, ...record.snapshots.map(item => timestamp(item.ts))]) if (value) { min = Math.min(min, value); max = Math.max(max, value); }
  return { records, range: max ? { min, max } : { min: 0, max: 0 } };
}

export function mergeHistories(parts) {
  const all = [];
  for (const part of parts) all.push(...part.records);
  const records = uniqueRecords(all);
  for (const record of records) enrichRecord(record);
  let min = Infinity, max = 0;
  for (const record of records) for (const value of [record.lastTs, ...record.snapshots.map(item => timestamp(item.ts))]) if (value) { min = Math.min(min, value); max = Math.max(max, value); }
  return { records, range: max ? { min, max } : { min: 0, max: 0 }, duplicates: all.length - records.length };
}

export function analyze(records, start = 0, end = Infinity) {
  const filtered = records.map(record => {
    const selectedSnapshots = record.snapshots.filter(item => { const ts = timestamp(item.ts); return ts && ts >= start && ts <= end; });
    const lastTs = record.lastTs >= start && record.lastTs <= end ? record.lastTs : Math.max(0, ...selectedSnapshots.map(item => timestamp(item.ts)));
    return { ...record, lastTs, snapshots: selectedSnapshots };
  }).filter(record => (start === 0 && end === Infinity) || record.lastTs || record.snapshots.length);

  const aggregate = (field, fallback = '未填写', skipMissing = false) => {
    const map = new Map();
    for (const record of filtered) {
      if (skipMissing && !record[field]) continue;
      const value = record[field] || fallback;
      const row = map.get(value) || { name: value, videos: 0, watches: 0 };
      row.videos++; row.watches += Math.max(0, record.count); map.set(value, row);
    }
    return [...map.values()].sort((a, b) => b.watches - a.watches || b.videos - a.videos).slice(0, 10);
  };
  const creators = aggregate('author', '', true);
  const types = aggregate('mediaType');

  const terms = new Map(), months = new Map(), days = new Map(), calendarDays = new Map();
  const domainRows = new Map(DOMAINS.map(domain => [domain.id, { id: domain.id, name: domain.name, color: domain.color, videos: 0, watches: 0 }]));
  const hourGrid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let earliest = null;
  let topReplay = null;
  let unclassified = 0;
  let nightSnapshots = 0;
  let timedSnapshots = 0;

  for (const record of filtered) {
    if (!topReplay || record.count > topReplay.count) topReplay = record;
    const keywords = Array.isArray(record.keywords) ? record.keywords : keywordsFor(record);
    for (const word of new Set(keywords)) {
      const term = terms.get(word) || { name: word, videos: 0, watches: 0 };
      term.videos++;
      term.watches += Math.max(0, record.count);
      terms.set(word, term);
    }
    const domainId = record.domain !== undefined ? record.domain : ((classifyContent([record.title, record.subtitle, record.collectionTitle, ...(record.tags || [])].filter(Boolean).join(' ')) || domainFromMediaType(record.mediaType))?.id ?? null);
    const row = domainRows.get(domainId);
    if (row) { row.videos++; row.watches += Math.max(0, record.count); }
    else unclassified++;

    for (const snapshot of record.snapshots) {
      const ts = timestamp(snapshot.ts);
      if (ts && (!earliest || ts < earliest.ts)) earliest = { ts, record };
    }
    for (const snap of record.snapshots) {
      const date = new Date(timestamp(snap.ts));
      if (!Number.isFinite(date.getTime())) continue;
      timedSnapshots++;
      if (date.getHours() >= 22 || date.getHours() < 4) nightSnapshots++;
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      months.set(month, (months.get(month) || 0) + 1);
      const dayKey = `${month}-${String(date.getDate()).padStart(2, '0')}`;
      calendarDays.set(dayKey, (calendarDays.get(dayKey) || 0) + 1);
      const day = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
      days.set(day, (days.get(day) || 0) + 1);
      hourGrid[date.getDay()][date.getHours()]++;
    }
  }

  const rankedTerms = [...terms.values()].sort((a, b) => b.watches - a.watches || b.videos - a.videos).slice(0, 16);
  // 番剧 / 电视剧 / 合集要按「整部」看：把同一部剧的分集并成一行，播放数相加，
  // 不然榜单会被某一集的第 3 集压住，看不出你到底追了多少部。
  // 区分两类：连载剧集（有集数）和 UP 主的视频合集（并列的视频，不分集）。
  const seriesRows = new Map();
  for (const record of filtered) {
    if (!record.series) continue;
    const kind = SERIES_TYPES.has(record.mediaType) ? 'series' : 'collection';
    let row = seriesRows.get(record.series);
    if (!row) {
      row = { name: record.series, kind, type: record.mediaType, parts: 0, partTotal: 0, watches: 0, lastTs: 0, topTitle: '' };
      seriesRows.set(record.series, row);
    }
    if (kind === 'series' && row.kind !== 'series') { row.kind = 'series'; row.type = record.mediaType; }
    row.parts += 1;
    row.watches += Math.max(0, record.count);
    row.partTotal = Math.max(row.partTotal, record.partTotal || 0);
    if (record.lastTs > row.lastTs) { row.lastTs = record.lastTs; }
    if (record.count > (row.topCount || 0)) { row.topCount = record.count; row.topTitle = record.title; }
  }
  // 有的条目把分集名当合集名（「良医 第七季第9集」），如果它所属的那一部已经在榜里，就并回去
  for (const [name, row] of [...seriesRows]) {
    if (!/第\s*\d+\s*[集话期回]/.test(name)) continue;
    const base = name.replace(/第\s*\d+\s*[集话期回].*$/, '').trim();
    const target = base && base !== name ? seriesRows.get(base) : null;
    if (!target) continue;
    target.parts += row.parts;
    target.watches += row.watches;
    target.partTotal = Math.max(target.partTotal, row.partTotal);
    target.lastTs = Math.max(target.lastTs, row.lastTs);
    if ((row.topCount || 0) > (target.topCount || 0)) { target.topCount = row.topCount; target.topTitle = row.topTitle; }
    seriesRows.delete(name);
  }
  const cleaned = [...seriesRows.values()]
    .filter(row => row.kind === 'series' || row.parts >= 2)
    .map(({ topCount, ...row }) => row)
    .sort((a, b) => b.watches - a.watches || b.parts - a.parts);
  // 榜单给剧集留位置：最多 5 部剧 + 3 个合集，免得一堆 UP 合集把番剧顶下去
  const series = [
    ...cleaned.filter(row => row.kind === 'series').slice(0, 5),
    ...cleaned.filter(row => row.kind === 'collection').slice(0, 3)
  ];
  const peakDay = [...calendarDays].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
  const domains = [...domainRows.values()];
  const topDomain = domains.slice().sort((a, b) => b.watches - a.watches || b.videos - a.videos)[0] || null;

  return {
    records: filtered,
    summary: {
      videos: filtered.length,
      watches: filtered.reduce((sum, item) => sum + Math.max(0, item.count), 0),
      snapshots: filtered.reduce((sum, item) => sum + item.snapshots.length, 0),
      creators: new Set(filtered.map(item => item.author).filter(Boolean)).size
    },
    creators,
    types,
    series,
    terms: rankedTerms,
    domains,
    coverage: {
      classified: filtered.length - unclassified,
      unclassified,
      ratio: filtered.length ? Number((((filtered.length - unclassified) / filtered.length) * 100).toFixed(1)) : 0
    },
    profile: {
      nightRatio: timedSnapshots ? Number(((nightSnapshots / timedSnapshots) * 100).toFixed(1)) : 0,
      topDomain: topDomain && topDomain.videos ? { name: topDomain.name, color: topDomain.color, watches: topDomain.watches, videos: topDomain.videos } : null,
      peakDay: peakDay ? peakDay[0] : '',
      firstDay: calendarDays.size ? [...calendarDays.keys()].sort()[0] : '',
      lastDay: calendarDays.size ? [...calendarDays.keys()].sort().slice(-1)[0] : ''
    },
    milestones: {
      peakDay: peakDay ? { name: peakDay[0], snapshots: peakDay[1] } : null,
      topReplay: topReplay ? { title: topReplay.title, author: topReplay.author, watches: topReplay.count, key: topReplay.key } : null,
      earliest: earliest ? { title: earliest.record.title, author: earliest.record.author, ts: earliest.ts, key: earliest.record.key } : null,
      repeatVideos: filtered.filter(record => record.count > 1).length
    },
    months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })),
    calendarDays: [...calendarDays].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })),
    weekdays: [...days].map(([name, count]) => ({ name, count })),
    hourGrid: hourGrid.map((hours, day) => ({ day: ['日', '一', '二', '三', '四', '五', '六'][day], hours }))
  };
}
