/**
 * 间隔重复调度（SRS）
 *
 * 模型：莱特纳盒子（Leitner box）+ 间隔表，见 constants.js。
 *   · 认识一次  → 盒子 +1，下次见面的时间按新盒子取值（越来越久）
 *   · 稍后复习  → 盒子 -1，并按当前盒子推迟一小段时间重新出现
 *   · 卡片自动消失（没作答）→ 不算遗忘，只把 due 往后推一点点
 * 用户的三种操作语义清晰、后果可预期，因此"学习成本"接近于零。
 */

import {
  BOX_INTERVALS,
  SNOOZE_INTERVALS,
  BOX_MASTERED,
  SEEN_DELAY,
  MIN,
  DAY,
} from './constants.js';

/** 新词的初始记录。 */
export function emptyRecord(now = Date.now()) {
  return {
    box: 0, // 当前盒子 0..6
    due: now, // 下次该出现的时间戳
    status: 'new', // new | learning | mastered
    reps: 0, // 记得了次数（旧字段语义保留；主动作答统计用 known + snooze）
    known: 0, // 点过"记得了"的次数
    snooze: 0, // 点过"稍后复习"的次数
    seen: 0, // 展示次数（含自动淡出）
    lastSeen: 0, // 最近一次展示时间
  };
}

/** 取某个词的记录（不存在时返回未落盘的临时记录）。 */
export function recordOf(state, wordId, now = Date.now()) {
  return state.progress[wordId] || emptyRecord(now);
}

export function isMastered(rec) {
  return !!rec && rec.status === 'mastered';
}

/** 盒子 → 间隔毫秒。 */
export function intervalMs(box) {
  const safe = Math.max(0, Math.min(BOX_INTERVALS.length - 1, box | 0));
  return BOX_INTERVALS[safe] * MIN;
}

/**
 * 结算一次交互，返回更新后的记录（纯函数，不写 storage）。
 * @param {object} rec 旧记录
 * @param {'known'|'snooze'|'seen'} action
 * @param {number} now
 */
export function grade(rec, action, now = Date.now()) {
  const next = { ...emptyRecord(now), ...rec };

  if (action === 'known') {
    next.box = Math.min(next.box + 1, BOX_INTERVALS.length - 1);
    next.reps += 1;
    next.known += 1;
    next.status = next.box >= BOX_MASTERED ? 'mastered' : 'learning';
    next.due = now + intervalMs(next.box);
  } else if (action === 'snooze') {
    next.box = Math.max(0, next.box - 1);
    next.snooze += 1;
    next.status = 'learning';
    next.due = now + SNOOZE_INTERVALS[next.box] * MIN;
  } else {
    // 'seen'：只看到、没作答。保持盒子不变，稍后再来一次，不惩罚用户。
    next.status = next.status === 'new' ? 'learning' : next.status;
    if (next.due <= now) next.due = now + SEEN_DELAY * MIN;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * 取词
 * ------------------------------------------------------------------ */

/** 是不是"从没出现过"的新词。 */
function isFresh(rec) {
  return !rec || rec.seen === 0 || rec.status === 'new';
}

/** 保温至少隔 14 天，且尊重记录中更晚的明确到期时间。 */
function recycleAt(rec) {
  const due = Number.isFinite(rec?.due) ? rec.due : 0;
  const seen = Number.isFinite(rec?.lastSeen) ? rec.lastSeen : 0;
  return Math.max(due, seen + 14 * DAY);
}

/** 下一个尚未到期的复习时刻；无计划返回 0，新词不算复习。 */
export function nextDueAt(state, pool, now = Date.now()) {
  let next = 0;
  for (const word of pool) {
    const rec = state.progress[word.id];
    if (isFresh(rec)) continue;
    if (isMastered(rec) && !state.settings.recycleMastered) continue;
    const due = isMastered(rec) ? recycleAt(rec) : rec.due;
    if (Number.isFinite(due) && due > now && (!next || due < next)) next = due;
  }
  return next;
}

/** 在候选区间内做"越靠前越容易被选中"的加权随机，避免总是按字母序背。 */
function weightedPick(list) {
  if (list.length === 0) return null;
  const weights = list.map((_, i) => 1 / (i + 3));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

/** 待复习 / 新词 / 已掌握 的队列概览，popup 和角标都用它。 */
export function queueSummary(state, pool, now = Date.now()) {
  let due = 0;
  let fresh = 0;
  let mastered = 0;
  let learning = 0;

  for (const word of pool) {
    const rec = state.progress[word.id];
    if (!rec || isFresh(rec)) {
      fresh += 1;
    } else if (isMastered(rec)) {
      mastered += 1;
      if (state.settings.recycleMastered && recycleAt(rec) <= now) due += 1;
    } else if (rec.due <= now) {
      due += 1;
      learning += 1;
    } else {
      learning += 1;
    }
  }
  return { due, fresh, mastered, learning, total: pool.length };
}

/**
 * 选出下一张卡。
 * 自动触发传 allowEarlyReview:false，主动练习才允许兜底提前复习。
 * @returns {{word:object, mode:'review'|'new'|'recycle'|'early', rec:object}|null}
 */
export function pickNext(state, pool, now = Date.now(), options = {}) {
  const { allowNew = true, recycleMastered = true, allowEarlyReview = true, avoidId = '' } = options;
  if (pool.length === 0) return null;

  const candidates = pool.filter((w) => w.id !== avoidId);
  const list = candidates.length > 0 ? candidates : pool;

  // ① 到期复习优先：这是间隔重复的核心价值，必须先还债
  const dueList = list
    .filter((w) => {
      const rec = state.progress[w.id];
      return rec && !isFresh(rec) && !isMastered(rec) && rec.due <= now;
    })
    .sort((a, b) => state.progress[a.id].due - state.progress[b.id].due);
  if (dueList.length > 0) {
    const word = dueList[0];
    return { word, mode: 'review', rec: state.progress[word.id] };
  }

  // ② 新词：只在前 40 个未见过的词里挑，保证难度和场景大致可控
  if (allowNew) {
    const freshList = list.filter((w) => isFresh(state.progress[w.id])).slice(0, 40);
    const word = weightedPick(freshList);
    if (word) return { word, mode: 'new', rec: state.progress[word.id] || emptyRecord(now) };
  }

  // ③ 保温：已掌握的词隔很久回来见一面，避免"考完就忘"
  if (recycleMastered) {
    const old = list
      .filter((w) => {
        const rec = state.progress[w.id];
        return isMastered(rec) && (allowEarlyReview || recycleAt(rec) <= now);
      })
      .sort((a, b) => (state.progress[a.id].lastSeen || 0) - (state.progress[b.id].lastSeen || 0));
    const word = old[0];
    if (word && now - (state.progress[word.id].lastSeen || 0) >= 14 * DAY) {
      return { word, mode: 'recycle', rec: state.progress[word.id] };
    }
  }

  if (!allowEarlyReview) return null;

  // ④ 实在没有了：把"最久没见"的在学词拿出来温习
  const stale = list
    .filter((w) => !isFresh(state.progress[w.id]) && !isMastered(state.progress[w.id]))
    .sort((a, b) => (state.progress[a.id]?.lastSeen || 0) - (state.progress[b.id]?.lastSeen || 0));
  if (stale.length > 0 && state.progress[stale[0].id]) {
    return { word: stale[0], mode: 'early', rec: state.progress[stale[0].id] };
  }

  return null;
}
