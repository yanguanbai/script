// 文档卫生检查：git 跟踪的 *.md / *.txt 里不允许出现控制字符。
// 起因：用 PowerShell 双引号字符串拼中文段落时，`t / `v 会被当成转义，
// 结果在 README 里留下 TAB / VT——渲染出来是"丢掉一个字符"或一个方块。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 以仓库根为准，不依赖运行时的工作目录
const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

const files = execSync('git ls-files "*.md" "*.txt"', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map(l => l.trim().replace(/^"|"$/g, ''))
  .filter(Boolean);

const bad = /[\u0000-\u0008\u0009\u000B\u000C\u000E-\u001F\u007F]/;
let problems = 0;

for (const rel of files) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (bad.test(line)) {
      const codes = [...line].filter(ch => bad.test(ch)).map(ch => '0x' + ch.codePointAt(0).toString(16).padStart(2, '0'));
      console.error(`${rel}:${i + 1}: 控制字符 ${codes.join(', ')}`);
      problems++;
    }
  });
}

if (problems) {
  console.error(`\n发现 ${problems} 处控制字符。多半是把反引号后面的 t / v 当成转义了，改成单引号字符串或 here-string 重新写。`);
  process.exit(1);
}

console.log(`文档控制字符检查通过（${files.length} 个文件）。`);
