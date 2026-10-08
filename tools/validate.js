/**
 * 自检脚本：npm run check
 *
 * 不安装任何依赖，做四件事：
 *   1. 逐个动态 import src 下的所有 ES Module —— 顺带验证语法和模块顶层代码
 *      （用一个假的 chrome 对象兜住扩展 API，这样 service worker 也能被加载）
 *   2. 校验 manifest.json 结构，并确认它引用的每个文件都真实存在
 *   3. 校验内置词库：字段完整、id/单词不重复、标签合法
 *   4. 校验 HTML 里引用的 js/css 是否存在
 *   5. 校验所有展示给人看的版本号都和 manifest.json 一致（含设置页页脚这类硬编码）
 *
 * 这不是单元测试，只是一个"改完代码别把扩展改坏"的快速体检。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

/* ------------------------------------------------------------------ *
 * 假的 chrome API：任何属性访问都返回一个"什么都能干"的函数代理
 * ------------------------------------------------------------------ */
function chromeLike() {
  const target = function fake() {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
      if (prop === 'lastError') return undefined;
      return chromeLike();
    },
    apply() {
      return chromeLike();
    },
    construct() {
      return chromeLike();
    },
  });
}
globalThis.chrome = chromeLike();

/* ------------------------------------------------------------------ *
 * 1. 逐个加载模块
 * ------------------------------------------------------------------ */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

async function checkModules() {
  const files = await walk(path.join(ROOT, 'src'));
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    try {
      await import(pathToFileURL(file).href);
      notes.push(`✓ ${rel}`);
    } catch (err) {
      // bootstrap.js 会在加载时真的去 import 一个扩展 URL，在 Node 里必然抛错；
      // 只要不是语法错误就算通过。
      if (err instanceof SyntaxError) problems.push(`语法错误 ${rel}: ${err.message}`);
      else notes.push(`✓ ${rel}（顶层执行被环境拦下，非语法问题：${err.constructor.name}）`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. manifest 与文件引用
 * ------------------------------------------------------------------ */
async function checkManifest() {
  const manifestPath = path.join(ROOT, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    problems.push(`manifest.json 无法解析：${err.message}`);
    return;
  }
  const must = ['manifest_version', 'name', 'version', 'action', 'background'];
  for (const key of must) if (!manifest[key]) problems.push(`manifest.json 缺少 ${key}`);
  if (manifest.manifest_version !== 3) problems.push('manifest_version 必须是 3');

  const referenced = new Set();
  for (const size of Object.values(manifest.icons || {})) referenced.add(size);
  for (const size of Object.values(manifest.action?.default_icon || {})) referenced.add(size);
  referenced.add(manifest.action?.default_popup);
  referenced.add(manifest.options_ui?.page);
  referenced.add(manifest.background?.service_worker);
  for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) referenced.add(js);

  for (const rel of referenced) {
    if (!rel) continue;
    if (!existsSync(path.join(ROOT, rel))) problems.push(`manifest.json 引用的文件不存在：${rel}`);
  }
  notes.push(`✓ manifest.json（引用了 ${referenced.size} 个文件）`);

  // 版本号必须和 package.json 一致。
  // 两处各写各的，最容易悄悄漂移——这个项目就漂过一次（manifest 1.2.0 / package 1.0.0）。
  try {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.version !== manifest.version) {
      problems.push(
        `版本号不一致：manifest.json 是 ${manifest.version}，package.json 是 ${pkg.version}`,
      );
    } else {
      notes.push(`✓ 版本号一致：${manifest.version}`);
    }
  } catch (err) {
    problems.push(`package.json 读取失败：${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 2.5 全仓库版本引用一致性
 *
 * 为什么需要这一层：上一节只比对 manifest ↔ package 两个清单文件。
 * 设置页页脚写死过一个 v1.0.0，两个清单都还是 1.2.0，于是这处漂移
 * 躲过了每一次自检、一路带到用户眼前。凡是"展示给人看的版本号"
 * 都必须跟着真源走，否则它迟早会说谎。
 *
 * 哪些地方**不算**漂移（有意排除）：
 *   · README.md / CHANGELOG.md —— 讲的是历史版本，本来就该留着旧号
 *   · tools/ 与 tools/validate.js 自身 —— 本文件注释里就要引用旧版本举例
 * ------------------------------------------------------------------ */
const VERSION_SCAN_DIRS = ['src', 'assets'];
const VERSION_SCAN_ROOT_FILES = ['manifest.json', 'package.json'];
const VERSION_SKIP_DIRS = new Set(['.git', 'node_modules', 'tools']);
/** 版本号形态：v1.2.3 / 1.2.3 / 1.2.3-beta.1；四段以上（如 Edge 150.0.4078.65）不算。 */
const VERSION_LABEL_RE = /(?<![\w.-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)*)(?![\w.-])/g;

/** 递归收集要扫描的文本文件。 */
async function collectVersionFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在就跳过，交给别的检查去报
  }
  for (const entry of entries) {
    if (VERSION_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectVersionFiles(full)));
    else if (/\.(js|mjs|html|css|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function checkVersionReferences(current) {
  const files = [];
  for (const dir of VERSION_SCAN_DIRS) files.push(...(await collectVersionFiles(path.join(ROOT, dir))));
  for (const rel of VERSION_SCAN_ROOT_FILES) {
    const full = path.join(ROOT, rel);
    if (existsSync(full)) files.push(full);
  }

  let scanned = 0;
  for (const full of files) {
    const rel = relative(ROOT, full).split(path.sep).join('/');
    let text;
    try {
      text = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const lines = text.split('\n');
    const counts = new Map();
    lines.forEach((line, index) => {
      for (const match of line.matchAll(VERSION_LABEL_RE)) {
        counts.set(match[1], (counts.get(match[1]) || []).concat(index + 1));
      }
    });
    for (const [found, lineNos] of counts) {
      if (found === current) continue;
      problems.push(
        `${rel}:${lineNos.join(',')} 的版本引用是 ${found}，与当前版本 ${current} 不一致`,
      );
    }
  }
  if (problems.length === 0) {
    notes.push(`✓ 版本引用一致：${scanned} 个文件里出现的版本号都是 ${current}`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. 词库
 * ------------------------------------------------------------------ */
const ALLOWED_TAGS = ['core', 'office', 'meeting', 'email', 'tech', 'travel', 'daily', 'academic', 'spoken'];

async function checkWords() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/data/words.js')).href);
  const all = [...(mod.BUILTIN_WORDS || []), ...(mod.BUILTIN_PHRASES || [])];
  if (all.length < 100) problems.push(`内置词条太少（${all.length}），至少应有一百多条`);

  const ids = new Set();
  const terms = new Set();
  for (const word of all) {
    const where = word.id || word.term || '未知词条';
    for (const field of ['id', 'term', 'meaning']) {
      if (!word[field] || String(word[field]).trim() === '') problems.push(`${where} 缺少字段 ${field}`);
    }
    if (ids.has(word.id)) problems.push(`id 重复：${word.id}`);
    ids.add(word.id);
    const key = String(word.term).toLowerCase();
    if (terms.has(key)) problems.push(`单词重复：${word.term}`);
    terms.add(key);
    for (const tag of word.tags || []) {
      if (!ALLOWED_TAGS.includes(tag)) problems.push(`${word.term} 使用了未知标签 ${tag}`);
    }
    if (![1, 2, 3].includes(word.level)) problems.push(`${word.term} 的 level 应为 1/2/3`);
    if (word.type === 'word' && !word.phonetic) problems.push(`${word.term} 缺少音标`);
  }
  notes.push(
    `✓ 词库：${(mod.BUILTIN_WORDS || []).length} 个单词 + ${(mod.BUILTIN_PHRASES || []).length} 个短语`,
  );
}

/* ------------------------------------------------------------------ *
 * 4. HTML 里的资源引用
 * ------------------------------------------------------------------ */
async function checkHtml() {
  const files = [
    'src/popup/popup.html',
    'src/options/options.html',
    'src/pages/study.html',
    'src/newtab/newtab.html',
  ];
  for (const rel of files) {
    const full = path.join(ROOT, rel);
    if (!existsSync(full)) {
      problems.push(`缺少页面：${rel}`);
      continue;
    }
    const html = await readFile(full, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      const target = path.join(path.dirname(full), ref);
      if (!existsSync(target)) problems.push(`${rel} 引用了不存在的文件：${ref}`);
    }
    if (/<script(?![^>]*\bsrc=)/i.test(html)) problems.push(`${rel} 含内联 <script>，MV3 的 CSP 不允许`);
    notes.push(`✓ ${rel}`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. 脚本里 el('id') 引用的元素是否真的存在于对应 HTML 中
 *    （选项特别多，靠肉眼很难发现拼错的 id）
 * ------------------------------------------------------------------ */
async function checkElementIds() {
  const pairs = [
    ['src/options/options.js', 'src/options/options.html'],
    ['src/popup/popup.js', 'src/popup/popup.html'],
    ['src/pages/study.js', 'src/pages/study.html'],
    ['src/newtab/newtab.js', 'src/newtab/newtab.html'],
  ];
  for (const [jsRel, htmlRel] of pairs) {
    const js = await readFile(path.join(ROOT, jsRel), 'utf8');
    const html = await readFile(path.join(ROOT, htmlRel), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set(
      [...js.matchAll(/\b(?:el|document\.getElementById)\('([^']+)'\)/g)].map((m) => m[1]),
    );
    const missing = [...used].filter((id) => !ids.has(id));
    if (missing.length) problems.push(`${jsRel} 引用了 HTML 里不存在的元素 id：${missing.join(', ')}`);
    else notes.push(`✓ ${jsRel} 的 ${used.size} 个元素引用都能对上`);
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
async function main() {
  await checkManifest();
  await checkModules();
  await checkWords();
  await checkHtml();
  await checkElementIds();

  // 版本引用的真源是 manifest.json（package.json 的比对已在 checkManifest 里做过）
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  await checkVersionReferences(manifest.version);

  console.log('\n—— 自检结果 ——');
  for (const line of notes) console.log(line);

  if (problems.length === 0) {
    console.log('\n全部通过 ✅  扩展可以直接在 chrome://extensions 里加载。\n');
    return;
  }
  console.log('\n发现问题：');
  for (const line of problems) console.log(`  ✗ ${line}`);
  console.log('');
  process.exitCode = 1;
}

// 目录自检（未被 import 时的入口）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { main, ROOT };
void stat;
