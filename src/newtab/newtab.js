/**
 * 新标签页：展示与交互在页面内，取词与记账统一交给后台。
 * 卡片常驻，不启动网页浮层的倒计时；所有写入确认后再换卡。
 */
import { MESSAGES } from '../core/constants.js';
import { read, subscribe } from '../core/store.js';
import { buildView } from '../core/view.js';
import { createCard } from '../ui/card.js';

const SEARCH_URL = 'https://www.bing.com/search?q=';
const el = (id) => document.getElementById(id);
let state = null;
let card = null;
let busy = false;
let stopped = false;

async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || result?.reason || '后台暂时没有响应，请重试');
  return result;
}

function clearCard() {
  card?.destroy();
  card = null;
  el('ntCardSlot').replaceChildren();
}

function showEmpty(title, note) {
  clearCard();
  const box = document.createElement('div');
  box.className = 'nt__empty';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const text = document.createElement('span');
  text.textContent = note;
  box.append(heading, text);
  el('ntCardSlot').append(box);
}

function setBusy(value) {
  busy = value;
  el('ntNext').disabled = value;
  el('ntCardSlot').setAttribute('aria-busy', String(value));
}

async function refresh() {
  state = await read();
  if (!stopped) renderProgress();
}

async function nextCard() {
  if (busy || stopped) return;
  setBusy(true);
  try {
    clearCard();
    el('ntHint').textContent = '正在准备下一张…';
    const payload = await send(MESSAGES.REQUEST_CARD, { trigger: 'manual', manual: true });
    if (stopped) return;
    const shownAt = Date.now();
    card = createCard({
      word: payload.word,
      mode: payload.mode,
      settings: payload.settings,
      container: el('ntCardSlot'),
      countdown: false,
      onAction: async (action) => {
        setBusy(true);
        try {
          await send(MESSAGES.CARD_ACTION, {
            wordId: payload.word.id, mode: payload.mode, action, elapsedMs: Date.now() - shownAt,
          });
        } finally {
          setBusy(false);
        }
        await nextCard();
      },
      onSkip: async (reason) => {
        setBusy(true);
        try {
          await send(MESSAGES.CARD_DISMISSED, { wordId: payload.word.id, reason });
          if (stopped) return;
          showEmpty('给自己留一点空白。', '准备好了，就点下方「换一张」继续。');
          await refresh();
        } finally {
          if (!stopped) setBusy(false);
        }
      },
      onSpeak: (text) => chrome.runtime.sendMessage({ type: MESSAGES.SPEAK, text }),
      onPause: async () => {
        setBusy(true);
        try {
          await send(MESSAGES.PAUSE, { minutes: 60 });
          await refresh();
          if (!stopped) el('ntHint').textContent = '自动提醒已暂停 1 小时，这里仍然可以继续学习。';
        } finally {
          if (!stopped) setBusy(false);
        }
      },
    });
    card.setBusy(true);
    await send(MESSAGES.CARD_SHOWN, { wordId: payload.word.id, mode: payload.mode });
    await refresh();
    if (!stopped) card?.setBusy(false);
  } catch (error) {
    if (!stopped) {
      showEmpty('先歇一小会儿。', error.message || '暂时拿不到卡片，点「换一张」重试。');
      el('ntHint').textContent = '也可以在设置中检查词库与学习安排。';
    }
  } finally {
    if (!stopped) setBusy(false);
  }
}

function renderProgress() {
  if (!state) return;
  const view = buildView(state);
  el('ntToday').textContent = String(view.goalCount);
  el('ntGoal').textContent = String(view.goal);
  el('ntGoalMetric').textContent = '今日' + view.goalLabel + '目标';
  el('ntPercent').textContent = view.goalPercent + '%';
  el('ntGoalBar').value = view.goalPercent;
  el('ntStreak').textContent = String(view.streak);
  el('ntStreakLabel').textContent = view.goalMetric === 'answered' ? '连续作答' : '连续接触';
  el('ntDue').textContent = String(view.summary.due);
  el('ntMastered').textContent = String(view.summary.mastered);
  el('ntShown').textContent = String(view.today.shown);
  el('ntAnswered').textContent = String(view.today.answered);
  el('ntNewShown').textContent = view.today.newShownComplete ? String(view.today.newShown) : '—';
  el('ntReviewAnswered').textContent = view.today.reviewAnsweredComplete ? String(view.today.reviewAnswered) : '—';
  el('ntCategoryNote').hidden = view.today.newShownComplete && view.today.reviewAnsweredComplete;
  el('ntProgress').textContent = view.goalCount >= view.goal
    ? '今日目标已完成，积累正在发生。'
    : '还需' + view.goalLabel + ' ' + (view.goal - view.goalCount) + ' 张，完成今天的小目标。';
  el('ntWeekMetric').textContent = view.goalLabel + '张数';
  el('ntWeek').setAttribute('aria-label', '最近七天' + view.goalLabel + '记录');
  const ceiling = Math.max(view.goal, ...view.days.map((day) => day[view.goalMetric]), 1);
  const week = view.days.map((day, index) => {
    const item = document.createElement('div');
    item.className = 'nt__day' + (index === 6 ? ' nt__day--today' : '');
    const amount = day[view.goalMetric];
    const description = day.key + '：展示 ' + day.shown + ' 张，主动完成 ' + day.answered + ' 张';
    item.title = description;
    item.setAttribute('aria-label', description);
    const bar = document.createElement('span');
    bar.className = 'nt__day-bar';
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('i');
    fill.style.height = (amount / ceiling * 100) + '%';
    bar.append(fill);
    const value = document.createElement('span');
    value.className = 'nt__day-count';
    value.setAttribute('aria-hidden', 'true');
    value.textContent = String(amount);
    const label = document.createElement('span');
    label.setAttribute('aria-hidden', 'true');
    label.textContent = index === 6 ? '今天' : day.key.slice(5).replace('-', '/');
    item.append(value, bar, label);
    return item;
  });
  el('ntWeek').replaceChildren(...week);
  el('ntHint').textContent = !view.settings.enabled
    ? '自动提醒已关闭，你仍然可以在这里手动学习。'
    : view.runtime.pausedUntil > Date.now() ? view.status + '，这里仍然可以手动学习。' : '';
}

function renderDate() {
  el('ntDate').textContent = new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());
}

function openSearch(query) {
  const q = query.trim();
  if (!q) return;
  if (/^https?:\/\//i.test(q)) {
    location.href = q;
  } else if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q)) {
    location.href = 'https://' + q;
  } else {
    location.href = SEARCH_URL + encodeURIComponent(q);
  }
}

async function main() {
  renderDate();
  el('ntSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    openSearch(el('ntQuery').value);
  });
  el('ntNext').addEventListener('click', nextCard);
  el('ntStudy').addEventListener('click', async () => {
    const button = el('ntStudy');
    button.disabled = true;
    try {
      await send('ui:open-study');
    } catch {
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/study.html') });
      } catch {
        el('ntHint').textContent = '连学窗口未能打开，请稍后重试。';
      }
    } finally {
      button.disabled = false;
    }
  });
  el('ntOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage().catch(() => {
      el('ntHint').textContent = '设置页未能打开，请从扩展菜单重试。';
    });
  });
  const unsubscribe = subscribe((next) => {
    state = next;
    if (!stopped) renderProgress();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !stopped) {
      renderDate();
      refresh().catch(() => { el('ntHint').textContent = '进度暂时无法刷新，请稍后重试。'; });
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || stopped) return;
    renderDate();
    refresh().catch(() => { el('ntHint').textContent = '进度暂时无法刷新，请稍后重试。'; });
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    stopped = true;
    unsubscribe();
    card?.destroy();
  });
  try {
    await refresh();
    await nextCard();
  } catch {
    showEmpty('暂时无法读取学习进度', '请重新加载扩展后再试，已有数据不会在这里被重置。');
  }
  el('ntQuery').focus();
}

if (typeof document !== 'undefined') main();
