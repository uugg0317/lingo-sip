/** 三步引导隔离回归；仅用 Node 内置模块，不开真实窗口、不写真实学习数据。 */
import assert from 'node:assert/strict';
import { createOnboarding } from '../src/options/onboarding.js';
import { defaultState } from '../src/core/store.js';
import { preferencePatch, SCENES } from '../src/core/preferences.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.open = false; this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.textContent = ''; this.className = ''; this.openCount = 0; this.closeCount = 0;
  }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  async fire(name) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await Promise.all([...this.listeners.get(name) || []].map((callback) => callback(event)));
    if (name === 'cancel' && !event.defaultPrevented) this.close();
    return event;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...children) { this.children.push(...children); }
  querySelectorAll(selector) { return this.children.filter((node) => selector.split(',').map((tag) => tag.trim()).includes(node.tagName)); }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; this.openCount += 1; }
  close() { this.open = false; this.closeCount += 1; }
}

const ids = ['guideDialog', 'guideForm', 'guideTitle', 'guideStepLabel', 'guideStep1', 'guideStep2', 'guideStep3', 'guideScene', 'guideRhythm', 'guideGoal', 'guideMetric', 'guideNotify', 'guideSummary', 'guideResult', 'guidePrev', 'guideNext', 'guideFinish', 'guideSkip', 'btnOpenGuide'];
const original = Object.fromEntries(['document', 'chrome'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let harness;
let passed = 0;
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function setup({ first = true, save, openStudy } = {}) {
  harness?.controller.dispose();
  const nodes = new Map(ids.map((id) => [id, new Element(
    ['guideScene', 'guideRhythm', 'guideMetric'].includes(id) ? 'select'
      : ['guideGoal', 'guideNotify'].includes(id) ? 'input'
        : ['guidePrev', 'guideNext', 'guideFinish', 'guideSkip', 'btnOpenGuide'].includes(id) ? 'button' : id === 'guideDialog' ? 'dialog' : 'div',
  )]));
  const el = (id) => nodes.get(id);
  el('guideDialog').children = [...nodes.entries()].filter(([id]) => id !== 'guideDialog' && id !== 'btnOpenGuide').map(([, node]) => node);
  const state = defaultState(); state.settings.onboardingDone = !first; state.settings.enabled = !first;
  state.settings.notifyEnabled = false;
  state.progress.w001 = { status: 'mastered', box: 5, seen: 12, known: 6, due: 99 };
  state.customWords = [{ id: 'private-test', term: 'test-only', meaning: '保留词条' }];
  const context = { el, nodes, memory: structuredClone(state), attempts: [], writes: 0, messages: [], controller: null };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: el, createElement: (tag) => new Element(tag), activeElement: null } });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { sendMessage: async (message) => {
    context.messages.push(structuredClone(message)); return openStudy ? await openStudy(message, context) : { ok: true };
  } } } });
  context.controller = createOnboarding({ saveSettings: async (patch) => {
    context.attempts.push(structuredClone(patch));
    const result = save ? await save(patch, context) : true;
    if (result !== false && result?.ok !== false) { context.writes += 1; Object.assign(context.memory.settings, structuredClone(patch)); context.controller.render(context.memory); }
    return result;
  } });
  context.controller.render(context.memory); harness = context;
  return context;
}

async function test(name, run) { await run(); harness?.controller.dispose(); passed += 1; console.log(`✓ ${name}`); }
async function thirdStep(context, { scene = 'office', rhythm = 'manual', goal = '12', metric = 'answered' } = {}) {
  const { el } = context;
  el('guideScene').value = scene; await el('guideNext').fire('click');
  el('guideRhythm').value = rhythm; await el('guideRhythm').fire('change');
  el('guideGoal').value = goal; el('guideMetric').value = metric;
  await el('guideNext').fire('click');
}

try {
  await test('已有用户不自动打开；手动重走使用当前目标且不写数据', async () => {
    const context = setup({ first: false }); const { el, controller, memory } = context;
    assert.equal(el('guideDialog').openCount, 0);
    memory.settings.dailyGoal = 35; memory.settings.goalMetric = 'shown'; controller.render(memory);
    await el('btnOpenGuide').fire('click');
    assert.equal(el('guideDialog').open, true); assert.equal(el('guideGoal').value, '35');
    assert.equal(el('guideMetric').value, 'shown'); assert.equal(context.attempts.length, 0);
    assert.equal(el('guideScene').children.length, Object.keys(SCENES).length);
  });
  await test('首次自动打开一次；三步选择与返回均零写入，Escape可取消', async () => {
    const context = setup(); const { el, controller, memory } = context;
    const before = structuredClone(memory);
    assert.equal(el('guideDialog').openCount, 1); assert.equal(el('guideGoal').value, '10'); assert.equal(el('guideMetric').value, 'answered');
    await thirdStep(context);
    assert.equal(el('guideStep3').hidden, false); assert.match(el('guideSummary').textContent, /办公沟通/);
    await el('guidePrev').fire('click'); assert.equal(el('guideStep2').hidden, false); assert.equal(el('guideGoal').value, '12');
    await el('guidePrev').fire('click'); assert.equal(el('guideStep1').hidden, false); assert.equal(el('guideScene').value, 'office');
    const cancelled = await el('guideDialog').fire('cancel'); assert.equal(cancelled.defaultPrevented, false); assert.equal(el('guideDialog').open, false);
    controller.render(memory); assert.equal(el('guideDialog').openCount, 1);
    assert.equal(context.attempts.length, 0); assert.deepEqual(memory, before);
  });
  await test('目标无效时保持第二步并聚焦字段，主动模式禁用通知', async () => {
    const context = setup(); const { el } = context;
    await el('guideNext').fire('click');
    el('guideRhythm').value = 'manual'; el('guideNotify').checked = true; await el('guideRhythm').fire('change');
    assert.equal(el('guideNotify').checked, false); assert.equal(el('guideNotify').disabled, true);
    for (const value of ['', '0', '201', '2.5', 'bad']) {
      el('guideGoal').value = value; await el('guideNext').fire('click');
      assert.equal(el('guideStep2').hidden, false); assert.equal(document.activeElement, el('guideGoal')); assert.match(el('guideResult').textContent, /1 到 200/);
    }
    assert.equal(context.attempts.length, 0);
  });
  await test('确认只保存选择对应偏好；保留全部进度和自定义词，再打开试学', async () => {
    const context = setup(); const beforeProgress = structuredClone(context.memory.progress); const beforeWords = structuredClone(context.memory.customWords);
    await thirdStep(context); await context.el('guideFinish').fire('click');
    assert.equal(context.writes, 1); assert.deepEqual(context.attempts[0], preferencePatch({scene:'office', rhythm:'manual', dailyGoal:12, goalMetric:'answered', notifyEnabled:false}));
    assert.equal(context.memory.settings.onboardingDone, true); assert.equal(context.memory.settings.enabled, false);
    assert.equal(context.memory.settings.autoSpeak, false); assert.equal(context.memory.settings.notifyEnabled, false);
    assert.deepEqual(context.memory.progress, beforeProgress); assert.deepEqual(context.memory.customWords, beforeWords);
    assert.deepEqual(context.messages, [{type:'ui:open-study'}]); assert.equal(context.el('guideDialog').open, false);
  });
  await test('重复点击只保存一次，等待保存期间按钮锁定且Escape不关闭', async () => {
    const gate = deferred(); const context = setup({ save: () => gate.promise }); const { el } = context;
    await thirdStep(context); const first = el('guideFinish').fire('click'); await flush();
    assert.equal(el('guideFinish').disabled, true); assert.equal(el('guidePrev').disabled, true);
    const cancelled = await el('guideDialog').fire('cancel'); assert.equal(cancelled.defaultPrevented, true); assert.equal(el('guideDialog').open, true);
    await el('guideFinish').fire('click'); assert.equal(context.attempts.length, 1);
    gate.resolve(true); await first; assert.equal(context.writes, 1); assert.equal(context.messages.length, 1);
  });
  await test('保存失败可原位重试，第一次失败不打开试学窗口', async () => {
    let fail = true; const context = setup({ save: async () => !fail }); const { el } = context;
    await thirdStep(context); await el('guideFinish').fire('click');
    assert.equal(context.writes, 0); assert.equal(context.messages.length, 0); assert.match(el('guideResult').textContent, /没有保存/);
    assert.equal(el('guideDialog').open, true); assert.equal(el('guideFinish').disabled, false);
    fail = false; await el('guideFinish').fire('click'); assert.equal(context.writes, 1); assert.equal(context.el('guideDialog').open, false);
  });
  await test('保存成功但窗口失败明确已保存，重试窗口不重复保存', async () => {
    let fail = true; const context = setup({ openStudy: async () => ({ok:!fail}) }); const { el } = context;
    await thirdStep(context); await el('guideFinish').fire('click');
    assert.equal(context.writes, 1); assert.equal(el('guideDialog').open, true); assert.match(el('guideResult').textContent, /偏好已保存/);
    assert.match(el('guideFinish').textContent, /重新打开/); fail = false;
    await el('guideFinish').fire('click'); assert.equal(context.writes, 1); assert.equal(context.messages.length, 2); assert.equal(el('guideDialog').open, false);
  });
  await test('跳过只保存手动模式开关，不修改词库、进度或目标，不发语音通知', async () => {
    const context = setup(); const before = structuredClone(context.memory);
    await context.el('guideSkip').fire('click');
    assert.deepEqual(context.attempts, [{onboardingDone:true,enabled:false,notifyEnabled:false}]);
    assert.equal(context.memory.settings.dailyGoal, before.settings.dailyGoal); assert.deepEqual(context.memory.progress, before.progress);
    assert.deepEqual(context.memory.customWords, before.customWords); assert.equal(context.messages.length, 0); assert.equal(context.el('guideDialog').open, false);
  });
  await test('回退修改后重新确认会保存最新选择，预览不会提交旧配置', async () => {
    const context = setup(); const { el } = context;
    await thirdStep(context); await el('guidePrev').fire('click');
    el('guideRhythm').value = 'standard'; await el('guideRhythm').fire('change'); el('guideGoal').value = '18';
    el('guideMetric').value = 'shown'; el('guideNotify').checked = true; await el('guideNext').fire('click');
    assert.equal(context.attempts.length, 0); await el('guideFinish').fire('click');
    assert.equal(context.attempts[0].dailyGoal, 18); assert.equal(context.attempts[0].goalMetric, 'shown');
    assert.equal(context.attempts[0].notifyEnabled, true); assert.equal(context.attempts[0].notifySound, false);
    assert.equal(context.attempts[0].cooldownMinutes, 4);
  });
  await test('dispose清理全部监听，正在保存的晚响应不打开窗口、不更新UI', async () => {
    const gate = deferred(); const context = setup({ save: () => gate.promise }); const { el, controller } = context;
    await thirdStep(context); const pending = el('guideFinish').fire('click'); await flush(); controller.dispose();
    const feedback = el('guideResult').textContent; const closed = el('guideDialog').closeCount;
    gate.resolve(true); await pending;
    assert.equal(context.messages.length, 0); assert.equal(el('guideResult').textContent, feedback); assert.equal(el('guideDialog').closeCount, closed);
    assert.equal([...context.nodes.values()].reduce((total,node) => total + [...node.listeners.values()].reduce((sum,set) => sum + set.size,0),0),0);
  });
  await test('dispose之后试学窗口晚响应不再次关闭或修改已经销毁的引导', async () => {
    const gate = deferred(); const context = setup({ openStudy: () => gate.promise }); const { el, controller } = context;
    await thirdStep(context); const pending = el('guideFinish').fire('click'); await flush();
    assert.equal(context.writes, 1); assert.equal(context.messages.length, 1); controller.dispose();
    const closed = el('guideDialog').closeCount; const feedback = el('guideResult').textContent;
    gate.resolve({ok:true}); await pending;
    assert.equal(el('guideDialog').closeCount, closed); assert.equal(el('guideResult').textContent, feedback);
  });
  console.log(`\n${passed} 组首次引导回归通过。没有打开真实窗口、播放声音或访问真实学习数据。`);
} finally {
  harness?.controller.dispose();
  for (const [name, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis,name,descriptor); else delete globalThis[name];
  }
}
