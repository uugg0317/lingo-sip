/** 页面缓存前进/后退回归；模拟浏览器事件，不读写真实学习数据。 */
import assert from 'node:assert/strict';
import { MESSAGES } from '../src/core/constants.js';

const names = ['window', 'document', 'location', 'chrome', 'setInterval', 'clearInterval'];
const originals = new Map(names.map((name) => [name, globalThis[name]]));
const originalNow = Date.now;
const runtimeListeners = new Set();
const storageListeners = new Set();
const timers = new Map();
let settingsReads = 0;
let cardRequests = 0;
let now = 1000000;
const event = (type, persisted) => {
  const value = new Event(type);
  Object.defineProperty(value, 'persisted', { value: persisted });
  return value;
};

try {
  const surface = new EventTarget();
  surface.top = surface;
  globalThis.window = surface;
  globalThis.document = {
    visibilityState: 'visible', hasFocus: () => true, activeElement: null,
    getSelection: () => null, querySelectorAll: () => [],
  };
  globalThis.location = { protocol: 'https:' };
  globalThis.setInterval = (callback) => { const id = Symbol(); timers.set(id, callback); return id; };
  globalThis.clearInterval = (id) => timers.delete(id);
  Date.now = () => now;
  const listeners = (entries) => ({
    addListener: (callback) => entries.add(callback),
    removeListener: (callback) => entries.delete(callback),
  });
  globalThis.chrome = {
    runtime: {
      id: 'test-only', onMessage: listeners(runtimeListeners),
      sendMessage: async () => { cardRequests++; return { ok: false }; },
    },
    storage: {
      local: { get: async () => { settingsReads++; return {}; } },
      onChanged: listeners(storageListeners),
    },
  };

  const { start } = await import('../src/content/app.js');
  await start();
  assert.equal(runtimeListeners.size, 1);
  assert.equal(storageListeners.size, 1);
  assert.equal(timers.size, 1);

  surface.dispatchEvent(event('pagehide', true));
  now += 60000;
  surface.dispatchEvent(event('pageshow', true));
  await Promise.resolve();
  await start();
  assert.equal(runtimeListeners.size, 1);
  assert.equal(storageListeners.size, 1);
  assert.equal(timers.size, 1);
  assert.equal(settingsReads, 2);
  for (const tick of timers.values()) await tick();
  assert.equal(cardRequests, 0, '恢复页面后重新计算空闲时间，不立即打扰');
  let response;
  for (const listener of runtimeListeners) listener({ type: MESSAGES.SHOW_CARD }, {}, (value) => { response = value; });
  assert.equal(response?.reason, '没有词', '后退恢复后消息通道仍然工作');

  surface.dispatchEvent(event('pagehide', false));
  assert.equal(runtimeListeners.size, 0);
  assert.equal(storageListeners.size, 0);
  assert.equal(timers.size, 0);
  surface.dispatchEvent(event('pageshow', true));
  await start();
  assert.equal(settingsReads, 2, '真实卸载已注销恢复监听');
  assert.equal(runtimeListeners.size, 0);
  console.log('通过 1 项页面缓存生命周期回归');
} finally {
  Date.now = originalNow;
  for (const [name, value] of originals) {
    if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
  }
}
