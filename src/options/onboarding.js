/** 三步本地引导：选择期间零写入，确认后只更新偏好。 */
import { SCENES, RHYTHMS, preferencePatch } from '../core/preferences.js';

export function createOnboarding({ saveSettings }) {
  const el = (id) => document.getElementById(id);
  const dialog = el('guideDialog');
  const listeners = [];
  let state = null;
  let presented = false;
  let step = 1;
  let busy = false;
  let disposed = false;
  let saved = false;
  const on = (node, name, fn) => { node.addEventListener(name, fn); listeners.push(() => node.removeEventListener(name, fn)); };
  const feedback = (message = '', error = false) => {
    if (disposed) return;
    el('guideResult').textContent = message;
    el('guideResult').className = `result ${error ? 'err' : ''}`;
  };
  for (const [id, items] of [['guideScene', SCENES], ['guideRhythm', RHYTHMS]]) {
    for (const [key, item] of Object.entries(items)) {
      const option = document.createElement('option'); option.value = key;
      option.textContent = item.label + (item.note ? ` · ${item.note}` : ''); el(id).append(option);
    }
  }
  function choices() {
    return { scene: el('guideScene').value, rhythm: el('guideRhythm').value,
      dailyGoal: el('guideGoal').value, goalMetric: el('guideMetric').value, notifyEnabled: el('guideNotify').checked };
  }
  function validateGoal() {
    const value = Number(el('guideGoal').value);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      feedback('每日目标请填写 1 到 200 的整数。', true); el('guideGoal').focus(); return false;
    }
    return true;
  }
  function update() {
    for (let i = 1; i <= 3; i += 1) el(`guideStep${i}`).hidden = i !== step;
    el('guideStepLabel').textContent = `第 ${step} 步 / 共 3 步`;
    el('guideTitle').textContent = ['从适合你的英语开始', '找到舒服的学习节奏', '确认你的每一小步'][step - 1];
    el('guidePrev').hidden = step === 1;
    el('guideNext').hidden = step === 3 || saved;
    el('guideFinish').hidden = step !== 3;
    el('guideFinish').textContent = saved ? '重新打开试学窗口' : '保存并试学';
    const manual = el('guideRhythm').value === 'manual';
    el('guideNotify').disabled = manual || busy;
    if (manual) el('guideNotify').checked = false;
    for (const node of dialog.querySelectorAll('button, select, input')) node.disabled = busy;
    el('guideNotify').disabled = manual || busy;
    dialog.setAttribute('aria-busy', String(busy));
    if (step === 3) {
      const selected = choices();
      el('guideSummary').textContent = [
        `词库场景：${SCENES[selected.scene].label}`,
        `提醒节奏：${RHYTHMS[selected.rhythm].label}`,
        `每日目标：${selected.dailyGoal} 张${selected.goalMetric === 'answered' ? '主动作答' : '卡片展示'}`,
        `系统通知：${selected.notifyEnabled && !manual ? '开启，静音' : '关闭'}`,
        '保留全部学习进度与自定义词条；自动朗读关闭。',
      ].join('\n');
    }
  }
  function open() {
    if (disposed || busy || dialog.open) return;
    const settings = state?.settings || {};
    const first = settings.onboardingDone === false;
    const tags = settings.bankTags || [];
    el('guideScene').value = Object.keys(SCENES).find((key) => SCENES[key].tags.length === tags.length && SCENES[key].tags.every((tag) => tags.includes(tag))) || 'all';
    el('guideRhythm').value = first ? 'light' : !settings.enabled ? 'manual' : settings.cooldownMinutes >= 15 ? 'light' : 'standard';
    el('guideGoal').value = String(first ? 10 : settings.dailyGoal || 10);
    el('guideMetric').value = first ? 'answered' : settings.goalMetric === 'answered' ? 'answered' : 'shown';
    el('guideNotify').checked = first ? false : !!settings.notifyEnabled;
    step = 1; saved = false; feedback(); update(); dialog.showModal(); el('guideTitle').focus();
  }
  function next() {
    if (busy || disposed || step >= 3) return;
    if (step === 2 && !validateGoal()) return;
    feedback(); step += 1; update(); el('guideTitle').focus();
  }
  async function finish() {
    if (busy || disposed || step !== 3 || !validateGoal()) return;
    const patch = preferencePatch(choices());
    busy = true; update(); feedback(saved ? '正在重新打开试学窗口…' : '正在保存学习偏好…');
    try {
      if (!saved) {
        const ok = await saveSettings(patch);
        if (ok === false || ok?.ok === false) throw new Error('学习偏好没有保存，请重试。');
        saved = true;
      }
      if (disposed) return;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'ui:open-study' });
        if (!response?.ok) throw new Error('试学窗口暂时未能打开。');
        if (disposed) return;
        dialog.close();
      } catch {
        feedback('偏好已保存。试学窗口暂时未能打开，可点“重新打开试学窗口”，或从工具栏主动学习。', true);
      }
    } catch (error) {
      feedback(error.message || '暂时无法保存，请重试。', true);
    } finally {
      busy = false; if (!disposed) update();
    }
  }
  async function skip() {
    if (busy || disposed) return;
    busy = true; update(); feedback('正在保存手动学习模式…');
    try {
      const ok = await saveSettings({ onboardingDone: true, enabled: false, notifyEnabled: false });
      if (ok === false || ok?.ok === false) throw new Error('设置没有保存，请重试。');
      if (!disposed) dialog.close();
    } catch (error) { feedback(error.message || '暂时无法保存，请重试。', true); }
    finally { busy = false; if (!disposed) update(); }
  }
  on(el('btnOpenGuide'), 'click', open);
  on(el('guideNext'), 'click', next);
  on(el('guidePrev'), 'click', () => { if (!busy && step > 1) { step -= 1; saved = false; feedback(); update(); el('guideTitle').focus(); } });
  on(el('guideRhythm'), 'change', update);
  on(el('guideFinish'), 'click', finish);
  on(el('guideSkip'), 'click', skip);
  on(dialog, 'cancel', (event) => { if (busy) event.preventDefault(); });
  on(el('guideForm'), 'submit', (event) => { event.preventDefault(); if (step < 3) next(); else finish(); });
  return {
    render(nextState) { state = nextState; if (!disposed && !presented && state.settings.onboardingDone === false) { presented = true; open(); } },
    open,
    dispose() { disposed = true; for (const remove of listeners) remove(); if (dialog.open) dialog.close(); },
  };
}
