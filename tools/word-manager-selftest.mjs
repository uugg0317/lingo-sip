/** 词库管理纯逻辑与隔离 DOM / storage 回归；只用 Node 内置模块。 */
import assert from 'node:assert/strict';
import { STORAGE_KEY } from '../src/core/constants.js';
import { defaultState } from '../src/core/store.js';
import { BUILTIN, normalizeWord, parseImport, applyWordImport } from '../src/core/wordbank.js';
import { selectWordRows, restoreDeletedWords, createWordManager } from '../src/options/word-manager.js';

let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`✓ ${name}`); }
const word = (i) => normalizeWord({ term: `manager_${String(i).padStart(4, '0')}`, meaning: `管理测试 ${i}`, example: `Example ${i}.` });
await test('501 条自定义词分页可到末页，搜索第 501 条并按 canonical 学习状态筛选', () => {
  const state = defaultState(); state.settings.bankTags = ['meeting'];
  state.customWords = Array.from({ length: 501 }, (_, i) => word(i + 1));
  state.progress[state.customWords[500].id] = { status: 'mastered', seen: 3 };
  const first = selectWordRows(state, { scope: 'custom' }, 1);
  assert.equal(first.rows.length, 20); assert.equal(first.pages, 26);
  assert.equal(selectWordRows(state, { scope: 'custom' }, 26).rows[0].word.term, 'manager_0501');
  assert.equal(selectWordRows(state, { scope: 'custom', query: 'Example 501', status: 'mastered' }).total, 1);
  assert.equal(selectWordRows(state, { scope: 'custom', query: 'Example 501', status: 'learning' }).total, 0);
  assert.equal(selectWordRows(state, { scope: 'all' }).total, 501 + BUILTIN.length);
});
await test('我的词条同名去重，内置覆盖继续使用内置进度，全部范围忽略启用分类', () => {
  const state = defaultState(); const builtin = BUILTIN[0];
  state.customWords = [normalizeWord({ term: builtin.term, meaning: '新释义' }), word(1), { ...word(1), meaning: '更新' }];
  state.progress[builtin.id] = { status: 'learning', seen: 2 };
  const result = selectWordRows(state, { scope: 'custom', status: 'learning' });
  assert.equal(result.total, 1); assert.equal(result.rows[0].word.id, builtin.id); assert.equal(result.customCount, 2);
});
await test('撤销不覆盖删除后新建的同名内容，也拒绝其他词已占用的身份', () => {
  const old = word(1); const state = defaultState();
  state.customWords = [{ ...old, meaning: '删后新内容' }];
  const restored = restoreDeletedWords(state, [old]);
  assert.equal(restored.restored, 0); assert.equal(restored.customWords[0].meaning, '删后新内容');
  state.customWords = [{ ...word(2), id: old.id }];
  assert.equal(restoreDeletedWords(state, [old]).restored, 0);
});
await test('同名两列导入保留未提供的例句，编辑可明确清空例句', () => {
  const state = defaultState(); state.customWords = [word(1)];
  const imported = applyWordImport(state, parseImport('manager_0001,新意思').words).state;
  assert.equal(imported.customWords[0].example, 'Example 1.');
  const edited = applyWordImport(imported, [normalizeWord({ ...imported.customWords[0], example: '' })]).state;
  assert.equal(edited.customWords[0].example, ''); assert.equal(edited.customWords[0].id, state.customWords[0].id);
});

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.value = ''; this.children = []; this.listeners = new Map(); this.dataset = {}; this.disabled = false; this.hidden = false; this.open = false; this.className = ''; this.textContent = ''; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  async fire(name) { const event = { preventDefault() {}, target: this }; await Promise.all([...this.listeners.get(name) || []].map((callback) => callback(event))); }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  contains(node) { return node === this || this.children.some((child) => child.contains?.(node)); }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const ids = ['wordSearch', 'wordScope', 'wordStatus', 'customCount', 'customList', 'wordListInfo', 'wordPrev', 'wordNext', 'wordPage', 'wordManageResult', 'btnUndoDelete', 'btnClearCustom', 'newTerm', 'newMeaning', 'newPhonetic', 'newPos', 'newExample', 'newExampleZh', 'newType', 'btnAddWord', 'wordAddResult', 'importFile', 'importText', 'btnImport', 'importResult', 'wordImportPreview', 'btnConfirmWords', 'btnCancelWords', 'wordEditor', 'wordEditForm', 'editTerm', 'editMeaning', 'editPhonetic', 'editPos', 'editExample', 'editExampleZh', 'editType', 'editTags', 'btnSaveWord', 'btnCancelEdit', 'editResult'];
const originals = Object.fromEntries(['document', 'chrome', 'confirm'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let elements; let memory; let writes; let manager;
const el = (id) => elements.get(id);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(state = defaultState()) {
  manager?.dispose(); writes = 0; memory = { [STORAGE_KEY]: structuredClone(state) };
  elements = new Map(ids.map((id) => [id, new Element()])); el('wordScope').value = 'custom'; el('wordStatus').value = 'all'; el('newType').value = 'auto';
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: (id) => el(id), createElement: (tag) => new Element(tag), activeElement: null } });
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => true });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
    get: async (key) => structuredClone({ [key]: memory[key] }),
    set: async (bag) => { writes += 1; Object.assign(memory, structuredClone(bag)); },
  } }, runtime: { sendMessage: async () => { throw new Error('模拟角标刷新失败'); } } } });
  manager = createWordManager(); manager.render(state);
}

try {
  await test('导入预览零写入；确认时检测他处词库变化并要求再次确认；连点只写一次', async () => {
    setup(); el('importText').value = 'manager_0001,管理词条';
    await el('btnImport').fire('click'); assert.equal(writes, 0); assert.equal(el('btnConfirmWords').hidden, false);
    memory[STORAGE_KEY].customWords.push(word(2));
    await el('btnConfirmWords').fire('click'); assert.equal(writes, 0); assert.match(el('importResult').textContent, /重新生成预览/);
    await Promise.all([el('btnConfirmWords').fire('click'), el('btnConfirmWords').fire('click')]);
    assert.equal(writes, 1); assert.equal(memory[STORAGE_KEY].customWords.length, 2); assert.match(el('importResult').className, /ok/);
  });
  await test('修改导入内容会使旧预览失效，后确认不能导入未核对的新内容', async () => {
    setup(); el('importText').value = 'manager_0001,旧'; await el('btnImport').fire('click');
    el('importText').value = 'manager_0002,新'; await el('importText').fire('input');
    await el('btnConfirmWords').fire('click'); assert.equal(writes, 0); assert.equal(el('wordImportPreview').hidden, true);
  });
  await test('导入写入失败保留预览和确认入口，重试后成功且不会丢例句', async () => {
    const state = defaultState(); state.customWords = [word(1)]; setup(state);
    el('importText').value = 'manager_0001,新释义'; await el('btnImport').fire('click');
    const setter = chrome.storage.local.set; chrome.storage.local.set = async () => { throw new Error('存储暂时失败'); };
    await el('btnConfirmWords').fire('click'); assert.equal(memory[STORAGE_KEY].customWords[0].meaning, '管理测试 1');
    assert.equal(el('wordImportPreview').hidden, false); assert.equal(el('btnConfirmWords').disabled, false); assert.match(el('importResult').textContent, /存储暂时失败/);
    chrome.storage.local.set = setter; await el('btnConfirmWords').fire('click');
    assert.equal(memory[STORAGE_KEY].customWords[0].meaning, '新释义'); assert.equal(memory[STORAGE_KEY].customWords[0].example, 'Example 1.');
  });
  await test('文件读取慢响应不会覆盖更晚选的文件或用户输入，读取失败可重试', async () => {
    setup(); let resolveOld;
    el('importFile').files = [{ name: 'old.csv', text: () => new Promise((resolve) => { resolveOld = resolve; }) }];
    const oldRead = el('importFile').fire('change');
    el('importFile').files = [{ name: 'new.csv', text: async () => 'manager_0002,新的' }];
    await el('importFile').fire('change'); resolveOld('manager_0001,旧的'); await oldRead;
    assert.equal(el('importText').value, 'manager_0002,新的'); assert.equal(el('btnImport').disabled, false);
    let resolvePending;
    el('importFile').files = [{ name: 'pending.csv', text: () => new Promise((resolve) => { resolvePending = resolve; }) }];
    const pendingRead = el('importFile').fire('change');
    el('importText').value = '用户新输入'; await el('importText').fire('input'); resolvePending('过期文件'); await pendingRead;
    assert.equal(el('importText').value, '用户新输入'); assert.equal(el('btnImport').disabled, false);
    el('importFile').files = [{ name: 'broken.csv', text: async () => { throw new Error('读取失败'); } }];
    await el('importFile').fire('change'); assert.equal(el('btnImport').disabled, false); assert.match(el('importResult').textContent, /读取文件失败/);
  });
  await test('同名添加与编辑保留词条 ID 和进度，角标失败不误报存储失败', async () => {
    const state = defaultState(); state.customWords = [word(1)]; state.progress[word(1).id] = { status: 'learning', seen: 5, known: 2 };
    setup(state); el('newTerm').value = word(1).term; el('newMeaning').value = '添加更新的释义'; await el('btnAddWord').fire('click');
    assert.equal(memory[STORAGE_KEY].customWords[0].id, word(1).id); assert.equal(memory[STORAGE_KEY].customWords[0].example, 'Example 1.');
    assert.equal(memory[STORAGE_KEY].progress[word(1).id].known, 2); assert.match(el('wordAddResult').className, /ok/);
    const edit = el('customList').children[0].children[1].children[0]; await edit.fire('click');
    el('editMeaning').value = '编辑后的释义'; el('editExample').value = ''; await el('wordEditForm').fire('submit'); await flush();
    assert.equal(memory[STORAGE_KEY].customWords[0].meaning, '编辑后的释义'); assert.equal(memory[STORAGE_KEY].customWords[0].example, '');
    assert.equal(memory[STORAGE_KEY].progress[word(1).id].known, 2); assert.equal(el('wordEditor').open, false);
  });
  await test('添加同名短语只改释义时，自动类型保留短语、音标与例句', async () => {
    const state = defaultState(); state.customWords = [{ ...word(1), type: 'phrase', phonetic: '/saved/' }]; setup(state);
    el('newTerm').value = word(1).term; el('newMeaning').value = '只更新意思'; await el('btnAddWord').fire('click');
    assert.equal(memory[STORAGE_KEY].customWords[0].type, 'phrase'); assert.equal(memory[STORAGE_KEY].customWords[0].phonetic, '/saved/');
    assert.equal(memory[STORAGE_KEY].customWords[0].example, 'Example 1.'); assert.equal(el('newType').value, 'auto');
  });
  await test('编辑打开后他处更改同词时拒绝旧表单覆盖，保留当前内容和编辑输入', async () => {
    const state = defaultState(); state.customWords = [word(1)]; setup(state);
    await el('customList').children[0].children[1].children[0].fire('click'); el('editMeaning').value = '旧编辑界面的输入';
    memory[STORAGE_KEY].customWords[0].meaning = '其他页面的新修改';
    await el('wordEditForm').fire('submit'); await flush();
    assert.equal(writes, 0); assert.equal(memory[STORAGE_KEY].customWords[0].meaning, '其他页面的新修改');
    assert.equal(el('wordEditor').open, true); assert.equal(el('editMeaning').value, '旧编辑界面的输入'); assert.match(el('editResult').textContent, /其他页面更新/);
  });
  await test('删除保留进度；撤销保留删后新内容；清空可以完整撤销', async () => {
    const state = defaultState(); state.customWords = [word(1)]; state.progress[word(1).id] = { known: 3, seen: 5, status: 'learning' };
    setup(state); await el('customList').children[0].children[1].children[1].fire('click');
    assert.equal(memory[STORAGE_KEY].customWords.length, 0); assert.equal(memory[STORAGE_KEY].progress[word(1).id].known, 3);
    memory[STORAGE_KEY].customWords = [{ ...word(1), meaning: '删除之后新增的内容' }];
    await el('btnUndoDelete').fire('click'); assert.equal(memory[STORAGE_KEY].customWords[0].meaning, '删除之后新增的内容');
    await el('btnClearCustom').fire('click'); assert.equal(memory[STORAGE_KEY].customWords.length, 0);
    await el('btnUndoDelete').fire('click'); assert.equal(memory[STORAGE_KEY].customWords.length, 1); assert.equal(memory[STORAGE_KEY].progress[word(1).id].known, 3);
  });
  await test('订阅重绘不清空输入或打断列表按钮焦点，dispose 注销绑定', async () => {
    const state = defaultState(); state.customWords = [word(1)]; setup(state);
    el('newMeaning').value = '尚未提交的输入'; const row = el('customList').children[0];
    row.children[1].children[0].focus(); const next = structuredClone(state); next.customWords[0].meaning = '外部更新';
    manager.render(next); assert.equal(el('customList').children[0], row); assert.equal(el('newMeaning').value, '尚未提交的输入');
    document.activeElement = null; await el('customList').fire('focusout'); await flush();
    assert.notEqual(el('customList').children[0], row); manager.dispose();
    el('newTerm').value = 'new'; await el('btnAddWord').fire('click'); assert.equal(writes, 0);
  });
} finally {
  manager?.dispose();
  for (const [name, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
}
console.log(`通过 ${passed} 组词库管理回归。`);
