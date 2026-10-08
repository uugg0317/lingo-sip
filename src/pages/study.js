/** 独立连学窗：上一张的记账完成后，再请求下一张。 */
import { MESSAGES } from '../core/constants.js';
import { createCard } from '../ui/card.js';

function init() {
  const stage = document.getElementById('stage');
  const counterEl = document.getElementById('counter');
  const statusEl = document.getElementById('studyStatus');
  const nextBtn = document.getElementById('nextBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  let count = 0;
  let card = null;
  let busy = false;
  let disposed = false;
  let nextTimer = null;

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.reason || response?.error || '连接暂时中断，请重试');
    return response;
  }

  function updateControls() {
    nextBtn.disabled = busy || !!card || nextTimer !== null;
    pauseBtn.disabled = busy;
    stage.setAttribute('aria-busy', String(busy));
    counterEl.textContent = `本次完成 ${count} 张`;
  }

  function setStatus(message, error = false, state = error ? 'error' : 'ready') {
    statusEl.textContent = message;
    statusEl.classList.toggle('is-error', error);
    document.body.dataset.state = state;
  }

  function showEmpty(title, note = '') {
    const box = document.createElement('div');
    box.className = 'empty';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.textContent = note;
    box.append(heading, detail);
    stage.replaceChildren(box);
  }

  function scheduleNext() {
    clearTimeout(nextTimer);
    nextTimer = setTimeout(() => {
      nextTimer = null;
      next();
    }, 220);
    updateControls();
  }

  async function next() {
    if (busy || card || disposed) return;
    clearTimeout(nextTimer);
    nextTimer = null;
    busy = true;
    updateControls();
    setStatus('正在准备下一张…', false, 'loading');
    try {
      const payload = await request({ type: MESSAGES.REQUEST_CARD, trigger: 'manual', manual: true });
      if (disposed) return;
      stage.replaceChildren();
      card = createCard({
        word: payload.word,
        mode: payload.mode,
        settings: payload.settings,
        container: stage,
        presentation: 'study',
        onAction: async (action, elapsedMs) => {
          busy = true;
          updateControls();
          setStatus('正在保存学习记录…', false, 'loading');
          try {
            await request({ type: MESSAGES.CARD_ACTION, wordId: payload.word.id, mode: payload.mode, action, elapsedMs });
            if (disposed) return;
            card = null;
            count += 1;
            busy = false;
            setStatus(action === 'known' ? '已记录「记得了」，继续下一张。' : '已安排复习，继续下一张。');
            scheduleNext();
          } catch (error) {
            busy = false;
            updateControls();
            setStatus('记录未保存，请在卡片上重试。', true);
            throw error;
          }
        },
        onSkip: async (reason) => {
          busy = true;
          updateControls();
          try {
            await request({ type: MESSAGES.CARD_DISMISSED, wordId: payload.word.id, reason });
            if (disposed) return;
            card = null;
            busy = false;
            if (reason === 'close') {
              setStatus('这张先跳过，继续下一张。');
              scheduleNext();
            } else {
              showEmpty('休息一下也很好', '这张先放一放，准备好后点「再来一张」。');
              setStatus('未作答的卡片不会计为遗忘。', false, 'empty');
              updateControls();
            }
          } catch (error) {
            busy = false;
            updateControls();
            setStatus('暂时无法跳过，请重试。', true);
            throw error;
          }
        },
        onSpeak: (text) => chrome.runtime.sendMessage({ type: MESSAGES.SPEAK, text }),
        onPause: pauseAutomatic,
      });
      card.setBusy(true);
      // 确认本次展示已入账，再允许作答，保证 shown/action 的顺序。
      await request({ type: MESSAGES.CARD_SHOWN, wordId: payload.word.id, mode: payload.mode });
      if (disposed) return;
      card.setBusy(false);
      setStatus('1 记得了 · 2 稍后复习 · 3 看释义');
    } catch (error) {
      if (disposed) return;
      card?.destroy();
      card = null;
      showEmpty('暂时没有拿到卡片', error.message || '请稍后再试。');
      setStatus('点「再来一张」重新尝试。', true);
    } finally {
      busy = false;
      if (!disposed) updateControls();
    }
  }

  async function pauseAutomatic() {
    if (busy || disposed) return;
    clearTimeout(nextTimer);
    nextTimer = null;
    busy = true;
    card?.setBusy(true);
    updateControls();
    try {
      await request({ type: MESSAGES.PAUSE, minutes: 60 });
      if (disposed) return;
      card?.destroy();
      card = null;
      showEmpty('自动提醒已暂停', '1 小时内不再自动出现。想主动学习，随时点「再来一张」。');
      setStatus('主动学习不受自动提醒开关和暂停时间影响。', false, 'paused');
    } catch (error) {
      if (!disposed) setStatus('暂停未成功，请重试。', true);
      throw error;
    } finally {
      busy = false;
      card?.setBusy(false);
      if (!disposed) updateControls();
    }
  }

  function handleKey(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
    const path = event.composedPath?.() || [event.target];
    if (path.some((node) => node?.isContentEditable || node?.matches?.('input, textarea, select, button, a, [role="textbox"], [role="combobox"]'))) return;
    if ((event.key.toLowerCase() === 'n' || event.key === 'Enter') && !card && !busy) {
      event.preventDefault();
      next();
    }
    if (event.key === 'Escape' && !card && !busy) window.close();
  }

  function dispose(event) {
    if (event.persisted) return;
    disposed = true;
    clearTimeout(nextTimer);
    card?.destroy();
    card = null;
    window.removeEventListener('keydown', handleKey);
    window.removeEventListener('pagehide', dispose);
  }

  window.addEventListener('keydown', handleKey);
  window.addEventListener('pagehide', dispose);
  nextBtn.addEventListener('click', next);
  document.getElementById('closeBtn').addEventListener('click', () => window.close());
  pauseBtn.addEventListener('click', () => pauseAutomatic().catch(() => {}));
  // 这里是用户主动打开的学习窗，关闭自动卡片不应阻止手动学习。
  updateControls();
  next();
}

if (typeof document !== 'undefined') init();
