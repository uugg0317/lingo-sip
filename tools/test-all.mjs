/** 零依赖回归入口：核心逻辑与所有独立自测分别在隔离 Node 进程中运行。 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const files = ['selftest.js', ...readdirSync(directory).filter((name) => name.endsWith('-selftest.mjs')).sort()];
for (const file of files) {
  const result = spawnSync(process.execPath, [join(directory, file)], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(`自测失败：${file}${result.error ? `：${result.error.message}` : ''}`);
    process.exit(1);
  }
}
console.log(`全部 ${files.length} 个回归套件通过。真实浏览器另用 npm run test:browser 验收。`);
