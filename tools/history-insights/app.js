const worker = new Worker('./worker.js', { type: 'module' });
const $ = selector => document.querySelector(selector);
const numberFormat = new Intl.NumberFormat('zh-CN');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const ui = {
  file: $('#history-file'), pick: $('#pick-file'), drop: $('#drop-zone'),
  fileLabel: $('#file-label'), fileBadge: $('#file-badge'), fileMeta: $('#file-meta'), loadLatest: $('#load-latest'), pickDir: $('#pick-dir'),
  listBackups: $('#list-backups'), listCount: $('#list-count'), localList: $('#local-list'), localRows: $('#local-rows'),
  localAll: $('#local-all'), localNone: $('#local-none'), localLoad: $('#local-load'),
  status: $('#status'), progress: $('#load-progress'),
  range: $('#range-control'), start: $('#date-start'), end: $('#date-end'), analyze: $('#analyze'),
  dashboard: $('#dashboard'), activeRange: $('#active-range'),
  personaTag: $('#persona-tag'), personaSummary: $('#persona-summary'),
  search: $('#record-search'), keywordStatus: $('#keyword-status'), clearKeyword: $('#clear-keyword'),
  metrics: { videos: $('#metric-videos'), watches: $('#metric-watches'), snapshots: $('#metric-snapshots'), creators: $('#metric-creators') }
};

const chartIds = ['trend-chart', 'heatmap-chart', 'radar-chart', 'type-chart', 'spark-videos', 'spark-watches', 'spark-snapshots', 'spark-creators'];
const charts = new Map();
let hasData = false;
let dateBounds = { min: 0, max: 0 };
let latestResult = null;
let requestId = 0;
let trendMode = 'days';
let activeKeyword = '';
let searchQuery = '';
let sessionFiles = [];
let printing = false;
// 服务端导出 PDF 时以 ?print=1 打开本页，首轮分析完成后要按纸张宽度重画一次图表。
let printLayoutPending = new URLSearchParams(location.search).get('print') === '1';

/* ---------------------------------------------------------------- 工具函数 */
function dayInput(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function localDayBounds(value, isEnd) {
  if (!value) return isEnd ? Infinity : 0;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, isEnd ? 999 : 0).getTime();
}
function selectedRange() { return { start: localDayBounds(ui.start.value, false), end: localDayBounds(ui.end.value, true) }; }
function showStatus(message, error = false) { ui.status.textContent = message; ui.status.classList.toggle('error', error); }
function normalizedTimestamp(value) { const ts = Number(value) || 0; return ts > 0 && ts < 1e11 ? ts * 1000 : ts; }
function tone(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function chartTheme() {
  return {
    text: tone('--muted'), faint: tone('--faint'), line: tone('--line'), panel: tone('--panel-solid'),
    accent: tone('--accent'), accentBright: tone('--accent-bright'), cyan: tone('--cyan'),
    violet: tone('--violet'), amber: tone('--amber'), textStrong: tone('--text-strong'), raised: tone('--raised'),
    slate: tone('--slate')
  };
}

function isPaperPalette() {
  return document.documentElement.dataset.palette === 'paper';
}

// 纸本主题下把荧光色往纸色里调一点，避免深色霓虹色直接印在米白纸上显得刺眼。
function softColor(color) {
  if (!isPaperPalette() || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const paper = [255, 254, 250];
  const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
  return `rgb(${rgb.map((value, index) => Math.round(value * .66 + paper[index] * .34)).join(',')})`;
}

function setMetric(element, value) {
  const target = Number(value) || 0;
  const current = Number(element.textContent.replace(/[^\d]/g, '')) || 0;
  if (current === target || reduceMotion() || printing) { element.textContent = numberFormat.format(target); return; }
  const started = performance.now();
  const duration = 520;
  const frame = now => {
    const progress = Math.min((now - started) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = numberFormat.format(Math.round(current + (target - current) * eased));
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function toast(message) {
  const target = $('#toast');
  target.textContent = message;
  target.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove('visible'), 2200);
}

function videoUrl(key) {
  const value = String(key || '');
  const match = value.match(/^(BV[a-zA-Z0-9]+)(\?p=\d+)?/i);
  if (match) return `https://www.bilibili.com/video/${match[1]}${match[2] || ''}`;
  if (/^(ep|ss)\d+$/i.test(value)) return `https://www.bilibili.com/bangumi/play/${value}`;
  return 'https://www.bilibili.com';
}

/* ---------------------------------------------------------------- 图表基础 */
// 图表在第一次真正渲染时才初始化，避免在 hidden 面板里以 0×0 尺寸建实例。
function chartFor(id) {
  let chart = charts.get(id);
  if (chart) return chart;
  const container = document.getElementById(id);
  if (!container || !window.echarts) return null;
  chart = window.echarts.init(container, null, { renderer: 'canvas' });
  charts.set(id, chart);
  return chart;
}

function initCharts() {
  if (!window.echarts) { showStatus('图表库未加载。请确认 vendor/echarts.min.js 存在，并重新启动本地页面。', true); return; }
  const resizeAll = () => charts.forEach(chart => chart.resize());
  window.addEventListener('resize', resizeAll);
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const chart = charts.get(entry.target.id);
      if (chart && entry.contentRect.width > 0 && entry.contentRect.height > 0) chart.resize();
    }
  });
  for (const id of chartIds) { const element = document.getElementById(id); if (element) observer.observe(element); }
}

function setChart(id, option) {
  const chart = chartFor(id);
  if (chart) chart.setOption({ ...option, animation: !reduceMotion() && !printing }, true);
}

function emptyChart(id, message) {
  setChart(id, {
    animation: false, xAxis: { show: false }, yAxis: { show: false }, series: [],
    graphic: [{ type: 'text', left: 'center', top: 'middle', style: { text: message, fill: tone('--faint'), fontSize: 12, fontFamily: 'inherit' } }]
  });
}

function tooltipBase(theme, border) {
  return {
    backgroundColor: theme.panel, borderColor: border, borderWidth: 1,
    textStyle: { color: tone('--text'), fontSize: 12 }, padding: [8, 11],
    extraCssText: 'backdrop-filter: blur(8px); border-radius: 9px; box-shadow: 0 8px 22px rgba(0,0,0,.35);'
  };
}

/* ---------------------------------------------------------------- 趋势 */
function renderTrend(items) {
  const theme = chartTheme();
  const isMonthly = trendMode === 'months';
  $('#trend-unit').textContent = `${isMonthly ? '按月' : '按日'} · 快照条数 · 共 ${numberFormat.format(items.length)} 个时间单位`;
  if (!items.length) { emptyChart('trend-chart', '此范围内没有可识别的观看快照'); return; }
  const visible = items.slice(isMonthly ? -24 : -45);
  const labels = visible.map(item => isMonthly ? item.name : item.name.slice(5));
  const values = visible.map(item => item.count);
  setChart('trend-chart', {
    animationDuration: 700,
    grid: { left: 44, right: 18, top: 22, bottom: 30 },
    tooltip: { ...tooltipBase(theme, theme.accent), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: theme.accent, opacity: .4 } }, formatter: params => { const item = params[0]; return `<div style="font-family:monospace;font-size:11px;color:${theme.text}">${item.axisValue}</div><div style="font-weight:700;color:${theme.accentBright}">${numberFormat.format(item.value)} 条快照</div>`; } },
    xAxis: { type: 'category', boundaryGap: isMonthly, data: labels, axisLine: { lineStyle: { color: theme.line } }, axisTick: { show: false }, axisLabel: { color: theme.text, fontSize: 11, hideOverlap: true, fontFamily: 'monospace' } },
    yAxis: { type: 'value', minInterval: 1, splitNumber: 4, axisLabel: { color: theme.faint, fontSize: 11, fontFamily: 'monospace' }, splitLine: { lineStyle: { color: theme.line, type: 'dashed' } } },
    series: [isMonthly ? {
      type: 'bar', data: values, barMaxWidth: 34,
      label: { show: true, position: 'top', color: theme.accentBright, fontFamily: 'monospace', fontSize: 10 },
      itemStyle: { borderRadius: [7, 7, 0, 0], color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: theme.accentBright }, { offset: 1, color: theme.accent }]) },
      emphasis: { itemStyle: { shadowBlur: 14, shadowColor: theme.accent } }
    } : {
      type: 'line', data: values, smooth: .42, showSymbol: values.length < 20, symbolSize: 6,
      itemStyle: { color: theme.accentBright },
      lineStyle: { width: 2.2, color: new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: theme.accent }, { offset: .5, color: theme.cyan }, { offset: 1, color: theme.violet }]), shadowColor: theme.accent, shadowBlur: isPaperPalette() ? 0 : 10 },
      areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: theme.accent }, { offset: .85, color: 'transparent' }]), opacity: isPaperPalette() ? .1 : .22 },
      emphasis: { focus: 'series' }
    }]
  });
}

/* ---------------------------------------------------------------- 热力 */
function renderHeatmap(rows) {
  const theme = chartTheme();
  const heat = tone('--heat').split(',').map(item => item.trim()).filter(Boolean);
  const values = [];
  rows.forEach((row, day) => row.hours.forEach((count, hour) => values.push([hour, day, count])));
  if (!values.some(item => item[2])) { emptyChart('heatmap-chart', '此范围内没有带时间的快照'); $('#heatmap-peak').textContent = '无峰值'; return; }
  const max = Math.max(...values.map(item => item[2]), 1);
  // 快照时间高度集中（多数格子是 0，少数格子几百），线性色阶会把有效格子全压成一个颜色。
  // 改成按分位数分级，让「1 条 / 5 条 / 40 条 / 300 条」都读得出来。
  const nonzero = values.map(item => item[2]).filter(item => item > 0).sort((a, b) => a - b);
  const quantile = ratio => (nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(ratio * nonzero.length))] : 1);
  const breaks = [1, Math.max(2, quantile(.55)), Math.max(3, quantile(.85)), Math.max(5, quantile(.95))]
    .map((value, index, list) => Math.max(value, index ? list[index - 1] + 1 : 1));
  const ramp = heat.length >= 5 ? heat : ['#0b1116', '#064e3b', '#0d9488', '#10b981', '#a7f3d0'];
  let peak = { hour: 0, day: 0, count: 0 };
  values.forEach(([hour, day, count]) => { if (count > peak.count) peak = { hour, day, count }; });
  $('#heatmap-peak').textContent = `峰值：周${rows[peak.day].day} ${String(peak.hour).padStart(2, '0')}:00`;
  setChart('heatmap-chart', {
    animationDuration: 560,
    grid: { left: 40, right: 10, top: 10, bottom: 34 },
    tooltip: { ...tooltipBase(theme, theme.cyan), position: 'top', formatter: p => `<div style="font-family:monospace;font-size:11px;color:${theme.text}">周${rows[p.data[1]].day} ${String(p.data[0]).padStart(2, '0')}:00 - ${String(p.data[0]).padStart(2, '0')}:59</div><div style="font-weight:700;color:${theme.cyan}">${numberFormat.format(p.data[2])} 条快照</div>` },
    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => i), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: theme.faint, fontSize: 10, fontFamily: 'monospace', hideOverlap: true, formatter: v => String(v).padStart(2, '0') } },
    yAxis: { type: 'category', data: rows.map(row => `周${row.day}`), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: theme.text, fontSize: 11 } },
    visualMap: {
      type: 'piecewise',
      show: false,
      pieces: [
        { min: 0, max: 0.5, color: ramp[0] },
        { min: 0.5, max: breaks[0], color: ramp[1] },
        { min: breaks[0], max: breaks[1], color: ramp[2] },
        { min: breaks[1], max: breaks[2], color: ramp[3] },
        { min: breaks[2], color: ramp[4] },
      ],
      max,
    },
    series: [{ type: 'heatmap', data: values, itemStyle: { borderColor: theme.panel, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: theme.textStrong, borderWidth: 1 } } }]
  });
}

/* ---------------------------------------------------------------- 雷达 */
function renderRadar(domains, coverage) {
  const theme = chartTheme();
  const axes = domains.slice();
  const maximum = Math.max(...axes.map(item => item.watches), 1) * 1.15;
  $('#radar-coverage').textContent = `已归类 ${coverage.ratio}%`;
  setChart('radar-chart', {
    animationDuration: 700,
    tooltip: { ...tooltipBase(theme, theme.violet), trigger: 'item', formatter: () => axes.map(item => `<div style="display:flex;justify-content:space-between;gap:14px;font-size:11.5px"><span style="color:${theme.text}">${item.name}</span><strong style="color:${item.color}">${numberFormat.format(item.watches)} 次 / ${numberFormat.format(item.videos)} 条</strong></div>`).join('') },
    radar: {
      center: ['50%', '52%'], radius: '64%',
      indicator: axes.map(item => ({ name: item.name, max: maximum })),
      axisName: { color: theme.text, fontSize: 11.5 },
      axisLine: { lineStyle: { color: theme.line } },
      splitLine: { lineStyle: { color: theme.line } },
      splitArea: { areaStyle: { color: isPaperPalette() ? ['rgba(58,52,36,0.02)', 'rgba(58,52,36,0.045)'] : ['rgba(139,92,246,0.03)', 'rgba(16,185,129,0.035)'] } }
    },
    series: [{
      type: 'radar',
      data: [{ value: axes.map(item => item.watches), name: '累计观看次数', symbol: 'circle', symbolSize: 6, itemStyle: { color: theme.violet }, lineStyle: { color: theme.violet, width: 2 }, areaStyle: { color: theme.violet, opacity: .26 } }],
      tooltip: { show: true }
    }]
  });
}

/* ---------------------------------------------------------------- 环形 */
function renderDonut(domains, coverage) {
  const theme = chartTheme();
  const data = domains.filter(item => item.videos > 0).map(item => ({ name: item.name, value: item.videos, itemStyle: { color: softColor(item.color) } }));
  const total = data.reduce((sum, item) => sum + item.value, 0);
  $('#type-total').textContent = numberFormat.format(total);
  const coverageBadge = $('#type-coverage');
  if (coverageBadge) {
    coverageBadge.textContent = coverage.unclassified
      ? `已归类 ${coverage.ratio}% · 未归类 ${numberFormat.format(coverage.unclassified)}`
      : `已归类 ${coverage.ratio}%`;
    coverageBadge.className = coverage.ratio >= 80 ? 'badge badge-green' : coverage.ratio >= 50 ? 'badge badge-amber' : 'badge badge-violet';
  }
  if (!total) { emptyChart('type-chart', '没有命中内容域词表的视频'); return; }
  setChart('type-chart', {
    animationDuration: 700,
    tooltip: {
      ...tooltipBase(theme, theme.accent),
      trigger: 'item',
      confine: true,
      // 固定在图表右上角，永远不遮挡圆心与圆环主体。
      position: (point, params, dom, rect, size) => {
        const width = size?.viewSize?.[0] || 260;
        const content = size?.contentSize?.[0] || 120;
        return [Math.max(8, width - content - 8), 10];
      },
      formatter: p => `<div style="font-family:monospace;font-size:11px;color:${theme.text}">${p.name}</div><div style="font-weight:700;color:${theme.textStrong}">${numberFormat.format(p.value)} 条 · ${p.percent}%</div>`
    },
    legend: { type: 'plain', orient: 'horizontal', left: 'center', bottom: 0, width: '100%', itemWidth: 7, itemHeight: 7, itemGap: 8, textStyle: { color: theme.text, fontSize: 10.5 }, formatter: name => (name.length > 2 ? name.slice(0, 2) : name) },
    series: [{
      name: '内容域', type: 'pie', radius: ['46%', '70%'], center: ['50%', '43%'],
      avoidLabelOverlap: true, label: { show: false }, labelLine: { show: false },
      itemStyle: { borderRadius: 6, borderColor: theme.panel, borderWidth: 2 },
      emphasis: { scale: true, scaleSize: 5, itemStyle: { shadowBlur: 16, shadowColor: 'rgba(16,185,129,.4)' } },
      data
    }]
  });
}

/* ---------------------------------------------------------------- 关键词 */
function renderNebula(terms) {
  const target = $('#keyword-cloud');
  target.replaceChildren();
  const words = terms.slice(0, 10);
  if (!words.length) {
    const empty = document.createElement('p');
    empty.className = 'nebula-empty';
    empty.textContent = '这个时间范围内没有提取到关键词';
    target.append(empty);
    return;
  }
  const max = Math.max(...words.map(item => item.watches), 1);
  words.forEach((item, index) => {
    const ratio = item.watches / max;
    const tier = ratio >= .62 ? 'tier-1' : ratio >= .3 ? 'tier-2' : 'tier-3';
    // 字号在 13px–23px 之间连续取值，避免最高频词扎堆成同一档而看起来「气泡一样大」。
    const size = 13 + Math.round(ratio * 10);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `nebula-word ${tier} tone-${index % 4}`;
    button.style.fontSize = `${size}px`;
    button.style.animationDelay = `${index * 0.05}s`;
    button.setAttribute('aria-pressed', String(activeKeyword === item.name));
    button.title = `累计观看 ${numberFormat.format(item.watches)} 次 · ${numberFormat.format(item.videos)} 个视频`;
    const label = document.createElement('span');
    label.textContent = `#${item.name}`;
    const count = document.createElement('b');
    count.textContent = numberFormat.format(item.videos);
    button.append(label, count);
    button.addEventListener('click', () => toggleKeyword(item.name));
    target.append(button);
  });
}

function setKeywordStatus() {
  ui.keywordStatus.textContent = activeKeyword ? `已锁定关键词：#${activeKeyword}` : '当前：全部关键词';
  ui.clearKeyword.hidden = !activeKeyword;
}
function toggleKeyword(word) {
  activeKeyword = activeKeyword === word ? '' : word;
  setKeywordStatus();
  if (latestResult) { renderNebula(latestResult.terms); renderRecords(latestResult.records); }
  if (activeKeyword) toast(`已按关键词 #${activeKeyword} 过滤视频`);
}

/* ---------------------------------------------------------------- UP 主 */
function renderCreators(result) {
  const items = result.creators;
  const withAuthor = result.records.filter(item => item.author).length;
  const repeated = result.records.filter(item => item.author && item.count > 1).length;
  const pct = withAuthor ? Math.round((repeated / withAuthor) * 100) : 0;
  $('#creator-badge').textContent = `长情回看 ${pct}%`;

  const summary = $('#creator-summary');
  summary.replaceChildren();
  const head = document.createElement('div');
  head.className = 'loyalty-head';
  const left = document.createElement('span');
  left.textContent = '累计次数 ≥ 2 的条目';
  const value = document.createElement('strong');
  value.textContent = `${pct}%`;
  head.append(left, value);
  const bar = document.createElement('div');
  bar.className = 'loyalty-bar';
  const loyal = document.createElement('i');
  loyal.style.width = `${pct}%`;
  const once = document.createElement('u');
  once.style.width = `${100 - pct}%`;
  bar.append(loyal, once);
  summary.append(head, bar);

  const list = $('#creator-list');
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = '这个时间范围内没有可统计的 UP 主';
    list.append(empty);
    return;
  }
  const max = items[0].watches || 1;
  items.slice(0, 7).forEach(item => {
    const li = document.createElement('li');
    li.className = 'creator-row';
    li.title = `筛选「${item.name}」的视频`;
    const avatar = document.createElement('span');
    avatar.className = 'creator-avatar';
    avatar.textContent = (item.name || '?').slice(0, 1).toUpperCase();
    const main = document.createElement('div');
    main.className = 'creator-main';
    const nameLine = document.createElement('div');
    nameLine.className = 'creator-name';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const tag = document.createElement('span');
    tag.className = 'creator-tag';
    tag.textContent = item.watches >= 10 ? '常驻频道' : item.watches >= 3 ? '高频常看' : '偶尔路过';
    nameLine.append(name, tag);
    const meter = document.createElement('div');
    meter.className = 'creator-meter';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(6, Math.round(item.watches / max * 100))}%`;
    meter.append(fill);
    main.append(nameLine, meter);
    const val = document.createElement('span');
    val.className = 'creator-value';
    val.textContent = `${numberFormat.format(item.videos)} 条`;
    li.append(avatar, main, val);
    li.addEventListener('click', () => { searchQuery = item.name; ui.search.value = item.name; renderRecords(latestResult.records); toast(`已定位「${item.name}」的观看记录`); });
    list.append(li);
  });
}

/* ---------------------------------------------------------------- 视频明细 */
function recordMatches(item) {
  if (activeKeyword && !(item.keywords || []).includes(activeKeyword)) return false;
  if (!searchQuery) return true;
  const haystack = [item.title, item.author, item.domainName, item.mediaType, item.collectionTitle, item.subtitle, ...(item.keywords || []), ...(item.tags || [])].join(' ').toLocaleLowerCase();
  return haystack.includes(searchQuery.toLocaleLowerCase());
}

function renderRecords(items) {
  const target = $('#record-list');
  target.replaceChildren();
  setKeywordStatus();
  const matched = items.filter(recordMatches).sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  const visible = matched.slice(0, 30);
  $('#record-count').textContent = `${numberFormat.format(visible.length)} / ${numberFormat.format(matched.length)}`;
  if (!matched.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '当前筛选条件下没有匹配的视频';
    target.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const row = document.createElement('div');
    row.className = 'record-row';

    const head = document.createElement('div');
    head.className = 'record-head';
    const title = document.createElement('a');
    title.className = 'record-title';
    title.textContent = item.title || '(无标题)';
    title.href = videoUrl(item.key);
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    const side = document.createElement('div');
    side.className = 'record-side';
    const count = document.createElement('strong');
    count.className = 'record-count';
    count.textContent = `${numberFormat.format(item.count)} 次`;
    const date = document.createElement('span');
    date.className = 'record-date';
    date.textContent = item.lastTs ? dayInput(item.lastTs) : '时间未知';
    side.append(count, date);
    head.append(title, side);

    const meta = document.createElement('div');
    meta.className = 'record-meta';
    const chips = [];
    if (item.author) chips.push(['chip-author', item.author]);
    if (item.domainName) chips.push(['chip-domain', item.domainName]);
    for (const keyword of (item.keywords || []).slice(0, 2)) chips.push(['chip-keyword', `#${keyword}`]);
    if (item.lastProgress && item.lastProgress !== '0%') chips.push(['chip-progress', `进度 ${item.lastProgress}`]);
    if (`${item.key}`.length <= 16) chips.push(['chip-id', item.key]);
    for (const [className, text] of chips) {
      const chip = document.createElement('span');
      chip.className = `chip ${className}`;
      chip.textContent = text;
      meta.append(chip);
    }
    const snapCount = document.createElement('span');
    snapCount.textContent = `${numberFormat.format(item.snapshots.length)} 条快照`;
    meta.append(snapCount);

    row.append(head, meta);

    if (item.snapshots.length) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'snapshot-toggle';
      const list = document.createElement('ol');
      list.className = 'snapshot-list';
      list.hidden = true;
      const sorted = item.snapshots.slice().sort((a, b) => normalizedTimestamp(b.ts) - normalizedTimestamp(a.ts)).slice(0, 20);
      for (const snap of sorted) {
        const li = document.createElement('li');
        const when = document.createElement('span');
        when.textContent = normalizedTimestamp(snap.ts) ? new Date(normalizedTimestamp(snap.ts)).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
        const info = document.createElement('span');
        const position = snap.watchTimeStr || (snap.pos > 0 ? `${Math.floor(snap.pos / 60)}:${String(Math.floor(snap.pos % 60)).padStart(2, '0')}` : '位置未记录');
        info.textContent = [snap.progress || '', position, snap.completed ? '已看完' : '', snap.source === 'official' ? '官方历史' : snap.source === 'player' ? '播放器记录' : ''].filter(Boolean).join(' · ');
        li.append(when, info);
        list.append(li);
      }
      toggle.textContent = `展开 ${numberFormat.format(item.snapshots.length)} 条观看快照`;
      toggle.addEventListener('click', () => {
        list.hidden = !list.hidden;
        toggle.textContent = `${list.hidden ? '展开' : '收起'} ${numberFormat.format(item.snapshots.length)} 条观看快照`;
      });
      row.append(toggle, list);
    }
    fragment.append(row);
  }
  target.append(fragment);
}

/* ---------------------------------------------------------------- 里程碑 */
function renderMilestones(result) {
  const data = result.milestones;
  $('#peak-day').textContent = data.peakDay ? `${data.peakDay.name} · ${numberFormat.format(data.peakDay.snapshots)} 条` : '无可识别快照';
  $('#peak-day-sub').textContent = '按快照时间统计，不代表观看时长';
  $('#top-replay').textContent = data.topReplay?.title || '无标题记录';
  $('#top-replay-sub').textContent = data.topReplay ? `累计 ${numberFormat.format(data.topReplay.watches)} 次 · ${data.topReplay.author || 'UP 主未填写'}` : '备份中没有可用累计次数';
  $('#earliest-snapshot').textContent = data.earliest?.title || '无可识别快照';
  $('#earliest-sub').textContent = data.earliest ? `${dayInput(data.earliest.ts)} · ${data.earliest.author || 'UP 主未填写'}` : '没有可识别的快照时间';
}

/* ---------------------------------------------------------------- 摘要条 */
function renderPersona(result) {
  const { summary, profile, coverage } = result;
  if (!summary.videos) {
    ui.personaTag.textContent = '✦ 静默观测期';
    ui.personaSummary.textContent = '当前所选时间窗口内没有观看记录，请调整起止日期。';
    return;
  }
  const tagRules = [
    [() => profile.nightRatio >= 30, '✦ 深夜夜航员'],
    [() => profile.topDomain?.name === '音乐', '✦ 单曲循环者'],
    [() => profile.topDomain?.name === '游戏', '✦ 游戏常客'],
    [() => profile.topDomain?.name === '科技数码', '✦ 技术极客'],
    [() => profile.topDomain?.name === '知识科普', '✦ 知识漫游者'],
    [() => profile.topDomain?.name === '影视动漫', '✦ 剧情追踪者'],
    [() => profile.topDomain?.name === '生活娱乐', '✦ 生活观察员']
  ];
  ui.personaTag.textContent = (tagRules.find(([test]) => test()) || [null, '✦ 多元探索者'])[1];
  ui.personaSummary.textContent = [
    `选定周期内涉及 ${numberFormat.format(summary.videos)} 部视频与 ${numberFormat.format(summary.creators)} 位 UP 主`,
    profile.topDomain ? `内容重心是「${profile.topDomain.name}」，累计 ${numberFormat.format(profile.topDomain.watches)} 次` : '没有足够的关键词判定内容重心',
    `22:00–04:00 的快照占 ${profile.nightRatio}%`,
    `内容域归类覆盖 ${coverage.ratio}%`
  ].join('；') + '。';
}

/* ---------------------------------------------------------------- 迷你趋势 */
function renderSparklines(result) {
  const theme = chartTheme();
  const snapshotDays = result.calendarDays;
  const videoDays = new Map(), creatorDays = new Map();
  for (const record of result.records) {
    for (const snap of record.snapshots) {
      const ts = normalizedTimestamp(snap.ts);
      if (!ts) continue;
      const date = dayInput(ts);
      if (!videoDays.has(date)) videoDays.set(date, new Set());
      videoDays.get(date).add(record.key);
      if (record.author) {
        if (!creatorDays.has(date)) creatorDays.set(date, new Set());
        creatorDays.get(date).add(record.author);
      }
    }
  }
  const ranked = result.records.filter(item => item.count > 0).slice().sort((a, b) => a.count - b.count).slice(-18).map(item => item.count);
  const series = [
    [...videoDays].sort(([a], [b]) => a.localeCompare(b)).slice(-26).map(([, set]) => set.size),
    ranked,
    snapshotDays.slice(-26).map(item => item.count),
    [...creatorDays].sort(([a], [b]) => a.localeCompare(b)).slice(-26).map(([, set]) => set.size)
  ];
  const palette = [theme.accent, theme.amber, theme.cyan, theme.violet];
  ['spark-videos', 'spark-watches', 'spark-snapshots', 'spark-creators'].forEach((id, index) => {
    if (!series[index].length) { emptyChart(id, ''); return; }
    setChart(id, {
      animation: false,
      grid: { left: 1, right: 1, top: 4, bottom: 1 },
      xAxis: { type: 'category', show: false, data: series[index].map((_, i) => i) },
      yAxis: { type: 'value', show: false },
      tooltip: { show: false },
      series: [{
        type: 'line', data: series[index], smooth: true, symbol: 'none',
        lineStyle: { color: palette[index], width: 1.6 },
        areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: palette[index] }, { offset: 1, color: 'transparent' }]), opacity: isPaperPalette() ? .14 : .3 }
      }]
    });
  });
}

/* ---------------------------------------------------------------- 汇总渲染 */
function render(result) {
  latestResult = result;
  ui.dashboard.hidden = false;
  if (!ui.dashboard.classList.contains('dashboard-ready')) {
    void ui.dashboard.offsetWidth;
    ui.dashboard.classList.add('dashboard-ready');
  }

  for (const [name, value] of Object.entries(result.summary)) setMetric(ui.metrics[name], value);
  renderTrend(trendMode === 'months' ? result.months : result.calendarDays);
  renderHeatmap(result.hourGrid);
  renderRadar(result.domains, result.coverage);
  renderDonut(result.domains, result.coverage);
  renderNebula(result.terms);
  renderSparklines(result);
  renderCreators(result);
  renderRecords(result.records);
  renderMilestones(result);
  renderPersona(result);

  const { start, end } = selectedRange();
  const low = Math.max(start, dateBounds.min), high = Math.min(end, dateBounds.max);
  const rangeText = start === 0 && end === Infinity
    ? (dateBounds.min ? `${dayInput(dateBounds.min)} — ${dayInput(dateBounds.max)}` : '全部时间 · 无可识别日期')
    : low <= high ? `${dayInput(low)} — ${dayInput(high)}` : '所选范围内没有记录';
  ui.activeRange.textContent = rangeText;
  const printRange = document.getElementById('print-range');
  if (printRange) printRange.textContent = rangeText;
  showStatus(`分析完成：当前范围包含 ${numberFormat.format(result.summary.videos)} 个去重视频、${numberFormat.format(result.summary.snapshots)} 条快照。`);
  // 面板刚从 hidden 变为可见时布局刚建立，等两帧再做一次尺寸校准，避免图画在 0×0 上。
  // 打印流程会自己按纸张宽度重画，这里不能覆盖它。
  if (!printing) requestAnimationFrame(() => requestAnimationFrame(() => charts.forEach(chart => chart.resize())));
  ui.analyze.disabled = false;
  if (printLayoutPending) { printLayoutPending = false; preparePrintLayout(); }
}

/* ---------------------------------------------------------------- 数据流 */
function generate() {
  if (!hasData) return;
  const range = selectedRange();
  if (range.start > range.end) { showStatus('开始日期不能晚于结束日期。', true); return; }
  ui.analyze.disabled = true;
  showStatus('正在按所选时间范围整理数据…');
  worker.postMessage({ type: 'analyze', requestId: ++requestId, ...range });
}

// 一次可以读多个备份：不同日期导出的 JSON 会在这里合并，同一视频的快照取并集、次数取最大。
let rawTexts = [];
let rawNames = [];

function loadFiles(fileList, options = {}) {
  const incoming = [...(fileList || [])].filter(file => file && /\.(json|csv)$/i.test(file.name || ''));
  if (!incoming.length) { showStatus('请选择 JSON 或 CSV 文件。', true); return; }

  // 分批导入：后选的文件是追加而不是覆盖，同一份文件（同名同大小同时间）只算一次。
  if (options.replace) sessionFiles = [];
  const seen = new Set(sessionFiles.map(file => `${file.name}|${file.size}|${file.lastModified}`));
  const added = incoming.filter(file => {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!added.length) {
    showStatus('这几个文件已经在报告里了，没有新增内容。');
    toast('没有新增文件：选的都是已经导入过的那几份');
    return;
  }
  sessionFiles = [...sessionFiles, ...added];
  const files = sessionFiles;

  hasData = false; latestResult = null;
  activeKeyword = ''; searchQuery = ''; ui.search.value = '';
  ui.clearKeyword.hidden = true;
  ui.dashboard.classList.remove('dashboard-ready');
  ui.dashboard.hidden = true;
  ui.analyze.disabled = true;
  ui.range.hidden = true;

  const job = ++requestId;
  rawNames = files.map(file => file.name);
  const totalMb = files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024;
  ui.fileLabel.textContent = files.length === 1 ? files[0].name : `${files.length} 个备份合并`;
  ui.fileBadge.hidden = false;
  const isAppend = files.length > added.length;
  ui.fileMeta.textContent = files.length === 1
    ? `${totalMb.toFixed(2)} MB · 只在本机浏览器中解析`
    : `${isAppend ? `本次追加 ${added.length} 份 · ` : ''}共 ${files.length} 个文件 · ${totalMb.toFixed(2)} MB · 已合并去重`;
  ui.progress.hidden = false; ui.progress.value = 0;
  showStatus('正在本机读取文件…');

  Promise.all(files.map(file => file.text()))
    .then(texts => {
      if (job !== requestId) return;
      rawTexts = texts;
      worker.postMessage({ type: 'load', files: files.map((file, index) => ({ text: texts[index], name: file.name })), filename: files[0].name, requestId: job });
    })
    .catch(error => { if (job === requestId) showStatus(`读取失败：${error.message}`, true); });
}

function loadFile(file, options) { loadFiles([file], options); }

function syncPalette() {
  const theme = document.documentElement.dataset.theme || 'system';
  const paper = theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  const next = paper ? 'paper' : 'space';
  // 两套色阶方向相反：纸本是「越深越多」，观测台是暗底上的「越亮越多」，说明文字得跟着换，不能写死。
  const legendNote = $('#heatmap-legend-note');
  if (legendNote) legendNote.textContent = next === 'paper' ? '格子颜色越深，代表这个时段看得越多。' : '格子颜色越亮，代表这个时段看得越多。';
  if (document.documentElement.dataset.palette === next) return false;
  document.documentElement.dataset.palette = next;
  return true;
}

/* ---------------------------------------------------------------- 事件 */
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => {
    const theme = button.dataset.themeChoice;
    document.documentElement.dataset.theme = theme;
    syncPalette();
    try { localStorage.setItem('history-insights-theme', theme); } catch { /* 仅本次会话生效 */ }
    for (const option of document.querySelectorAll('[data-theme-choice]')) option.setAttribute('aria-pressed', String(option === button));
    if (latestResult) render(latestResult);
  });
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (syncPalette() && latestResult) render(latestResult);
});

ui.file.addEventListener('change', () => { loadFiles(ui.file.files); ui.file.value = ''; });
ui.pick.addEventListener('click', event => { if (event.target !== ui.file) ui.file.click(); });

// 读最新备份：让本地服务在「用户指定过的目录」和默认位置（下载 / 桌面 / 文档 / OneDrive）里找。
async function loadLatestBackup() {
  showStatus('正在查找最新的备份…');
  let info;
  try {
    const response = await fetch('/local/info', { cache: 'no-store' });
    info = await response.json();
  } catch {
    toast('这个入口只在本地服务里可用，双击「一键看报告.cmd」启动后再点', true);
    return;
  }
  if (!info?.found) {
    toast(info?.savedDir
      ? `指定过的目录里没找到备份：${info.savedDir}`
      : '没找到备份文件：先点「指定备份文件夹」选一个长期存放的目录，或把备份放进「下载」文件夹', true);
    showStatus('没找到备份文件，可以指定一个长期存放的文件夹，下次自动用。', true);
    return;
  }
  const latest = await fetch('/local/latest.json', { cache: 'no-store' });
  if (!latest.ok) { toast('读取最新备份失败，请手动选择文件', true); return; }
  const blob = await latest.blob();
  const name = decodeURIComponent(latest.headers.get('X-Backup-Name') || 'history.json');
  const dir = decodeURIComponent(latest.headers.get('X-Backup-Dir') || '');
  loadFiles([new File([blob], name, { type: 'application/json' })], { replace: true });
  toast(`已读入最新备份：${name}${dir ? `（来自 ${dir}）` : ''}`);
}

// 指定备份文件夹：服务端弹原生选择框，选完把路径记进用户配置，下次自动用这个目录。
async function pickBackupDir() {
  toast('请在弹出的小窗口里选择存放备份的文件夹…');
  let result;
  try {
    const response = await fetch('/local/pick', { method: 'POST' });
    result = await response.json();
  } catch {
    toast('这个入口只在本地服务里可用，双击「一键看报告.cmd」启动后再点', true);
    return;
  }
  if (result?.cancelled) { toast('没有选择文件夹'); return; }
  if (!result?.ok) { toast(`没能记住目录：${result?.error || '未知原因'}`, true); return; }
  toast(`已记住备份目录：${result.savedDir}`);
  if (result.found) await loadLatestBackup();
  else toast('这个目录里还没有备份文件，导出后放进来再点「读最新备份」', true);
}

ui.loadLatest?.addEventListener('click', () => loadLatestBackup());
ui.pickDir?.addEventListener('click', () => pickBackupDir());

// ---- 本机备份勾选表：扫到多份时默认只勾最新那份，想合并就多勾几份 ----
let localBackups = [];

function formatBackupMeta(item) {
  const date = new Date(item.mtimeMs);
  const stamp = Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const size = item.size >= 1024 * 1024 ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(item.size / 1024)} KB`;
  return [stamp, size, item.dir].filter(Boolean).join(' · ');
}

function updateLocalCount() {
  const checked = [...ui.localRows.querySelectorAll('input[type="checkbox"]:checked')].length;
  ui.localLoad.disabled = checked === 0;
  ui.localLoad.textContent = checked ? `载入勾选的 ${checked} 份` : '载入勾选的';
}

function renderLocalRows() {
  ui.localRows.textContent = '';
  localBackups.forEach((item, index) => {
    const row = document.createElement('label');
    row.className = 'local-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(index);
    box.checked = index === 0;
    box.addEventListener('change', updateLocalCount);
    const name = document.createElement('span');
    name.className = 'local-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'local-meta';
    meta.textContent = formatBackupMeta(item);
    row.append(box, name, meta);
    ui.localRows.appendChild(row);
  });
  updateLocalCount();
}

async function refreshLocalBackups({ expand = false } = {}) {
  let data;
  try {
    data = await (await fetch('/local/list.json', { cache: 'no-store' })).json();
  } catch {
    return false;
  }
  localBackups = Array.isArray(data?.items) ? data.items : [];
  if (!localBackups.length) {
    ui.listBackups.hidden = true;
    ui.localList.hidden = true;
    return false;
  }
  ui.listBackups.hidden = false;
  ui.listCount.textContent = String(localBackups.length);
  renderLocalRows();
  if (expand) ui.localList.hidden = false;
  return true;
}

// 把勾中的几份取回来，走和「选文件」完全一样的导入与合并路径
async function loadCheckedBackups() {
  const picked = [...ui.localRows.querySelectorAll('input[type="checkbox"]:checked')]
    .map(box => localBackups[Number(box.value)])
    .filter(Boolean);
  if (!picked.length) { toast('先勾上至少一份备份再用这个按钮'); return; }
  ui.localLoad.disabled = true;
  showStatus(`正在读取 ${picked.length} 份本机备份…`);
  const files = [];
  for (const item of picked) {
    try {
      const response = await fetch(`/local/backup?path=${encodeURIComponent(item.file)}`, { cache: 'no-store' });
      if (!response.ok) continue;
      const blob = await response.blob();
      const name = decodeURIComponent(response.headers.get('X-Backup-Name') || item.name);
      files.push(new File([blob], name, { type: 'application/json', lastModified: Math.round(item.mtimeMs) }));
    } catch {
      /* 单份读失败就跳过，其余继续 */
    }
  }
  if (!files.length) { showStatus('这几份备份都读不出来，可以改用「选文件」手动挑', true); updateLocalCount(); return; }
  loadFiles(files, { replace: true });
  updateLocalCount();
  toast(files.length === 1 ? `已读入：${files[0].name}` : `已读入并合并 ${files.length} 份本机备份`);
}

ui.listBackups?.addEventListener('click', async () => {
  if (!localBackups.length) await refreshLocalBackups();
  if (!localBackups.length) { toast('还没扫到备份文件'); return; }
  ui.localList.hidden = !ui.localList.hidden;
});
ui.localAll?.addEventListener('click', () => {
  ui.localRows.querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = true; });
  updateLocalCount();
});
ui.localNone?.addEventListener('click', () => {
  ui.localRows.querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = false; });
  updateLocalCount();
});
ui.localLoad?.addEventListener('click', () => loadCheckedBackups());
// 点已导入文件的徽标，也能展开这张表，看看本机还有哪几份没勾上
ui.fileBadge?.addEventListener('click', async () => {
  const has = localBackups.length ? true : await refreshLocalBackups();
  if (!has) { toast('这台机器上没扫到别的备份'); return; }
  ui.localList.hidden = false;
});

// 直接双击 html（file://）时，读备份 / 指定目录 / 导出都依赖本地服务，先把入口说清楚，别点了才报错。
const offlineMode = location.protocol === 'file:';
if (offlineMode) {
  const note = $('#offline-note');
  if (note) note.hidden = false;
  for (const id of ['load-latest', 'pick-dir', 'list-backups', 'export-poster', 'print-report']) {
    const el = $('#' + id);
    if (!el) continue;
    el.disabled = true;
    el.title = '离线打开：需要本地服务，请用桌面「观看报告」快捷方式';
  }
}
// 一进页面就把本机扫到的备份数标出来，多份的时候用户一眼能看到还能挑
if (!offlineMode) refreshLocalBackups();
ui.analyze.addEventListener('click', generate);
$('#export-poster').addEventListener('click', () => requestExport('png'));
$('#print-report').addEventListener('click', () => requestExport('pdf'));

ui.search.addEventListener('input', () => { searchQuery = ui.search.value.trim(); if (latestResult) renderRecords(latestResult.records); });
ui.clearKeyword.addEventListener('click', () => {
  activeKeyword = '';
  ui.search.value = '';
  searchQuery = '';
  setKeywordStatus();
  if (latestResult) { renderNebula(latestResult.terms); renderRecords(latestResult.records); }
  toast('已重置关键词筛选');
});

for (const button of document.querySelectorAll('[data-trend-choice]')) {
  button.addEventListener('click', () => {
    trendMode = button.dataset.trendChoice;
    for (const option of document.querySelectorAll('[data-trend-choice]')) option.setAttribute('aria-pressed', String(option === button));
    if (latestResult) renderTrend(trendMode === 'months' ? latestResult.months : latestResult.calendarDays);
  });
}

for (const button of document.querySelectorAll('[data-range]')) {
  button.addEventListener('click', () => {
    const range = button.dataset.range;
    const end = dateBounds.max;
    let start = '';
    if (range !== 'all') { const startDate = new Date(end); startDate.setDate(startDate.getDate() - Number(range) + 1); start = dayInput(Math.max(dateBounds.min, startDate.getTime())); }
    ui.start.value = start; ui.end.value = range === 'all' ? '' : dayInput(end);
    for (const option of document.querySelectorAll('[data-range]')) option.setAttribute('aria-pressed', String(option === button));
    if (hasData) { showStatus('已切换观测时间窗口'); generate(); }
  });
}
for (const input of [ui.start, ui.end]) input.addEventListener('change', () => { for (const button of document.querySelectorAll('[data-range]')) button.setAttribute('aria-pressed', 'false'); });

ui.drop.addEventListener('dragover', event => { event.preventDefault(); ui.drop.classList.add('dragging'); });
ui.drop.addEventListener('dragleave', event => { if (!ui.drop.contains(event.relatedTarget)) ui.drop.classList.remove('dragging'); });
ui.drop.addEventListener('drop', event => {
  event.preventDefault();
  ui.drop.classList.remove('dragging');
  const files = [...event.dataTransfer.files];
  if (files.some(item => /\.(json|csv)$/i.test(item.name))) loadFiles(files); else showStatus('请选择 JSON 或 CSV 文件。', true);
});

worker.addEventListener('message', event => {
  const message = event.data;
  if (message.requestId !== requestId) return;
  if (message.type === 'progress') { showStatus(message.message); if (!ui.progress.hidden) ui.progress.value = message.value; return; }
  if (message.type === 'error') { showStatus(message.message, true); ui.analyze.disabled = false; ui.progress.hidden = true; return; }
  if (message.type === 'loaded') {
    hasData = true;
    dateBounds = message.range;
    ui.range.hidden = false;
    ui.start.min = ui.end.min = dayInput(dateBounds.min);
    ui.start.max = ui.end.max = dayInput(dateBounds.max);
    ui.start.value = ui.end.value = '';
    ui.progress.hidden = true;
    ui.fileMeta.textContent = `${numberFormat.format(message.recordCount)} 个视频条目 · 可用时间 ${dayInput(dateBounds.min) || '无'} 至 ${dayInput(dateBounds.max) || '无'}${message.files > 1 ? ` · 已合并 ${message.files} 个备份，去重 ${numberFormat.format(message.duplicates || 0)} 条` : ''}`;
    ui.analyze.disabled = false;
    showStatus('数据已读入本机。正在生成全时间范围的分析…');
    if (message.files > 1) toast(`已合并 ${message.files} 个备份并去重 ${numberFormat.format(message.duplicates || 0)} 条重复记录`);
    generate();
  }
  if (message.type === 'analysis') render(message.result);
});

/* ---------------------------------------------------------------- 导出 */
// 导出不在当前页面上重排一遍：把原始数据发给本地服务，由它另开一个干净的浏览器去渲染。
// 好处是页面不抖、不带插件挂件，暗色也能原样导出。多个备份交给服务端合并后再渲染。

function exportTheme() {
  return document.documentElement.dataset.palette === 'space' ? 'dark' : 'light';
}

async function requestExport(kind) {
  if (!latestResult) { toast('先导入观看历史，再导出'); return; }
  if (!rawTexts.length) { toast('读不到原始文件内容，请重新导入一次'); return; }
  toast(kind === 'pdf' ? '正在生成 PDF…' : '正在生成长图…');
  let response;
  try {
    response = await fetch(`/export/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: rawTexts, names: rawNames, filename: rawNames[0], theme: exportTheme(), width: 1440 })
    });
  } catch (error) {
    toast(`导出失败：${error.message}`, true);
    return;
  }
  if (!response.ok) {
    toast(`导出失败：${(await response.text()).slice(0, 140)}`, true);
    return;
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `history-insights-${new Date().toISOString().slice(0, 10)}.${kind}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  toast(kind === 'pdf' ? 'PDF 已生成并下载' : '长图已生成并下载');
}

/* ---------------------------------------------------------------- 打印排版 */
// 只有服务端渲染 PDF 时会以 ?print=1 打开这个页面，这里按 A4 内容宽（约 660px）重画图表。
// A4 纵向、12mm 页边距 → 内容宽 186mm ≈ 703px；面板左右内边距 5mm 后约 660px。
const PRINT_CHART_WIDTH = 660;
const PRINT_CHART_HEIGHTS = { 'trend-chart': 224, 'heatmap-chart': 211, 'radar-chart': 222, 'type-chart': 222 };

function preparePrintLayout() {
  printing = true;
  if (latestResult) render(latestResult);
  requestAnimationFrame(() => {
    for (const [id, height] of Object.entries(PRINT_CHART_HEIGHTS)) {
      charts.get(id)?.resize({ width: PRINT_CHART_WIDTH, height });
    }
  });
}

initCharts();
setKeywordStatus();
// 一开始就得对齐一次：主题可能来自 localStorage（head 里已经写好 data-theme），
// 这时不调 syncPalette 的话，热力图说明会停在默认的纸本说法。
syncPalette();

// 开发辅助：?autoload=/path/to/backup.json 可跳过手动选文件，便于自动化验证导出与打印。
// ?theme=light|dark 让导出用的浏览器进程按指定主题渲染。
const themeParam = new URLSearchParams(location.search).get('theme');
if (themeParam === 'light' || themeParam === 'dark') {
  document.documentElement.dataset.theme = themeParam;
  syncPalette();
}
const autoloadPath = new URLSearchParams(location.search).get('autoload');
const autoloadName = new URLSearchParams(location.search).get('name');
if (autoloadPath === '/local/latest.json') {
  loadLatestBackup();
} else if (autoloadPath) {
  fetch(autoloadPath)
    .then(response => (response.ok ? response.blob() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then(blob => loadFile(new File([blob], autoloadName || autoloadPath.split('/').pop() || 'history.json', { type: 'application/json' }), { replace: true }))
    .catch(error => showStatus(`自动载入失败：${error.message}`, true));
}
