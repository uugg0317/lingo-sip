/**
 * 发音只使用浏览器 / 本机语音，不引入网络服务。
 * chrome.tts 的回调只表示请求已受理；收到 start / end 才确认播放。
 * 参考：https://developer.chrome.com/docs/extensions/reference/api/tts
 */

const START_TIMEOUT_MS = 8000;
const VOICES_TIMEOUT_MS = 1500;
let active = null;

/**
 * 可选声音的统一元数据。remote 声音会保留在枚举结果中供界面解释，
 * 朗读和自动选择只使用 local 声音。
 */
export async function listVoices() {
  const [chromeVoices, webVoices] = await Promise.all([getChromeVoices(), getWebVoices()]);
  const voices = new Map();
  for (const voice of [...chromeVoices, ...webVoices]) {
    const { native, ...metadata } = voice;
    const key = `${voice.voiceName}\u0000${voice.lang}`;
    if (!voices.has(key) || (!voices.get(key).local && metadata.local)) voices.set(key, metadata);
  }
  return [...voices.values()].sort((a, b) => (
    Number(b.local) - Number(a.local) || a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName)
  ));
}

/** 返回真实的播放开始结果；取消 / 中断不降级重播，也不视为引擎故障。 */
export async function speak(text, settings = {}) {
  const content = String(text || '').trim();
  if (!content) return failure('empty', '没有可朗读的文本。');

  stop();
  const request = { controller: new AbortController() };
  active = request;
  const signal = request.controller.signal;
  const options = {
    lang: settings.voiceLang || 'en-US',
    rate: clamp(settings.speechRate ?? 0.95, 0.5, 1.5),
    pitch: 1,
    volume: 1,
    enqueue: false,
  };
  const voiceName = String(settings.voiceName || '').trim();
  let result = await speakChrome(content, options, voiceName, signal);
  if (signal.aborted) return failure('interrupted', '', result.via);

  // 只有明确尚未播放的失败才允许回退。超时可能仍在准备播放，不能重播两遍。
  if (!result.ok && ['unsupported', 'no-voices', 'unavailable-voice', 'error'].includes(result.reason) && webAvailable()) {
    stopChrome();
    result = await speakWeb(content, options, voiceName, signal);
  }
  if (active === request && !result.ok) active = null;
  return result;
}

/** 立即打断朗读，也结束正在等待声音枚举 / start 的请求。 */
export async function stop() {
  const previous = active;
  active = null;
  previous?.controller.abort();
  stopChrome();
  try { globalThis.speechSynthesis?.cancel(); } catch { /* 停止失败不妨碍下一次播放 */ }
}

async function speakChrome(content, options, voiceName, signal) {
  const api = globalThis.chrome?.tts;
  if (typeof api?.speak !== 'function') return failure('unsupported', '当前环境不支持本机发音。');
  const voices = await getChromeVoices(signal);
  if (signal.aborted) return failure('interrupted', '', 'chrome.tts');
  const voice = chooseVoice(voices, options.lang, voiceName);
  if (!voice) return voiceFailure(voiceName, 'chrome.tts');

  return await playback('chrome.tts', signal, (settle) => {
    const returned = api.speak(content, {
      ...options,
      lang: voice.lang || options.lang,
      voiceName: voice.voiceName,
      ...(voice.extensionId ? { extensionId: voice.extensionId } : {}),
      desiredEventTypes: ['start', 'end', 'error', 'interrupted', 'cancelled'],
      onEvent(event = {}) {
        if (event.type === 'start' || event.type === 'end') settle({ ok: true, via: 'chrome.tts' });
        if (event.type === 'error') settle(failure('error', errorMessage(event.errorMessage), 'chrome.tts'));
        if (event.type === 'interrupted' || event.type === 'cancelled') settle(failure(event.type, '', 'chrome.tts'));
      },
    }, () => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) settle(failure('error', errorMessage(error.message), 'chrome.tts'));
    });
    // 新浏览器的 Promise API 和旧版本的 callback API 都不能当成已发声。
    returned?.catch?.((error) => settle(failure('error', errorMessage(error?.message), 'chrome.tts')));
  }, stopChrome);
}

async function speakWeb(content, options, voiceName, signal) {
  const voices = await getWebVoices(signal);
  if (signal.aborted) return failure('interrupted', '', 'speechSynthesis');
  const voice = chooseVoice(voices, options.lang, voiceName);
  if (!voice) return voiceFailure(voiceName, 'speechSynthesis');
  return await playback('speechSynthesis', signal, (settle) => {
    const synth = globalThis.speechSynthesis;
    const utter = new globalThis.SpeechSynthesisUtterance(content);
    utter.lang = voice.lang || options.lang;
    utter.rate = options.rate;
    utter.pitch = options.pitch;
    utter.volume = options.volume;
    utter.voice = voice.native;
    utter.onstart = utter.onend = () => settle({ ok: true, via: 'speechSynthesis' });
    utter.onerror = (event = {}) => {
      const reason = ['interrupted', 'canceled', 'cancelled'].includes(event.error)
        ? (event.error === 'interrupted' ? 'interrupted' : 'cancelled') : 'error';
      settle(failure(reason, reason === 'error' ? errorMessage(event.error) : '', 'speechSynthesis'));
    };
    synth.speak(utter);
  }, () => { try { globalThis.speechSynthesis.cancel(); } catch { /* 已超时 */ } });
}

/** 所有等待都受超时和用户取消约束。受理回调 / Promise 不会提前结算成功。 */
function playback(via, signal, begin, cancelPlayback) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const settle = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => settle(failure('interrupted', '', via));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    timer = setTimeout(() => {
      settle(failure('timeout', '发音引擎长时间没有开始播放，请选择其他本机声音后重试。', via));
      cancelPlayback();
    }, START_TIMEOUT_MS);
    try { begin(settle); } catch (error) { settle(failure('error', errorMessage(error?.message), via)); }
  });
}

function getChromeVoices(signal) {
  const api = globalThis.chrome?.tts;
  if (typeof api?.getVoices !== 'function') return Promise.resolve([]);
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (values = []) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(Array.isArray(values) ? values.filter((v) => v && typeof v.voiceName === 'string' && v.voiceName.trim()).map((v) => ({
        voiceName: v.voiceName,
        lang: typeof v.lang === 'string' ? v.lang : '',
        remote: v.remote === true,
        local: v.remote !== true,
        via: 'chrome.tts',
        eventTypes: Array.isArray(v.eventTypes) ? v.eventTypes.filter((type) => typeof type === 'string') : [],
        extensionId: typeof v.extensionId === 'string' ? v.extensionId : '',
      })) : []);
    };
    const cancel = () => finish();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    timer = setTimeout(() => finish(), VOICES_TIMEOUT_MS);
    try {
      const returned = api.getVoices((voices) => {
        const error = globalThis.chrome?.runtime?.lastError;
        finish(error ? [] : voices);
      });
      returned?.then?.(finish, () => finish());
    } catch { finish(); }
  });
}

function getWebVoices(signal) {
  if (!webAvailable()) return Promise.resolve([]);
  return new Promise((resolve) => {
    const synth = globalThis.speechSynthesis;
    let done = false;
    let timer;
    const finish = (values = []) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      synth.removeEventListener?.('voiceschanged', changed);
      signal?.removeEventListener('abort', cancel);
      resolve(values.filter((v) => v && typeof v.name === 'string' && v.name.trim()).map((v) => ({
        voiceName: v.name,
        lang: typeof v.lang === 'string' ? v.lang : '',
        remote: v.localService === false,
        local: v.localService !== false,
        via: 'speechSynthesis',
        eventTypes: ['start', 'end', 'error'],
        extensionId: '',
        native: v,
      })));
    };
    const cancel = () => finish();
    const changed = () => { try { const values = synth.getVoices(); if (Array.isArray(values) && values.length) finish(values); } catch { finish(); } };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    timer = setTimeout(() => finish(), VOICES_TIMEOUT_MS);
    try {
      const values = synth.getVoices();
      if (Array.isArray(values) && values.length) finish(values);
      else if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', changed);
      else finish();
    } catch { finish(); }
  });
}

function chooseVoice(voices, lang, voiceName) {
  const local = voices.filter((voice) => voice.local);
  if (voiceName) return local.find((voice) => voice.voiceName === voiceName) || null;
  const language = String(lang).toLowerCase();
  const family = language.split('-')[0];
  return local.find((voice) => voice.lang.toLowerCase() === language)
    || local.find((voice) => voice.lang.toLowerCase().split('-')[0] === family) || null;
}

function voiceFailure(voiceName, via) {
  return voiceName
    ? failure('unavailable-voice', '所选声音当前不可用，请在设置中重新选择本机声音。', via)
    : failure('no-voices', '没有找到匹配语言的本机声音，请安装英文语音包或在设置中选择其他声音。', via);
}

function webAvailable() {
  return typeof globalThis.SpeechSynthesisUtterance === 'function'
    && typeof globalThis.speechSynthesis?.speak === 'function'
    && typeof globalThis.speechSynthesis?.getVoices === 'function';
}

function stopChrome() {
  try { globalThis.chrome?.tts?.stop?.(); } catch { /* API 可能随扩展重载失效 */ }
}

function failure(reason, message, via) {
  return { ok: false, reason, ...(message ? { message } : {}), ...(via ? { via } : {}) };
}

function errorMessage(message) {
  const detail = typeof message === 'string' ? message.trim().slice(0, 200) : '';
  return detail ? `发音失败：${detail}` : '发音引擎无法播放，请选择其他本机声音后重试。';
}

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}
