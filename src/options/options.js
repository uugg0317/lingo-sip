/**
 * 设置页
 *
 * 原则：改一下保存一下（不需要点"保存"按钮），顶栏始终展示保存状态。
 * 界面上每个控件都直接对应 settings 里的一个字段，没有隐藏状态。
 */

import { MESSAGES, CARD_SECONDS, BADGE_MODES, TAG_LABELS, SNAPSHOT_KEEP } from '../core/constants.js';
import { read, subscribe, updateSettings, getLog } from '../core/store.js';
import { previewMerge } from '../core/backup.js';
import { createWordManager } from './word-manager.js';
import { createVoiceControls } from './voices.js';
import { createOnboarding } from './onboarding.js';
import { buildView } from '../core/view.js';
import {
  BUILTIN,
  builtinTags,
  toCSV,
  toJSON,
  templateCSV,
  download,
} from '../core/wordbank.js';

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

let view = null;
let wordManager = null;
let voiceControls = null;
let onboarding = null;
/** 已解析、等待用户确认的备份状态（先看预览，确认后才落盘）。 */
let pendingImport = null;
let backupReadId = 0;
let backupApplying = false;

/** 局部更新设置：走后台统一入口，保证角标、日志、广播一起更新。 */
async function patch(patchObj) {
  try {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGES.SET_SETTINGS, patch: patchObj });
      if (!response?.ok) throw new Error(response?.error || '后台没有确认保存');
    } catch {
      // 使用存储层的统一合并，保留 quietHours 中未修改的其他字段。
      await updateSettings(patchObj);
    }
    flashSaved();
    return true;
  } catch (error) {
    flashSaved(`保存失败：${error.message || '请重试'}`, true);
    return false;
  }
}

let savedTimer = null;
function flashSaved(message = '所有更改已保存', isError = false) {
  const tip = el('savedTip');
  clearTimeout(savedTimer);
  tip.textContent = message;
  tip.classList.toggle('on', !isError);
  tip.classList.toggle('error', isError);
  if (!isError) savedTimer = setTimeout(() => {
    tip.textContent = '更改会自动保存';
    tip.classList.remove('on');
  }, 2400);
}

/** 只在控件没被聚焦时回填，避免打断正在输入的用户。 */
function setValue(node, value) {
  if (!node || document.activeElement === node) return;
  if (node.type === 'checkbox') node.checked = !!value;
  else node.value = value;
}

/**
 * 绑定一个布尔开关。
 * @param {string} id 元素 id
 * @param {string} key settings 里的字段名
 * @param {() => void} [after] 写盘之后再执行（例如通知后台起停轮询）
 */
function bindBool(id, key, after) {
  const node = el(id);
  if (!node) return;
  node.addEventListener('change', async () => {
    const saved = await patch({ [key]: node.checked });
    if (saved && typeof after === 'function') after();
  });
}

function bindNumber(id, key, min, max) {
  const node = el(id);
  if (!node) return;
  node.addEventListener('change', () => {
    let value = Number(node.value);
    if (!node.value.trim() || !Number.isFinite(value)) {
      node.value = view?.settings[key] ?? min ?? '';
      return;
    }
    if (min !== undefined) value = Math.max(min, value);
    if (max !== undefined) value = Math.min(max, value);
    value = Math.round(value);
    node.value = String(value);
    patch({ [key]: value });
  });
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

async function render() {
  const state = await read();
  view = buildView(state);
  const s = view.settings;

  /* —— 顶部状态 —— */
  el('statusPill').textContent = view.status;
  el('todayPill').textContent = `今日${view.goalLabel} ${view.goalCount} / ${view.goal} · 连续 ${view.streak} 天`;
  setValue(el('goalMetric'), view.goalMetric);

  /* —— 学习节奏 —— */
  setValue(el('dailyGoal'), s.dailyGoal);
  setValue(el('cardSeconds'), String(s.cardSeconds));
  setValue(el('maxNewPerDay'), s.maxNewPerDay);
  setValue(el('speechRate'), String(s.speechRate));
  el('speechRateValue').textContent = Number(s.speechRate).toFixed(2);
  setValue(el('quizMode'), s.quizMode);
  setValue(el('autoSpeak'), s.autoSpeak);
  setValue(el('recycleMastered'), s.recycleMastered);

  /* —— 触发时机 —— */
  setValue(el('triggerTabSwitch'), s.triggerTabSwitch);
  setValue(el('triggerPageLoad'), s.triggerPageLoad);
  setValue(el('triggerIdle'), s.triggerIdle);
  setValue(el('idleSeconds'), s.idleSeconds);
  setValue(el('triggerTimer'), s.triggerTimer);
  setValue(el('timerMinutes'), s.timerMinutes);
  el('idleSeconds').disabled = !s.triggerIdle;
  el('timerMinutes').disabled = !s.triggerTimer;
  setValue(el('triggerReturn'), s.triggerReturn);

  /* —— 频率闸门 —— */
  setValue(el('cooldownMinutes'), s.cooldownMinutes);
  setValue(el('hourlyCap'), s.hourlyCap);
  setValue(el('dailyCap'), s.dailyCap);
  setValue(el('tabCooldownMinutes'), s.tabCooldownMinutes);
  setValue(el('quietEnabled'), s.quietHours.enabled);
  setValue(el('quietStart'), String(s.quietHours.start));
  setValue(el('quietEnd'), String(s.quietHours.end));
  el('quietStart').disabled = !s.quietHours.enabled;
  el('quietEnd').disabled = !s.quietHours.enabled;

  /* —— 免打扰 —— */
  setValue(el('blacklist'), (s.blacklist || []).join('\n'));

  /* —— 桌面提醒 —— */
  setValue(el('notifyEnabled'), s.notifyEnabled);
  setValue(el('notifySound'), s.notifySound);
  setValue(el('devReload'), s.devReload);
  setValue(el('notifyMinutes'), s.notifyMinutes);
  el('notifySound').disabled = !s.notifyEnabled;
  el('notifyMinutes').disabled = !s.notifyEnabled;

  /* —— 数据 —— */
  setValue(el('badgeMode'), s.showBadge);
  renderChart(view);

  /* —— 词库 —— */
  renderTags(view);
  renderBankStats(view);
  wordManager?.render(state);
  voiceControls?.render(s);
  onboarding?.render(state);

  /* —— 诊断 —— */
  el('lastBlock').textContent = state.runtime.lastBlockReason
    ? `最近一次没有出现卡片的原因：${state.runtime.lastBlockReason}`
    : '最近没有被拦截的记录。如果一直不出现，检查总开关、暂停状态与频率闸门。';

  /* —— 自动备份快照 —— */
  await renderSnapshots();
}

function renderBankStats(v) {
  const total = BUILTIN.length;
  el('bankStats').textContent =
    `内置 ${total} 个高频词与短语，当前学习池 ${v.summary.total} 个：` +
    `待复习 ${v.summary.due} · 没见过 ${v.summary.fresh} · 已掌握 ${v.summary.mastered} · 我的词条 ${v.customCount}`;
}

function renderTags(v) {
  const box = el('tagChips');
  const counts = new Map();
  for (const w of BUILTIN) for (const t of w.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const selected = new Set(v.activeTags);
  const focusedTag = box.contains(document.activeElement) ? document.activeElement.dataset.tag : null;
  box.replaceChildren();
  for (const tag of builtinTags()) {
    const btn = document.createElement('button');
    btn.className = `chip${selected.has(tag) ? ' on' : ''}`;
    btn.type = 'button';
    btn.dataset.tag = tag;
    btn.setAttribute('aria-pressed', String(selected.has(tag)));
    btn.append(document.createTextNode(TAG_LABELS[tag] || tag));
    const small = document.createElement('small');
    small.textContent = String(counts.get(tag) || 0);
    btn.append(small);
    btn.addEventListener('click', async () => {
      if (selected.has(tag)) selected.delete(tag);
      else selected.add(tag);
      await patch({ bankTags: [...selected] });
      await chrome.runtime.sendMessage({ type: MESSAGES.BANK_CHANGED }).catch(() => {});
    });
    box.append(btn);
    if (focusedTag === tag) btn.focus({ preventScroll: true });
  }
  if (selected.size === 0) {
    const tip = document.createElement('span');
    tip.className = 'desc';
    tip.textContent = '（未选择 = 全部启用）';
    box.append(tip);
  }
}

function renderChart(v) {
  const box = el('chart');
  box.replaceChildren();
  const count = (day) => v.goalMetric === 'answered' ? day.answered : day.shown;
  box.setAttribute('aria-label', `近 7 天${v.goalLabel}记录：${v.days.map((d) => `${d.key} 展示 ${d.shown} 张，作答 ${d.answered} 张`).join('；')}`);
  const max = Math.max(v.goal, ...v.days.map(count), 1);
  for (const day of v.days) {
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${Math.max(3, Math.round((count(day) / max) * 84))}%`;
    if (count(day) === 0) bar.style.opacity = '0.25';
    const num = document.createElement('span');
    num.textContent = count(day) ? String(count(day)) : '';
    bar.append(num);

    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = day.key.slice(5).replace('-', '/');

    wrap.append(bar, label);
    box.append(wrap);
  }
}

/* ------------------------------------------------------------------ *
 * 词库：添加 / 导入 / 导出
 * ------------------------------------------------------------------ */

function setResult(id, text, kind) {
  const node = el(id);
  node.textContent = text;
  node.className = `result ${kind || ''}`;
}

async function exportCustom(kind) {
  const state = await read();
  const list = state.customWords;
  if (list.length === 0) {
    setResult('importResult', '还没有自己的词条，先从内置词库学起吧。', 'err');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'csv') download(`语滴-生词本-${stamp}.csv`, toCSV(list), 'text/csv');
  else download(`语滴-生词本-${stamp}.json`, toJSON(list), 'application/json');
  setResult('importResult', `已导出 ${list.length} 条。`, 'ok');
}

/* ------------------------------------------------------------------ *
 * 备份
 * ------------------------------------------------------------------ */

async function exportBackup() {
  const state = await read();
  const stamp = new Date().toISOString().slice(0, 10);
  download(
    `语滴-完整备份-${stamp}.json`,
    JSON.stringify({ app: 'lingo-sip', version: state.version, exportedAt: Date.now(), state }, null, 2),
    'application/json',
  );
  setResult('backupResult', '完整备份已导出（含设置、进度、统计与自定义词条）。', 'ok');
}

function clearBackupPreview() {
  pendingImport = null;
  el('backupPreview').hidden = true;
  el('backupFile').dataset.name = '';
  updateBackupConfirmLabel();
}

async function importBackup(file) {
  const readId = ++backupReadId;
  clearBackupPreview();
  setResult('backupResult', '正在读取备份…', '');
  try {
    const text = await file.text();
    if (readId !== backupReadId) return;
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('备份文件不是合法的 JSON。'); }
    const state = data?.state || data;
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.settings) {
      throw new Error('备份文件里没有找到可用的数据。');
    }
    // 这里只解析并预览；真正写盘始终要等用户点确认。
    pendingImport = state;
    el('backupFile').dataset.name = file.name;
    await previewBackup();
  } catch (error) {
    if (readId === backupReadId) setResult('backupResult', error.message || '读取备份失败，请重试。', 'err');
  }
}

/**
 * 展示差异预览。
 * 这是这次改造的核心：以前点一下"导入"就整体覆盖，用户没有任何机会
 * 发现自己即将丢掉 20 多个词。现在先算清楚、摆出来、等确认。
 */
async function previewBackup() {
  if (!pendingImport) return;
  const imported = pendingImport;
  el('btnConfirmImport').hidden = true;
  const cur = await read();
  if (imported !== pendingImport) return;
  const mode = el('modeReplace')?.checked ? 'replace' : 'merge';
  const box = el('backupPreview');

  const beforeWords = Object.keys(cur.progress || {}).length;
  const incWords = Object.keys(pendingImport.progress || {}).length;

  if (mode === 'merge') {
    const { text, report } = previewMerge(cur, pendingImport);
    box.textContent = `【合并模式预览 · ${el('backupFile').dataset.name || '备份'}】\n${text}`;
    box.dataset.mode = 'merge';
    const safe = report.added.length + report.updated.length > 0;
    setResult(
      'backupResult',
      safe ? '预览已生成，确认无误后点「确认按合并导入」。' : '这份备份没有带来任何新内容，可以不导入。',
      safe ? '' : 'err',
    );
  } else {
    box.textContent = [
      `【覆盖模式预览 · ${el('backupFile').dataset.name || '备份'}】`,
      `当前 ${beforeWords} 条进度记录 → 覆盖后 ${incWords} 条进度记录`,
      incWords < beforeWords ? `注意：会丢掉 ${beforeWords - incWords} 条进度记录，且无法撤销` : '进度记录数不会减少',
      '设置、统计、自定义词条都会整个换成备份里的内容。',
    ].join('\n');
    box.dataset.mode = 'replace';
    setResult('backupResult', '预览已生成，确认无误后点「确认按覆盖导入」。', incWords < beforeWords ? 'err' : '');
  }

  box.hidden = false;
  updateBackupConfirmLabel();
}

/** 确认按钮的文案随模式变化，避免用户点错。 */
function updateBackupConfirmLabel() {
  const btn = el('btnConfirmImport');
  if (!btn) return;
  btn.hidden = !pendingImport;
  btn.textContent = el('modeReplace')?.checked ? '确认按覆盖导入' : '确认按合并导入';
  btn.classList.toggle('btn--danger', !!el('modeReplace')?.checked);
  btn.classList.toggle('btn--primary', !el('modeReplace')?.checked);
  el('btnCancelImport').hidden = !pendingImport;
}

/** 用户点下确认之后，才真正写盘。 */
async function applyBackup() {
  if (!pendingImport || backupApplying) return;
  const mode = el('modeReplace')?.checked ? 'replace' : 'merge';
  if (el('backupPreview').hidden || el('backupPreview').dataset.mode !== mode) return;
  if (mode === 'replace' && !confirm('确定按「覆盖」导入吗？当前的学习进度会被整个替换掉，且无法撤销。')) return;

  backupApplying = true;
  const controls = ['btnConfirmImport', 'btnCancelImport', 'btnImportBackup', 'modeMerge', 'modeReplace'];
  controls.forEach((id) => { el(id).disabled = true; });
  setResult('backupResult', '正在导入，请稍候…', '');
  try {
    const response = await chrome.runtime.sendMessage({
      type: mode === 'replace' ? 'data:import-backup' : 'data:merge-backup',
      state: pendingImport,
    });
    if (!response?.ok) throw new Error(response?.error || '后台未确认导入，请重试。');
    const report = response.report;
    setResult('backupResult', mode === 'replace' ? '已按覆盖模式导入。' : report
      ? `已合并：新增 ${report.added.length} 个、更新 ${report.updated.length} 个、保持 ${report.kept.length} 个。`
      : '已按合并模式导入。', 'ok');
    clearBackupPreview();
    await render().catch(() => flashSaved('备份已导入，请刷新页面查看最新数据', true));
  } catch (error) {
    // 保留预览和待导入数据，失败时可以重试，绝不显示成功。
    setResult('backupResult', `导入失败：${error.message || '请重试'}`, 'err');
  } finally {
    backupApplying = false;
    controls.forEach((id) => { el(id).disabled = false; });
  }
}

/* ------------------------------------------------------------------ *
 * 自动备份快照
 * ------------------------------------------------------------------ */

async function renderSnapshots() {
  el('snapKeep').textContent = String(SNAPSHOT_KEEP);
  let list = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: 'snapshot:list' });
    list = res?.list || [];
  } catch {
    /* 后台没响应时静默降级，不影响其他功能 */
  }

  const sel = el('snapSelect');
  const selectedKey = sel.value;
  sel.textContent = '';
  sel.disabled = list.length === 0;
  el('btnRestoreSnapshot').disabled = list.length === 0;
  if (list.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（还没有快照）';
    sel.appendChild(opt);
    el('snapStatus').textContent = '还没有快照，明天跨天时会自动生成，也可以点下面「立即留一份快照」。';
    return;
  }
  for (const snap of list) {
    const opt = document.createElement('option');
    opt.value = snap.key;
    const time = snap.savedAt ? new Date(snap.savedAt).toLocaleString('zh-CN', { hour12: false }) : '';
    opt.textContent = `${snap.date} · ${snap.words} 条进度记录（掌握记录 ${snap.known}）${time ? ` · ${time}` : ''}`;
    sel.appendChild(opt);
  }
  if (list.some((snap) => snap.key === selectedKey)) sel.value = selectedKey;
  el('snapStatus').textContent = `共 ${list.length} 份，保留最近 ${SNAPSHOT_KEEP} 份。`;
}

async function snapshotNow() {
  const res = await chrome.runtime.sendMessage({ type: 'snapshot:save' }).catch(() => null);
  if (!res?.ok) {
    setResult('backupResult', '留快照失败，稍后再试。', 'err');
    return;
  }
  setResult('backupResult', res.saved ? '已留一份今天的快照。' : '今天的快照已经存在，未重复覆盖。', 'ok');
  await renderSnapshots();
}

async function restoreSnapshot() {
  const key = el('snapSelect').value;
  if (!key) {
    setResult('backupResult', '还没有可恢复的快照。', 'err');
    return;
  }
  if (!confirm('恢复这份快照会把当前进度整个换成快照里的内容。\n恢复前会自动先给"现在"留一份快照作为退路。\n继续吗？')) return;
  const res = await chrome.runtime.sendMessage({ type: 'snapshot:restore', key }).catch(() => null);
  if (!res?.ok) {
    setResult('backupResult', res?.error || '恢复失败。', 'err');
    return;
  }
  setResult('backupResult', '已恢复，并把恢复前的状态另存为一份快照。', 'ok');
  await renderSnapshots();
  render();
}

/* ------------------------------------------------------------------ *
 * 诊断日志
 * ------------------------------------------------------------------ */

async function renderLog() {
  const logs = await getLog();
  const box = el('logList');
  box.replaceChildren();
  for (const item of logs) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const time = document.createElement('time');
    time.textContent = new Date(item.ts).toLocaleTimeString('zh-CN', { hour12: false });
    const text = document.createElement('span');
    text.textContent = item.text;
    row.append(time, text);
    box.append(row);
  }
}

/* ------------------------------------------------------------------ *
 * 初始化：下拉框、事件绑定、订阅
 * ------------------------------------------------------------------ */

function initSelects() {
  const seconds = el('cardSeconds');
  for (const value of CARD_SECONDS) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} 秒`;
    seconds.append(option);
  }

  const badge = el('badgeMode');
  for (const mode of BADGE_MODES) {
    const option = document.createElement('option');
    option.value = mode.value;
    option.textContent = mode.label;
    badge.append(option);
  }

  for (const id of ['quietStart', 'quietEnd']) {
    const node = el(id);
    for (let h = 0; h < 24; h += 1) {
      const option = document.createElement('option');
      option.value = String(h);
      option.textContent = `${String(h).padStart(2, '0')}:00`;
      node.append(option);
    }
  }
}

function initBindings() {
  /* 学习节奏 */
  bindNumber('dailyGoal', 'dailyGoal', 1, 200);
  el('cardSeconds').addEventListener('change', () => patch({ cardSeconds: Number(el('cardSeconds').value) }));
  bindNumber('maxNewPerDay', 'maxNewPerDay', 0, 200);
  el('speechRate').addEventListener('input', () => {
    el('speechRateValue').textContent = Number(el('speechRate').value).toFixed(2);
  });
  el('speechRate').addEventListener('change', () => patch({ speechRate: Number(el('speechRate').value) }));
  bindBool('quizMode', 'quizMode');
  bindBool('autoSpeak', 'autoSpeak');
  bindBool('recycleMastered', 'recycleMastered');

  /* 触发时机 */
  bindBool('triggerTabSwitch', 'triggerTabSwitch');
  bindBool('triggerPageLoad', 'triggerPageLoad');
  bindBool('triggerIdle', 'triggerIdle');
  bindNumber('idleSeconds', 'idleSeconds', 10, 600);
  bindBool('triggerTimer', 'triggerTimer');
  bindNumber('timerMinutes', 'timerMinutes', 10, 480);
  bindBool('triggerReturn', 'triggerReturn');

  /* 频率闸门 */
  bindNumber('cooldownMinutes', 'cooldownMinutes', 1, 120);
  bindNumber('hourlyCap', 'hourlyCap', 1, 60);
  bindNumber('dailyCap', 'dailyCap', 1, 300);
  bindNumber('tabCooldownMinutes', 'tabCooldownMinutes', 1, 240);
  el('quietEnabled').addEventListener('change', () =>
    patch({ quietHours: { enabled: el('quietEnabled').checked } }),
  );
  el('quietStart').addEventListener('change', () =>
    patch({ quietHours: { start: Number(el('quietStart').value) } }),
  );
  el('quietEnd').addEventListener('change', () => patch({ quietHours: { end: Number(el('quietEnd').value) } }));

  /* 免打扰名单 */
  el('blacklist').addEventListener('change', () => {
    const lines = el('blacklist')
      .value.split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    patch({ blacklist: lines });
  });

  /* 桌面提醒 */
  bindBool('notifyEnabled', 'notifyEnabled');
  bindBool('notifySound', 'notifySound');
  // 打开/关闭后要让 service worker 立刻起停轮询，否则要等下次启动才生效
  bindBool('devReload', 'devReload', () => {
    chrome.runtime.sendMessage({ type: 'dev:sync' }).catch(() => {});
  });
  bindNumber('notifyMinutes', 'notifyMinutes', 5, 480);
  el('btnTestNotice').addEventListener('click', async () => {
    setResult('noticeResult', '正在发送…', '');
    try {
      const res = await chrome.runtime.sendMessage({ type: MESSAGES.NOTIFY_TEST });
      if (res?.ok) setResult('noticeResult', `已发出测试通知（${res.word}），看右下角。`, 'ok');
      else setResult('noticeResult', res?.reason || res?.error || '发送失败', 'err');
    } catch (err) {
      setResult('noticeResult', `发送失败：${err.message}`, 'err');
    }
  });

  /* 导出入口；添加、编辑与导入交给独立词库管理模块。 */
  el('btnTemplate').addEventListener('click', () => download('语滴-导入模板.csv', templateCSV(), 'text/csv'));
  el('btnExportCSV').addEventListener('click', () => exportCustom('csv'));
  el('btnExportJSON').addEventListener('click', () => exportCustom('json'));

  /* 数据 */
  el('goalMetric').addEventListener('change', () => patch({ goalMetric: el('goalMetric').value }));
  el('badgeMode').addEventListener('change', () => patch({ showBadge: el('badgeMode').value }));
  el('btnExportBackup').addEventListener('click', exportBackup);
  el('btnImportBackup').addEventListener('click', () => el('backupFile').click());
  el('backupFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await importBackup(file);
    event.target.value = '';
  });
  // 切换模式要重算预览，否则预览和实际行为会对不上
  const refreshBackupPreview = () => previewBackup().catch((error) => setResult('backupResult', `预览失败：${error.message}`, 'err'));
  el('modeMerge').addEventListener('change', refreshBackupPreview);
  el('modeReplace').addEventListener('change', refreshBackupPreview);
  el('btnConfirmImport').addEventListener('click', applyBackup);
  el('btnCancelImport').addEventListener('click', () => {
    backupReadId += 1;
    clearBackupPreview();
    setResult('backupResult', '已取消导入，学习数据没有改变。', '');
  });
  el('btnSnapshotNow').addEventListener('click', snapshotNow);
  el('btnRestoreSnapshot').addEventListener('click', restoreSnapshot);
  el('btnResetProgress').addEventListener('click', async () => {
    if (!confirm('清空所有学习进度与统计（设置和词库保留）？')) return;
    await chrome.runtime.sendMessage({ type: 'data:reset-progress' }).catch(() => {});
    render();
  });
  el('btnResetAll').addEventListener('click', async () => {
    if (!confirm('恢复到出厂设置？所有进度、词库、设置都会被清空，且无法撤销。')) return;
    await chrome.runtime.sendMessage({ type: 'data:reset-all' }).catch(() => {});
    render();
  });

  /* 诊断 */
  el('btnRefreshLog').addEventListener('click', renderLog);
}

/** 导航只标记当前位置；原生锚点保证键盘、历史记录与无脚本跳转可用。 */
function initNavigation() {
  const links = [...document.querySelectorAll('.section-nav a')];
  const sections = links.map((link) => document.querySelector(link.getAttribute('href')));
  let scheduled = false;
  const updateCurrent = () => {
    scheduled = false;
    const offset = window.matchMedia('(max-width: 760px)').matches ? 80 : 150;
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= offset) current = section;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8) current = sections.at(-1);
    for (const link of links) {
      if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  window.addEventListener('scroll', () => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(updateCurrent); }
  }, { passive: true });
  updateCurrent();
}

/* —— 启动 —— */
if (typeof document !== 'undefined') {
  wordManager = createWordManager();
  voiceControls = createVoiceControls({ saveSettings: patch });
  onboarding = createOnboarding({ saveSettings: patch });
  initSelects();
  initBindings();
  initNavigation();
  const showLoadError = () => {
    el('statusPill').textContent = '暂时无法读取';
    flashSaved('读取失败，请重新打开设置页', true);
  };
  render().then(renderLog).then(() => voiceControls.refresh()).catch(showLoadError);
  const unsubscribe = subscribe(() => render().catch(showLoadError));
  // 页面隐藏时暂停日志刷新，避免闲置设置页继续反复读取存储。
  const logTimer = setInterval(() => {
    if (!document.hidden) renderLog().catch(() => {});
  }, 15000);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) render().then(renderLog).catch(showLoadError);
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    clearInterval(logTimer);
    clearTimeout(savedTimer);
    unsubscribe();
    wordManager.dispose();
    voiceControls.dispose();
    onboarding.dispose();
  });
}
