// 把 dev 版（index.html + css + echarts + worker 模块）打包成一个可以直接双击打开的单文件网页。
// 打包目标：不装 Node、不开终端、不联网，双击 观看报告.html 拖入备份就能出报告。
// 模块被打包进 worker 的字符串里运行，所以 file:// 下也能用（file:// 不允许单独加载 worker 文件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

// ESM 源码 -> 普通表达式：去掉 import / export 语法，靠函数作用域传递依赖。
function unbundle(code) {
  return code
    .replace(/^import\s[^;]*?from\s*'[^']*';\s*\r?\n/gm, '')
    .replace(/^export\s*\{[\s\S]*?\};\s*\r?\n/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|var|class)/gm, '')
    .replace(/^export\s+default\s+/gm, 'return ');
}

const segmentit = unbundle(read('vendor/segmentit.mjs'));
const domains = unbundle(read('content-domains.mjs'));
const analytics = unbundle(read('analytics.mjs'));
const workerBody = unbundle(read('worker.js'));

const workerSource = `
const { Segment, useDefault } = (function () {
${segmentit}
return { Segment, useDefault };
})();
const { DOMAINS, classifyContent, domainFromMediaType } = (function () {
${domains}
return { DOMAINS, classifyContent, domainFromMediaType };
})();
const { analyze, loadHistory, mergeHistories } = (function () {
${analytics}
return { analyze, loadHistory, mergeHistories };
})();
${workerBody}
`;

const css = read('observatory.css');
const echarts = read('vendor/echarts.min.js');
const app = read('app.js');

// 单文件版没有本地服务：worker 改成 Blob，导出/PDF 按钮降级为提示。
// 替换文本必须用函数返回：第三方代码里含 $ 序列，直接当字符串会被 replace 当成替换模式。
const appStandalone = app
  .replace(
    "const worker = new Worker('./worker.js', { type: 'module' });",
    () => `const workerSource = ${JSON.stringify(workerSource)};
const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));`
  )
  .replace(
    "const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;",
    () => `const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const standalone = location.protocol === 'file:';`
  );

// 单文件版里 app 是普通脚本（不再有 type=module 的延迟执行），所以包进 DOMContentLoaded 里，等到元素都在再接线。
const html = read('index.html')
  .replace('<link rel="stylesheet" href="./observatory.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script defer src="./vendor/echarts.min.js"></script>', () => `<script>\n${echarts}\n</script>`)
  .replace('<script type="module" src="./app.js"></script>', () => `<script>\ndocument.addEventListener('DOMContentLoaded', () => {\n${appStandalone}\n});\n</script>`);

const out = path.join(root, '观看报告.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${path.relative(process.cwd(), out)}（${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB）`);
