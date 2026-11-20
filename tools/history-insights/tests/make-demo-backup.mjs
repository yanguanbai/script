// 生成一份“合成”的观看历史备份，用来出演示截图 / PDF。
// 里面的 UP 主、视频标题、时间全是编的，跟任何人的真实记录无关，可以放心提交到仓库。
// 用法：node tests/make-demo-backup.mjs <输出路径>（默认 tests/fixtures/demo-history.json）
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, 'fixtures', 'demo-history.json');

// 固定种子：每次生成的演示数据完全一样，截图才能复现
function random(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = random(20261120);
const pick = list => list[Math.floor(rnd() * list.length)];
const between = (min, max) => min + Math.floor(rnd() * (max - min + 1));

const domains = [
  {
    type: '音乐', tags: ['音乐', '钢琴', '现场'], weight: 0.22,
    words: ['夜航电台', '旧磁带计划', '不插电现场', '城市民谣铺', '合成器实验室', '慢速弦乐'],
    titles: ['深夜钢琴练习曲', '雨天的城市民谣', '合成器与心跳', '现场版《候鸟》', '一小时纯乐器', '凌晨的歌单整理']
  },
  {
    type: '游戏', tags: ['游戏', '单机', '攻略'], weight: 0.2,
    words: ['旧存档', '像素工坊', '深夜开黑', '帧数实验室'],
    titles: ['第一章通关实录', '隐藏结局全收集', '这个机制有点意思', '两小时速通挑战', '复盘：为什么总是输', '我在游戏里造了座城']
  },
  {
    type: '知识科普', tags: ['知识', '科普', '历史'], weight: 0.18,
    words: ['冷知识仓库', '慢速讲解', '图纸与齿轮', '历史切片'],
    titles: ['为什么会有四季', '一张图看懂货币史', '空气里到底有什么', '从齿轮到发动机', '数学里最漂亮的证明', '海洋有多深']
  },
  {
    type: '科技数码', tags: ['科技', '数码', '评测'], weight: 0.14,
    words: ['桌面整理局', '参数党', '拆机日记', '效率研究所'],
    titles: ['这台小机器值不值', '拆开看看里面的结构', '我的桌面工作流', '键盘手感横向对比', '续航实测一周', '把旧设备重新用起来']
  },
  {
    type: '影视动漫', tags: ['影视', '动画', '解说'], weight: 0.16,
    words: ['光影档案', '分镜笔记', '动画观察', '剪辑台'],
    titles: ['三分钟看完这一季', '这个镜头为什么要这样拍', '剧场版剧情梳理', '分镜里的伏笔', '结局到底什么意思', '一部被低估的老片']
  },
  {
    type: '生活娱乐', tags: ['生活', '美食', '旅行'], weight: 0.1,
    words: ['厨房手记', '周末出走', '一屋一饭', '慢生活频道'],
    titles: ['一个人的晚饭', '周末去了趟海边', '整理房间的下午', '煮一锅汤的时间', '走路三小时看到的', '换季收纳清单']
  }
];

const creators = new Set();
for (const domain of domains) for (const word of domain.words) {
  for (const suffix of ['频道', '工作室', '记录', '局', '手记', '档案', '研究所', '计划']) {
    if (rnd() < 0.35) creators.add(`${word}${suffix}`);
  }
  for (const word of domain.words) creators.add(word);
}

// 一年里 1 月 1 日到 11 月 19 日，观看集中在晚上和周末（这样热力图才有形状）
const start = new Date('2026-01-01T00:00:00+08:00').getTime();
const end = new Date('2026-11-19T23:59:00+08:00').getTime();
const records = {};
let created = 0;

for (let month = 0; month < 11; month++) {
  const count = between(150, 190);
  for (let index = 0; index < count; index++) {
    const domain = (() => {
      let value = rnd();
      for (const item of domains) { value -= item.weight; if (value <= 0) return item; }
      return domains[domains.length - 1];
    })();
    const key = `BV1demo${String(created).padStart(6, '0')}`;
    // 留一小部分“看不出内容”的记录：真实备份里总有这种，覆盖率才不会被演示数据做成 100%
    const blank = rnd() < 0.12;
    const authorName = pick([...creators]);
    const watches = rnd() < 0.18 ? between(3, 9) : 1;
    const snapshots = [];
    let latest = 0;
    for (let watch = 0; watch < watches; watch++) {
      const time = between(start, end);
      latest = Math.max(latest, time);
      snapshots.push({ ts: Math.floor(time / 1000), pos: between(10, 900), progress: `${between(10, 100)}%` });
    }
    records[key] = {
      data: {
        key,
        title: blank ? `片段 ${String(created).padStart(4, '0')}` : pick(domain.titles),
        authorName,
        mediaType: blank ? '视频' : rnd() < 0.08 ? pick(['番剧', '纪录片', '电影']) : '视频',
        mediaTags: blank ? [] : domain.tags,
        lastTs: Math.floor(latest / 1000),
        watchCount: watches,
        snapshots: snapshots.slice(0, 5)
      }
    };
    created++;
  }
}

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ format: 'bvh-history-backup', version: 2, generatedAt: new Date('2026-11-19T23:59:00+08:00').toISOString(), demo: true, records }, null, 0), 'utf8');

let totalSnapshots = 0;
for (const record of Object.values(records)) totalSnapshots += record.data.snapshots.length;
console.log(`已生成演示备份：${out}`);
console.log(`视频 ${Object.keys(records).length} 个，快照 ${totalSnapshots} 条，UP 主 ${creators.size} 个（全部为合成数据）`);
