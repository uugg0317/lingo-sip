/**
 * 视图模型：把原始状态整理成界面（popup / options / 角标）直接能用的形状
 *
 * 抽出来单独放，是为了让三个界面 + 后台角标用的是同一套口径，
 * 不会出现"popup 说还剩 5 个、角标显示 7"这种不一致。
 */

import { pool, builtinTags } from './wordbank.js';
import { queueSummary, nextDueAt } from './srs.js';
import { describeState } from './scheduler.js';
import * as stats from './stats.js';

export function buildView(state, now = Date.now()) {
  const words = pool(state);
  const summary = queueSummary(state, words, now);
  const today = stats.today(state, now);
  const goal = Math.max(1, state.settings.dailyGoal || 1);
  const newLeft = Math.max(0, (state.settings.maxNewPerDay || 0) - state.runtime.newCount);
  const goalMetric = stats.goalMetric(state);
  const goalCount = today[goalMetric];
  const shownStreak = stats.streak(state, now);
  const answeredStreak = stats.answeredStreak(state, now);

  return {
    settings: state.settings,
    runtime: state.runtime,
    summary,
    today,
    goal,
    goalMetric,
    goalCount,
    goalLabel: goalMetric === 'answered' ? '作答' : '展示',
    goalPercent: Math.min(100, Math.round((goalCount / goal) * 100)),
    streak: goalMetric === 'answered' ? answeredStreak : shownStreak,
    shownStreak,
    answeredStreak,
    days: stats.lastDays(state, 7, now),
    status: describeState(state, now),
    pending: summary.due + Math.min(summary.fresh, newLeft),
    newLeft,
    nextDueAt: nextDueAt(state, words, now),
    customCount: state.customWords.length,
    tags: builtinTags(),
    activeTags: state.settings.bankTags || [],
  };
}
