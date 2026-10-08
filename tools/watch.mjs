/**
 * 开发用文件监听：node tools/watch.mjs
 *
 * 解决什么痛点——
 * 改完代码要手动去 edge://extensions 点"刷新"，一天点几十次。
 * 这个脚本监听源码变化，然后通知扩展自己调用 chrome.runtime.reload()。
 *
 * 为什么不用轮询改文件时间戳——
 * service worker 读不到任意本地文件，只能访问扩展目录内的资源。
 * 所以走一个本机 HTTP 服务：脚本改了文件就把"代号"加一，扩展定期来问一句
 * "代号变了吗"，变了就重载自己。额外好处是这个服务同时充当"活着"的开关，
 * 关掉脚本扩展就自动停止轮询，不会平白唤醒后台。
 *
 * 为什么不用 WebSocket——
 * MV3 的 service worker 会被回收，长连接要在重连与心跳上写不少代码，
 * 而这里只要一个"变了没"的信号，HTTP 足够且更省事。
 *
 * 边界（重要）：
 *   · manifest.json 的改动需要浏览器重新解析清单，本脚本做不到，仍需手动刷新。
 *   · 内容脚本（src/content/、src/ui/）只对**新加载的页面**生效，
 *     已经开着的标签页要刷新一下才会用上新代码。
 *
 * 用法：
 *   node tools/watch.mjs              监听并自动重载
 *   node tools/watch.mjs --port 4000  换端口（需同时改 src/core/constants.js 的 DEV_PORT）
 *   node tools/watch.mjs --once       只发一次信号后退出（给 CI/脚本用）
 */

import { watch, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(flagValue('--port', '3199'));
const DEBOUNCE_MS = 350;

/** 监听范围：扩展实际加载的东西 + 清单。刻意不含 tools/ 与 dist/。 */
const WATCH_FILES = ['manifest.json'];
const WATCH_DIRS = ['src', 'assets'];

let token = 1;
let lastReason = '启动';
let timer = null;

const json = (res, body, code = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // 别让浏览器缓存这个"变了没"的答复
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/ping') return json(res, { ok: true, watching: true });
  if (url.pathname === '/token') return json(res, { token, reason: lastReason });
  return json(res, { ok: false, error: '未知路径' }, 404);
});

/** 递归监听目录（fs.watch 的 recursive 在 Windows/macOS 上可用）。 */
function attachWatchers() {
  for (const rel of WATCH_DIRS) {
    const target = path.join(ROOT, rel);
    try {
      watch(target, { recursive: true }, (_event, filename) => bump(`${rel}/${filename || ''}`));
    } catch (err) {
      console.warn(`  无法监听 ${rel}：${err.message}`);
    }
  }
  for (const rel of WATCH_FILES) {
    try {
      watch(path.join(ROOT, rel), () => bump(rel));
    } catch (err) {
      console.warn(`  无法监听 ${rel}：${err.message}`);
    }
  }
}

/** 防抖：编辑器保存经常连着触发好几次。 */
function bump(reason) {
  lastReason = reason;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    token += 1;
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`  [${stamp}] 变更 → 代号 ${token}   (${reason})`);
  }, DEBOUNCE_MS);
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else if (entry.isFile()) n += 1;
  }
  return n;
}

if (argv.includes('--once')) {
  console.log('—— 语滴监听（--once：只发一次信号）——');
  console.log(`代号 ${token}`);
  process.exit(0);
}

console.log('—— 语滴开发监听 ——');
console.log(`地址    ：http://127.0.0.1:${PORT}`);
console.log(`监听    ：${[...WATCH_FILES, ...WATCH_DIRS].join('、')}`);
let watched = 0;
for (const rel of WATCH_DIRS) {
  try {
    watched += countFiles(path.join(ROOT, rel));
  } catch {
    /* 目录不存在就算了 */
  }
}
console.log(`文件数  ：约 ${watched} 个`);
console.log('停止    ：Ctrl+C');
console.log('');
console.log('接下来（只需做一次）：');
console.log('  1. 设置页 → 入口 → 勾上「开发时自动重载」');
console.log('  2. 之后改代码，扩展会自己刷新');
console.log('');
console.log('注意：manifest.json 的改动必须手动去 edge://extensions 刷新；');
console.log('      内容脚本的改动要刷新页面才会生效。');
console.log('');

attachWatchers();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 已开始监听，等待变更…`);
});

process.on('SIGINT', () => {
  console.log('\n已停止监听。');
  server.close();
  process.exit(0);
});
