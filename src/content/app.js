/**
 * 页面侧内容脚本
 *
 * 只负责三件事：
 *   1. 判断"这个页面此刻适不适合出现卡片"（输入中、有选中文字、放视频、全屏 → 一律不打扰）
 *   2. 渲染卡片、把用户动作回传给后台
 *   3. 检测页面内的长时间停顿，主动向后台申请一张卡（后台仍有最终否决权）
 *
 * 它不做任何调度决策——决策权全部在 service worker，避免多个标签页各自为政。
 */

import { MESSAGES, MIN, STORAGE_KEY } from '../core/constants.js';
import { createCard } from '../ui/card.js';
import { speak as speakLocally } from '../core/tts.js';

/** 页面内停顿的检查周期（毫秒）。5 秒一次，开销可以忽略。 */
const IDLE_POLL = 5000;
/** 本页面两次主动申请之间的最小间隔，避免频繁打扰后台。 */
const ASK_COOLDOWN = 2 * MIN;

let current = null; // { controller, word }
let lastActivity = Date.now();
let lastAsk = 0;
let idleTimer = null;
let destroyed = false;
let started = false;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart', 'input', 'focusin'];

/**
 * 本地缓存的触发配置。
 * 内容脚本不该为了"要不要申请一张卡"就跑一趟 storage，所以只在启动和设置变更时同步一次。
 */
const localCfg = { triggerIdle: true, idleSeconds: 30 };

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
export async function start() {
  if (started || destroyed) return;
  if (window.top !== window) return; // 只在顶层文档工作
  if (!/^https?:$/i.test(location.protocol)) return;
  started = true;
  window.addEventListener('pagehide', dispose);
  window.addEventListener('pageshow', onPageShow);
  await syncLocalSettings();
  if (destroyed) return;
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onMessage);
  bindActivity();
  startIdleWatch();
}

function onStorageChanged(changes, area) {
  if (area === 'local' && changes[STORAGE_KEY]) syncLocalSettings();
}

function onMessage(msg, _sender, sendResponse) {
  if (msg?.type === MESSAGES.SHOW_CARD) {
    sendResponse(show(msg.payload?.word, msg.payload?.mode, msg.payload?.settings));
  } else if (msg?.type === MESSAGES.STOP_SPEAK) {
    current?.controller.destroy();
    current = null;
  }
  return false;
}

function onPageShow(event) {
  if (!event.persisted || destroyed) return;
  markActivity();
  syncLocalSettings();
}

function dispose(event) {
  // 页面缓存会保留整个脚本上下文；后退恢复时继续使用现有监听与卡片。
  if (event?.persisted) return;
  destroyed = true;
  clearInterval(idleTimer);
  current?.controller.destroy();
  current = null;
  for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, markActivity, true);
  window.removeEventListener('pagehide', dispose);
  window.removeEventListener('pageshow', onPageShow);
  try {
    chrome.storage.onChanged.removeListener(onStorageChanged);
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch { /* 扩展上下文失效时，本地清理仍已完成。 */ }
}

function syncLocalSettings() {
  return chrome.storage.local
    .get(STORAGE_KEY)
    .then((bag) => {
      const s = bag?.[STORAGE_KEY]?.settings || {};
      localCfg.triggerIdle = s.triggerIdle !== false;
      localCfg.idleSeconds = Number(s.idleSeconds) || 30;
    })
    .catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 页面是否"此刻适合"出现卡片
 * ------------------------------------------------------------------ */

/** @returns {string} 空字符串 = 可以出现；否则是不能出现的理由 */
function whyNotNow() {
  if (destroyed || !chrome.runtime?.id) return '扩展已更新，页面需要刷新';
  if (document.visibilityState !== 'visible') return '标签页不在前台';
  if (!document.hasFocus()) return '窗口未聚焦';
  if (document.fullscreenElement) return '页面处于全屏';
  if (isEditing()) return '正在输入内容';
  if (hasSelection()) return '正在选中文字';
  if (isPlayingMedia()) return '页面正在播放音视频';
  return '';
}

function isEditing() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

function hasSelection() {
  const sel = window.getSelection?.();
  return !!sel && !sel.isCollapsed && String(sel).trim().length > 0;
}

function isPlayingMedia() {
  const media = document.querySelectorAll('video, audio');
  for (const el of media) {
    if (!el.paused && !el.ended && el.currentTime > 0 && el.volume > 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 展示卡片
 * ------------------------------------------------------------------ */

function show(word, mode, settings) {
  if (!word) return { ok: false, reason: '没有词' };
  if (current) return { ok: false, reason: '页面上已经有一张卡片了' };

  const blocked = whyNotNow();
  if (blocked) return { ok: false, reason: blocked };

  const controller = createCard({
    word,
    mode,
    settings,
    container: document.documentElement,
    onAction: async (action, elapsedMs) => {
      await request({ type: MESSAGES.CARD_ACTION, wordId: word.id, mode, action, elapsedMs });
      if (current?.controller === controller) current = null;
    },
    onSkip: async (reason) => {
      await request({ type: MESSAGES.CARD_DISMISSED, wordId: word.id, reason });
      if (current?.controller === controller) current = null;
    },
    onSpeak: (text) => speak(text, settings),
    onPause: async () => {
      await request({ type: MESSAGES.PAUSE, minutes: 60 });
      controller.destroy();
      if (current?.controller === controller) current = null;
    },
  });

  // 浮层定位交给宿主元素的内联样式，卡片内部样式全部在 Shadow DOM 里
  Object.assign(controller.host.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    width: 'min(360px, calc(100vw - 40px))',
    maxHeight: 'calc(100vh - 40px)',
    overflowY: 'auto',
    zIndex: '2147483647',
    pointerEvents: 'auto',
  });

  current = { controller, word };

  // 展示回执完成前禁用作答，防止 action 比 shown 先入账。
  controller.setBusy(true);
  request({ type: MESSAGES.CARD_SHOWN, wordId: word.id, mode })
    .then(() => controller.setBusy(false))
    .catch(() => {
      controller.destroy();
      if (current?.controller === controller) current = null;
    });
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 页面停顿检测：长时间没有鼠标/键盘/滚动动作 → 可能是个空档
 * ------------------------------------------------------------------ */
function bindActivity() {
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, markActivity, { passive: true, capture: true });
  }
}

function markActivity() { lastActivity = Date.now(); }

function startIdleWatch() {
  idleTimer = setInterval(async () => {
    if (destroyed || current) return;
    if (!chrome.runtime?.id) {
      // 扩展被重新加载/卸载，这个脚本已经失效，安静退出
      dispose();
      return;
    }
    if (!localCfg.triggerIdle) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (isEditing() || hasSelection() || isPlayingMedia()) return;

    const now = Date.now();
    if (now - lastActivity < localCfg.idleSeconds * 1000) return;
    if (now - lastAsk < ASK_COOLDOWN) return;
    lastAsk = now;

    const blocked = whyNotNow();
    if (blocked) return;
    await requestCard('idle');
  }, IDLE_POLL);
}

async function requestCard(trigger, manual = false) {
  if (current) return null;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: MESSAGES.REQUEST_CARD, trigger, manual });
  } catch {
    return null; // 后台没起来或扩展已更新，静默放弃
  }
  if (!res || !res.ok) return null;
  const result = show(res.word, res.mode, res.settings);
  return result;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || response?.reason || '后台暂时不可用');
  return response;
}

/**
 * 发音：优先走后台的 chrome.tts（不受网页自动播放策略限制，最可靠）。
 * 万一后台不可用，再退回页面自带的 Web Speech API —— 点 🔊 本身就有用户手势，
 * 所以这条路在浏览器里也能出声。
 */
async function speak(text, settings) {
  try {
    const res = await chrome.runtime.sendMessage({ type: MESSAGES.SPEAK, text });
    if (res) return res;
  } catch {
    /* 后台不可达时才使用页面本机语音；明确的引擎失败不重复播放。 */
  }
  return speakLocally(text, settings);
}

/** 暴露给后台/调试用：当前页面是否已经有一张卡。 */
export function isBusy() {
  return !!current;
}
