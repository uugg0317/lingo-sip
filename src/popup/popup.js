/** 工具栏面板：订阅实际进度，所有操作提供成功或失败反馈。 */
import { MESSAGES, PAUSE_OPTIONS } from '../core/constants.js';
import { read, subscribe } from '../core/store.js';
import { buildView } from '../core/view.js';

const el = (id) => document.getElementById(id);
const RING_LENGTH = 2 * Math.PI * 18;
let pauseKey = null;

function render(state) {
  const view = buildView(state);
  el('status').textContent = view.status;
  el('todayCount').textContent = String(view.goalCount);
  el('todayCount').classList.toggle('is-large', String(view.goalCount).length > 4);
  el('goalMetric').textContent = '今日' + view.goalLabel + '目标';
  el('goalCount').textContent = '/' + view.goal;
  el('ringFg').style.strokeDashoffset = String(RING_LENGTH * (1 - view.goalPercent / 100));
  el('ring').setAttribute('aria-valuenow', String(view.goalPercent));
  el('ring').setAttribute('aria-valuetext', '今日' + view.goalLabel + ' ' + view.goalCount + ' 张，目标 ' + view.goal + ' 张');
  el('progressLine').textContent = view.goalCount === 0 ? '从今天的第一次' + view.goalLabel + '开始'
    : view.goalCount >= view.goal ? '今日目标已完成'
    : '还需' + view.goalLabel + ' ' + (view.goal - view.goalCount) + ' 张';
  const streakLabel = view.goalMetric === 'answered' ? '连续作答' : '连续接触';
  el('streakLine').textContent = view.streak > 0
    ? streakLabel + ' ' + view.streak + ' 天，慢慢来就很好'
    : '词库里的 ' + view.summary.total + ' 个表达，等你发现';
  el('shownToday').textContent = String(view.today.shown);
  el('answeredToday').textContent = String(view.today.answered);
  el('newShownToday').textContent = view.today.newShownComplete ? String(view.today.newShown) : '—';
  el('reviewAnsweredToday').textContent = view.today.reviewAnsweredComplete ? String(view.today.reviewAnswered) : '—';
  el('categoryNote').hidden = view.today.newShownComplete && view.today.reviewAnsweredComplete;
  el('dueCount').textContent = String(view.summary.due);
  el('newCount').textContent = String(Math.min(view.summary.fresh, view.newLeft));
  el('masteredCount').textContent = String(view.summary.mastered);
  el('enabled').checked = !!view.settings.enabled;
  const pausedUntil = view.runtime.pausedUntil > Date.now() ? view.runtime.pausedUntil : 0;
  // 不重建未变化的按钮，保留键盘焦点。
  if (pauseKey === pausedUntil) return;
  pauseKey = pausedUntil;
  const box = el('pauseChips');
  box.replaceChildren();
  const options = pausedUntil ? [{
    label: '暂停至 ' + new Date(pausedUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' · 恢复',
    minutes: null,
  }] : PAUSE_OPTIONS;
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip' + (pausedUntil ? ' active' : '');
    button.textContent = option.label;
    button.addEventListener('click', () => run(button, async () => {
      await send(pausedUntil ? MESSAGES.RESUME : MESSAGES.PAUSE, { minutes: option.minutes });
      render(await read());
    }));
    box.append(button);
  }
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || '操作尚未完成，请重试');
  return response;
}

async function run(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  el('feedback').textContent = '';
  try {
    await action();
  } catch (error) {
    el('feedback').textContent = error.message || '操作失败，请稍后重试。';
    try { render(await read()); } catch { /* 保留错误供用户重试 */ }
  } finally {
    button.disabled = false;
  }
}

async function main() {
  el('enabled').addEventListener('change', () => {
    const enabled = el('enabled').checked;
    run(el('enabled'), () => send(MESSAGES.SET_SETTINGS, { patch: { enabled } }));
  });
  el('studyNow').addEventListener('click', () => run(el('studyNow'), async () => {
    const url = chrome.runtime.getURL('src/pages/study.html');
    try {
      await chrome.windows.create({ url, type: 'popup', width: 480, height: 580, focused: true });
    } catch {
      await chrome.tabs.create({ url });
    }
    window.close();
  }));
  el('openOptions').addEventListener('click', () => run(el('openOptions'), async () => {
    await chrome.runtime.openOptionsPage();
    window.close();
  }));
  el('openLog').addEventListener('click', () => run(el('openLog'), async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#diagnostics') });
    window.close();
  }));
  const refresh = async () => {
    try { render(await read()); }
    catch { el('feedback').textContent = '无法读取进度，请重新加载扩展后再试。'; }
  };
  const unsubscribe = subscribe(render);
  const timer = setInterval(refresh, 30 * 1000);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) refresh();
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    clearInterval(timer);
    unsubscribe();
  });
  await refresh();
}

if (typeof document !== 'undefined') main();
