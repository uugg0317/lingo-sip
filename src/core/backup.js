/**
 * 备份合并：把一份备份合进当前状态，而不是整体覆盖它。
 *
 * 为什么需要这个模块——
 * 设置页原来只有一个「导入备份」，走 replace(state) 整体覆盖。
 * 后果是：只要备份不包含你现在的全部进度，导入就是**净亏损**。
 * 合并模式用于保留当前更完整的进度，避免较小或较旧的备份造成数据回退。
 *
 * 所以这里的原则是「宁可少算，绝不多算」：
 *   · 同一词条两边都有 → 取最近活动的那份为基底（保留当前盒子与到期时间）
 *   · 但 known / seen / snooze / reps 取较大值，绝不倒退
 *   · due 取更早的那个 → 宁可让这个词提前复习，也不让它"假装已掌握"
 *   · 统计按天相加（每天只在两个状态里各计一次，不会重复计数）
 * 任何一条都不允许把"学过"变成"没学过"。
 */

import { STATS_KEEP_DAYS, DAY } from './constants.js';

/** 计数类字段：只增不减，合并时取较大值。 */
const COUNTERS = ['known', 'seen', 'snooze', 'reps'];

/** 合并后 progress 记录可能归属的三种情况。 */
export const MERGE_KINDS = {
  added: '新增', // 备份独有的词
  updated: '更新', // 两边都有，且合并结果与当前不同
  kept: '保持', // 两边都有，且当前已经更完整
};

/**
 * 合并单条 progress 记录。
 * @param {object} cur 当前记录（可能为 undefined）
 * @param {object} inc 备份里的记录
 * @returns {{record: object, changed: boolean}}
 */
function mergeRecord(cur, inc) {
  if (!cur) return { record: { ...inc }, changed: true };

  const curSeen = cur.lastSeen || 0;
  const incSeen = inc.lastSeen || 0;
  // 基底取最近活动的那份：它带有更可信的 box / status
  const base = incSeen > curSeen ? { ...inc } : { ...cur };
  const other = incSeen > curSeen ? cur : inc;

  // 计数只增不减
  for (const key of COUNTERS) {
    base[key] = Math.max(cur[key] || 0, inc[key] || 0);
  }
  // 到期时间取更早的：宁可提前复习，不要拖后
  const dueA = cur.due || 0;
  const dueB = inc.due || 0;
  base.due = dueA && dueB ? Math.min(dueA, dueB) : dueA || dueB;

  const changed = COUNTERS.some((k) => (base[k] || 0) !== (cur[k] || 0)) || base.due !== (cur.due || 0);
  return { record: base, changed };
}

/** 按 id 合并自定义词条，当前已有的优先（不允许备份覆盖你的编辑）。 */
function mergeCustomWords(curList, incList) {
  const map = new Map();
  for (const w of incList || []) if (w && w.id) map.set(w.id, w);
  for (const w of curList || []) if (w && w.id) map.set(w.id, w);
  return [...map.values()];
}

/** 按天相加统计。key 是 'YYYY-MM-DD'，同一天两边各记一次，相加即总量。 */
function mergeStats(curStats, incStats) {
  const out = {};
  const keys = new Set([...Object.keys(curStats || {}), ...Object.keys(incStats || {})]);
  for (const key of keys) {
    const a = curStats?.[key] || {};
    const b = incStats?.[key] || {};
    out[key] = {
      shown: (a.shown || 0) + (b.shown || 0),
      known: (a.known || 0) + (b.known || 0),
      snooze: (a.snooze || 0) + (b.snooze || 0),
      seconds: (a.seconds || 0) + (b.seconds || 0),
      newShown: (a.newShown || 0) + (b.newShown || 0),
      reviewAnswered: (a.reviewAnswered || 0) + (b.reviewAnswered || 0),
      // 一个日期只要有一份历史统计缺少分类，就不能声称分类总数完整。
      newShownComplete: (!curStats?.[key] || (Number.isFinite(a.newShown) && a.newShownComplete !== false))
        && (!incStats?.[key] || (Number.isFinite(b.newShown) && b.newShownComplete !== false)),
      reviewAnsweredComplete: (!curStats?.[key] || (Number.isFinite(a.reviewAnswered) && a.reviewAnsweredComplete !== false))
        && (!incStats?.[key] || (Number.isFinite(b.reviewAnswered) && b.reviewAnsweredComplete !== false)),
    };
  }
  // 与 store.js 的 pruneStats 保持一致，避免合并后留下过老的日期
  const cutoff = Date.now() - STATS_KEEP_DAYS * DAY;
  for (const key of Object.keys(out)) {
    const ts = Date.parse(`${key}T00:00:00`);
    if (Number.isFinite(ts) && ts < cutoff) delete out[key];
  }
  return out;
}

/**
 * 把备份状态合进当前状态。
 *
 * @param {object} cur 当前状态（来自 store.read()）
 * @param {object} incoming 备份里的 state
 * @returns {{state: object, report: object}} 合并结果与给人看的报告
 */
export function mergeState(cur, incoming) {
  const curProgress = cur.progress || {};
  const incProgress = incoming?.progress || {};

  const progress = { ...curProgress };
  const added = [];
  const updated = [];
  const kept = [];

  for (const id of Object.keys(incProgress)) {
    const { record, changed } = mergeRecord(curProgress[id], incProgress[id]);
    progress[id] = record;
    if (!curProgress[id]) added.push(id);
    else if (changed) updated.push(id);
    else kept.push(id);
  }

  const curCustom = cur.customWords || [];
  const incCustom = Array.isArray(incoming?.customWords) ? incoming.customWords : [];
  const customWords = mergeCustomWords(curCustom, incCustom);

  const state = {
    ...cur,
    progress,
    customWords,
    stats: mergeStats(cur.stats, incoming?.stats),
    // 设置与运行时一律以当前为准：备份里的设置通常更旧，
    // 而且用户真正想合并的是「学习进度」，不是「当时的偏好」。
    settings: cur.settings,
    runtime: cur.runtime,
  };

  const report = {
    added,
    updated,
    kept,
    // 备份里有、当前没有的统计日期，说明这份备份带来了新的天数
    statsDays: Object.keys(state.stats).length,
    customWords: customWords.length,
    customAdded: customWords.length - curCustom.length,
  };
  return { state, report };
}

/**
 * 生成给人看的合并预览文案。
 * @param {object} cur 当前状态
 * @param {object} incoming 备份状态
 * @returns {{text: string, report: object}}
 */
export function previewMerge(cur, incoming) {
  const { state, report } = mergeState(cur, incoming);
  const before = Object.keys(cur.progress || {}).length;
  const after = Object.keys(state.progress).length;
  const knownBefore = Object.values(cur.progress || {}).filter((r) => (r.known || 0) >= 1).length;
  const knownAfter = Object.values(state.progress).filter((r) => (r.known || 0) >= 1).length;

  const lines = [
    `当前 ${before} 个词 → 合并后 ${after} 个词`,
    `新增 ${report.added.length} 个：${report.added.slice(0, 8).join('、') || '无'}${report.added.length > 8 ? ' 等' : ''}`,
    `更新 ${report.updated.length} 个：${report.updated.slice(0, 8).join('、') || '无'}${report.updated.length > 8 ? ' 等' : ''}`,
    `当前已更完整、保持不动 ${report.kept.length} 个`,
    `已掌握 ${knownBefore} → ${knownAfter} 个`,
    `统计天数 ${Object.keys(cur.stats || {}).length} → ${report.statsDays} 天`,
    `自定义词条 ${(cur.customWords || []).length} → ${report.customWords} 个`,
  ];
  // 覆盖警告：判断依据必须是「备份自己有多少词」，而不是合并后的词数。
  // 用合并后的词数会漏掉最危险的一幕——备份只有 3 个词、合并后有 28 个，
  // 此时 after > before，警告不出现，而用户若选了覆盖就会掉 22 个词。
  const incomingCount = Object.keys(incoming?.progress || {}).length;
  if (incomingCount < before) {
    lines.push(`⚠️ 若改为"覆盖式导入"，词数会从 ${before} 降到 ${incomingCount} 个，少掉的进度无法找回`);
  }
  return { text: lines.join('\n'), report };
}
