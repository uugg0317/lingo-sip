/**
 * 后台 Service Worker：整个扩展的"大脑"和唯一决策点
 *
 * 职责：
 *  1. 捕捉可介入时机（切换标签 / 页面加载完成 / 页面内停顿 / 定时兜底 / 离开后回来 / 快捷键）
 *  2. 通过 scheduler.evaluate 做闸门判断，决定"现在到底能不能弹"
 *  3. 取词、下发卡片、接收页面回执、写入进度与统计
 *  4. 维护工具栏角标
 *
 * MV3 注意点：SW 随时会被浏览器回收，所以这里不保存任何"必须活下来"的状态，
 * 所有计数都落在 chrome.storage 里，任何时刻中断都能接着来。
 */

import { MESSAGES, MIN, DEV_RELOAD_PORT, DEV_POLL_MS } from '../core/constants.js';
import { read, update, updateSettings, logEvent, SKIP_WRITE, ensureSnapshot } from '../core/store.js';
import { evaluate } from '../core/scheduler.js';
import { pickNext, nextDueAt } from '../core/srs.js';
import * as stats from '../core/stats.js';
import { pool } from '../core/wordbank.js';
import { buildView } from '../core/view.js';
import { speak, listVoices, stop as stopSpeak } from '../core/tts.js';
import { showWordNotice, wordIdFromNotice, clearNotice, clearAllNotices } from '../core/notice.js';
import { createLearningSession } from './learning-session.js';
import { createDataHandlers } from './data-handlers.js';

const { recordShown, recordAction, recordDismissed, noticeMode } = createLearningSession({ refreshBadge, broadcastState });
const handleDataMessage = createDataHandlers({ refreshBadge, broadcastState, ensureAlarm });

const ALARM_TICK = 'lingoSip:tick';
/** 触发后的等待时间：刚切过去页面还在渲染，稍等一下再打扰才自然。 */
const DELAY_AFTER_SWITCH = 1200;
const DELAY_AFTER_LOAD = 1500;
/** 新标签页 / 空白页没有内容脚本，不用白费力气。 */
const WEB_URL = /^https?:\/\//i;
/** 同一条拦截原因的最小记录间隔：低于这个间隔不再重复写日志与落盘。 */
const BLOCK_LOG_INTERVAL = 10 * MIN;

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await update((s) => {
    stats.rollover(s, Date.now());
    if (details.reason === 'install') {
      s.settings.onboardingDone = false;
      s.settings.enabled = false;
      s.settings.notifyEnabled = false;
      s.settings.notifySound = false;
    }
    logEvent(s, details.reason === 'install' ? '扩展已安装' : '扩展已更新');
  });
  await ensureAlarm();
  await ensureIdleInterval();
  await refreshBadge();
  setupContextMenus();
  syncDevWatch();
  // 首次安装打开设置页：让用户第一眼就知道"节奏"和"免打扰"在哪里调
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await ensureIdleInterval();
  setupContextMenus();
  syncDevWatch();
  await update((s) => stats.rollover(s, Date.now()));
  await refreshBadge();
});

/* ------------------------------------------------------------------ *
 * 开发时自动重载
 *
 * 痛点：改完代码要手动去 edge://extensions 点"刷新"。
 * 做法：tools/watch.mjs 在本机起一个小 HTTP 服务，源码一变就把"代号"加一；
 *       这里轮询那个代号，发现变了就 chrome.runtime.reload() 自己刷新自己。
 *
 * 为什么是轮询而不是 WebSocket：MV3 的 service worker 会被回收，
 * 长连接要额外写重连与心跳；而这里只要一个"变了没"的信号，HTTP 足够。
 * 另外这个服务同时充当开关——脚本关掉后请求失败，就自动停止轮询，
 * 不会平白把后台唤醒（这点对 MV3 的耗电与生命周期都很重要）。
 *
 * 默认关闭（settings.devReload），打包时也会把 manifest 里的相关字段剥掉。
 * ------------------------------------------------------------------ */
let devTimer = null;

function stopDevWatch() {
  if (devTimer) {
    clearInterval(devTimer);
    devTimer = null;
  }
}

async function syncDevWatch() {
  const state = await read();
  if (!state.settings.devReload) {
    stopDevWatch();
    return;
  }
  if (devTimer) return;
  devTimer = setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${DEV_RELOAD_PORT}/token`, { cache: 'no-store' });
      if (!res.ok) return;
      const { token } = await res.json();
      const s = await read();
      const seen = s.runtime.devToken;
      if (seen === undefined) {
        // 第一次先记下当前代号，避免一打开就无谓地重载一次
        await update((x) => {
          x.runtime.devToken = token;
        });
        return;
      }
      if (token === seen) return;
      // 防循环：万一服务端代号异常变化，也不要在短时间内反复重载
      if (Date.now() - (s.runtime.devReloadAt || 0) < 3000) return;
      await update((x) => {
        x.runtime.devToken = token;
        x.runtime.devReloadAt = Date.now();
        logEvent(x, `开发重载：代号 ${token}`);
      });
      chrome.runtime.reload();
    } catch {
      // 监听脚本没在跑（或已退出）：停下来，等下次启动再试
      stopDevWatch();
    }
  }, DEV_POLL_MS);
}

/** 打开连学窗（小窗口，可连着学）。通知点击与右键菜单共用。
    尺寸 480×580：原先 420×460 时卡片加上底栏会显得挤，
    舞台的上下留白被压到几乎没有。 */
async function openStudyWindow() {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/pages/study.html'),
      type: 'popup',
      width: 480,
      height: 580,
      focused: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 右键菜单：给"我现在想学"提供主动入口。
 *
 * 为什么是右键而不是抢占新标签页——主动入口的摩擦接近 0（本来就要点右键），
 * 而且用户意图明确，不需要任何时机判断。菜单不会重复注册（removeAll 先清）。
 */
const MENU_CARD = 'lingoSip:card-now';
const MENU_STUDY = 'lingoSip:study-window';

function setupContextMenus() {
  const api = chrome.contextMenus;
  if (!api?.create) return;
  // 先查再建，避免扩展更新时重复调用 create 造成 id 冲突
  api.removeAll(() => {
    api.create({
      id: MENU_CARD,
      title: '语滴：立即学一张',
      contexts: ['page', 'selection', 'link'],
    });
    api.create({
      id: MENU_STUDY,
      title: '语滴：打开连学窗',
      contexts: ['page', 'selection', 'link'],
    });
  });
}

chrome.contextMenus?.onClicked.addListener(async (info) => {
  const menuItemId = String(info.menuItemId);
  if (menuItemId === MENU_STUDY) {
    await openStudyWindow();
    return;
  }
  if (menuItemId !== MENU_CARD) return;
  // 走和快捷键同一条路径：manual 会跳过冷却与配额，但仍然尊重"暂停"
  const tabId = info.tab?.id ?? (await getActiveTab())?.id;
  if (!tabId) return;
  await considerShow({ tabId, trigger: 'contextmenu', manual: true });
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_TICK).catch(() => null);
  if (!existing) chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1, delayInMinutes: 1 });
}

async function ensureIdleInterval() {
  try {
    chrome.idle.setDetectionInterval(60); // 秒；60 秒无输入即视为 idle
  } catch {
    /* 某些环境不支持 idle，忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 触发器
 * ------------------------------------------------------------------ */

// 触发去抖：同一标签页同一类触发，短时间内只算一次
const pending = new Map();

function scheduleConsider(tabId, trigger, delay = 0) {
  const key = `${tabId}:${trigger}`;
  const old = pending.get(key);
  if (old) clearTimeout(old);
  const id = setTimeout(async () => {
    pending.delete(key);
    await considerShow({ tabId, trigger });
  }, delay);
  pending.set(key, id);
}

/** 切换标签：最典型的"任务间隙"，也是本扩展最主要的介入点。 */
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const state = await read();
  if (!state.settings.enabled || !state.settings.triggerTabSwitch) return;
  scheduleConsider(tabId, 'tab-switch', DELAY_AFTER_SWITCH);
});

/** 页面加载完成：等待结束的那一瞬间。 */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab || !WEB_URL.test(tab.url || '')) return;
  const state = await read();
  if (!state.settings.enabled || !state.settings.triggerPageLoad) return;
  scheduleConsider(tabId, 'page-load', DELAY_AFTER_LOAD);
});

/** 标签关闭：顺手清掉单页冷却记录，避免 tabId 复用导致误判。 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await update((s) => {
    delete s.runtime.tabShown[String(tabId)];
  }).catch(() => {});
});

/** 离开电脑后回来：默认关闭（最谨慎的一类时机）。 */
chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState !== 'active') return;
  const state = await read();
  if (!state.settings.enabled || !state.settings.triggerReturn) return;
  const tab = await getActiveTab();
  if (!tab || !WEB_URL.test(tab.url || '')) return;
  scheduleConsider(tab.id, 'return', 2000);
});

/** 定时兜底：长时间没有自然时机时，轻轻提醒一次。 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_TICK) return;

  // 跨天/跨小时时才需要落盘；绝大多数 tick 什么都不用做（原来无条件写一次全量状态）
  const rolledOver = await update((s) => {
    const beforeDay = s.runtime.dayKey;
    const beforeHour = s.runtime.hourKey;
    stats.rollover(s, Date.now());
    if (beforeDay === s.runtime.dayKey && beforeHour === s.runtime.hourKey) return SKIP_WRITE;
    return beforeDay !== s.runtime.dayKey;
  });
  if (rolledOver) {
    // 新的一天：留一份自动备份快照。没人会记得手动导出，所以让它自己发生。
    await ensureSnapshot().catch(() => {});
    await refreshBadge();
  }

  const state = await read();
  if (!state.settings.enabled) return;

  const tab = await getActiveTab();
  const focused = tab ? await isWindowFocused(tab) : false;

  // 浏览器不在前台（最小化 / 被别的软件盖住 / 你在桌面上）：
  // 卡片浮层没地方画，改走系统通知——那是唯一能到桌面的通道。
  if (!focused) {
    await maybeNotify(state);
    return;
  }

  if (!tab || !WEB_URL.test(tab.url || '')) return;
  if (!state.settings.triggerTimer) return;
  if (Date.now() - (state.runtime.lastShownAt || 0) < state.settings.timerMinutes * MIN) return;
  scheduleConsider(tab.id, 'timer', 0);
});

/** 快捷键：立刻来一张（用户主动，跳过冷却与配额）。 */
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'show-card-now') return;
  const tab = await getActiveTab();
  if (!tab) return;
  await considerShow({ tabId: tab.id, trigger: 'shortcut', manual: true });
});

/* ------------------------------------------------------------------ *
 * 决策与下发
 * ------------------------------------------------------------------ */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 核心决策：能不能弹？弹哪个词？
 * 不产生任何副作用（不记账、不改计数器），记账统一发生在页面回执 CARD_SHOWN 时。
 */
async function decide({ tabId = null, url = '', manual = false } = {}) {
  const now = Date.now();
  const state = await read();
  stats.rollover(state, now);

  const gate = evaluate(state, { now, url, hostname: safeHost(url), tabId, manual, isNew: false });
  if (!gate.allowed) return { ok: false, reason: gate.reason };

  const words = pool(state);
  if (words.length === 0) return { ok: false, reason: '词库为空：去设置页启用分类或导入词表' };

  const newLeft = Math.max(0, (state.settings.maxNewPerDay || 0) - state.runtime.newCount);
  const picked = pickNext(state, words, now, {
    allowNew: newLeft > 0, // 新词额度用完就只复习，不硬塞新词
    recycleMastered: state.settings.recycleMastered,
    avoidId: state.runtime.lastWordId,
    allowEarlyReview: manual,
  });
  if (!picked) {
    const dueAt = nextDueAt(state, words, now);
    const reason = dueAt
      ? `现在没有到期词，下一次复习约在 ${new Date(dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '暂时没有需要出现的词，可以添加词条或调整启用的分类。';
    return { ok: false, reason, nextDueAt: dueAt };
  }

  return {
    ok: true,
    word: picked.word,
    mode: picked.mode,
    settings: state.settings,
    summary: { newLeft: picked.mode === 'new' ? newLeft - 1 : newLeft },
  };
}

/** 由后台主动发起：用于切换标签 / 加载完成 / 定时兜底等场景。 */
async function considerShow({ tabId, trigger, manual = false }) {
  const tab = await getTab(tabId);
  if (!tab || !WEB_URL.test(tab.url || '')) return;

  // 只在"用户正在看的那个标签页"上出现，避免后台标签页突然冒东西
  if (!manual) {
    const active = await getActiveTab();
    if (!active || active.id !== tabId) return;
    // 浏览器窗口本身没在前台（被最小化、或被别的应用盖住）时直接放弃。
    // 少了这道判断：chrome.tabs.query 仍会返回"活动标签页"，于是白跑一趟
    // 内容脚本、拿到一句"标签页不在前台"，还每次都记一条日志。
    if (!(await isWindowFocused(tab))) return;
  }

  const result = await decide({ tabId, url: tab.url, manual });
  if (!result.ok) {
    await noteBlocked(result.reason, trigger);
    return;
  }

  try {
    const reply = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGES.SHOW_CARD,
      payload: { word: result.word, mode: result.mode, settings: result.settings },
    });
    if (!reply || !reply.ok) {
      await noteBlocked(reply?.reason || '页面暂不接受卡片', trigger);
    }
  } catch {
    // 内容脚本还没注入（例如扩展刚安装、页面未刷新），或是不允许注入的页面
    await noteBlocked('当前页面暂不支持（扩展安装后新开或刷新页面即可）', trigger);
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/** 该标签页所在的浏览器窗口此刻是否真的处于前台。 */
async function isWindowFocused(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    return win?.focused === true;
  } catch {
    return false; // 查不到就当作没聚焦，宁可不打扰
  }
}

/* ------------------------------------------------------------------ *
 * 桌面通知：浏览器不在前台时唯一能到达桌面的通道
 * ------------------------------------------------------------------ */

/**
 * 浏览器不在前台时（最小化、被别的软件盖住、你在桌面上），
 * 卡片浮层没地方画，改用系统通知把单词送到 Windows 通知中心。
 *
 * 与卡片共用同一套闸门（暂停、安静时段、免打扰名单、每日配额、冷却）和
 * 同一套间隔重复；但通知有自己的最小间隔（默认 30 分钟），
 * 因为"你在干别的活"时被频繁打断，比在浏览器里被打断更烦。
 */
async function maybeNotify(state) {
  const s = state.settings;
  if (!s.notifyEnabled) return;

  const now = Date.now();
  const gap = Math.max(5, Number(s.notifyMinutes) || 30) * MIN;
  if (now - (state.runtime.lastNotifiedAt || 0) < gap) return; // 距上一条通知还不够久
  if (now - (state.runtime.lastShownAt || 0) < gap) return; // 刚在浏览器里学过，别重复打扰

  const result = await decide({ tabId: null, url: '', manual: false });
  if (!result.ok) return; // 暂停期 / 安静时段 / 配额用完，都在这里被挡下

  const ok = await showWordNotice(result.word, result.mode, { sound: s.notifySound });
  if (!ok) return; // 系统拒绝了通知，不记账、不消耗配额

  // 通知同样算一次"展示"：计入统计、更新 lastShownAt，避免和卡片重复打扰
  await recordShown({ wordId: result.word.id, mode: result.mode }, null, {
    lastNotifiedAt: now,
    lastNoticeWordId: result.word.id,
    lastNoticeMode: result.mode,
  });
  await refreshBadge();
  broadcastState();
}

/**
 * 已经被处理过的通知 id。
 * 点按钮会先触发 onButtonClicked，紧接着系统还会补一次 onClosed；
 * 不去重的话，"已掌握"会被随后的"见过"覆盖掉，盒子推进就白做了。
 */
const handledNotices = new Set();

/** 点通知上的按钮 = 直接作答，和卡片上的按钮完全等价。 */
chrome.notifications?.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  // 先标记"已处理"：点按钮后系统通常还会补一次 onClosed，
  // 不先标记，作答会被随后的"见过"覆盖掉。
  handledNotices.add(notificationId);
  if (handledNotices.size > 100) handledNotices.clear();
  const wordId = wordIdFromNotice(notificationId);
  try {
    if (wordId) {
      const mode = await noticeMode(wordId);
      await recordAction({ wordId, action: buttonIndex === 0 ? 'known' : 'snooze', mode });
    }
    // 测试通知（wordId 为空）不记账；无论哪一种，finally 都会把通知关掉，
    // 保证按钮点下去一定有反馈，不会让用户觉得"按钮失灵"。
  } catch {
    /* 记账失败也继续往下，至少把通知关闭 */
  } finally {
    await clearNotice(notificationId);
  }
});

/** 点通知本体 = 想学，打开连学窗。 */
chrome.notifications?.onClicked.addListener(async (notificationId) => {
  if (!wordIdFromNotice(notificationId)) return;
  handledNotices.add(notificationId);
  await clearNotice(notificationId);
  await openStudyWindow();
});

/** 通知被划掉或超时消失 = 和卡片超时一致，只算"见过"，不算答错。 */
chrome.notifications?.onClosed.addListener(async (notificationId) => {
  if (handledNotices.delete(notificationId)) return; // 已被按钮 / 点击处理过
  const wordId = wordIdFromNotice(notificationId);
  if (wordId) await recordDismissed({ wordId }, 'notice-closed');
});

/**
 * 拦截原因的"类别"。
 *
 * 像"冷却中，206 秒后可出现"、"暂停中，还有 27 分钟"这种原因里带着倒计时，
 * 数字每一秒都在变。如果拿整句去重，节流会被倒计时轻易绕过——每切一次标签
 * 就写一次盘、刷一条日志。所以只取第一个逗号之前的稳定部分作为去重依据。
 */
function blockKey(text) {
  return String(text).replace(/^未展示：/, '').split('，')[0];
}

/** 记录"为什么没弹"，设置页会展示，方便用户理解与调参。 */
async function noteBlocked(reason, trigger) {
  if (!reason) return;
  const text = `${reason} · ${triggerLabel(trigger)}`;
  const now = Date.now();
  const key = blockKey(reason);
  await update((s) => {
    const last = s.runtime.log[s.runtime.log.length - 1];
    // 同一类原因刚记过就整条跳过：连日志带写盘一起省掉。
    // 浏览器不在前台、或一直处在冷却期时，触发会一次次撞同一堵墙，
    // 不拦的话日志会被刷满（诊断面板直接失效），而且每次都落一次盘。
    if (last && blockKey(last.text) === key && now - last.ts < BLOCK_LOG_INTERVAL) {
      return SKIP_WRITE;
    }
    s.runtime.lastBlockReason = text;
    logEvent(s, `未展示：${reason}`);
  }).catch(() => {});
}

function triggerLabel(trigger) {
  return (
    {
      'tab-switch': '切换标签时',
      'page-load': '页面加载完成时',
      idle: '页面停顿',
      timer: '定时兜底',
      return: '回到电脑',
      shortcut: '快捷键',
      manual: '手动',
    }[trigger] || trigger
  );
}

/* ------------------------------------------------------------------ *
 * 角标
 * ------------------------------------------------------------------ */

async function refreshBadge() {
  try {
    const state = await read();
    const s = state.settings;
    if (!s.enabled || s.showBadge === 'off') {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const view = buildView(state);
    let text = '';
    let color = '#4f5bd5';

    if (s.showBadge === 'today') {
      text = String(view.goalCount);
      if (view.goalCount >= view.goal) color = '#12a150';
    } else {
      const n = view.pending;
      text = n > 99 ? '99+' : n > 0 ? String(n) : '✓';
      if (n === 0) color = '#12a150';
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* 角标失败不影响主流程 */
  }
}

/** 通知所有已打开的 popup / 设置页 / 学习窗刷新界面。 */
function broadcastState() {
  chrome.runtime.sendMessage({ type: MESSAGES.STATE_CHANGED }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => sendResponse(res || { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // 保持通道打开，异步回复
});

async function handleMessage(msg, sender) {
  const dataResult = await handleDataMessage(msg);
  if (dataResult) return dataResult;
  const type = msg?.type;
  switch (type) {
    /* —— 页面说"现在有空，来一张"（页面内停顿触发） —— */
    case MESSAGES.REQUEST_CARD: {
      const tabId = sender?.tab?.id ?? msg.tabId ?? null;
      const url = sender?.tab?.url || msg.url || '';
      const result = await decide({
        tabId,
        url,
        manual: !!msg.manual,
      });
      if (!result.ok) {
        await noteBlocked(result.reason, msg.trigger || 'idle');
        return { ok: false, reason: result.reason, nextDueAt: result.nextDueAt || 0 };
      }
      return {
        ok: true,
        word: result.word,
        mode: result.mode,
        settings: result.settings,
      };
    }

    /* —— 页面确认卡片已展示 —— */
    case MESSAGES.CARD_SHOWN: {
      await recordShown({ wordId: msg.wordId, mode: msg.mode }, sender?.tab?.id);
      await refreshBadge();
      broadcastState();
      return { ok: true };
    }

    /* —— 用户作答 —— */
    case MESSAGES.CARD_ACTION: {
      const info = await recordAction({
        wordId: msg.wordId,
        action: msg.action,
        elapsedMs: msg.elapsedMs || 0,
        mode: msg.mode,
      });
      return { ok: true, ...info };
    }

    /* —— 卡片消失但没作答 —— */
    case MESSAGES.CARD_DISMISSED: {
      await recordDismissed({ wordId: msg.wordId }, msg.reason || 'timeout');
      return { ok: true };
    }

    /* —— 暂停 / 恢复 —— */
    case MESSAGES.PAUSE: {
      const minutes = Number(msg.minutes) || 60;
      await update((s) => {
        s.runtime.pausedUntil = Date.now() + minutes * MIN;
        logEvent(s, `已暂停 ${minutes} 分钟`);
      });
      broadcastState();
      return { ok: true, pausedUntil: Date.now() + minutes * MIN };
    }
    case MESSAGES.RESUME: {
      await update((s) => {
        s.runtime.pausedUntil = 0;
        logEvent(s, '已恢复');
      });
      broadcastState();
      return { ok: true };
    }

    /* —— 设置页的"发一条测试通知" —— */
    case MESSAGES.NOTIFY_TEST: {
      const state = await read();
      const result = await decide({ tabId: null, url: '', manual: true });
      if (!result.ok) return { ok: false, reason: result.reason };
      const ok = await showWordNotice(result.word, 'review', {
        test: true,
        sound: state.settings.notifySound,
      });
      return {
        ok,
        word: result.word.term,
        reason: ok
          ? ''
          : '系统没有接受这条通知。检查「Windows 设置 → 系统 → 通知」里 Microsoft Edge 是否被允许，以及是否开了专注助手。',
      };
    }

    /* —— 设置 —— */
    case MESSAGES.SET_SETTINGS: {
      await updateSettings(msg.patch || {});
      // 关掉桌面提醒时，顺手把已经挂在屏幕上的通知收掉
      if (msg.patch && msg.patch.notifyEnabled === false) await clearAllNotices();
      await refreshBadge();
      broadcastState();
      return { ok: true };
    }

    /* —— 词库变了 —— */
    case MESSAGES.BANK_CHANGED: {
      await refreshBadge();
      broadcastState();
      return { ok: true };
    }

    /* —— 发音 —— */
    case MESSAGES.SPEAK: {
      const state = await read();
      const res = await speak(msg.text, {
        voiceLang: msg.voiceLang || state.settings.voiceLang,
        speechRate: msg.rate ?? state.settings.speechRate,
        voiceName: msg.voiceName ?? state.settings.voiceName,
      });
      return res;
    }
    case MESSAGES.LIST_VOICES: {
      return { ok: true, voices: await listVoices() };
    }
    case MESSAGES.STOP_SPEAK: {
      await stopSpeak();
      return { ok: true };
    }

    /* —— 开发 —— */
    case 'dev:sync': {
      await syncDevWatch();
      return { ok: true, active: !!devTimer };
    }
    /* —— 界面请求打开连学窗 ——
       统一走 openStudyWindow，保证"连学窗"在任何入口下都是小窗口，
       而不是把当前标签页导航走（新标签页上曾经就是这么错的）。 */
    case 'ui:open-study': {
      const opened = await openStudyWindow();
      return { ok: opened };
    }

    default:
      return { ok: false, error: `未知消息类型：${type}` };
  }
}
