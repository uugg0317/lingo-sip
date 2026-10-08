/**
 * 统计模块：每日进度、连续天数、配额滚动
 *
 * 展示与作答独立记账；主动完成可以从历史的 known + snooze 得到，
 * 新词 / 复习分类则只记录真正收到的事件，不推测旧记录。
 */

/** 本地时区的日期键 YYYY-MM-DD（不能用 toISOString，那是 UTC，会跨天错位）。 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 小时键，用于"每小时上限"的滚动归零。 */
export function hourKey(ts = Date.now()) {
  return `${dayKey(ts)}T${new Date(ts).getHours()}`;
}

function emptyDay() {
  return {
    shown: 0, known: 0, snooze: 0, seconds: 0,
    newShown: 0, reviewAnswered: 0,
    newShownComplete: true, reviewAnsweredComplete: true,
  };
}

function count(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** 缺少分类字段的历史日期只能展示已知部分，不能把总展示倒推为新词。 */
function dayView(raw) {
  if (!raw || typeof raw !== 'object') return { ...emptyDay(), answered: 0 };
  const day = { ...emptyDay(), ...raw };
  for (const key of ['shown', 'known', 'snooze', 'seconds', 'newShown', 'reviewAnswered']) {
    day[key] = count(raw[key]);
  }
  day.newShownComplete = Number.isFinite(raw.newShown) && raw.newShownComplete !== false;
  day.reviewAnsweredComplete = Number.isFinite(raw.reviewAnswered) && raw.reviewAnsweredComplete !== false;
  day.answered = day.known + day.snooze;
  return day;
}

/** 使用本地日历退天，夏令时切换也不会重复或漏掉日期。 */
function daysAgo(now, offset) {
  const date = new Date(now);
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

/**
 * 跨天 / 跨小时时把配额计数器归零。
 * 必须在每次判断闸门和每次记账前调用。
 */
export function rollover(state, now = Date.now()) {
  const dk = dayKey(now);
  const hk = hourKey(now);
  if (state.runtime.dayKey !== dk) {
    state.runtime.dayKey = dk;
    state.runtime.dayCount = 0;
    state.runtime.newCount = 0;
  }
  if (state.runtime.hourKey !== hk) {
    state.runtime.hourKey = hk;
    state.runtime.hourCount = 0;
  }
}

/** 今日统计。 */
export function today(state, now = Date.now()) {
  return dayView(state.stats[dayKey(now)]);
}

/** 最近 n 天（含今天），从旧到新。 */
export function lastDays(state, n = 7, now = Date.now()) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const ts = daysAgo(now, i);
    const key = dayKey(ts);
    out.push({ key, ...dayView(state.stats[key]) });
  }
  return out;
}

/**
 * 记一笔。
 * @param {'shown'|'known'|'snooze'} kind
 * @param {{ seconds?: number, isNew?: boolean, mode?: 'new'|'review'|'recycle'|'early', classificationKnown?: boolean }} extra
 */
export function bump(state, kind, extra = {}, now = Date.now()) {
  rollover(state, now);
  const key = dayKey(now);
  // 补足计数并保留历史分类不完整标记；未来追加不会让旧日期变成完整数据。
  state.stats[key] = dayView(state.stats[key]);
  const day = state.stats[key];
  delete day.answered; // 主动完成始终由 known + snooze 派生，不保存第二份总数。

  if (kind === 'shown') {
    day.shown += 1;
    state.runtime.dayCount += 1;
    state.runtime.hourCount += 1;
    if (extra.classificationKnown === false) day.newShownComplete = false;
    if (extra.isNew) {
      state.runtime.newCount += 1;
      day.newShown += 1;
    }
  } else if (kind === 'known') {
    day.known += 1;
  } else if (kind === 'snooze') {
    day.snooze += 1;
  }
  if ((kind === 'known' || kind === 'snooze') && ['review', 'recycle', 'early'].includes(extra.mode)) {
    day.reviewAnswered += 1;
  } else if ((kind === 'known' || kind === 'snooze') && extra.mode !== 'new') {
    // 老卡片 / 老通知可能没有模式；主动作答总数有效，分类不能假装完整。
    day.reviewAnsweredComplete = false;
  }
  if (Number.isFinite(extra.seconds) && extra.seconds > 0) day.seconds += Math.round(extra.seconds);
  return day;
}

/** 连续打卡天数：从今天（或昨天）往前数连续有记录的天数。 */
export function streak(state, now = Date.now()) {
  return countStreak(state, (day) => day.shown > 0, now);
}

/** 主动作答的连续天数；旧记录直接使用 known + snooze，不依赖 progress.reps。 */
export function answeredStreak(state, now = Date.now()) {
  return countStreak(state, (day) => day.answered > 0, now);
}

function countStreak(state, predicate, now) {
  const has = (offset) => {
    const day = state.stats[dayKey(daysAgo(now, offset))];
    return !!day && predicate(dayView(day));
  };
  // 今天还没开始学也不算断，从昨天开始数
  let offset = has(0) ? 0 : 1;
  if (offset === 1 && !has(1)) return 0;
  let count = 0;
  while (has(offset)) {
    count += 1;
    offset += 1;
  }
  return count;
}

/** 未设置过目标口径的旧用户沿用展示，不改变历史目标与连续记录。 */
export function goalMetric(state) {
  return state.settings.goalMetric === 'answered' ? 'answered' : 'shown';
}

/** 今日目标完成度 0~1。 */
export function goalProgress(state, now = Date.now()) {
  const goal = Math.max(1, state.settings.dailyGoal || 1);
  return Math.min(1, today(state, now)[goalMetric(state)] / goal);
}
