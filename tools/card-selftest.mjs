/** 卡片的生命周期与异步交互回归；仅用 Node 内置模块，不读写学习数据。 */
import assert from 'node:assert/strict';
import { createCard } from '../src/ui/card.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.className = '';
    this.disabled = false;
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      add: (name) => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: (name) => { this.className = this.className.split(' ').filter((item) => item !== name).join(' '); },
      toggle: (name, value) => { if (value) this.classList.add(name); else this.classList.remove(name); },
    };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'hidden') this.hidden = true; }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'hidden') this.hidden = false; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); this.parentNode = null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  attachShadow() { this.shadowRoot = new Element('shadow'); return this.shadowRoot; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  fire(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init };
    event.composedPath ||= () => [event.target];
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  matches(selector) {
    return selector.split(',').some((entry) => {
      const token = entry.trim();
      if (token.startsWith('.')) return this.classList.contains(token.slice(1));
      if (token.startsWith('[role=')) return this.getAttribute('role') === token.slice(7, -2);
      return this.tagName.toLowerCase() === token;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
}

const original = Object.fromEntries(['window', 'document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((key) => [key, globalThis[key]]));
const originalNow = Date.now;
let now = 0;
let sequence = 0;
const timers = new Map();
let passed = 0;
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
function reset() {
  timers.clear(); now = 0;
  globalThis.window = new Element('window');
  globalThis.document = new Element('document');
  document.body = new Element('body');
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_ns, tag) => new Element(tag);
  document.hidden = false;
  Date.now = () => now;
  globalThis.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; };
  globalThis.setInterval = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay, interval: delay }); return id; };
  globalThis.clearTimeout = globalThis.clearInterval = (id) => timers.delete(id);
}
async function advance(ms) {
  const end = now + ms;
  while (true) {
    const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    const [id, timer] = next;
    now = timer.at;
    if (timer.interval) timer.at += timer.interval; else timers.delete(id);
    timer.fn();
    await flush();
  }
  now = end;
  await flush();
}
const word = { id: 'test-only', term: 'schedule', meaning: '安排', tags: ['office'], example: 'Let us schedule a call.' };
const make = (options = {}) => createCard({ word, settings: { cardSeconds: 5 }, ...options });
const button = (controller, className) => controller.card.querySelector(className);
const key = (value, extra = {}) => window.fire('keydown', { key: value, target: document.body, ...extra });
async function test(label, run) { reset(); await run(); passed += 1; console.log(`✓ ${label}`); }

try {
  await test('destroy 立即移除 DOM，并清理计时、自动发音和全局监听', async () => {
    let calls = 0;
    const card = make({ settings: { autoSpeak: true, cardSeconds: 5 }, onSpeak: () => calls++, onSkip: () => calls++ });
    card.destroy(); card.destroy();
    await advance(6000);
    assert.equal(calls, 0);
    assert.equal(document.body.children.length, 0);
    assert.equal(timers.size, 0);
    assert.equal(window.listeners.get('keydown').size, 0);
    assert.equal(window.listeners.get('pageshow').size, 0);
    assert.equal(document.listeners.get('visibilitychange').size, 0);
  });
  await test('countdown:false 长时间停留也不触发跳过', async () => {
    let skips = 0;
    const card = make({ countdown: false, onSkip: () => skips++ });
    await advance(60000);
    assert.equal(skips, 0);
    assert.equal(button(card, '.ls-progress'), null);
    card.destroy();
  });
  await test('异步记账完成前，连点和快捷键只提交一次', async () => {
    let calls = 0;
    let resolve;
    const saved = new Promise((done) => { resolve = done; });
    const card = make({ onAction: () => { calls++; return saved; } });
    button(card, '.ls-btn--primary').fire('click');
    button(card, '.ls-btn--primary').fire('click');
    key('2');
    await flush();
    assert.equal(calls, 1);
    assert.equal(button(card, '.ls-btn--primary').disabled, true);
    assert.equal(card.host.parentNode, document.body);
    resolve(); await flush(); await advance(170);
    assert.equal(card.host.parentNode, null);
  });
  await test('写入失败后保留原卡、显示错误并允许重新作答', async () => {
    let calls = 0;
    const card = make({ onAction: async () => { if (++calls === 1) throw new Error('offline'); } });
    key('1'); await flush();
    assert.equal(calls, 1);
    assert.equal(button(card, '.ls-error').hidden, false);
    assert.equal(button(card, '.ls-btn--primary').disabled, false);
    assert.equal(card.host.parentNode, document.body);
    key('1'); await flush(); await advance(170);
    assert.equal(calls, 2);
    assert.equal(card.host.parentNode, null);
  });
  await test('输入框、编辑区、按钮、链接和组合快捷键不被卡片吞掉', async () => {
    let actions = 0;
    const card = make({ onAction: () => actions++ });
    for (const tag of ['input', 'textarea', 'select', 'button', 'a']) {
      assert.equal(key('1', { target: new Element(tag) }).defaultPrevented, false);
    }
    const editable = new Element(); editable.isContentEditable = true;
    assert.equal(key('1', { target: editable }).defaultPrevented, false);
    for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'repeat', 'defaultPrevented']) key('1', { [flag]: true });
    assert.equal(actions, 0);
    assert.equal(key('1').defaultPrevented, true);
    await flush(); assert.equal(actions, 1); card.destroy();
  });
  await test('多卡预览只响应当前卡，并可用交互切换当前卡', async () => {
    let first = 0; let second = 0;
    const a = make({ onSpeak: () => first++ });
    const b = make({ onSpeak: () => second++ });
    key(' '); assert.equal(first, 0); assert.equal(second, 1);
    a.card.fire('pointerdown'); key(' ');
    assert.equal(first, 1); assert.equal(second, 1);
    a.destroy(); b.destroy();
  });
  await test('销毁旧卡不会注销异步回调里刚创建的新卡', async () => {
    let speaks = 0; let next;
    const previous = make({ onAction: async () => { next = make({ onSpeak: () => speaks++ }); } });
    key('1'); await flush(); key(' ');
    assert.equal(speaks, 1);
    previous.destroy(); next.destroy();
  });
  await test('按 3 揭示释义，同时更新辅助技术可见性', async () => {
    const card = make({ settings: { quizMode: true } });
    const answer = button(card, '.ls-answer');
    assert.equal(answer.getAttribute('aria-hidden'), 'true');
    key('3');
    assert.equal(card.isRevealed(), true);
    assert.equal(answer.getAttribute('aria-hidden'), null);
    assert.equal(button(card, '.ls-reveal-btn'), null);
    card.destroy();
  });
  await test('鼠标、键盘焦点和隐藏页面都会暂停倒计时', async () => {
    let skips = 0;
    const card = make({ onSkip: () => skips++ });
    card.card.fire('mouseenter'); await advance(6000); assert.equal(skips, 0);
    card.card.fire('focusin'); card.card.fire('mouseleave'); await advance(6000); assert.equal(skips, 0);
    card.card.fire('focusout', { relatedTarget: null });
    document.hidden = true; document.fire('visibilitychange'); await advance(6000); assert.equal(skips, 0);
    document.hidden = false; document.fire('visibilitychange'); await advance(5000); assert.equal(skips, 1);
    card.destroy();
  });
  await test('外部 busy 阻止作答和计时，解除后恢复', async () => {
    let actions = 0; let skips = 0;
    const card = make({ onAction: () => actions++, onSkip: () => skips++ });
    card.setBusy(true); key('1'); await advance(6000);
    assert.equal(actions, 0); assert.equal(skips, 0);
    card.setBusy(false); key('1'); await flush(); assert.equal(actions, 1);
    card.destroy();
  });
  await test('页面缓存恢复会重置计时基准，冻结时间不消耗卡片倒计时', async () => {
    let skips = 0;
    const card = make({ onSkip: () => skips++ });
    // 模拟浏览器冻结计时器，但墙上时钟已前进一分钟。
    now += 60000;
    for (const timer of timers.values()) timer.at += 60000;
    window.fire('pageshow', { persisted: true });
    await advance(4900);
    assert.equal(skips, 0);
    assert.equal(card.host.parentNode, document.body);
    await advance(100);
    assert.equal(skips, 1);
    card.destroy();
    assert.equal(window.listeners.get('pageshow').size, 0);
  });
  await test('keyboard:false 由宿主管理按键，组件不重复消费', async () => {
    let calls = 0;
    const card = make({ keyboard: false, onAction: () => calls++ });
    assert.equal(key('1').defaultPrevented, false);
    assert.equal(calls, 0);
    assert.equal(window.listeners.get('keydown')?.size || 0, 0);
    card.destroy();
  });
  await test('异步操作中销毁卡片，后续失败不会复活旧 UI', async () => {
    let reject;
    const pending = new Promise((_resolve, fail) => { reject = fail; });
    const card = make({ onAction: () => pending });
    key('1'); card.destroy(); reject(new Error('offline')); await flush();
    assert.equal(card.host.parentNode, null);
    assert.equal(timers.size, 0);
    assert.equal(window.listeners.get('keydown').size, 0);
  });
  await test('发音等待时防连点，失败就近显示并允许重试', async () => {
    let resolve; let calls = 0;
    const pending = new Promise((done) => { resolve = done; });
    const card = make({ countdown: false, onSpeak: () => ++calls === 1 ? pending : Promise.resolve({ ok: true }) });
    key(' '); key(' ');
    assert.equal(calls, 1);
    assert.equal(button(card, '.ls-speak').disabled, true);
    card.setBusy(false);
    assert.equal(button(card, '.ls-speak').disabled, true);
    resolve({ ok: false, reason: 'no-voices', message: '请在设置中选择本机声音。' }); await flush();
    assert.equal(button(card, '.ls-error').hidden, false);
    assert.equal(button(card, '.ls-error').textContent, '请在设置中选择本机声音。');
    assert.equal(button(card, '.ls-speak').disabled, false);
    key(' '); await flush();
    assert.equal(calls, 2);
    assert.equal(button(card, '.ls-error').hidden, true);
    card.destroy();
  });
  await test('发音取消保持安静，消息失败有明确提示', async () => {
    let calls = 0;
    const card = make({ onSpeak: async () => {
      if (++calls === 1) return { ok: false, reason: 'cancelled' };
      throw new Error('后台暂时不可达。');
    } });
    key(' '); await flush();
    assert.equal(button(card, '.ls-error').hidden, true);
    key(' '); await flush();
    assert.equal(button(card, '.ls-error').textContent, '后台暂时不可达。');
    assert.equal(button(card, '.ls-speak').disabled, false);
    card.destroy();
  });
  await test('销毁后的迟到发音失败不恢复界面', async () => {
    let reject;
    const card = make({ onSpeak: () => new Promise((_done, fail) => { reject = fail; }) });
    key(' '); card.destroy(); reject(new Error('late failure')); await flush();
    assert.equal(card.host.parentNode, null);
    assert.equal(button(card, '.ls-error').hidden, true);
  });
  await test('连学全文暂停倒计时，阻止误作答，返回入口后快捷键继续有效', async () => {
    let actions = 0; let skips = 0;
    const card = make({ presentation: 'study', onAction: () => actions++, onSkip: () => skips++ });
    const dialog = card.host.shadowRoot.querySelector('dialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.fire('close'); };
    const entry = button(card, '.ls-fulltext-btn');
    entry.fire('click');
    assert.equal(dialog.open, true);
    key('1'); await advance(6000);
    assert.equal(actions, 0); assert.equal(skips, 0);
    dialog.close(); assert.equal(entry.focused, true);
    key('1', { target: entry }); await flush();
    assert.equal(actions, 1); card.destroy();
  });
  await test('连学全文保留全部字段，也保留单独提供的中文例句', async () => {
    const fullWord = { ...word, term: 'a very long term', phonetic: '/full phonetic/', pos: 'phrase', meaning: '完整的释义\n第二行', example: '', exampleZh: '只有中文例句，也必须保留。' };
    const card = make({ presentation: 'study', word: fullWord });
    const dialog = card.host.shadowRoot.querySelector('dialog');
    const texts = (node) => [node.textContent || '', ...node.children.flatMap(texts)];
    const full = texts(dialog).join('\n');
    for (const field of ['term', 'phonetic', 'pos', 'meaning', 'exampleZh']) assert.ok(full.includes(fullWord[field]));
    card.destroy();
  });
  await test('销毁连学卡片会关闭全文，不把焦点移回已移除入口', async () => {
    const card = make({ presentation: 'study' });
    const dialog = card.host.shadowRoot.querySelector('dialog'); let closed = 0;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { closed++; dialog.open = false; dialog.fire('close'); };
    const entry = button(card, '.ls-fulltext-btn'); entry.fire('click');
    card.destroy();
    assert.equal(closed, 1); assert.equal(entry.focused, undefined);
    assert.equal(card.host.parentNode, null); assert.equal(timers.size, 0);
  });
  console.log(`\n通过 ${passed} 项卡片交互回归`);
} finally {
  Date.now = originalNow;
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
  }
}
