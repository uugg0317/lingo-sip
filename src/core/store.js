/**
 * 存储层：唯一的读写入口
 *
 * 为什么要有这一层？
 * 1. MV3 的 service worker 随时可能被浏览器回收，"内存里的变量"不可信，
 *    所以每次操作都以 storage 为准做「读 → 改 → 写」，随时中断都不丢进度。
 * 2. chrome.storage 的读改写不是原子的，多个消息并发时可能互相覆盖，
 *    因此这里用 Web Locks 协调扩展页面与后台，再用 Promise 队列保证本上下文的顺序。
 * 3. 所有默认值、旧数据兜底、过期统计清理都收敛在 normalize() 里，
 *    上层模块拿到的永远是结构完整的对象。
 */

import {
  STORAGE_KEY,
  SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  STATS_KEEP_DAYS,
  LOG_KEEP,
  SNAPSHOT_KEEP,
  DAY,
} from './constants.js';
import { normalizeWordProgress, canonicalWordId } from './wordbank.js';

/** 出厂状态。 */
export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS, quietHours: { ...DEFAULT_SETTINGS.quietHours } },
    /** 学习进度：{ [wordId]: record }，record 见 srs.js */
    progress: {},
    /** 每日统计：{ 'YYYY-MM-DD': { shown, known, snooze, seconds } } */
    stats: {},
    /** 运行时计数：冷却、配额、暂停等，全部落盘以便 SW 重启后延续 */
    runtime: {
      lastShownAt: 0,
      lastWordId: '',
      hourKey: '',
      hourCount: 0,
      dayKey: '',
      dayCount: 0,
      newCount: 0,
      tabShown: {}, // { [tabId]: 时间戳 } 单页冷却
      lastBlockReason: '',
      log: [], // [{ ts, text }] 最近事件，用于设置页排查
    },
    /** 用户自己添加 / 导入的词条 */
    customWords: [],
  };
}

/** 深拷贝一份默认设置（避免调用方改到共享对象）。 */
export function defaultSettings() {
  return { ...DEFAULT_SETTINGS, quietHours: { ...DEFAULT_SETTINGS.quietHours } };
}

/** 把任意来源的数据规整成完整可用的状态对象。 */
export function normalize(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  const state = {
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...(raw.settings || {}) },
    progress: raw.progress && typeof raw.progress === 'object' ? raw.progress : {},
    stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : {},
    runtime: { ...base.runtime, ...(raw.runtime || {}) },
    customWords: Array.isArray(raw.customWords) ? raw.customWords : [],
  };

  // 安静时段是个小对象，单独兜底一层
  state.settings.quietHours = {
    ...base.settings.quietHours,
    ...(raw.settings && raw.settings.quietHours ? raw.settings.quietHours : {}),
  };
  state.settings.goalMetric = state.settings.goalMetric === 'answered' ? 'answered' : 'shown';
  state.settings.voiceName = typeof state.settings.voiceName === 'string' ? state.settings.voiceName : '';
  // tabShown / log 必须是正确的容器类型
  if (!state.runtime.tabShown || typeof state.runtime.tabShown !== 'object') state.runtime.tabShown = {};
  if (!Array.isArray(state.runtime.log)) state.runtime.log = [];

  state.progress = normalizeWordProgress(state);
  state.runtime.lastWordId = canonicalWordId(state, state.runtime.lastWordId);
  pruneStats(state);
  return state;
}

/** 清理过老的每日统计，避免数据无限增长。 */
function pruneStats(state) {
  const cutoff = Date.now() - STATS_KEEP_DAYS * DAY;
  for (const key of Object.keys(state.stats)) {
    const ts = Date.parse(`${key}T00:00:00`);
    if (Number.isFinite(ts) && ts < cutoff) delete state.stats[key];
  }
}

/** 读取当前状态（总是返回结构完整的对象）。 */
export async function read() {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  return normalize(bag[STORAGE_KEY]);
}

/** 直接覆盖整个状态（导入备份时使用）。 */
export function replace(state) {
  return enqueueWrite(async () => {
    const next = normalize(state);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  });
}

/**
 * 写操作串行队列。
 * update(state => { ... }) 里直接改 state 即可，返回值会透传给调用方。
 *
 * 特殊返回值 SKIP_WRITE：mutator 用它表示"这次什么都没改，不要落盘"。
 * 为什么需要它——chrome.storage.local 的 set 会把整个状态（含 progress、
 * 统计、日志）全量序列化写进 LevelDB，一次约 900 字节。定时兜底每分钟醒一次、
 * 被闸门拦下时也各写一次，一天下来是几百次无谓写盘，还会把日志刷满。
 */
let queue = Promise.resolve();

/**
 * Promise 队列只管得住当前页面；popup、设置页、新标签页和后台各有自己的模块实例。
 * 同源 Web Lock 把这些实例的整段「读 → 改 → 写」放进同一把锁，防止旧快照覆盖新进度。
 * 不支持 Web Locks 的测试环境仍保留原有本地队列；锁失败时透传错误，不绕锁重试。
 */
function enqueueWrite(operation) {
  const task = queue.then(() => {
    const locks = globalThis.navigator?.locks;
    return locks?.request ? locks.request(`${STORAGE_KEY}:write`, operation) : operation();
  });
  // 某次失败只影响它自己，不能让整条写队列永久卡住。
  queue = task.then(() => undefined, () => undefined);
  return task;
}

/** mutator 的"跳过写盘"信号。 */
export const SKIP_WRITE = Symbol('lingo-sip:skip-write');

export function update(mutator) {
  return enqueueWrite(async () => {
    const state = await read();
    const result = await mutator(state);
    if (result === SKIP_WRITE) return undefined; // 明确表示无变化：不落盘
    // 写之前再压一次大小：日志只留最近 LOG_KEEP 条
    if (state.runtime.log.length > LOG_KEEP) {
      state.runtime.log = state.runtime.log.slice(-LOG_KEEP);
    }
    state.version = SCHEMA_VERSION;
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return result === undefined ? state : result;
  });
}

/** 改设置（浅合并）。 */
export function updateSettings(patch) {
  return update((state) => {
    state.settings = {
      ...state.settings,
      ...patch,
      quietHours: { ...state.settings.quietHours, ...(patch.quietHours || {}) },
    };
  });
}

/** 往事件日志里追加一条（内部工具，读取时用 getLog()）。 */
export function logEvent(state, text) {
  state.runtime.log.push({ ts: Date.now(), text: String(text).slice(0, 200) });
  if (state.runtime.log.length > LOG_KEEP) {
    state.runtime.log = state.runtime.log.slice(-LOG_KEEP);
  }
}

/** 读日志（不修改状态）。 */
export async function getLog() {
  const state = await read();
  return state.runtime.log.slice().reverse();
}

/** 清空全部学习数据（保留设置）。 */
export async function resetProgress() {
  return update((state) => {
    state.progress = {};
    state.stats = {};
    state.runtime.dayCount = 0;
    state.runtime.hourCount = 0;
    state.runtime.newCount = 0;
    logEvent(state, '已清空学习进度与统计');
  });
}

/** 恢复出厂设置（慎用，会连词库一起重置）。 */
export function resetAll() {
  return replace(defaultState());
}

/**
 * storage.onChanged 的薄封装：popup / options 打开时订阅，
 * 后台一改数据界面就自动刷新，不需要手动轮询。
 */
export function subscribe(callback) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    callback(normalize(changes[STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/* ------------------------------------------------------------------ *
 * 自动备份快照
 *
 * 手动「导出备份」的问题是：没人会记得导出。而进度丢失的代价很高，
 * 于是这里每天自动留一份快照，不需要用户做任何事。
 *
 * 为什么不用第二个 storage key 存整个数组：
 * 每次都要读写全部快照，且一条坏数据会毁掉整份历史。
 * 一天一个 key 则互不影响，损坏也只损失一天。
 * ------------------------------------------------------------------ */

const SNAP_PREFIX = `${STORAGE_KEY}:snap:`;

/** 一天的快照 key，用本地日期（与 runtime.dayKey 同口径，跨天归零时对齐）。 */
export function snapshotKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${SNAP_PREFIX}${y}-${m}-${d}`;
}

/**
 * 确保今天已经有一份快照；同一天只写一次，不覆盖当天更早的那份。
 * @returns {Promise<{saved: boolean, key: string, pruned: number}>}
 */
export function ensureSnapshot() {
  return enqueueWrite(saveSnapshot);
}

async function saveSnapshot() {
  const key = snapshotKey();
  const bag = await chrome.storage.local.get(key);
  if (bag[key]) return { saved: false, key, pruned: 0 };

  const state = await read();
  const saved = Object.keys(state.progress).length > 0;
  if (saved) {
    await chrome.storage.local.set({ [key]: { savedAt: Date.now(), state } });
  }

  // 只保留最近 SNAPSHOT_KEEP 份
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all)
    .filter((k) => k.startsWith(SNAP_PREFIX))
    .sort();
  const extra = keys.slice(0, Math.max(0, keys.length - SNAPSHOT_KEEP));
  if (extra.length > 0) await chrome.storage.local.remove(extra);
  return { saved, key, pruned: extra.length };
}

/** 列出全部快照（按日期倒序，最新在前），只带给人看的摘要。 */
export async function listSnapshots() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(SNAP_PREFIX) && all[k]?.state)
    .sort()
    .reverse()
    .map((key) => {
      const snap = all[key];
      const progress = snap.state.progress || {};
      const ids = Object.keys(progress);
      return {
        key,
        date: key.slice(SNAP_PREFIX.length),
        savedAt: snap.savedAt || 0,
        words: ids.length,
        known: ids.filter((id) => (progress[id].known || 0) >= 1).length,
      };
    });
}

/** 读一份快照里的完整状态；不存在时返回 null。 */
export async function readSnapshot(key) {
  const bag = await chrome.storage.local.get(key);
  return bag[key]?.state || null;
}
