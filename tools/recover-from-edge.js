/**
 * 从明确指定的 Edge / Chrome 扩展存储目录中导出一份本地备份。
 * 未打包扩展的路径改变后可能产生新的扩展 ID。优先使用设置页正常导出。
 * 此工具只尝试读取 LevelDB 的 .log 文件，无法保证恢复所有被压缩或删除的数据。
 * 请先关闭浏览器或使用存储目录副本；输出可能含个人数据，不要提交到仓库。
 *
 * 用法（兼容原有位置参数）：
 *   node tools/recover-from-edge.js "<存储桶目录>" ["<输出文件>"]
 *   node tools/recover-from-edge.js --extension-id=<ID> --profile=Default --browser=edge
 *   node tools/recover-from-edge.js --help
 *
 * Windows 用户数据目录从 LOCALAPPDATA 推导，Profile 默认为 Default。
 * 可使用 LINGO_SIP_PROFILE / LINGO_SIP_BROWSER / LINGO_SIP_USER_DATA_DIR 配置；
 * 扩展 ID 或存储桶也可用 LINGO_SIP_EXTENSION_ID / LINGO_SIP_BUCKET 明确指定。
 * 不会自动扫描或选择任何扩展存储桶。
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function usage() {
  console.log([
    '用法：node tools/recover-from-edge.js "<存储桶目录>" ["<输出文件>"]',
    '   或：node tools/recover-from-edge.js --extension-id=<ID> [选项]',
    '',
    '--browser=edge|chrome     浏览器类型，默认 edge',
    '--profile=<名称>          浏览器 Profile，默认 Default',
    '--user-data-dir=<目录>    显式指定浏览器用户数据根目录',
    '--output=<文件>           输出备份文件',
    '--help                    仅显示说明，不读取浏览器数据',
    '',
    '环境变量：LINGO_SIP_BROWSER、LINGO_SIP_PROFILE、LINGO_SIP_USER_DATA_DIR、',
    '          LINGO_SIP_EXTENSION_ID、LINGO_SIP_BUCKET、LINGO_SIP_OUTPUT',
    '命令行参数优先于环境变量。未提供存储桶或扩展 ID 时不读取数据。',
  ].join('\n'));
}

function parseArguments(args) {
  const flags = {};
  const positional = [];
  const allowed = new Set(['browser', 'profile', 'user-data-dir', 'extension-id', 'output']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (arg === '--help') { flags.help = true; continue; }
    const separator = arg.indexOf('=');
    const name = arg.slice(2, separator < 0 ? undefined : separator);
    if (!allowed.has(name)) throw new Error('未知选项：--' + name);
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
    if (!value || value.startsWith('--')) throw new Error('选项缺少值：--' + name);
    flags[name] = value;
  }
  if (positional.length > 2) throw new Error('最多接收存储桶和输出文件两个位置参数。');
  return { flags, positional };
}

let bucket;
let outFile;
try {
  const { flags, positional } = parseArguments(process.argv.slice(2));
  if (flags.help) { usage(); process.exit(0); }
  const env = process.env;
  const extensionId = flags['extension-id'] || env.LINGO_SIP_EXTENSION_ID;
  bucket = positional[0] || (flags['extension-id'] ? undefined : env.LINGO_SIP_BUCKET);
  outFile = flags.output || positional[1] || env.LINGO_SIP_OUTPUT || path.join(process.cwd(), 'lingo-sip-recovered-backup.json');
  if (!bucket && extensionId) {
    const browser = flags.browser || env.LINGO_SIP_BROWSER || 'edge';
    const profile = flags.profile || env.LINGO_SIP_PROFILE || 'Default';
    if (!['edge', 'chrome'].includes(browser)) throw new Error('browser 必须是 edge 或 chrome。');
    if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('扩展 ID 必须是 32 位浏览器扩展标识符。');
    if (/[\\/]/.test(profile) || profile === '.' || profile === '..') throw new Error('profile 必须是单个目录名称。');
    let userDataDir = flags['user-data-dir'] || env.LINGO_SIP_USER_DATA_DIR;
    if (!userDataDir) {
      if (!env.LOCALAPPDATA) throw new Error('无法推导用户数据目录，请提供 --user-data-dir。');
      userDataDir = path.join(env.LOCALAPPDATA, ...(browser === 'edge'
        ? ['Microsoft', 'Edge', 'User Data'] : ['Google', 'Chrome', 'User Data']));
    }
    bucket = path.join(userDataDir, profile, 'Local Extension Settings', extensionId);
  }
  if (!bucket) { usage(); process.exit(1); }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

/* 1. 收集 LevelDB 的数据日志。
      Chrome/Edge 把 chrome.storage.local 存在 LevelDB 里，最新的写入都在 .log 文件里。
      同目录下那个叫 "LOG" 的文件是 LevelDB 自己的运行日志，不含数据，所以按 .log 后缀过滤。 */
const files = readdirSync(bucket)
  .filter((f) => f.endsWith('.log'))
  .sort();
if (files.length === 0) {
  console.error(`目录里没有 .log 文件：${bucket}`);
  process.exit(1);
}

// 2. 按文件名顺序拼接（写入是按时间顺序追加的，越靠后越新）
const buf = Buffer.concat(files.map((f) => readFileSync(path.join(bucket, f))));

/* 3. 找出所有 lingoSip 记录的起点，从最后一个往回试。
      最后一次写入有可能是残缺的（比如浏览器正在写就被关掉了），
      所以解析失败就往前退一条，而不是直接报错退出。 */
const KEY = Buffer.from('lingoSip', 'utf8');
const hits = [];
for (let i = 0; i <= buf.length - KEY.length; i += 1) {
  if (buf.compare(KEY, 0, KEY.length, i, i + KEY.length) === 0) hits.push(i);
}
if (hits.length === 0) {
  console.error('这份存储里没有 lingoSip 记录，可能不是本扩展的数据。');
  process.exit(1);
}

/** 从 from 开始做花括号配对，返回完整 JSON 对象的结束位置（不含）。 */
function findJsonEnd(start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i += 1) {
    const c = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b) depth += 1;
    else if (c === 0x7d) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

let state = null;
let used = 0;
for (let k = hits.length - 1; k >= 0; k -= 1) {
  // 键后面跟着 2 个字节的写入序列号，跳过它们再找 JSON 的左花括号
  let start = hits[k] + KEY.length;
  while (start < buf.length && buf[start] !== 0x7b) start += 1;
  const end = findJsonEnd(start);
  if (end < 0) continue;
  try {
    const parsed = JSON.parse(buf.slice(start, end).toString('utf8'));
    if (parsed && parsed.settings && parsed.progress) {
      state = parsed;
      used = k;
      break;
    }
  } catch {
    /* 这条残缺，往前退一条再试 */
  }
}

if (!state) {
  console.error(`找到 ${hits.length} 条记录，但没有一条能完整解析出来。`);
  process.exit(1);
}

// 4. 写成设置页认得的备份格式：{ app, version, exportedAt, state }
const backup = {
  app: 'lingo-sip',
  version: state.version || 1,
  exportedAt: Date.now(),
  state,
};
writeFileSync(outFile, JSON.stringify(backup, null, 2), 'utf8');

// 5. 汇报抢救结果
const learned = Object.keys(state.progress || {}).length;
const days = Object.keys(state.stats || {}).length;
const custom = (state.customWords || []).length;
const lastSeen = state.runtime?.lastShownAt
  ? new Date(state.runtime.lastShownAt).toLocaleString('zh-CN')
  : '(无记录)';

console.log(`已恢复 -> ${outFile}`);
console.log(`  来源：第 ${used + 1} / ${hits.length} 条记录（从最新往回找）`);
console.log(`  学过 ${learned} 个词，有 ${days} 天统计，自定义词条 ${custom} 条`);
console.log(`  最近一次展示：${lastSeen}`);
console.log('');
console.log('接下来：在新扩展的设置页底部点「导入备份」，选中上面这个文件。');
