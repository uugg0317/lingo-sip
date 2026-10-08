/** 学习记账：展示、作答与消失共用同一个串行存储入口。 */
import { MIN } from '../core/constants.js';
import { read, update, logEvent } from '../core/store.js';
import { grade, recordOf } from '../core/srs.js';
import * as stats from '../core/stats.js';
import { canonicalWordId } from '../core/wordbank.js';

const KNOWN_MODES = new Set(['new', 'review', 'recycle', 'early']);

/** UI 副作用注入；每个操作只持有一次 store.update，不在锁里嵌套写操作。 */
export function createLearningSession({ refreshBadge, broadcastState, now = Date.now }) {
  /** 卡片真正显示后才消耗配额；通知可同时保存自己的明示模式。 */
  async function recordShown({ wordId, mode }, tabId, extra = null) {
    const timestamp = now();
    return update((state) => {
      stats.rollover(state, timestamp);
      const id = canonicalWordId(state, wordId);
      const rec = recordOf(state, id, timestamp);
      rec.seen = (rec.seen || 0) + 1;
      rec.lastSeen = timestamp;
      if (rec.status === 'new') rec.status = 'learning';
      // 展示过但没作答的词，至少 20 分钟后才再出现。
      if (!rec.due || rec.due <= timestamp) rec.due = timestamp + 20 * MIN;
      state.progress[id] = rec;
      state.runtime.lastShownAt = timestamp;
      state.runtime.lastWordId = id;
      if (tabId != null) state.runtime.tabShown[String(tabId)] = timestamp;
      if (extra) {
        Object.assign(state.runtime, extra);
        if (Object.hasOwn(extra, 'lastNoticeWordId')) {
          state.runtime.lastNoticeWordId = canonicalWordId(state, extra.lastNoticeWordId);
          state.runtime.lastNoticeMode = KNOWN_MODES.has(extra.lastNoticeMode) ? extra.lastNoticeMode : '';
        }
      }
      stats.bump(state, 'shown', { isNew: mode === 'new', mode, classificationKnown: KNOWN_MODES.has(mode) }, timestamp);
      logEvent(state, `展示 ${id}（${mode}）`);
    });
  }

  /** 用户作答，明示 mode 才加入新词/复习分类，不推测旧卡片。 */
  async function recordAction({ wordId, action, elapsedMs = 0, mode }) {
    const timestamp = now();
    const result = await update((state) => {
      stats.rollover(state, timestamp);
      const id = canonicalWordId(state, wordId);
      const rec = grade(recordOf(state, id, timestamp), action, timestamp);
      rec.lastSeen = timestamp;
      state.progress[id] = rec;
      stats.bump(state, action === 'known' ? 'known' : 'snooze', {
        seconds: Math.max(0, Math.min(Number(elapsedMs) || 0, 60000)) / 1000,
        mode,
      }, timestamp);
      logEvent(state, action === 'known' ? `记得了 ${id}` : `稍后复习 ${id}`);
      return { box: rec.box, status: rec.status };
    });
    await refreshBadge();
    broadcastState();
    return result;
  }

  /** 卡片消失只调整下次复习时间；展示已经记过，不重复累加统计。 */
  async function recordDismissed({ wordId }, reason) {
    const timestamp = now();
    await update((state) => {
      stats.rollover(state, timestamp);
      const id = canonicalWordId(state, wordId);
      const rec = grade(recordOf(state, id, timestamp), 'seen', timestamp);
      rec.lastSeen = timestamp;
      state.progress[id] = rec;
      logEvent(state, `跳过 ${id}（${reason}）`);
    });
    await refreshBadge();
    broadcastState();
  }

  /** SW 重启后仍可认出最后一条通知；旧通知无明示模式时返回 undefined。 */
  async function noticeMode(wordId) {
    const state = await read();
    const id = canonicalWordId(state, wordId);
    const lastId = canonicalWordId(state, state.runtime.lastNoticeWordId);
    return id && lastId === id && KNOWN_MODES.has(state.runtime.lastNoticeMode)
      ? state.runtime.lastNoticeMode : undefined;
  }

  return { recordShown, recordAction, recordDismissed, noticeMode };
}
