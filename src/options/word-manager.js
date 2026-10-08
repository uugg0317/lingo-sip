/** 词库管理：搜索、分页、预览确认、保留身份的编辑与可撤销删除。 */
import { read, update, SKIP_WRITE } from '../core/store.js';
import { MESSAGES } from '../core/constants.js';
import { pool, normalizeWord, parseImport, previewWordImport, applyWordImport } from '../core/wordbank.js';

const termKey = (term) => String(term || '').trim().toLowerCase();
export const wordFingerprint = (words) => JSON.stringify(words || []);

/** pool 已统一身份；直接按 canonical id 查进度，避免逐词再次扫描整个词库。 */
export function selectWordRows(state, filters = {}, page = 1, pageSize = 20) {
  const customTerms = new Set((state.customWords || []).map((word) => termKey(word.term)));
  const query = termKey(filters.query);
  const words = pool({ ...state, settings: { ...state.settings, bankTags: [] } });
  const rows = words.map((word) => {
    const rec = state.progress?.[word.id];
    const status = !rec || rec.seen === 0 || rec.status === 'new' ? 'new'
      : rec.status === 'mastered' ? 'mastered' : 'learning';
    return { word, status, custom: customTerms.has(termKey(word.term)) };
  }).filter(({ word, status, custom }) => (filters.scope !== 'custom' || custom)
    && (!filters.status || filters.status === 'all' || filters.status === status)
    && (!query || [word.term, word.meaning, word.example, word.exampleZh].some((text) => termKey(text).includes(query))));
  rows.sort((a, b) => a.word.term.localeCompare(b.word.term, 'en', { sensitivity: 'base' }));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.max(1, Math.min(pages, Number(page) || 1));
  return { rows: rows.slice((safePage - 1) * pageSize, safePage * pageSize), total: rows.length, page: safePage, pages, customCount: customTerms.size };
}

/** 撤销只恢复当前不存在的词；删后新建或编辑的同名词优先，原进度一直保留。 */
export function restoreDeletedWords(state, deletedWords) {
  const present = new Set((state.customWords || []).map((word) => termKey(word.term)));
  const candidates = deletedWords.filter((word) => !present.has(termKey(word.term)));
  const preview = previewWordImport(state, candidates);
  const rejected = new Set(preview.conflicts.map((word) => termKey(word.term)));
  const safe = candidates.filter((word) => !rejected.has(termKey(word.term)));
  const restored = new Set(safe.map((word) => termKey(word.term))).size;
  return { customWords: [...(state.customWords || []), ...safe], restored, skipped: new Set(deletedWords.map((word) => termKey(word.term))).size - restored };
}

export function describeWordImport(report, errors = []) {
  const s = report.summary;
  const lines = [`新增 ${s.added} 条 · 更新 ${s.updated} 条 · 未变 ${s.unchanged} 条 · 身份冲突 ${s.conflicts} 条`,
    `可导入 ${s.ready} 条；同名更新保留词条身份和学习进度。`];
  for (const [label, list] of [['新增', report.added], ['更新', report.updated]]) {
    if (list.length) lines.push(`${label}：${list.slice(0, 8).map((word) => word.term).join('、')}${list.length > 8 ? '…' : ''}`);
  }
  if (report.conflicts.length) lines.push('冲突词条会跳过，其余有效词条可导入。', ...report.conflicts.slice(0, 8).map((word) => `${word.term || '未命名词条'}：${word.reason}`));
  if (errors.length) lines.push(`解析时跳过 ${errors.length} 行：`, ...errors.slice(0, 8));
  return lines.join('\n');
}

export function createWordManager() {
  const el = (id) => document.getElementById(id);
  const listeners = [];
  let state = null;
  let page = 1;
  let signature = '';
  let deferred = false;
  let disposed = false;
  let writing = false;
  let importRevision = 0;
  let fileRevision = 0;
  let fileReading = false;
  let pending = null;
  let undo = null;
  let undoTimer = null;
  let editing = null;
  const busyButtons = new Set();
  const on = (node, event, callback) => { node.addEventListener(event, callback); listeners.push(() => node.removeEventListener(event, callback)); };
  const result = (id, message, kind = '') => {
    if (disposed) return;
    const node = el(id); node.textContent = message; node.className = `result ${kind}`;
  };
  const notify = async () => { try { await chrome.runtime.sendMessage({ type: MESSAGES.BANK_CHANGED }); } catch { /* 数据已保存，角标刷新失败不误报写入失败。 */ } };
  async function run(button, id, action, mutation = false) {
    if (disposed || busyButtons.has(button) || (mutation && writing)) return;
    busyButtons.add(button); button.disabled = true;
    if (mutation) writing = true;
    try { await action(); }
    catch (error) { result(id, error.message || '操作未完成，请重试。', 'err'); }
    finally { busyButtons.delete(button); if (mutation) writing = false; if (!disposed) button.disabled = button === el('btnImport') && fileReading; }
  }

  function render(next, force = false) {
    if (disposed) return;
    state = next;
    const selected = selectWordRows(state, { query: el('wordSearch').value, scope: el('wordScope').value, status: el('wordStatus').value }, page);
    page = selected.page;
    el('customCount').textContent = String(selected.customCount);
    el('wordListInfo').textContent = selected.total ? `找到 ${selected.total} 条，每页最多 20 条。` : '没有符合当前条件的词条。';
    el('wordPage').textContent = `第 ${page} / ${selected.pages} 页`;
    el('wordPrev').disabled = page <= 1;
    el('wordNext').disabled = page >= selected.pages;
    const nextSignature = JSON.stringify(selected.rows);
    if (nextSignature === signature) return;
    const list = el('customList');
    if (!force && list.contains(document.activeElement)) { deferred = true; return; }
    signature = nextSignature; deferred = false;
    const rows = selected.rows.map(({ word, status, custom }) => {
      const row = document.createElement('div'); row.className = 'wm-row'; row.dataset.wordId = word.id;
      const body = document.createElement('div'); body.className = 'wm-row-body';
      const head = document.createElement('div'); head.className = 'wm-row-head';
      const term = document.createElement('strong'); term.textContent = word.term;
      const badge = document.createElement('span'); badge.className = `wm-status wm-status--${status}`;
      badge.textContent = { new: '未学', learning: '在学', mastered: '已掌握' }[status];
      const source = document.createElement('span'); source.className = 'wm-source'; source.textContent = custom ? '我的词条' : '内置';
      head.append(term, badge, source);
      const meaning = document.createElement('p'); meaning.className = 'wm-meaning'; meaning.textContent = word.meaning;
      body.append(head, meaning);
      if (word.example) { const example = document.createElement('p'); example.className = 'wm-example'; example.textContent = word.example; body.append(example); }
      const actions = document.createElement('div'); actions.className = 'wm-row-actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn'; edit.dataset.action = 'edit'; edit.textContent = '编辑'; edit.setAttribute('aria-label', `编辑词条 ${word.term}`);
      edit.addEventListener('click', () => openEditor(word)); actions.append(edit);
      if (custom) {
        const del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn--danger'; del.dataset.action = 'delete'; del.textContent = '删除'; del.setAttribute('aria-label', `删除我的词条 ${word.term}`);
        del.addEventListener('click', () => run(del, 'wordManageResult', () => deleteWords(new Set([termKey(word.term)])), true)); actions.append(del);
      }
      row.append(body, actions); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'wm-empty'; empty.textContent = '调整搜索、范围或学习状态，再找找看。'; rows.push(empty); }
    list.replaceChildren(...rows);
  }

  async function refresh(force = false) { const next = await read(); if (!disposed) render(next, force); }
  function openEditor(word) {
    if (writing || disposed) return;
    editing = { key: termKey(word.term), word, signature: wordFingerprint([word]) };
    for (const [id, field] of [['editTerm', 'term'], ['editMeaning', 'meaning'], ['editPhonetic', 'phonetic'], ['editPos', 'pos'], ['editExample', 'example'], ['editExampleZh', 'exampleZh'], ['editType', 'type']]) el(id).value = word[field] || '';
    el('editTags').value = (word.tags || []).join('|');
    result('editResult', ''); el('wordEditor').showModal(); el('editMeaning').focus();
  }
  async function saveEdit() {
    const request = editing;
    if (!request || !el('editMeaning').value.trim()) { result('editResult', '请填写中文释义。', 'err'); return; }
    const patch = { id: request.word.id, term: request.word.term, meaning: el('editMeaning').value, phonetic: el('editPhonetic').value, pos: el('editPos').value, example: el('editExample').value, exampleZh: el('editExampleZh').value, type: el('editType').value, tags: el('editTags').value, level: request.word.level };
    await update((current) => {
      const latest = pool({ ...current, settings: { ...current.settings, bankTags: [] } }).find((word) => termKey(word.term) === request.key);
      if (!latest || wordFingerprint([latest]) !== request.signature) throw new Error('词条已在其他页面更新，请关闭编辑后重新打开，避免覆盖新的内容。');
      const applied = applyWordImport(current, [normalizeWord(patch)]);
      if (!applied.report.canApply) throw new Error(applied.report.conflicts[0]?.reason || '词条未能保存，请重试。');
      current.customWords = applied.state.customWords; current.progress = applied.state.progress;
    });
    el('wordEditor').close(); editing = null;
    result('wordManageResult', `已保存 ${request.word.term}，原词条身份和学习进度已保留。`, 'ok');
    await refresh(true); await notify();
  }

  const addFields = ['newTerm', 'newMeaning', 'newPhonetic', 'newPos', 'newExample', 'newExampleZh', 'newType'];
  async function addWord() {
    const submitted = Object.fromEntries(addFields.map((id) => [id, el(id).value]));
    const raw = { term: submitted.newTerm.trim(), meaning: submitted.newMeaning.trim() };
    if (submitted.newType === 'word' || submitted.newType === 'phrase') raw.type = submitted.newType;
    if (!raw.term || !raw.meaning) { result('wordAddResult', '请填写单词和中文释义。', 'err'); el(!raw.term ? 'newTerm' : 'newMeaning').focus(); return; }
    // 添加同名词时，未填写的可选字段保留原值；编辑弹窗则允许明确清空字段。
    for (const [id, field] of [['newPhonetic', 'phonetic'], ['newPos', 'pos'], ['newExample', 'example'], ['newExampleZh', 'exampleZh']]) if (submitted[id].trim()) raw[field] = submitted[id];
    let report;
    await update((current) => {
      const applied = applyWordImport(current, [normalizeWord(raw)]); report = applied.report;
      if (!report.canApply) throw new Error(report.conflicts[0]?.reason || '词条无法保存，请检查内容。');
      current.customWords = applied.state.customWords; current.progress = applied.state.progress;
    });
    for (const id of addFields) if (el(id).value === submitted[id]) el(id).value = id === 'newType' ? 'auto' : '';
    result('wordAddResult', `${report.summary.added ? '已添加' : '已更新'}：${raw.term}。原有学习进度保留。`, 'ok');
    await refresh(); await notify();
    if (document.activeElement === el('btnAddWord')) el('newTerm').focus();
  }
  function clearPreview() {
    pending = null; el('wordImportPreview').hidden = true;
    el('btnConfirmWords').hidden = true; el('btnCancelWords').hidden = true;
  }
  function showPreview(request, report, notice = '') {
    pending = request;
    el('wordImportPreview').textContent = describeWordImport(report, request.errors);
    el('wordImportPreview').hidden = false;
    el('btnConfirmWords').hidden = !report.canApply; el('btnCancelWords').hidden = false;
    result('importResult', notice || (report.canApply ? '预览已生成，核对后点「确认导入」。' : '没有可导入词条，请修改内容后重新预览。'), report.canApply ? '' : 'err');
  }
  async function previewImport() {
    const revision = importRevision;
    const parsed = parseImport(el('importText').value);
    if (!parsed.words.length) { clearPreview(); result('importResult', parsed.errors.join('\n') || '没有解析出有效词条。', 'err'); return; }
    const latest = await read();
    if (disposed || revision !== importRevision) return;
    // 保留原对象的非枚举 Symbol，用于区分“未提供字段”与“明确空值”。
    const request = { words: parsed.words, errors: parsed.errors, revision, fingerprint: wordFingerprint(latest.customWords) };
    showPreview(request, previewWordImport(latest, request.words));
  }
  async function confirmImport() {
    const request = pending;
    if (!request || request.revision !== importRevision) return;
    let report; let changed = false;
    el('btnCancelWords').disabled = true;
    try {
      await update((current) => {
        report = previewWordImport(current, request.words);
        if (wordFingerprint(current.customWords) !== request.fingerprint) {
          changed = true; request.fingerprint = wordFingerprint(current.customWords); return SKIP_WRITE;
        }
        if (!report.canApply) throw new Error('没有可导入词条，请重新预览。');
        const applied = applyWordImport(current, request.words);
        current.customWords = applied.state.customWords; current.progress = applied.state.progress; report = applied.report;
      });
      if (disposed) return;
      if (changed) {
        if (pending === request && importRevision === request.revision) showPreview(request, report, '词库已在其他页面变化，已重新生成预览。请再次核对并确认。');
        else result('importResult', '词库已变化，本次没有写入。请重新预览后确认。', 'err');
        return;
      }
      if (pending === request) clearPreview();
      const s = report.summary;
      result('importResult', `导入完成：新增 ${s.added} 条、更新 ${s.updated} 条、未变 ${s.unchanged} 条；跳过 ${s.conflicts} 条身份冲突${request.errors.length ? `与 ${request.errors.length} 行解析错误` : ''}。`, 'ok');
      await refresh(); await notify();
    } finally { if (!disposed) el('btnCancelWords').disabled = false; }
  }

  function rememberDeletion(removed) {
    clearTimeout(undoTimer);
    undo = { words: removed, expires: Date.now() + 10000 };
    el('btnUndoDelete').hidden = false;
    undoTimer = setTimeout(() => {
      undo = null; if (!disposed) { el('btnUndoDelete').hidden = true; result('wordManageResult', '撤销时间已结束。学习进度仍保留，可重新添加词条。'); }
    }, 10000);
  }
  async function deleteWords(keys) {
    let removed = [];
    await update((current) => {
      removed = current.customWords.filter((word) => !keys || keys.has(termKey(word.term)));
      if (!removed.length) return SKIP_WRITE;
      current.customWords = current.customWords.filter((word) => keys && !keys.has(termKey(word.term)));
    });
    if (!removed.length) { result('wordManageResult', '这些词条已被删除。'); await refresh(true); return; }
    rememberDeletion(removed);
    result('wordManageResult', `已删除 ${new Set(removed.map((word) => termKey(word.term))).size} 个自定义词条，10 秒内可撤销；学习进度仍保留。`, 'ok');
    await refresh(true); await notify();
    if (!disposed) el('btnUndoDelete').focus({ preventScroll: true });
  }
  async function undoDelete() {
    const request = undo;
    if (!request || Date.now() > request.expires) return;
    let restored;
    await update((current) => {
      restored = restoreDeletedWords(current, request.words);
      if (!restored.restored) return SKIP_WRITE;
      current.customWords = restored.customWords;
    });
    if (undo === request) { undo = null; clearTimeout(undoTimer); el('btnUndoDelete').hidden = true; }
    result('wordManageResult', `已恢复 ${restored.restored} 个词条${restored.skipped ? `，${restored.skipped} 个已有新内容或身份冲突，保留当前内容` : ''}。`, 'ok');
    await refresh(true); await notify();
  }
  for (const id of ['wordSearch', 'wordScope', 'wordStatus']) on(el(id), id === 'wordSearch' ? 'input' : 'change', () => { page = 1; if (state) render(state, true); });
  on(el('wordPrev'), 'click', () => { page -= 1; if (state) render(state, true); });
  on(el('wordNext'), 'click', () => { page += 1; if (state) render(state, true); });
  on(el('customList'), 'focusout', () => queueMicrotask(() => { if (!disposed && deferred && state && !el('customList').contains(document.activeElement)) render(state); }));
  on(el('btnAddWord'), 'click', () => run(el('btnAddWord'), 'wordAddResult', addWord, true));
  on(el('btnImport'), 'click', () => run(el('btnImport'), 'importResult', previewImport));
  on(el('btnConfirmWords'), 'click', () => run(el('btnConfirmWords'), 'importResult', confirmImport, true));
  on(el('btnCancelWords'), 'click', () => { importRevision += 1; clearPreview(); result('importResult', '已取消导入，词库没有改变。'); });
  on(el('importText'), 'input', () => { importRevision += 1; fileRevision += 1; fileReading = false; el('btnImport').disabled = busyButtons.has(el('btnImport')); clearPreview(); result('importResult', '内容已修改，请重新预览。'); });
  on(el('importFile'), 'change', async () => {
    const file = el('importFile').files?.[0]; if (!file) return;
    const revision = ++fileRevision; fileReading = true; importRevision += 1; clearPreview(); result('importResult', '正在读取文件…');
    const button = el('btnImport'); button.disabled = true;
    try {
      const text = await file.text(); if (disposed || revision !== fileRevision) return;
      el('importText').value = text; result('importResult', `已读取 ${file.name}，点击「预览导入」核对。`);
    } catch (error) { if (revision === fileRevision) result('importResult', `读取文件失败：${error.message || '请重试'}`, 'err'); }
    finally { if (!disposed && revision === fileRevision) { fileReading = false; button.disabled = busyButtons.has(button); el('importFile').value = ''; } }
  });
  on(el('btnClearCustom'), 'click', () => run(el('btnClearCustom'), 'wordManageResult', async () => {
    if (!confirm('清空所有自定义词条？内置词库和学习进度会保留，10 秒内可以撤销。')) return;
    await deleteWords(null);
  }, true));
  on(el('btnUndoDelete'), 'click', () => run(el('btnUndoDelete'), 'wordManageResult', undoDelete, true));
  on(el('wordEditForm'), 'submit', (event) => { event.preventDefault(); run(el('btnSaveWord'), 'editResult', saveEdit, true); });
  on(el('btnCancelEdit'), 'click', () => { if (!writing) { editing = null; el('wordEditor').close(); } });
  on(el('wordEditor'), 'cancel', (event) => { if (writing) event.preventDefault(); else editing = null; });
  return {
    render: (next) => render(next),
    dispose() {
      disposed = true; fileRevision += 1; importRevision += 1; clearTimeout(undoTimer);
      for (const remove of listeners) remove();
      el('customList').replaceChildren();
      if (el('wordEditor').open) el('wordEditor').close();
      pending = null; undo = null; editing = null;
    },
  };
}
