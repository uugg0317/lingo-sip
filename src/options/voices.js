/** 本机声音选择与试听：只读声音列表，用户改选后才保存设置。 */
import { MESSAGES } from '../core/constants.js';

const PREVIEW_TEXT = 'A little practice every day makes a difference.';

/** 依赖由设置页注入；Node 模块校验和缺失控件环境均可安全载入。 */
export function createVoiceControls({ saveSettings } = {}) {
  const doc = globalThis.document;
  const select = doc?.getElementById('voiceName');
  const info = doc?.getElementById('voiceInfo');
  const refreshButton = doc?.getElementById('btnRefreshVoices');
  const previewButton = doc?.getElementById('btnVoicePreview');
  const result = doc?.getElementById('voiceResult');
  if (![select, info, refreshButton, previewButton, result].every(Boolean)) {
    return { render() {}, refresh: async () => false, dispose() {} };
  }

  let settings = { voiceName: '', voiceLang: 'en-US', speechRate: 0.95 };
  let voices = [];
  let loaded = false;
  let loadError = '';
  let refreshing = false;
  let saving = false;
  let previewing = false;
  let disposed = false;
  let refreshToken = 0;
  let previewToken = 0;
  let pendingSelection = null;
  let optionSignature = '';
  const pendingMessages = new Set();

  select.setAttribute('aria-describedby', 'voiceInfo voiceResult');
  info.setAttribute('aria-live', 'polite');
  info.setAttribute('aria-atomic', 'true');

  function selectedName() { return pendingSelection ?? settings.voiceName; }

  function setResult(message = '', kind = '') {
    if (disposed) return;
    result.textContent = message;
    result.classList.toggle('ok', kind === 'ok');
    result.classList.toggle('err', kind === 'err');
  }

  function updateBusy() {
    if (disposed) return;
    const busy = refreshing || saving || previewing;
    select.disabled = busy;
    refreshButton.disabled = busy;
    previewButton.disabled = busy;
    refreshButton.setAttribute('aria-busy', String(refreshing));
    previewButton.setAttribute('aria-busy', String(previewing));
    select.setAttribute('aria-busy', String(saving || refreshing));
  }

  function renderOptions(force = false) {
    if (disposed) return;
    const selected = selectedName();
    const unavailable = !!selected && !voices.some((voice) => voice.voiceName === selected);
    const items = [
      { value: '', label: '系统默认（本机英文声音）', disabled: false },
      ...voices.map((voice) => ({ value: voice.voiceName, label: `${voice.voiceName} · ${voice.lang}`, disabled: false })),
      ...(unavailable ? [{ value: selected, label: `${selected}（当前不可用）`, disabled: true }] : []),
    ];
    const signature = JSON.stringify(items);
    // 存储广播不重建正在操作的下拉框；失焦后再同步候选项和已保存值。
    if (!force && doc.activeElement === select && !select.disabled) return;
    if (signature !== optionSignature) {
      const fragment = doc.createDocumentFragment();
      for (const item of items) {
        const option = doc.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        option.disabled = item.disabled;
        fragment.append(option);
      }
      select.replaceChildren(fragment);
      optionSignature = signature;
    }
    select.value = selected;
  }

  function renderInfo() {
    if (disposed) return;
    if (refreshing) { info.textContent = '正在读取本机英文声音…'; return; }
    if (loadError) { info.textContent = loadError; return; }
    if (!loaded) { info.textContent = '点击“刷新声音”读取本机英文声音。'; return; }
    const selected = selectedName();
    if (selected && !voices.some((voice) => voice.voiceName === selected)) {
      info.textContent = `已选声音“${selected}”当前不可用。原选择已保留，可以重新选择或刷新声音列表。`;
    } else if (!voices.length) {
      info.textContent = '没有找到本机英文声音。安装系统英文语音包后点击“刷新声音”，再选择声音试听。';
    } else {
      info.textContent = `找到 ${voices.length} 个本机英文声音。${selected ? '已使用所选声音。' : '系统默认按发音语言匹配声音。'}`;
    }
  }

  /** callback / Promise 消息接口兼容；后台没有响应时恢复可重试状态。 */
  function sendMessage(message, timeout = 15000) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const settle = (value, error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingMessages.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => settle(null, new Error('声音设置已关闭。'));
      pendingMessages.add(cancel);
      timer = setTimeout(() => settle(null, new Error('后台没有及时响应，请重试。')), timeout);
      try {
        const returned = globalThis.chrome.runtime.sendMessage(message, (response) => {
          const error = globalThis.chrome?.runtime?.lastError;
          settle(response, error ? new Error(error.message || '后台连接失败。') : null);
        });
        returned?.then?.((response) => settle(response), (error) => settle(null, error));
      } catch (error) { settle(null, error); }
    });
  }

  async function refresh() {
    if (disposed) return false;
    const token = ++refreshToken;
    refreshing = true;
    updateBusy(); renderInfo();
    try {
      const response = await sendMessage({ type: MESSAGES.LIST_VOICES }, 6000);
      if (disposed || token !== refreshToken) return false;
      if (!response?.ok || !Array.isArray(response.voices)) throw new Error(response?.message || response?.error || '后台没有返回声音列表。');
      const available = response.voices.filter((voice) => voice?.local === true
        && typeof voice.voiceName === 'string' && voice.voiceName.trim()
        && typeof voice.lang === 'string' && /^en(?:-|$)/i.test(voice.lang));
      const byName = new Map();
      for (const voice of available) if (!byName.has(voice.voiceName)) byName.set(voice.voiceName, voice);
      voices = [...byName.values()].sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName));
      loaded = true;
      loadError = '';
      return true;
    } catch (error) {
      if (!disposed && token === refreshToken) loadError = `声音列表读取失败：${error?.message || '请重试。'} 点击“刷新声音”可以重试。`;
      return false;
    } finally {
      if (!disposed && token === refreshToken) {
        refreshing = false;
        renderOptions(true); renderInfo(); updateBusy();
      }
    }
  }

  async function changeVoice() {
    if (disposed || saving || refreshing || previewing) return;
    const chosen = select.value;
    const previous = settings.voiceName;
    if (chosen === previous) return;
    saving = true;
    pendingSelection = chosen;
    updateBusy(); setResult('正在保存声音选择…');
    try {
      if (typeof saveSettings !== 'function') throw new Error('设置保存入口不可用。');
      const saved = await saveSettings({ voiceName: chosen });
      if (disposed) return;
      if (saved === false || saved?.ok === false) throw new Error(saved?.message || '保存未完成，请重试。');
      settings.voiceName = chosen;
      setResult('声音选择已保存。', 'ok');
    } catch (error) {
      if (!disposed) {
        settings.voiceName = previous;
        setResult(`声音选择保存失败：${error?.message || '请重试。'}`, 'err');
      }
    } finally {
      if (!disposed) {
        saving = false;
        pendingSelection = null;
        renderOptions(true); renderInfo(); updateBusy();
      }
    }
  }

  async function preview() {
    if (disposed || previewing || saving || refreshing) return;
    const token = ++previewToken;
    previewing = true;
    updateBusy(); setResult('正在准备发音…');
    try {
      const response = await sendMessage({
        type: MESSAGES.SPEAK,
        text: PREVIEW_TEXT,
        voiceName: select.value,
        voiceLang: settings.voiceLang,
        rate: settings.speechRate,
      });
      if (disposed || token !== previewToken) return;
      if (response?.ok) setResult('已开始播放试听句。', 'ok');
      else if (['interrupted', 'cancelled'].includes(response?.reason)) setResult();
      else setResult(response?.message || response?.error || '没有成功播放，请选择其他本机声音后重试。', 'err');
    } catch (error) {
      if (!disposed && token === previewToken) setResult(`试听失败：${error?.message || '请重试。'}`, 'err');
    } finally {
      if (!disposed && token === previewToken) { previewing = false; updateBusy(); }
    }
  }

  const syncAfterBlur = () => { renderOptions(true); renderInfo(); };
  select.addEventListener('change', changeVoice);
  select.addEventListener('blur', syncAfterBlur);
  refreshButton.addEventListener('click', refresh);
  previewButton.addEventListener('click', preview);

  return {
    render(nextSettings = {}) {
      if (disposed) return;
      settings = { ...settings, ...nextSettings, voiceName: typeof nextSettings.voiceName === 'string' ? nextSettings.voiceName : settings.voiceName };
      renderOptions(); renderInfo(); updateBusy();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      refreshToken += 1;
      previewToken += 1;
      select.removeEventListener('change', changeVoice);
      select.removeEventListener('blur', syncAfterBlur);
      refreshButton.removeEventListener('click', refresh);
      previewButton.removeEventListener('click', preview);
      for (const cancel of pendingMessages) cancel();
      pendingMessages.clear();
    },
  };
}
