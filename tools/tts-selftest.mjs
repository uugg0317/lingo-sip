/** 发音回归：只模拟浏览器 API，不播放声音，不读写真实学习数据。 */
import assert from 'node:assert/strict';
import { speak, stop, listVoices } from '../src/core/tts.js';

const keys = ['chrome', 'speechSynthesis', 'SpeechSynthesisUtterance', 'setTimeout', 'clearTimeout'];
const original = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
let sequence = 0;
let clock = 0;
let passed = 0;
const timers = new Map();
const voice = { voiceName: 'Local English', lang: 'en-US', remote: false, eventTypes: ['start', 'end', 'error'] };
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };

async function reset() {
  await stop();
  for (const key of keys.slice(0, 3)) delete globalThis[key];
  timers.clear(); clock = 0;
  globalThis.setTimeout = (run, delay) => { const id = ++sequence; timers.set(id, { run, at: clock + delay }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
}
async function advance(ms) {
  const target = clock + ms;
  while (true) {
    const first = [...timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!first) break;
    const [id, item] = first;
    timers.delete(id); clock = item.at; item.run(); await flush();
  }
  clock = target; await flush();
}
function chromeEngine(run, voices = [voice]) {
  const state = { calls: [], stops: 0 };
  globalThis.chrome = {
    runtime: {},
    tts: {
      getVoices(callback) { callback(voices); },
      speak(content, options, callback) { state.calls.push({ content, options }); return run?.(content, options, callback); },
      stop() { state.stops += 1; },
    },
  };
  return state;
}
function webEngine(run, voices = [{ name: 'Local English', lang: 'en-US', localService: true }]) {
  const state = { calls: [], cancels: 0, listeners: new Map(), voices };
  globalThis.SpeechSynthesisUtterance = class { constructor(content) { this.text = content; } };
  globalThis.speechSynthesis = {
    getVoices: () => state.voices,
    speak(utter) { state.calls.push(utter); run?.(utter); },
    cancel() { state.cancels += 1; },
    addEventListener(type, callback) { state.listeners.set(type, callback); },
    removeEventListener(type, callback) { if (state.listeners.get(type) === callback) state.listeners.delete(type); },
  };
  return state;
}
async function test(label, run) { await reset(); await run(); await stop(); assert.equal(timers.size, 0, `${label} 没有残留计时器`); passed += 1; console.log(`✓ ${label}`); }

try {
  await test('空文本与完全不支持发音都有明确失败结果', async () => {
    assert.equal((await speak('  ')).reason, 'empty');
    assert.equal((await speak('word')).reason, 'unsupported');
  });
  await test('chrome 回调受理和 word 事件不会提前报告成功，start 才确认', async () => {
    const state = chromeEngine((_text, _options, callback) => callback());
    let result;
    const pending = speak('word').then((value) => { result = value; return value; });
    await flush(); assert.equal(result, undefined);
    state.calls[0].options.onEvent({ type: 'word' }); await flush(); assert.equal(result, undefined);
    state.calls[0].options.onEvent({ type: 'start' });
    assert.deepEqual(await pending, { ok: true, via: 'chrome.tts' });
  });
  await test('没有 start 的引擎可由 end 事件确认', async () => {
    chromeEngine((_text, options) => options.onEvent({ type: 'end' }));
    assert.equal((await speak('word')).ok, true);
  });
  await test('runtime.lastError 在 callback 内捕获并返回原因', async () => {
    chromeEngine((_text, _options, callback) => {
      chrome.runtime.lastError = { message: 'No engine found' }; callback(); delete chrome.runtime.lastError;
    });
    const result = await speak('word');
    assert.equal(result.ok, false); assert.equal(result.reason, 'error'); assert.match(result.message, /No engine found/);
  });
  await test('受理之后异步 error 事件返回引擎失败', async () => {
    const state = chromeEngine((_text, _options, callback) => callback());
    const pending = speak('word'); await flush();
    state.calls[0].options.onEvent({ type: 'error', errorMessage: 'device unavailable' });
    const result = await pending;
    assert.equal(result.reason, 'error'); assert.match(result.message, /device unavailable/);
  });
  await test('Chrome 同步抛错被捕获', async () => {
    chromeEngine(() => { throw new Error('invalid engine'); });
    const result = await speak('word'); assert.equal(result.reason, 'error'); assert.match(result.message, /invalid engine/);
  });
  await test('初次失败才允许 Web Speech 回退，回退同样等开始事件', async () => {
    const chromeState = chromeEngine((_text, _options, callback) => {
      chrome.runtime.lastError = { message: 'engine failed' }; callback(); delete chrome.runtime.lastError;
    });
    const webState = webEngine();
    let result;
    const pending = speak('word').then((value) => { result = value; return value; });
    await flush(); assert.equal(result, undefined); assert.equal(webState.calls.length, 1);
    webState.calls[0].onstart();
    assert.deepEqual(await pending, { ok: true, via: 'speechSynthesis' });
    assert.equal(chromeState.calls.length, 1);
  });
  await test('Promise 型 Chrome speak 拒绝后回退，Promise 受理不等于播放', async () => {
    chromeEngine(() => Promise.reject(new Error('permission rejected')));
    webEngine((utter) => utter.onstart());
    assert.equal((await speak('word')).via, 'speechSynthesis');
    await stop();
    const state = chromeEngine(() => Promise.resolve());
    let result;
    const pending = speak('word').then((value) => { result = value; return value; });
    await flush(); assert.equal(result, undefined);
    state.calls[0].options.onEvent({ type: 'start' }); assert.equal((await pending).ok, true);
  });
  await test('interrupted / cancelled 不报引擎故障，也不降级重播', async () => {
    const webState = webEngine();
    for (const reason of ['interrupted', 'cancelled']) {
      chromeEngine((_text, options) => options.onEvent({ type: reason }));
      const result = await speak('word'); assert.equal(result.reason, reason); assert.equal(result.message, undefined);
    }
    assert.equal(webState.calls.length, 0);
  });
  await test('停止正在等 start 的朗读立即结算，中断后晚到事件不能重播', async () => {
    const state = chromeEngine(); const webState = webEngine();
    const pending = speak('word'); await flush(); await stop();
    assert.equal((await pending).reason, 'interrupted');
    state.calls[0].options.onEvent({ type: 'error' }); await flush(); assert.equal(webState.calls.length, 0);
  });
  await test('第二次朗读替换第一请求，旧请求不会影响新请求', async () => {
    const state = chromeEngine();
    const first = speak('first'); await flush();
    const second = speak('second'); await flush();
    assert.equal((await first).reason, 'interrupted');
    state.calls[0].options.onEvent({ type: 'error' });
    state.calls[1].options.onEvent({ type: 'start' }); assert.equal((await second).ok, true);
  });
  await test('开始前超时会停止引擎并提示，绝不自动重复降级', async () => {
    const state = chromeEngine(); const webState = webEngine();
    const pending = speak('word'); await flush(); await advance(8000);
    const result = await pending; assert.equal(result.reason, 'timeout'); assert.match(result.message, /没有开始播放/);
    assert.ok(state.stops >= 2); assert.equal(webState.calls.length, 0);
    state.calls[0].options.onEvent({ type: 'start' }); await flush(); assert.equal(webState.calls.length, 0);
  });
  await test('指定声音和语速传给引擎；系统默认按语言选本机声音', async () => {
    const state = chromeEngine((_text, options) => options.onEvent({ type: 'start' }), [
      { voiceName: 'Remote English', lang: 'en-US', remote: true },
      { ...voice, voiceName: 'British', lang: 'en-GB', extensionId: 'test-engine' }, voice,
    ]);
    await speak('word', { voiceName: 'British', speechRate: 1.2 });
    assert.equal(state.calls[0].options.voiceName, 'British'); assert.equal(state.calls[0].options.rate, 1.2);
    assert.equal(state.calls[0].options.extensionId, 'test-engine');
    await speak('word'); assert.equal(state.calls[1].options.voiceName, 'Local English');
  });
  await test('没有本机声音 / 所选声音失效返回明确信息，远程声音不播放', async () => {
    const state = chromeEngine(undefined, [{ voiceName: 'Remote', lang: 'en-US', remote: true }]);
    assert.equal((await speak('word')).reason, 'no-voices');
    assert.equal((await speak('word', { voiceName: 'Remote' })).reason, 'unavailable-voice');
    assert.equal((await speak('word', { voiceName: 'Removed' })).reason, 'unavailable-voice');
    assert.equal(state.calls.length, 0);
  });
  await test('getVoices 支持 callback / Promise，保留 offline 元数据且去重', async () => {
    chromeEngine(undefined, [voice, { voiceName: 'Cloud', lang: 'en-US', remote: true }, null, { voiceName: '' }]);
    webEngine(undefined, [{ name: 'Local English', lang: 'en-US', localService: true }]);
    const values = await listVoices(); assert.equal(values.length, 2); assert.equal(values[0].local, true);
    assert.equal(values[1].remote, true); assert.equal(values[0].native, undefined);
    chrome.tts.getVoices = () => Promise.resolve([{ ...voice, voiceName: 'Promise Voice' }]);
    const promised = await listVoices(); assert.ok(promised.some((entry) => entry.voiceName === 'Promise Voice'));
  });
  await test('getVoices 失败 / 不回调受到超时约束，停止也可立即取消枚举', async () => {
    chromeEngine(); chrome.tts.getVoices = () => undefined;
    const pending = listVoices(); await advance(1500); assert.deepEqual(await pending, []);
    const speech = speak('word'); await flush(); await stop(); assert.equal((await speech).reason, 'interrupted');
    chrome.tts.getVoices = (callback) => {
      chrome.runtime.lastError = { message: 'no voices access' }; callback([]); delete chrome.runtime.lastError;
    };
    assert.deepEqual(await listVoices(), []);
  });
  await test('Service Worker 只有不完整 Web Speech 时不能假报成功', async () => {
    globalThis.speechSynthesis = { speak() { throw new Error('should not call'); }, getVoices: () => [] };
    assert.equal((await speak('word')).reason, 'unsupported');
  });
  await test('Web Speech 支持延迟声音枚举，声音元数据可安全序列化', async () => {
    const state = webEngine((utter) => utter.onend(), []);
    const pending = speak('word'); await flush();
    state.voices.push({ name: 'Local English', lang: 'en-US', localService: true });
    state.listeners.get('voiceschanged')(); assert.equal((await pending).ok, true);
    assert.equal(state.listeners.size, 0);
    const metadata = await listVoices(); assert.equal(metadata[0].native, undefined);
    assert.doesNotThrow(() => JSON.stringify(metadata));
  });
  await test('Web Speech error 和超时都返回失败，取消无错误提示', async () => {
    const state = webEngine();
    let pending = speak('word'); await flush(); state.calls[0].onerror({ error: 'audio-busy' });
    assert.equal((await pending).reason, 'error');
    pending = speak('word'); await flush(); state.calls[1].onerror({ error: 'canceled' });
    const cancelled = await pending; assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.message, undefined);
    pending = speak('word'); await flush(); await advance(8000); assert.equal((await pending).reason, 'timeout');
  });
  await test('Web Speech 无声音会在有限时间内结束', async () => {
    const state = webEngine(undefined, []);
    const pending = speak('word'); await flush(); await advance(1500);
    assert.equal((await pending).reason, 'no-voices'); assert.equal(state.calls.length, 0); assert.equal(state.listeners.size, 0);
  });
  console.log(`\n${passed} 组发音回归通过。没有播放真实声音或访问学习数据。`);
} finally {
  await stop();
  for (const key of keys) {
    if (original[key] === undefined) delete globalThis[key]; else globalThis[key] = original[key];
  }
}
