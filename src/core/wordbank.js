/**
 * 词库：内置词表 + 用户自定义词条 + 导入导出
 *
 * 内置词表放在 src/data/words.js（纯数据，直接改就能替换整套词库）。
 * 用户导入/自建的词条存在 storage 的 customWords 里，两者在这里合并成
 * 一个统一的学习池。覆盖释义保留已有身份；旧版产生的同词别名在读取时
 * 无损关联进度，原词条 id 和旧进度记录都保留。
 */

import { BUILTIN_WORDS, BUILTIN_PHRASES } from '../data/words.js';
import { TAG_LABELS } from './constants.js';

/** 内置词条全集（单词在前、短语在后，顺序即默认学习顺序）。 */
export const BUILTIN = [...BUILTIN_WORDS, ...BUILTIN_PHRASES];

/** 内置词表里实际出现过的分类。 */
export function builtinTags() {
  const set = new Set();
  for (const w of BUILTIN) for (const t of w.tags || []) set.add(t);
  return Object.keys(TAG_LABELS).filter((t) => set.has(t));
}

export function tagLabel(tag) {
  return TAG_LABELS[tag] || tag;
}

/**
 * 组装学习池。
 * @param {object} state 完整状态（要用 settings.bankTags 和 customWords）
 */
export function pool(state) {
  const tags = state?.settings?.bankTags || [];
  const builtin = tags.length > 0 ? BUILTIN.filter((w) => (w.tags || []).some((t) => tags.includes(t))) : BUILTIN;
  const custom = Array.isArray(state?.customWords) ? state.customWords : [];
  const identities = identityGroups(custom);
  return dedupeByTerm([...builtin, ...custom]).map((word) => {
    const id = identities.get(termKey(word.term))?.id || word.id;
    return id === word.id ? word : { ...word, id };
  });
}

/** 大小写和首尾空格不构成新的词条身份。 */
function termKey(term) {
  return String(term || '').trim().toLowerCase();
}

/**
 * 内置词优先沿用发布过的 id；纯自定义词优先沿用最早已有的 id。
 * 后面的同名词只覆盖内容，不取代学习身份。aliases 仅记录历史兼容身份。
 */
function identityGroups(customWords = []) {
  const groups = new Map();
  for (const word of [...BUILTIN, ...customWords]) {
    const key = termKey(word?.term);
    if (!key || !word?.id) continue;
    let group = groups.get(key);
    if (!group) {
      group = { id: word.id, ids: new Set([word.id, makeId(word.term)]) };
      groups.set(key, group);
    }
    group.ids.add(word.id);
    for (const alias of Array.isArray(word.aliases) ? word.aliases : []) {
      if (typeof alias === 'string' && alias) group.ids.add(alias);
    }
  }
  // 一个 id 若被旧数据用于不同单词，不能把两词进度串到一起。
  const owners = new Map();
  for (const [key, group] of groups) {
    for (const id of group.ids) {
      if (!owners.has(id)) owners.set(id, key);
      else if (owners.get(id) !== key) owners.set(id, null);
    }
  }
  for (const [key, group] of groups) {
    for (const id of group.ids) if (owners.get(id) !== key) group.ids.delete(id);
  }
  return groups;
}

/** 把兼容别名转换为学习池使用的 id，未知 id 原样返回。 */
export function canonicalWordId(state, id) {
  if (!id) return id;
  for (const group of identityGroups(state?.customWords || []).values()) {
    if (group.ids.has(id)) return group.id;
  }
  return id;
}

const IDENTITY_COUNTERS = ['known', 'seen', 'snooze', 'reps'];
const STATUS_ORDER = { new: 0, learning: 1, mastered: 2 };

/** 别名只有实际内容变化才重新合并，避免旧记录回滚后来的正常作答。 */
function recordSignature(record) {
  return JSON.stringify([
    record.box, record.status, record.due, record.lastSeen,
    ...IDENTITY_COUNTERS.map((key) => record[key]),
  ]);
}

function mergeIdentityRecord(current, incoming) {
  if (!current) return { ...incoming };
  const next = (incoming.lastSeen || 0) > (current.lastSeen || 0) ? { ...incoming } : { ...current };
  for (const key of IDENTITY_COUNTERS) next[key] = Math.max(current[key] || 0, incoming[key] || 0);
  next.box = Math.max(current.box || 0, incoming.box || 0);
  next.status = (STATUS_ORDER[incoming.status] ?? 0) > (STATUS_ORDER[current.status] ?? 0)
    ? incoming.status : current.status;
  const dates = [current.due, incoming.due].filter((due) => Number.isFinite(due) && due > 0);
  next.due = dates.length ? Math.min(...dates) : current.due || incoming.due || 0;
  next.lastSeen = Math.max(current.lastSeen || 0, incoming.lastSeen || 0);
  return next;
}

/**
 * 读取旧状态或恢复备份时无损关联同名词的进度（纯函数）。
 * 返回新的 progress 容器，不改词条 id、不删除任何历史 progress key。
 * 消费过的别名快照留在主记录里；备份带来更新别名时仍会继续合并。
 */
export function normalizeWordProgress(state) {
  const progress = { ...(state?.progress || {}) };
  for (const group of identityGroups(state?.customWords || []).values()) {
    let record = progress[group.id];
    const sources = { ...(record?._wordIdentitySources || {}) };
    let changed = false;
    for (const id of group.ids) {
      if (id === group.id) continue;
      const alias = progress[id];
      if (!alias || typeof alias !== 'object') continue;
      const signature = recordSignature(alias);
      if (sources[id] === signature) continue;
      record = mergeIdentityRecord(record, alias);
      sources[id] = signature;
      changed = true;
    }
    if (changed) progress[group.id] = { ...record, _wordIdentitySources: sources };
  }
  return progress;
}

/** 同一个词只留一条：自定义词条优先（允许用户覆盖内置释义）。 */
function dedupeByTerm(list) {
  const seen = new Map();
  for (const word of list) {
    const key = termKey(word?.term);
    if (!key) continue;
    seen.set(key, word); // 后面的覆盖前面的
  }
  return [...seen.values()];
}

/** 依据词条内容生成稳定 id：重复导入同一个词不会重置学习进度。 */
export function makeId(term, prefix = 'c') {
  const slug = String(term || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  let hash = 0;
  const src = String(term || '').trim().toLowerCase();
  for (let i = 0; i < src.length; i += 1) hash = (hash * 31 + src.charCodeAt(i)) % 100000;
  return `${prefix}_${slug || 'word'}_${hash}`;
}

// 仅在一次解析/预览中使用，不写入 storage 或导出文件。空缺字段不覆盖已有例句等内容。
const PROVIDED_FIELDS = Symbol('lingo-sip:word-import-fields');
const FIELD_ALIASES = {
  term: ['term', 'word', '单词'],
  type: ['type'],
  phonetic: ['phonetic', 'ipa', '音标'],
  pos: ['pos', '词性'],
  meaning: ['meaning', 'translation', '释义', '意思'],
  example: ['example', '例句'],
  exampleZh: ['exampleZh', 'example_zh', '例句翻译'],
  tags: ['tags', '标签'],
  level: ['level'],
};

/** 把任意来源的原始对象规整成标准词条。 */
export function normalizeWord(raw, index = 0) {
  const term = String(raw.term ?? raw.word ?? raw['单词'] ?? '').trim();
  const obj = {
    id: String(raw.id || makeId(term)),
    type: raw.type === 'phrase' ? 'phrase' : 'word',
    term,
    phonetic: String(raw.phonetic ?? raw.ipa ?? raw['音标'] ?? '').trim(),
    pos: String(raw.pos ?? raw['词性'] ?? '').trim(),
    meaning: String(raw.meaning ?? raw.translation ?? raw['释义'] ?? raw['意思'] ?? '').trim(),
    example: String(raw.example ?? raw['例句'] ?? '').trim(),
    exampleZh: String(raw.exampleZh ?? raw.example_zh ?? raw['例句翻译'] ?? '').trim(),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).trim()).filter(Boolean)
      : String(raw.tags ?? raw['标签'] ?? '')
          .split(/[|,;/、]/)
          .map((t) => t.trim())
          .filter(Boolean),
    level: Number(raw.level) || 2,
    source: 'custom',
  };
  if (!obj.tags.length) obj.tags = ['custom'];
  if (obj.type === 'word' && !obj.phonetic) obj.phonetic = '';
  if (Array.isArray(raw.aliases)) {
    obj.aliases = [...new Set(raw.aliases.filter((id) => typeof id === 'string' && id && id !== obj.id))];
  }
  obj._index = index;
  delete obj._index;
  const fields = raw[PROVIDED_FIELDS] || Object.keys(FIELD_ALIASES).filter(
    (key) => FIELD_ALIASES[key].some((alias) => Object.hasOwn(raw, alias)),
  );
  Object.defineProperty(obj, PROVIDED_FIELDS, { value: fields });
  return obj;
}

/** 把一个对象规整成合法词条；字段不全时返回 null。 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const word = normalizeWord(raw);
  return word.term && word.meaning ? word : null;
}

/** 词条字段相同则不重复写入；aliases 是兼容信息，不算一次内容更新。 */
function sameWordContent(a, b) {
  return ['type', 'term', 'phonetic', 'pos', 'meaning', 'example', 'exampleZh', 'level'].every(
    (key) => (a[key] ?? '') === (b[key] ?? ''),
  ) && JSON.stringify(a.tags || []) === JSON.stringify(b.tags || []);
}

/**
 * 词库导入预览（纯函数）：按同词身份分为新增、更新、未变和冲突。
 * words 是可安全写入的最终词条；冲突行不在该列表里。
 * 同 id 不同 term 一律拒绝，包括本次文件内部的冲突。
 */
export function previewWordImport(state, inputWords) {
  const custom = Array.isArray(state?.customWords) ? state.customWords : [];
  const byTerm = new Map();
  const idTerms = new Map();
  for (const word of [...BUILTIN, ...custom]) {
    if (!word?.id || !termKey(word.term)) continue;
    byTerm.set(termKey(word.term), word);
    for (const id of [word.id, makeId(word.term), ...(Array.isArray(word.aliases) ? word.aliases : [])]) {
      const owners = idTerms.get(id) || new Set();
      owners.add(termKey(word.term));
      idTerms.set(id, owners);
    }
  }

  const added = [];
  const updated = [];
  const unchanged = [];
  const conflicts = [];
  const staged = new Map();
  const normalized = [];
  for (const raw of Array.isArray(inputWords) ? inputWords : []) {
    const word = sanitize(raw);
    if (!word) {
      conflicts.push({ term: String(raw?.term || raw?.word || ''), id: String(raw?.id || ''), reason: '缺少单词或释义' });
      continue;
    }
    normalized.push(word);
  }
  // 先检查整个文件，不能因先后顺序而默默接受其中一条碰撞身份。
  const fileIdTerms = new Map();
  for (const word of normalized) {
    const terms = fileIdTerms.get(word.id) || new Set();
    terms.add(termKey(word.term));
    fileIdTerms.set(word.id, terms);
  }

  for (const word of normalized) {
    const key = termKey(word.term);
    const usedTerms = idTerms.get(word.id);
    const unsafe = ['__proto__', 'constructor', 'prototype'].includes(word.id);
    const differentTerm = usedTerms && [...usedTerms].some((term) => term !== key);
    if (unsafe || differentTerm || fileIdTerms.get(word.id).size > 1) {
      conflicts.push({
        term: word.term,
        id: word.id,
        reason: unsafe ? '词条 ID 不可用' : `ID ${word.id} 已关联不同单词，已跳过`,
      });
      continue;
    }
    const existing = byTerm.get(key);
    const id = existing?.id || word.id;
    const aliases = new Set([...(existing?.aliases || []), ...(word.aliases || [])]);
    if (word.id !== id) aliases.add(word.id);
    // 用户提交的历史 aliases 同样不能引用其他单词。
    const badAlias = [...aliases].find((alias) => {
      const owners = idTerms.get(alias) || fileIdTerms.get(alias);
      return ['__proto__', 'constructor', 'prototype'].includes(alias) || owners && [...owners].some((term) => term !== key);
    });
    if (badAlias) {
      conflicts.push({ term: word.term, id: word.id, reason: `兼容 ID ${badAlias} 已关联不同单词，已跳过` });
      continue;
    }
    const patch = Object.fromEntries((word[PROVIDED_FIELDS] || Object.keys(FIELD_ALIASES)).map((field) => [field, word[field]]));
    const next = existing ? { ...normalizeWord(existing), ...patch, id, source: 'custom' } : { ...word, id };
    aliases.delete(id);
    if (aliases.size) next.aliases = [...aliases];
    else delete next.aliases;
    staged.set(key, { word: next, existing: staged.has(key) ? staged.get(key).existing : existing || null });
    byTerm.set(key, next);
    idTerms.set(id, new Set([key]));
    for (const alias of aliases) idTerms.set(alias, new Set([key]));
  }

  for (const { word, existing } of staged.values()) {
    if (!existing) added.push(word);
    else if (sameWordContent(normalizeWord(existing), word)) unchanged.push(word);
    else updated.push(word);
  }
  const words = [...staged.values()].map((entry) => entry.word);
  return {
    added, updated, unchanged, conflicts, words,
    summary: {
      added: added.length, updated: updated.length, unchanged: unchanged.length,
      conflicts: conflicts.length, total: normalized.length, ready: words.length,
    },
    canApply: words.length > 0,
  };
}

/**
 * 应用已预览的词库导入（纯函数）。调用方应在 store.update 内用最新状态再检查。
 * 返回 {state, report}；已有词条原 id 保留，同名重复记录继续兼容，不删除旧进度。
 */
export function applyWordImport(state, inputWords) {
  const report = previewWordImport(state, inputWords);
  const customWords = [...(state?.customWords || [])];
  const indexes = new Map();
  customWords.forEach((word, index) => indexes.set(termKey(word?.term), index));
  for (const word of report.words) {
    // 更新同名词的最后一条（与内容覆盖规则一致），保留其已持久化 id。
    const key = termKey(word.term);
    if (indexes.has(key)) customWords[indexes.get(key)] = word;
    else {
      indexes.set(key, customWords.length);
      customWords.push(word);
    }
  }
  const next = { ...state, customWords };
  next.progress = normalizeWordProgress(next);
  return { state: next, report };
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

/** 导入时能识别的表头别名。 */
const HEADER_ALIASES = {
  id: ['id'],
  type: ['type', '类型'],
  term: ['term', 'word', '单词', '词条', '词汇'],
  phonetic: ['phonetic', 'ipa', '音标', '发音'],
  pos: ['pos', 'partofspeech', '词性'],
  meaning: ['meaning', 'translation', 'definition', '释义', '意思', '中文', '翻译'],
  example: ['example', 'sentence', '例句', '英文例句'],
  exampleZh: ['examplezh', 'examplezh', '例句翻译', '例句中文', '例句释义'],
  tags: ['tags', 'tag', '标签', '分类', '场景'],
  level: ['level', '难度', '等级'],
};

const NO_HEADER_ORDER = ['term', 'phonetic', 'pos', 'meaning', 'example', 'exampleZh', 'tags', 'level'];

/**
 * 解析导入文本。三种格式都能吃：
 *   1. JSON 数组：[{ term, meaning, ... }]
 *   2. JSON 对象：{ words: [...] }
 *   3. CSV / TSV：首行可以是表头（中英文别名都可以），也可以没有表头
 *      最简形式每行 `单词,意思` 也能导入。
 * @returns {{ words: object[], errors: string[] }}
 */
export function parseImport(text) {
  const raw = String(text || '').trim();
  const errors = [];
  if (!raw) return { words: [], errors: ['内容为空'] };

  // —— JSON
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : data.words || data.list || data.items || [];
      const words = arr.map(sanitize).filter(Boolean);
      if (words.length === 0) errors.push('JSON 里没有解析出任何有效词条');
      return { words: dedupeByTerm(words), errors };
    } catch (err) {
      return { words: [], errors: [`JSON 解析失败：${err.message}`] };
    }
  }

  // —— 分隔符文本
  const { records, unclosedLine } = splitRecords(raw);
  if (unclosedLine) errors.push(`第 ${unclosedLine} 行引号未闭合，已跳过`);
  if (records.length === 0) return { words: [], errors: errors.length ? errors : ['没有有效行'] };

  // 只把引号外的制表符当作 TSV 分隔符，例句里的制表符仍属于单元格。
  const delimiter = splitLine(records[0].text, '\t').length > 1 ? '\t' : ',';
  const rows = records.map((record) => splitLine(record.text, delimiter));

  // 表头识别
  let order = NO_HEADER_ORDER;
  let start = 0;
  const first = rows[0].map((c) => c.toLowerCase().replace(/[\s_-]/g, ''));
  const matched = first.map((h) => Object.keys(HEADER_ALIASES).find((k) => HEADER_ALIASES[k].includes(h)) || null);
  if (matched.filter(Boolean).length >= 2) {
    order = matched;
    start = 1;
  } else if (rows[0].length === 2) {
    // 形如 "word,意思" 的两列清单
    order = ['term', 'meaning'];
  }

  const words = [];
  for (let i = start; i < rows.length; i += 1) {
    const parts = rows[i];
    if (parts.length === 0) continue;
    const obj = {};
    order.forEach((key, idx) => {
      if (key) obj[key] = parts[idx] ?? '';
    });
    if (!obj.term && parts[0]) obj.term = parts[0];
    if (!obj.meaning && parts[1]) obj.meaning = parts[1];
    const word = sanitize(obj);
    if (word) words.push(word);
    else if (parts[0]) errors.push(`第 ${records[i].line} 行缺少单词或释义，已跳过`);
  }
  return { words: dedupeByTerm(words), errors };
}

/** 按逻辑记录分行：引号内的换行、空行和 # 都是词条内容。 */
function splitRecords(text) {
  const records = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let quoted = false;
  let comment = false;
  const append = (end) => {
    const value = text.slice(start, end).trim();
    if (value && !value.startsWith('#')) records.push({ text: value, line: startLine });
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    // 注释里的引号不会开启 CSV 字段。
    if (!quoted && ch === '#' && !text.slice(start, i).trim()) comment = true;
    if (!comment && ch === '"') {
      if (quoted && text[i + 1] === '"') i += 1;
      else quoted = !quoted;
    }
    if (ch === '\r' || ch === '\n') {
      if (!quoted) append(i);
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
      if (!quoted) {
        start = i + 1;
        startLine = line;
        comment = false;
      }
    }
  }
  if (!quoted) append(text.length);
  return { records, unclosedLine: quoted ? startLine : 0 };
}

/** CSV 记录拆分，支持双引号包裹、多行字段与 "" 转义。 */
function splitLine(line, delimiter) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

const EXPORT_COLUMNS = ['term', 'phonetic', 'pos', 'meaning', 'example', 'exampleZh', 'tags', 'level', 'id', 'type'];

/** 导出为 CSV 文本（带表头，能被本扩展和 Excel / Anki 直接读）。 */
export function toCSV(list) {
  const head = EXPORT_COLUMNS.join(',');
  const rows = list.map((w) =>
    EXPORT_COLUMNS.map((col) => {
      const value = col === 'tags' ? (w.tags || []).join('|') : (w[col] ?? '');
      const text = String(value);
      return /[",\r\n\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(','),
  );
  return [head, ...rows].join('\n');
}

/** 导出为 JSON 文本。 */
export function toJSON(list) {
  return JSON.stringify(
    list.map((w) => ({
      id: w.id,
      type: w.type || 'word',
      term: w.term,
      phonetic: w.phonetic || '',
      pos: w.pos || '',
      meaning: w.meaning,
      example: w.example || '',
      exampleZh: w.exampleZh || '',
      tags: w.tags || [],
      level: w.level || 2,
    })),
    null,
    2,
  );
}

/** 提供给用户的导入模板。 */
export function templateCSV() {
  return [
    'term,phonetic,pos,meaning,example,exampleZh,tags,level',
    'resilient,/rɪˈzɪliənt/,adj.,有韧性的；能迅速恢复的,She stayed resilient after the setback.,遭遇挫折后她依然坚韧。,office|core,2',
  ].join('\n');
}

/** 触发浏览器下载（popup / options 里调用）。 */
export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
