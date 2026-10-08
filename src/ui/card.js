/**
 * 单词卡片视图（唯一的一份卡片实现）
 *
 * 三个地方共用：页面右下角浮层（content script）、弹窗、独立学习窗。
 * 全部渲染在 Shadow DOM 里，配合 :host { all: initial } 彻底隔离宿主页面样式，
 * 既不会被网站 CSS 弄坏，也不会污染网站。
 *
 * 交互约定（10~30 秒内可完成）：
 *   · 鼠标移上去自动暂停倒计时，慢慢看不会被催
 *   · 1 / 点按钮 = 记得了、2 = 稍后复习、空格 = 发音、Esc = 跳过、3 = 看释义
 *   · 没人操作就淡出，不算遗忘、不扣分
 */

/** 卡片右上角的模式标签。 */
export const MODE_LABELS = {
  new: '新词',
  review: '复习',
  recycle: '保温',
  early: '提前练习',
};

// 多张预览卡共存时，只让最后创建或最近交互的那张响应快捷键。
let keyboardHost = null;

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) {
    svg.setAttribute(name, value);
  }
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

/**
 * 把样式塞进 Shadow Root。
 *
 * 必须优先用「构造式样式表」（new CSSStyleSheet + adoptedStyleSheets）：
 * 很多网站（GitHub、Google 系、各家网银）都有严格的 style-src CSP，
 * 它们会直接拒绝内容脚本插入的 <style> 元素，导致卡片变成一堆裸文字。
 * 构造式样式表不经过文档的 CSP 检查，是扩展场景下唯一稳妥的做法；
 * 浏览器太老不支持时才回退到 <style>。
 */
function applyStyles(root, css) {
  try {
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root && 'replaceSync' in CSSStyleSheet.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
}

/** 极简 DOM 构造器：文本一律走 textContent，杜绝自定义词条里的 HTML 注入。 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/**
 * 创建一张卡片。
 * @param {object} options
 * @param {object} options.word      词条对象
 * @param {'new'|'review'|'recycle'|'early'} options.mode
 * @param {object} options.settings  扩展设置（用到 cardSeconds / quizMode / autoSpeak）
 * @param {HTMLElement} options.container 卡片挂载到哪个元素里
 * @param {(action:'known'|'snooze', elapsedMs:number)=>void} options.onAction
 * @param {(reason:'timeout'|'close'|'destroy')=>void} options.onSkip
 * @param {(text:string)=>void} options.onSpeak
 * @param {()=>void} options.onPause
 * @param {boolean} [options.countdown=true] 主动学习页面可关闭自动消失。
 * @param {boolean} [options.keyboard=true] 内容脚本可由宿主统一管理快捷键。
 * @param {'default'|'study'} [options.presentation='default'] 连学窗使用受视口约束的紧凑布局。
 */
export function createCard(options) {
  const {
    word,
    mode = 'new',
    settings = {},
    container = document.body,
    onAction,
    onSkip,
    onSpeak,
    onPause,
    countdown = true,
    keyboard = true,
    presentation = 'default',
  } = options;

  const duration = Math.max(5000, (Number(settings.cardSeconds) || 25) * 1000);
  let remaining = duration;
  let lastTick = Date.now();
  let hovered = false;
  let focused = false;
  let busy = false;
  let speaking = false;
  let finished = false;
  let destroyed = false;
  let autoSpeakTimer = null;
  let removalTimer = null;
  const startedAt = Date.now();
  let revealed = !settings.quizMode;
  let detailsDialog = null;
  let detailsOpen = false;

  const host = h('div', { class: 'lingo-sip-root', 'data-presentation': presentation });
  const root = host.attachShadow({ mode: 'open' });
  applyStyles(root, CARD_CSS);

  /* ---------------- 进度条 ---------------- */
  const barFill = h('i');
  const progress = countdown ? h('div', { class: 'ls-progress', 'aria-hidden': 'true' }, barFill) : null;

  /* ---------------- 头部 ---------------- */
  const chips = [];
  chips.push(h('span', { class: `ls-chip ls-chip--${mode}`, text: MODE_LABELS[mode] || '学习' }));
  if (word.type === 'phrase') chips.push(h('span', { class: 'ls-chip ls-chip--ghost', text: '短语' }));
  // 标签只是辅助信息，最多显示两个，避免头部太花
  (word.tags || [])
    .slice(0, 2)
    .forEach((tag) => chips.push(h('span', { class: 'ls-chip ls-chip--ghost', text: TAG_TEXT[tag] || tag })));

  const btnPause = onPause && presentation !== 'study' ? h('button', {
    class: 'ls-icon',
    title: '暂停 1 小时',
    'aria-label': '暂停 1 小时',
    onClick: pauseAutomatic,
  }, icon('M8 5v14M16 5v14')) : null;
  const btnClose = h('button', {
    class: 'ls-icon',
    title: '跳过（Esc）',
    'aria-label': '跳过',
    onClick: () => finish('close'),
  }, icon('m6 6 12 12M18 6 6 18'));
  const btnFulltext = presentation === 'study' ? h('button', {
    class: 'ls-fulltext-btn', text: '全文', title: '查看完整词条、释义与例句',
    'aria-label': '查看完整词条、释义与例句', onClick: openDetails,
  }) : null;

  const head = h(
    'div',
    { class: 'ls-head' },
    h('div', { class: 'ls-chips' }, chips),
    h('div', { class: 'ls-actions' }, btnFulltext, btnPause, btnClose),
  );

  /* ---------------- 主体 ---------------- */
  const termEl = h('div', { class: 'ls-term', text: word.term });

  const speakText = word.term;
  const btnSpeak = h('button', {
    class: 'ls-speak',
    title: '朗读（空格）',
    'aria-label': '朗读',
    onClick: play,
  }, icon('M11 5 6 9H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14'));

  const phonBits = [];
  if (word.phonetic) phonBits.push(h('span', { class: 'ls-phon-text', text: word.phonetic }));
  if (word.pos) phonBits.push(h('span', { class: 'ls-pos', text: word.pos }));
  const phon = phonBits.length ? h('div', { class: 'ls-phon' }, phonBits) : null;

  const revealBtn = h('button', {
    class: 'ls-reveal-btn',
    text: '看释义　(3)',
    onClick: () => reveal(),
  });

  const meaningEl = h('div', { class: 'ls-meaning', text: word.meaning });
  const exampleBlock = word.example
    ? h(
        'div',
        { class: 'ls-example' },
        h('p', { class: 'ls-en', text: word.example }),
        word.exampleZh ? h('p', { class: 'ls-zh', text: word.exampleZh }) : null,
      )
    : null;

  // 回忆模式：释义与例句先遮住，想一下再揭晓
  const answer = h('div', { class: 'ls-answer' }, meaningEl, exampleBlock);
  const body = h('div', { class: 'ls-body' }, h('div', { class: 'ls-term-row' }, termEl, btnSpeak), phon, answer);

  /* ---------------- 底部按钮 ---------------- */
  const foot = h(
    'div',
    { class: 'ls-foot' },
    h(
      'button',
      { class: 'ls-btn ls-btn--ghost', onClick: () => finish('snooze') },
      h('span', { text: '稍后复习' }),
      h('kbd', { text: '2' }),
    ),
    h(
      'button',
      { class: 'ls-btn ls-btn--primary', onClick: () => finish('known') },
      h('span', { text: '记得了' }),
      h('kbd', { text: '1' }),
    ),
  );

  const hint = h('div', { class: 'ls-hint', text: presentation === 'study' ? '空格 发音 · Esc 跳过 · 3 看释义' : countdown ? '空格 发音 · Esc 跳过 · 停留或聚焦暂停计时' : '空格 发音 · Esc 跳过 · 按 3 看释义' });
  const errorEl = h('p', { class: 'ls-error', role: 'alert', hidden: true });

  const card = h(
    'div',
    { class: `ls-card${presentation === 'study' ? ' ls-card--study' : ''}`, role: 'note', 'aria-label': '英语学习卡片' },
    progress,
    head,
    body,
    foot,
    errorEl,
    hint,
  );
  root.append(card);

  if (presentation === 'study') {
    const content = h('div', { class: 'ls-fulltext-content', tabindex: '0', 'aria-label': '完整词条内容，可滚动阅读' },
      h('p', { class: 'ls-fulltext-term', text: word.term }),
      h('p', { class: 'ls-fulltext-phon', text: [word.phonetic, word.pos].filter(Boolean).join(' · ') }),
      h('p', { class: 'ls-fulltext-meaning', text: word.meaning }),
      word.example || word.exampleZh ? h('div', { class: 'ls-fulltext-example' },
        word.example ? h('p', { text: word.example }) : null, word.exampleZh ? h('p', { class: 'ls-fulltext-zh', text: word.exampleZh }) : null) : null,
    );
    const close = h('button', { class: 'ls-fulltext-close', text: '返回卡片', onClick: () => detailsDialog.close() });
    detailsDialog = h('dialog', { class: 'ls-fulltext-dialog', 'aria-labelledby': 'ls-fulltext-title' },
      h('div', { class: 'ls-fulltext-head' }, h('strong', { id: 'ls-fulltext-title', text: '完整词条' }),
        h('span', { text: 'Esc 返回' })), content,
      h('div', { class: 'ls-fulltext-footer' }, h('span', { text: '长内容可滚动阅读' }), close),
    );
    detailsDialog.addEventListener('close', () => {
      detailsOpen = false;
      if (!destroyed) { syncPaused(); btnFulltext.focus(); }
    });
    root.append(detailsDialog);
  }

  if (!revealed) {
    answer.classList.add('ls-masked');
    answer.setAttribute('aria-hidden', 'true');
    body.append(revealBtn);
  }

  /* ---------------- 计时与生命周期 ---------------- */
  const timer = countdown ? setInterval(step, 100) : null;

  function step() {
    const now = Date.now();
    const delta = now - lastTick;
    lastTick = now;
    if (hovered || focused || detailsOpen || busy || finished || document.hidden) return;
    remaining -= delta;
    if (remaining <= 0) {
      finish('timeout');
      return;
    }
    barFill.style.transform = `scaleX(${(remaining / duration).toFixed(4)})`;
  }

  function syncPaused() {
    card.classList.toggle('ls-paused', hovered || focused || detailsOpen || busy || document.hidden);
    lastTick = Date.now();
  }

  // 鼠标停在卡片上 = 我在看，别催
  card.addEventListener('mouseenter', () => { hovered = true; syncPaused(); });
  card.addEventListener('mouseleave', () => { hovered = false; syncPaused(); });
  card.addEventListener('focusin', () => { focused = true; activateKeys(); syncPaused(); });
  card.addEventListener('focusout', (event) => { focused = card.contains(event.relatedTarget); syncPaused(); });
  card.addEventListener('pointerdown', activateKeys);
  document.addEventListener('visibilitychange', syncPaused);
  window.addEventListener('pageshow', syncPaused);

  function activateKeys() {
    if (keyboard && !destroyed) keyboardHost = host;
  }

  function handleKey(event) {
    if (destroyed || finished || busy || detailsDialog?.open || keyboardHost !== host || document.hidden) return;
    if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    const path = event.composedPath?.() || [event.target];
    if (path.some((node) => node?.isContentEditable || node?.matches?.('input, textarea, select, [role="textbox"], [role="combobox"]'))) return;
    const interactive = path.some((node) => node?.matches?.('button, a'));
    if (interactive && (presentation !== 'study' || !['1', '2', '3', 'Escape'].includes(event.key))) return;
    const actions = { '1': () => finish('known'), '2': () => finish('snooze'), '3': reveal, ' ': play, Spacebar: play, Escape: () => finish('close') };
    if (!Object.hasOwn(actions, event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    actions[event.key]();
  }

  function setBusy(value) {
    if (destroyed) return;
    busy = !!value;
    card.setAttribute('aria-busy', String(busy));
    for (const button of card.querySelectorAll('button')) button.disabled = busy;
    btnSpeak.disabled = busy || speaking;
    syncPaused();
  }

  function showError(message = '操作未完成，请重试。若扩展刚刚更新，请刷新页面。') {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  async function play() {
    if (destroyed || finished || busy || speaking) return;
    speaking = true;
    btnSpeak.disabled = true;
    btnSpeak.setAttribute('aria-busy', 'true');
    btnSpeak.title = '正在播放…';
    errorEl.hidden = true;
    try {
      const result = await onSpeak?.(speakText);
      if (!destroyed && result?.ok === false && !['interrupted', 'cancelled'].includes(result.reason)) {
        showError(result.message || '暂时无法播放发音，请检查设置中的本机声音。');
      }
    } catch (error) {
      if (!destroyed) showError(error.message || '暂时无法播放发音，请稍后重试。');
    } finally {
      speaking = false;
      if (!destroyed) {
        btnSpeak.disabled = busy;
        btnSpeak.removeAttribute('aria-busy');
        btnSpeak.title = '朗读（空格）';
      }
    }
  }

  async function pauseAutomatic() {
    if (finished || busy || destroyed) return;
    setBusy(true);
    errorEl.hidden = true;
    try {
      await onPause?.();
    } catch {
      if (!destroyed) showError();
    } finally {
      setBusy(false);
    }
  }

  function reveal() {
    if (revealed || destroyed) return;
    revealed = true;
    answer.classList.remove('ls-masked');
    answer.removeAttribute('aria-hidden');
    const restoreFocus = root.activeElement === revealBtn;
    revealBtn.remove();
    if (restoreFocus) foot.querySelector('button')?.focus();
  }

  function openDetails() {
    if (destroyed || finished || busy || !detailsDialog || detailsDialog.open) return;
    // “全文”是明确的揭晓动作；回忆模式不会在入口点击前泄露释义。
    reveal();
    detailsOpen = true;
    syncPaused();
    detailsDialog.showModal();
    detailsDialog.querySelector('.ls-fulltext-content').focus();
  }

  async function finish(action) {
    if (finished || busy || destroyed) return;
    finished = true;
    setBusy(true);
    errorEl.hidden = true;
    try {
      if (action === 'known' || action === 'snooze') {
        await onAction?.(action, Math.max(0, countdown ? duration - remaining : Date.now() - startedAt));
      } else {
        await onSkip?.(action);
      }
      teardown();
    } catch {
      if (destroyed) return;
      finished = false;
      // 超时记账失败时不每 100ms 重试，留时间给用户决定下一步。
      remaining = Math.max(remaining, 5000);
      setBusy(false);
      showError();
    }
  }

  /** 立即移除（不触发任何回调），用于页面切走 / 重新来一张。 */
  function teardown(immediate = false) {
    destroyed = true;
    finished = true;
    if (detailsDialog?.open) detailsDialog.close();
    clearInterval(timer);
    clearTimeout(autoSpeakTimer);
    clearTimeout(removalTimer);
    window.removeEventListener('keydown', handleKey);
    window.removeEventListener('pageshow', syncPaused);
    document.removeEventListener('visibilitychange', syncPaused);
    if (keyboardHost === host) keyboardHost = null;
    if (immediate) { host.remove(); return; }
    card.classList.add('ls-out');
    removalTimer = setTimeout(() => host.remove(), 170);
  }

  container.append(host);
  barFill.style.transform = 'scaleX(1)';
  if (keyboard) { activateKeys(); window.addEventListener('keydown', handleKey); }

  if (settings.autoSpeak) {
    // 稍微延迟一点，避免和卡片入场动画抢注意力
    autoSpeakTimer = setTimeout(() => {
      if (!finished && !busy && !destroyed) play();
    }, 260);
  }

  return {
    host,
    card,
    reveal,
    setBusy,
    isRevealed: () => revealed,
    destroy: () => {
      teardown(true);
    },
  };
}

/** 标签的中文显示名（只用于卡片上，设置页用 core/constants 里的完整表）。 */
const TAG_TEXT = {
  core: '核心',
  office: '办公',
  meeting: '会议',
  email: '邮件',
  tech: '技术',
  travel: '出行',
  daily: '日常',
  academic: '学术',
  spoken: '口语',
  custom: '我的词',
};

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */
export const CARD_CSS = `
:host { all: initial; display: block; min-width: 0; color-scheme: light dark; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
:host {
  --ls-accent: #4f5bd5;
  --ls-accent-2: #5966ca;
  --ls-on-accent: #ffffff;
  --ls-text: #20243a;
  --ls-muted: #646b83;
  --ls-surface: #ffffff;
  --ls-soft: #eef0f8;
  --ls-line: #dfe3ee;
  --ls-success: #237657;
  --ls-danger: #ac3543;
}
.ls-card {
  position: relative;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border-radius: 20px;
  background: var(--ls-surface);
  color: var(--ls-text);
  border: 1px solid var(--ls-line);
  box-shadow: 0 12px 36px rgba(32, 36, 58, .055);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  text-align: left;
  animation: ls-in .18s ease-out;
}
.ls-card.ls-out { animation: ls-out .16s ease forwards; pointer-events: none; }
@keyframes ls-in { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
@keyframes ls-out { to { opacity: 0; transform: translateY(5px); } }
.ls-progress { height: 3px; background: var(--ls-soft); }
.ls-progress > i { display: block; height: 100%; width: 100%; transform-origin: left center; background: var(--ls-accent); transition: transform .1s linear; }
.ls-paused .ls-progress > i { opacity: .4; }
.ls-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 2px 20px; }
.ls-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.ls-chip { font-size: 12px; line-height: 1.4; padding: 4px 8px; border-radius: 6px; background: var(--ls-soft); color: var(--ls-accent); font-weight: 600; overflow-wrap: anywhere; }
.ls-chip--review { background: #fff3dc; color: #925c0b; }
.ls-chip--recycle { background: #eaf5ef; color: var(--ls-success); }
.ls-chip--ghost { color: var(--ls-muted); font-weight: 400; }
.ls-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.ls-icon, .ls-speak, .ls-reveal-btn, .ls-btn { appearance: none; border: 0; font: inherit; cursor: pointer; transition: background-color .15s ease, color .15s ease, opacity .15s ease; }
.ls-icon, .ls-speak { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; color: var(--ls-muted); background: transparent; flex-shrink: 0; }
.ls-icon svg, .ls-speak svg { width: 19px; height: 19px; }
.ls-icon:hover, .ls-speak:hover { background: var(--ls-soft); color: var(--ls-accent); }
button:focus-visible { outline: 3px solid var(--ls-accent); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: wait; }
.ls-body { padding: 8px 20px 18px; }
.ls-term-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ls-term { min-width: 0; font-size: clamp(27px, 5vw, 34px); line-height: 1.2; font-weight: 700; letter-spacing: -.7px; overflow-wrap: anywhere; color: var(--ls-text); }
.ls-speak { color: var(--ls-accent); background: var(--ls-soft); }
.ls-phon { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; font-size: 13px; color: var(--ls-muted); }
.ls-phon-text { font-family: "Segoe UI", "Lucida Sans Unicode", sans-serif; overflow-wrap: anywhere; }
.ls-pos { padding: 1px 6px; border-radius: 4px; background: var(--ls-soft); font-size: 12px; }
.ls-answer { transition: filter .18s ease, opacity .18s ease; }
.ls-masked { filter: blur(7px); opacity: .5; user-select: none; pointer-events: none; }
.ls-meaning { margin-top: 20px; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.ls-example { margin-top: 14px; padding: 12px 14px; border-radius: 10px; background: var(--ls-soft); border-left: 3px solid var(--ls-line); overflow-wrap: anywhere; }
.ls-en { font-size: 14px; color: var(--ls-text); }
.ls-zh { margin-top: 6px; font-size: 13px; color: var(--ls-muted); }
.ls-reveal-btn { display: block; width: 100%; min-height: 44px; text-align: center; margin-top: 14px; padding: 10px; border-radius: 10px; font-size: 14px; font-weight: 600; color: var(--ls-accent); background: var(--ls-soft); }
.ls-reveal-btn:hover { box-shadow: inset 0 0 0 1px var(--ls-accent); }
.ls-foot { display: flex; gap: 10px; padding: 0 20px 14px; }
.ls-btn { min-width: 0; min-height: 46px; flex: 1; text-align: center; padding: 10px 8px; border-radius: 10px; font-size: 14px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; }
.ls-btn:active:not(:disabled), .ls-icon:active:not(:disabled), .ls-speak:active:not(:disabled) { opacity: .75; }
.ls-btn kbd { font-family: inherit; font-size: 11px; min-width: 19px; padding: 0 4px; border: 1px solid currentColor; border-radius: 4px; font-weight: 400; opacity: .75; }
.ls-btn--ghost { background: var(--ls-soft); color: var(--ls-text); }
.ls-btn--ghost:hover { box-shadow: inset 0 0 0 1px var(--ls-line); }
.ls-btn--primary { background: var(--ls-accent); color: var(--ls-on-accent); }
.ls-btn--primary:hover { background: var(--ls-accent-2); }
.ls-hint { padding: 0 16px 16px; font-size: 12px; color: var(--ls-muted); text-align: center; }
.ls-error { margin: 0 20px 14px; color: var(--ls-danger); font-size: 13px; }

/* 只约束连学窗，不改变网页浮层和新标签页的卡片。 */
:host([data-presentation="study"]) { height: 100%; min-height: 0; container-type: size; container-name: study-card; }
.ls-card--study { height: 100%; min-height: 0; display: grid; grid-template-rows: 3px auto minmax(0, 1fr) auto auto auto; border-radius: 18px; box-shadow: 0 8px 28px rgba(20,25,50,.06); }
.ls-card--study .ls-progress { grid-row: 1; }
.ls-card--study .ls-head { grid-row: 2; padding: 8px 12px 0 16px; min-width: 0; }
.ls-card--study .ls-chips { flex-wrap: nowrap; overflow: hidden; }
.ls-card--study .ls-chip { white-space: nowrap; flex-shrink: 0; font-size: 11px; padding: 4px 7px; }
.ls-card--study .ls-chip--ghost { min-width: 0; max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
.ls-card--study .ls-icon { width: 34px; height: 34px; border-radius: 8px; }
.ls-fulltext-btn { min-height: 34px; padding: 4px 9px; border: 0; border-radius: 8px; color: var(--ls-muted); background: var(--ls-soft); font: inherit; font-size: 12px; cursor: pointer; }
.ls-fulltext-btn:hover { color: var(--ls-accent); }
.ls-card--study .ls-body { grid-row: 3; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; min-height: 0; overflow: hidden; padding: 10px 16px 12px; }
.ls-card--study .ls-term-row { grid-row: 1; }
.ls-card--study .ls-term { font-size: 30px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; }
.ls-card--study .ls-speak { width: 38px; height: 38px; border-radius: 12px; }
.ls-card--study .ls-phon { grid-row: 2; margin-top: 6px; font-size: 12px; flex-wrap: nowrap; min-width: 0; overflow: hidden; }
.ls-card--study .ls-phon-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ls-card--study .ls-pos { flex: none; max-width: 96px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ls-card--study .ls-answer { grid-row: 3; display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; overflow: hidden; }
.ls-card--study .ls-meaning { margin-top: 12px; font-size: 15px; line-height: 1.5; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.ls-card--study .ls-example { align-self: start; min-height: 0; max-height: calc(100% - 10px); overflow: hidden; margin-top: 10px; padding: 8px 10px; border-left-width: 2px; }
.ls-card--study .ls-en { font-size: 13px; line-height: 1.55; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.ls-card--study .ls-zh { font-size: 12px; line-height: 1.5; margin-top: 5px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; }
.ls-card--study .ls-reveal-btn { grid-row: 4; min-height: 36px; margin-top: 8px; padding: 6px; font-size: 13px; }
.ls-card--study .ls-foot { grid-row: 4; padding: 0 16px 10px; gap: 10px; }
.ls-card--study .ls-btn { min-height: 42px; font-size: 13px; }
.ls-card--study .ls-error { grid-row: 5; min-height: 0; max-height: 48px; overflow: auto; scrollbar-width: none; margin: 0 16px 8px; font-size: 12px; }
.ls-card--study .ls-hint { grid-row: 6; padding: 0 12px 10px; font-size: 11px; line-height: 1.5; }
.ls-card--study:has(.ls-error:not([hidden])) .ls-hint { display: none; }
@container study-card (max-height: 340px) {
  .ls-card--study .ls-body { padding: 6px 14px 8px; }
  .ls-card--study .ls-head { padding: 5px 10px 0 14px; }
  .ls-card--study .ls-term { font-size: 26px; -webkit-line-clamp: 1; }
  .ls-card--study .ls-meaning { margin-top: 8px; font-size: 14px; -webkit-line-clamp: 1; }
  .ls-card--study .ls-example { max-height: calc(100% - 7px); margin-top: 7px; padding: 7px 10px; }
  .ls-card--study .ls-en { font-size: 12px; line-height: 1.5; -webkit-line-clamp: 1; }
  .ls-card--study .ls-zh { font-size: 12px; margin-top: 4px; -webkit-line-clamp: 1; }
  .ls-card--study .ls-foot { padding: 0 14px 8px; }
  .ls-card--study .ls-hint { padding-bottom: 8px; font-size: 10px; }
  .ls-card--study .ls-reveal-btn { min-height: 32px; margin-top: 5px; }
  .ls-card--study .ls-error { max-height: 40px; margin-bottom: 4px; }
}
.ls-fulltext-dialog { width: min(540px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); margin: auto; padding: 0; border: 1px solid var(--ls-line); border-radius: 18px; background: var(--ls-surface); color: var(--ls-text); font: 14px/1.7 "Segoe UI", "Microsoft YaHei", sans-serif; overflow: hidden; }
.ls-fulltext-dialog[open] { display: flex; flex-direction: column; }
.ls-fulltext-dialog::backdrop { background: rgba(10,14,30,.6); }
.ls-fulltext-head, .ls-fulltext-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; flex: none; }
.ls-fulltext-head { border-bottom: 1px solid var(--ls-line); }
.ls-fulltext-head strong { font-size: 15px; }
.ls-fulltext-head span, .ls-fulltext-footer span { color: var(--ls-muted); font-size: 11px; }
.ls-fulltext-content { min-height: 0; padding: 18px; overflow: auto; scrollbar-width: none; overscroll-behavior: contain; overflow-wrap: anywhere; white-space: pre-wrap; }
.ls-fulltext-content::-webkit-scrollbar, .ls-card--study .ls-error::-webkit-scrollbar { display: none; }
.ls-fulltext-content:focus-visible { outline: 2px solid var(--ls-accent); outline-offset: -4px; }
.ls-fulltext-term { font-size: 26px; font-weight: 700; line-height: 1.35; }
.ls-fulltext-phon { margin-top: 7px; color: var(--ls-muted); font-size: 12px; }
.ls-fulltext-meaning { margin-top: 20px; font-size: 15px; font-weight: 600; }
.ls-fulltext-example { margin-top: 14px; padding: 12px; border-radius: 10px; background: var(--ls-soft); }
.ls-fulltext-zh { margin-top: 8px; color: var(--ls-muted); }
.ls-fulltext-footer { border-top: 1px solid var(--ls-line); }
.ls-fulltext-close { min-height: 38px; padding: 7px 14px; border: 0; border-radius: 9px; background: var(--ls-accent); color: var(--ls-on-accent); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
@media (prefers-color-scheme: dark) {
  :host { --ls-accent: #a3abff; --ls-accent-2: #b8beff; --ls-on-accent: #171a29; --ls-text: #edf0fb; --ls-muted: #abb2ca; --ls-surface: #202435; --ls-soft: #2b3047; --ls-line: #3a415b; --ls-success: #83d5b1; --ls-danger: #ffa1ad; }
  .ls-card { box-shadow: 0 12px 36px rgba(0,0,0,.15); }
  .ls-chip--review { color: #f1c77c; background: #3c3326; }
  .ls-chip--recycle { background: #253d37; }
}
@media (max-width: 360px) {
  .ls-head { padding-left: 14px; }
  .ls-body { padding-left: 14px; padding-right: 14px; }
  .ls-foot { padding-left: 14px; padding-right: 14px; gap: 8px; }
  .ls-hint { font-size: 11px; }
}
@media (pointer: coarse) { .ls-icon, .ls-speak { width: 44px; height: 44px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
@media (forced-colors: active) { .ls-card, .ls-chip, button { border: 1px solid CanvasText; } .ls-btn--primary { background: Highlight; color: HighlightText; } }
`;
