/** 学习统计与自动 / 主动复习边界；全程纯内存，不接触浏览器真实数据。 */
import assert from 'node:assert/strict';
import { DAY, MIN } from '../src/core/constants.js';
import { defaultState } from '../src/core/store.js';
import * as stats from '../src/core/stats.js';
import { buildView } from '../src/core/view.js';
import { emptyRecord, grade, pickNext, nextDueAt, queueSummary } from '../src/core/srs.js';
import { mergeState } from '../src/core/backup.js';

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}
const now = new Date(2026, 9, 3, 12).getTime();
const dk = stats.dayKey(now);
const words = [{ id: 'a', term: 'alpha' }, { id: 'b', term: 'beta' }, { id: 'c', term: 'gamma' }];
const record = (over = {}) => ({ ...emptyRecord(now), seen: 2, lastSeen: now - MIN, status: 'learning', ...over });

// 历史目标 / 连续记录兼容：只看到卡片与主动作答分别计算，切换不改原统计。
{
  const state = defaultState();
  state.settings.dailyGoal = 10;
  state.settings.goalMetric = 'shown';
  state.stats[dk] = { shown: 20, known: 0, snooze: 0, seconds: 0 };
  state.stats[stats.dayKey(now - DAY)] = { shown: 2, known: 1, snooze: 1, seconds: 10 };
  const snapshot = structuredClone(state.stats);
  const shown = buildView(state, now);
  eq(shown.goalCount, 20, '展示目标沿用已有记录');
  eq(shown.goalPercent, 100, '展示目标封顶 100%');
  eq(shown.shownStreak, 2, '展示连续记录仍保留');
  eq(shown.today.answered, 0, '只看卡片不能算主动完成');
  state.settings.goalMetric = 'answered';
  const answered = buildView(state, now);
  eq(answered.goalCount, 0, '主动目标不使用展示数');
  eq(answered.goalPercent, 0, '未作答的主动目标为 0%');
  eq(answered.streak, 1, '今天未答时从昨天的作答连续记录计数');
  eq(answered.shownStreak, 2, '切换后仍保留原展示连续天数');
  eq(state.stats, snapshot, '视图 / 目标切换不迁移或删除历史统计');
  eq(stats.today(state, now).newShownComplete, false, '历史新词数缺失会标为不完整');
  eq(stats.today(state, now).reviewAnsweredComplete, false, '历史复习分类缺失不伪造');
  eq(stats.lastDays(state, 2, now)[0].answered, 2, '历史主动完成包含 known + snooze');
  state.settings.goalMetric = 'invalid';
  eq(stats.goalMetric(state), 'shown', '非法口径安全回到旧展示目标');
}

// 新增事件独立分类：新词作答不算复习，超时关闭不算主动完成，提前练习算复习。
{
  const state = defaultState();
  stats.bump(state, 'shown', { isNew: true }, now);
  stats.bump(state, 'shown', {}, now);
  stats.bump(state, 'known', { mode: 'new', seconds: 8 }, now);
  stats.bump(state, 'snooze', { mode: 'review', seconds: 4 }, now);
  stats.bump(state, 'known', { mode: 'recycle' }, now);
  stats.bump(state, 'snooze', { mode: 'early' }, now);
  const day = stats.today(state, now);
  eq(day.answered, 4, '记得了与稍后复习都算主动作答');
  eq(day.shown, 2, '作答不重复增加展示');
  eq(day.newShown, 1, '新词展示只计首次学习模式');
  eq(day.reviewAnswered, 3, '到期、保温、提前练习计复习完成');
  eq(day.newShownComplete, true, '新日期完整记录新词分类');
  eq(day.reviewAnsweredComplete, true, '新日期完整记录复习分类');
  eq(state.runtime.newCount, 1, '每日新词额度沿用展示口径');
  eq(day.seconds, 12, '主动学习用时可累计');
  const snoozed = grade(record(), 'snooze', now);
  eq(snoozed.reps, 0, '旧 reps 字段语义无需迁移');
  eq(snoozed.snooze, 1, '主动完成仍可由 known + snooze 正确派生');
  state.settings.dailyGoal = 10;
  state.settings.goalMetric = 'answered';
  eq(stats.goalProgress(state, now), 0.4, '目标 helper 与视图使用同一主动口径');
  eq(buildView(state, now).goalPercent, 40, '视图进度与 helper 一致');
  stats.bump(state, 'known', {}, now);
  eq(stats.today(state, now).answered, 5, '旧卡片未传模式仍计入主动完成');
  eq(stats.today(state, now).reviewAnsweredComplete, false, '旧卡片未传模式如实标示分类不完整');
}

// 在旧统计日期继续学习时仅累计新分类，不会给未知的旧展示伪造分类。
{
  const state = defaultState();
  state.stats[dk] = { shown: 4, known: 1, snooze: 2, seconds: 5 };
  stats.bump(state, 'shown', { isNew: true }, now);
  stats.bump(state, 'known', { mode: 'review' }, now);
  const day = stats.today(state, now);
  eq(day.shown, 5, '旧日期展示正确追加');
  eq(day.answered, 4, '旧日期主动作答可以完整派生');
  eq(day.newShown, 1, '旧日期新分类只记真实新增事件');
  eq(day.newShownComplete, false, '追加不会把未知的新词历史变成完整');
  eq(day.reviewAnsweredComplete, false, '追加不会把未知的复习历史变成完整');
  stats.bump(state, 'shown', {}, now + DAY);
  eq(stats.today(state, now + DAY).newShownComplete, true, '新日期恢复完整分类计数');
  eq(stats.today(state, now + DAY).answered, 0, '跨天不复用昨日主动完成');
  eq(state.runtime.newCount, 0, '跨天新词额度归零');
}

// 自动触发没有到期复习时就等待；手动触发可提前练习，不绕过新词额度。
{
  const state = defaultState();
  state.progress.a = record({ due: now + 10 * MIN });
  state.progress.b = record({ due: now + 20 * MIN });
  state.progress.c = record({ due: now + 30 * MIN });
  eq(pickNext(state, words, now, { allowNew: false, allowEarlyReview: false }), null, '自动触发不提前拉出在学词');
  eq(pickNext(state, words, now, { allowNew: false, allowEarlyReview: true }).mode, 'early', '手动兜底标示提前练习');
  eq(nextDueAt(state, words, now), now + 10 * MIN, '等待时间选择最早的到期计划');
  eq(queueSummary(state, words, now).due, 0, '队列待复习与自动规则一致');
  eq(pickNext(state, words, now + 10 * MIN, { allowNew: false, allowEarlyReview: false }).mode, 'review', '刚到期即可正常自动复习');
  state.progress.b.due = now - MIN;
  const selected = pickNext(state, words, now, { allowNew: true, allowEarlyReview: false });
  eq(selected.word.id, 'b', '到期复习优先于其他候选');
  eq(selected.mode, 'review', '到期复习不会误标提前练习');
  state.progress.c = emptyRecord(now);
  state.progress.a.due = state.progress.b.due = now + DAY;
  eq(pickNext(state, words, now, { allowNew: false, allowEarlyReview: false }), null, '关闭新词后不借兜底绕过额度');
  eq(pickNext(state, [words[2]], now, { allowNew: false, allowEarlyReview: true }), null, '手动兜底同样不能把未见新词算作复习');
  eq(pickNext(state, words, now, { allowNew: true, allowEarlyReview: false }).word.id, 'c', '自动触发仍能学习额度内新词');
}

// 保温必须同时满足至少 14 天与明确 due；关闭保温后不显示其计划或待学数。
{
  const state = defaultState();
  state.settings.recycleMastered = true;
  state.progress.a = record({ status: 'mastered', box: 6, due: now + 21 * DAY, lastSeen: now - 30 * DAY });
  eq(pickNext(state, [words[0]], now, { allowNew: false, recycleMastered: true, allowEarlyReview: false }), null, '自动保温尊重未来 due');
  eq(nextDueAt(state, [words[0]], now), now + 21 * DAY, '保温计划不会早于明确 due');
  eq(queueSummary(state, [words[0]], now).due, 0, '未来保温不算待复习');
  state.progress.a.due = now - MIN;
  state.progress.a.lastSeen = now - 13 * DAY;
  eq(pickNext(state, [words[0]], now, { allowNew: false, allowEarlyReview: false }), null, '未满 14 天不自动保温');
  eq(nextDueAt(state, [words[0]], now), now + DAY, '保温等待至 14 天边界');
  state.progress.a.lastSeen = now - 14 * DAY;
  eq(pickNext(state, [words[0]], now, { allowNew: false, allowEarlyReview: false }).mode, 'recycle', '14 天边界且 due 到期允许保温');
  eq(queueSummary(state, [words[0]], now).due, 1, '到期保温计入待复习');
  state.settings.recycleMastered = false;
  eq(nextDueAt(state, [words[0]], now), 0, '关闭保温不保留等待计划');
  eq(queueSummary(state, [words[0]], now).due, 0, '关闭保温不计待复习');
  eq(pickNext(state, [words[0]], now, { allowNew: false, recycleMastered: false, allowEarlyReview: false }), null, '关闭保温不会偷偷选已掌握词');
}

// 备份保留新统计与其完整性；不从旧备份凭空补分类，不回退任何已知计数。
{
  const date = stats.dayKey(Date.now());
  const cur = defaultState();
  const inc = defaultState();
  cur.stats[date] = { shown: 6, known: 2, snooze: 1, seconds: 8, newShown: 4, reviewAnswered: 2, newShownComplete: true, reviewAnsweredComplete: true };
  inc.stats[date] = { shown: 2, known: 0, snooze: 1, seconds: 2, newShown: 1, reviewAnswered: 1, newShownComplete: true, reviewAnsweredComplete: true };
  const merged = mergeState(cur, inc).state;
  eq(merged.stats[date].newShown, 5, '合并保留双方新词展示');
  eq(merged.stats[date].reviewAnswered, 3, '合并保留双方复习完成');
  eq(stats.today(merged, Date.now()).answered, 4, '合并后主动完成仍由作答总数派生');
  eq(merged.stats[date].newShownComplete, true, '双方都完整时合并分类仍完整');
  delete inc.stats[date].newShown;
  delete inc.stats[date].reviewAnswered;
  const legacyMerged = mergeState(cur, inc).state;
  eq(legacyMerged.stats[date].newShown, 4, '旧备份不能抹掉新词已知计数');
  eq(legacyMerged.stats[date].reviewAnswered, 2, '旧备份不能抹掉复习已知计数');
  eq(legacyMerged.stats[date].newShownComplete, false, '旧备份导致分类不完整如实标示');
  eq(legacyMerged.stats[date].reviewAnsweredComplete, false, '旧备份不伪造复习总数');
  eq(cur.stats[date].newShown, 4, '备份合并不原地改源状态');
}

{
  const state = defaultState();
  stats.bump(state, 'shown', { isNew: false, classificationKnown: false }, now);
  eq(stats.today(state, now).newShownComplete, false, '旧展示未提供模式时不能声称新词分类完整');
  stats.bump(state, 'shown', { isNew: true, mode: 'new' }, now);
  eq(stats.today(state, now).newShownComplete, false, '新展示不会抹去当日分类缺失');
  eq(stats.today(state, now).newShown, 1, '仍记录已知的新词展示部分');
}

console.log(`学习统计与复习边界：${checks} 项断言通过。`);
