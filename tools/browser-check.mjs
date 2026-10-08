/**
 * 零依赖 Edge / Chrome 浏览器验收。
 * 使用全新临时 profile，绝不访问日常浏览器数据；默认禁止通知和自动朗读。
 * node tools/browser-check.mjs [--browser=绝对路径] [--output=截图目录]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultState } from '../src/core/store.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (key) => process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const browserPath = arg('browser') || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output = arg('output') ? resolve(arg('output')) : await mkdtemp(join(tmpdir(), 'lingo-sip-browser-'));
const profile = await mkdtemp(join(tmpdir(), 'lingo-sip-edge-profile-'));
await mkdir(output, { recursive: true });
await access(browserPath);

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timeout);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
        else request.resolve(message.result || {});
      } else for (const fn of this.listeners) fn(message);
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 12000);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(session, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(message);
}

let cdp;
const browser = spawn(browserPath, [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-sync', '--disable-default-apps', '--enable-unsafe-extension-debugging',
  `--disable-extensions-except=${repo}`, `--load-extension=${repo}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
browser.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
const report = {
  browser: browserPath, profile, output, mode: null, checks: [], pages: [], errors: [],
  startedAt: new Date().toISOString(),
  limitations: ['未播放真实系统声音；试听失败与声音回调使用隔离页面 mock。', '未点击原生 Windows 通知；通知记账另由隔离回归验证。'],
};

try {
  const portFile = await until(async () => {
    try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); }
    catch { return null; }
  }, 'Edge 没有启动 CDP');
  const [port, wsPath] = portFile.trim().split(/\r?\n/);
  cdp = await CDP.open(`ws://127.0.0.1:${port}${wsPath}`);
  report.browserVersion = await cdp.send('Browser.getVersion');
  console.log(JSON.stringify({ phase: 'cdp-ready', port, output }));
  let targets = (await cdp.send('Target.getTargets')).targetInfos;
  let worker = targets.find((target) => target.type === 'service_worker' && target.url.includes('/src/background/service-worker.js'));
  if (!worker) {
    try {
      const loaded = await cdp.send('Extensions.loadUnpacked', { path: repo });
      report.extensionLoad = loaded;
      console.log(JSON.stringify({ phase: 'extension-loaded', ...loaded }));
    } catch (error) {
      report.extensionLoadError = error.message;
    }
    try {
      worker = await until(async () => {
        targets = (await cdp.send('Target.getTargets')).targetInfos;
        return targets.find((target) => target.type === 'service_worker' && target.url.includes('/src/background/service-worker.js'));
      }, '临时 profile 未出现扩展 service worker', 6000);
    } catch { /* 把加载证据交给调用方。 */ }
  }
  if (!worker) {
    report.mode = 'extension-unavailable';
    report.targets = targets.map(({ type, url }) => ({ type, url }));
    report.browserStderr = stderr;
    throw new Error('真实扩展未能加载；需要以隔离的静态页面与模拟 chrome API 验收。');
  }
  report.mode = 'real-extension';
  const extensionId = new URL(worker.url).hostname;
  report.extensionId = extensionId;
  // MV3 worker 可能在枚举目标后立即回收；用稳定的扩展页面初始化隔离存储。
  const { targetId: setupTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/src/options/options.html` });
  const { sessionId: setupSession } = await cdp.send('Target.attachToTarget', { targetId: setupTarget, flatten: true });
  await cdp.send('Runtime.enable', {}, setupSession);
  await until(() => cdp.evaluate(setupSession, `typeof chrome !== 'undefined' && !!chrome.storage?.local`), '扩展页面 chrome API 未就绪');
  const seed = defaultState();
  Object.assign(seed.settings, { enabled: false, notifyEnabled: false, notifySound: false, autoSpeak: false, cardSeconds: 45, onboardingDone: true });
  await cdp.evaluate(setupSession, `(async () => {
    const state = ${JSON.stringify(seed)};
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ lingoSip: state });
    chrome.tts.speak = () => { throw new Error('浏览器验收禁止真实朗读'); };
    chrome.notifications.create = () => { throw new Error('浏览器验收禁止真实通知'); };
    return { initialized: true };
  })()`);
  await cdp.send('Target.closeTarget', { targetId: setupTarget });
  console.log(JSON.stringify({ phase: 'real-extension-ready', extensionId }));

  const diagnostics = new Map();
  const qaTargets = [];
  cdp.listeners.add((message) => {
    const diag = diagnostics.get(message.sessionId);
    if (!diag) return;
    if (message.method === 'Runtime.exceptionThrown') diag.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) diag.console.push({ type: message.params.type, text: message.params.args.map((x) => x.value ?? x.description).join(' ') });
    if (message.method === 'Network.loadingFailed') diag.failedNetwork.push({ errorText: message.params.errorText, blockedReason: message.params.blockedReason });
  });

  async function page(name, file, width, height, dark = false) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    qaTargets.push({ targetId, sessionId });
    const diag = { name, width, height, dark, errors: [], console: [], failedNetwork: [] };
    diagnostics.set(sessionId, diag);
    await Promise.all([
      cdp.send('Runtime.enable', {}, sessionId), cdp.send('Page.enable', {}, sessionId), cdp.send('Network.enable', {}, sessionId),
      cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId),
      cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId),
    ]);
    await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/${file}` }, sessionId);
    await until(() => cdp.evaluate(sessionId, `document.readyState === 'complete' && !document.body.innerText.includes('加载中…') && !document.body.innerText.includes('正在读取学习进度…') && !document.body.innerText.includes('正在准备下一张…')`), `页面未就绪：${name}`);
    await delay(300);
    diag.layout = await cdp.evaluate(sessionId, `(() => {
      const all = [...document.querySelectorAll('*')];
      const overflow = all.filter(x => { const r = x.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(x).position !== 'fixed'; }).map(x => ({ tag: x.tagName, id: x.id, class: String(x.className), width: x.getBoundingClientRect().width })).slice(0, 15);
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, overflow, title: document.title, bodyColor: getComputedStyle(document.body).backgroundColor };
    })()`);
    const screenshotHeight = name.startsWith('newtab-') || name.startsWith('study-') ? diag.layout.scrollHeight : height;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: screenshotHeight, scale: 1 } }, sessionId);
    diag.screenshot = join(output, `${name}.png`);
    await writeFile(diag.screenshot, Buffer.from(data, 'base64'));
    report.pages.push(diag);
    if (diag.layout.scrollWidth > width + 1) report.errors.push(`${name}: 横向溢出 ${diag.layout.scrollWidth}px > ${width}px`);
    console.log(JSON.stringify({ phase: 'page-checked', name, layout: diag.layout, errors: diag.errors, console: diag.console, failedNetwork: diag.failedNetwork }));
    return { sessionId, targetId };
  }
  const newtab = await page('newtab-1440', 'src/newtab/newtab.html', 1440, 1000);
  await page('newtab-375', 'src/newtab/newtab.html', 375, 1100);
  await page('newtab-dark', 'src/newtab/newtab.html', 1440, 1000, true);
  const options = await page('options-1440', 'src/options/options.html', 1440, 1000);
  await page('options-375', 'src/options/options.html', 375, 1100);
  await page('options-dark', 'src/options/options.html', 1440, 1000, true);
  const popup = await page('popup-360', 'src/popup/popup.html', 360, 700);
  const study = await page('study-480', 'src/pages/study.html', 480, 580);

  async function check(name, fn) {
    try { const detail = await fn(); report.checks.push({ name, passed: true, detail }); console.log(JSON.stringify({ phase: 'interaction', name, passed: true, detail })); }
    catch (error) { report.checks.push({ name, passed: false, error: error.message }); report.errors.push(`${name}: ${error.message}`); }
  }
  // MV3 后台会正常回收，存储验收通过页面上下文读取，不依赖旧 worker target。
  let stateSession = newtab.sessionId;
  const readState = () => cdp.evaluate(stateSession, `(async () => (await chrome.storage.local.get('lingoSip')).lingoSip)()`);
  await check('newtab-record-and-next', async () => {
    const before = await readState();
    const term = await cdp.evaluate(newtab.sessionId, `document.querySelector('#ntCardSlot > *').shadowRoot.querySelector('.ls-term').textContent`);
    await cdp.evaluate(newtab.sessionId, `document.querySelector('#ntCardSlot > *').shadowRoot.querySelector('.ls-btn--primary').click()`);
    const state = await until(async () => { const s = await readState(); return Object.values(s.stats).reduce((n, d) => n + d.known, 0) > Object.values(before.stats).reduce((n, d) => n + d.known, 0) && s; }, '学习操作未记账');
    await until(() => cdp.evaluate(newtab.sessionId, `!document.querySelector('#ntNext').disabled && !!document.querySelector('#ntCardSlot > *')?.shadowRoot?.querySelector('.ls-term')`), '作答后未换卡');
    const nextTerm = await cdp.evaluate(newtab.sessionId, `document.querySelector('#ntCardSlot > *').shadowRoot.querySelector('.ls-term').textContent`);
    if (nextTerm === term) throw new Error('作答后词条未变化');
    await cdp.evaluate(newtab.sessionId, `document.querySelector('#ntNext').click()`);
    await until(() => cdp.evaluate(newtab.sessionId, `!document.querySelector('#ntNext').disabled`), '换一张未完成');
    return { term, nextTerm, progressWords: Object.keys(state.progress).length };
  });
  await check('options-auto-save-and-reload', async () => {
    await cdp.evaluate(options.sessionId, `const input = document.querySelector('#dailyGoal'); input.value='35'; input.dispatchEvent(new Event('change', { bubbles: true }));`);
    await until(async () => (await readState()).settings.dailyGoal === 35, '设置未保存');
    await cdp.send('Page.reload', {}, options.sessionId);
    await until(() => cdp.evaluate(options.sessionId, `document.querySelector('#dailyGoal')?.value === '35'`), '重新加载未恢复已保存设置');
    return { dailyGoal: 35, reloadPreserved: true };
  });
  await check('popup-pause-and-resume', async () => {
    await cdp.evaluate(popup.sessionId, `document.querySelector('#pauseChips button').click()`);
    await until(async () => (await readState()).runtime.pausedUntil > Date.now(), '暂停未生效');
    await until(() => cdp.evaluate(popup.sessionId, `document.querySelector('#pauseChips button').textContent.includes('恢复')`), '暂停后未提供恢复按钮');
    await cdp.evaluate(popup.sessionId, `document.querySelector('#pauseChips button').click()`);
    await until(async () => !(await readState()).runtime.pausedUntil, '恢复未生效');
    return { paused: true, resumed: true };
  });
  await check('study-pause-then-manual-continue', async () => {
    await cdp.evaluate(study.sessionId, `document.querySelector('#pauseBtn').click()`);
    await until(() => cdp.evaluate(study.sessionId, `document.querySelector('#stage').textContent.includes('自动提醒已暂停') && !document.querySelector('#nextBtn').disabled`), '连学暂停状态不正确');
    await cdp.evaluate(study.sessionId, `document.querySelector('#nextBtn').click()`);
    await until(() => cdp.evaluate(study.sessionId, `!!document.querySelector('#stage > *')?.shadowRoot?.querySelector('.ls-term')`), '暂停后主动学习被阻止');
    await until(() => cdp.evaluate(study.sessionId, `!document.querySelector('#stage > *').shadowRoot.querySelector('.ls-btn--primary').disabled`), '主动学习未记展示');
    return { pausedAutomatic: true, manualCardLoaded: true };
  });
  await check('automatic-disabled-manual-continues', async () => {
    if ((await readState()).settings.enabled !== false) throw new Error('隔离设置意外开启自动学习');
    const before = (await readState()).runtime.dayCount;
    await cdp.evaluate(newtab.sessionId, `document.querySelector('#ntNext').click()`);
    await until(() => cdp.evaluate(newtab.sessionId, `!document.querySelector('#ntNext').disabled && !!document.querySelector('#ntCardSlot > *')?.shadowRoot?.querySelector('.ls-term')`), '自动关闭后手动换卡失败');
    const after = await readState();
    if (after.runtime.dayCount <= before) throw new Error('手动展示未记账');
    return { enabled: after.settings.enabled, pausedUntil: after.runtime.pausedUntil, manualShown: after.runtime.dayCount - before };
  });
  await check('cross-page-native-web-lock', async () => {
    await cdp.evaluate(newtab.sessionId, `(async () => {
      const { update } = await import(chrome.runtime.getURL('src/core/store.js'));
      await update(s => { s.runtime.qaCounter = 0; });
    })()`);
    const expression = `(async () => {
      const { update } = await import(chrome.runtime.getURL('src/core/store.js'));
      await update(async s => { const previous = s.runtime.qaCounter || 0; await new Promise(resolve => setTimeout(resolve, 300)); s.runtime.qaCounter = previous + 1; });
      return !!navigator.locks;
    })()`;
    const available = await Promise.all([cdp.evaluate(newtab.sessionId, expression), cdp.evaluate(options.sessionId, expression)]);
    const value = (await readState()).runtime.qaCounter;
    if (value !== 2 || !available.every(Boolean)) throw new Error(`跨页面计数丢失：${value}`);
    return { nativeLocksAvailable: true, concurrentUpdates: 2, finalCounter: value };
  });

  // 接下来的构造状态只供维护页验证。关闭学习页，避免旧卡片的计时回执写入新场景。
  stateSession = options.sessionId;
  for (const target of qaTargets) {
    if (target.targetId !== options.targetId) await cdp.send('Target.closeTarget', { targetId: target.targetId });
  }
  async function setupState(expression) {
    return cdp.evaluate(stateSession, `(async () => {
      const store = await import(chrome.runtime.getURL('src/core/store.js'));
      const wordbank = await import(chrome.runtime.getURL('src/core/wordbank.js'));
      const state = store.defaultState();
      Object.assign(state.settings, { enabled:false, notifyEnabled:false, notifySound:false, autoSpeak:false, onboardingDone:true, cardSeconds:45 });
      ${expression}
      await store.replace(state);
      return state;
    })()`);
  }
  async function reloadOptions() {
    await cdp.send('Page.reload', {}, options.sessionId);
    await until(() => cdp.evaluate(options.sessionId, `document.readyState === 'complete' && document.querySelector('#statusPill')?.textContent !== '加载中…' && document.querySelector('#dailyGoal')?.value !== ''`), '设置页重载未完成');
    await delay(200);
  }
  async function snapCurrent(name, sessionId, width, height) {
    const layout = await cdp.evaluate(sessionId, `({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight})`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x:0,y:0,width,height,scale:1 } }, sessionId);
    const screenshot = join(output, `${name}.png`);
    await writeFile(screenshot, Buffer.from(data, 'base64'));
    report.pages.push({ name, width, height, layout, screenshot, errors:[],console:[],failedNetwork:[] });
    if (layout.scrollWidth > width + 1) throw new Error(`${name}: 横向溢出`);
    return screenshot;
  }

  await check('same-term-import-preview-preserves-progress', async () => {
    await setupState(`
      const builtin = wordbank.BUILTIN.find(w => w.term === 'work');
      const alias = wordbank.makeId('work');
      state.customWords = [wordbank.normalizeWord({ id:alias, term:'work', meaning:'旧自定义释义' })];
      state.progress[builtin.id] = { box:5,status:'mastered',known:8,reps:8,seen:12,snooze:2,due:Date.now()+86400000,lastSeen:Date.now()-1000 };
      state.progress[alias] = { box:2,status:'learning',known:3,reps:3,seen:6,snooze:1,due:Date.now()+3600000,lastSeen:Date.now()-2000 };
    `);
    await reloadOptions();
    const before = await readState();
    await cdp.evaluate(options.sessionId, `document.querySelector('#importText').value='work,浏览器确认后的释义'; document.querySelector('#btnImport').click();`);
    const preview = await until(() => cdp.evaluate(options.sessionId, `!document.querySelector('#btnConfirmWords').hidden && document.querySelector('#wordImportPreview').textContent`), '同词导入没有预览');
    if (JSON.stringify(await readState()) !== JSON.stringify(before)) throw new Error('导入预览阶段发生存储写入');
    await cdp.evaluate(options.sessionId, `document.querySelector('#btnConfirmWords').click()`);
    const after = await until(async () => { const s=await readState(); return s.customWords.some(w=>w.term==='work' && w.meaning==='浏览器确认后的释义') && s; }, '确认导入未生效');
    const word = await cdp.evaluate(options.sessionId, `(async()=>{const {pool}=await import(chrome.runtime.getURL('src/core/wordbank.js'));return pool((await chrome.storage.local.get('lingoSip')).lingoSip).find(w=>w.term==='work');})()`);
    if (word.id !== 'w001' || JSON.stringify(after.progress) !== JSON.stringify(before.progress)) throw new Error('同词导入改变学习身份或原进度');
    return { preview, previewNoWrite:true, canonicalId:word.id, customId:after.customWords[0].id, mastered:after.progress.w001.status, known:after.progress.w001.known, oldAliasPreserved:true };
  });

  await check('goal-metric-switch-and-streak', async () => {
    await setupState(`
      const stats=await import(chrome.runtime.getURL('src/core/stats.js'));
      const now=Date.now(); const yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);
      state.settings.dailyGoal=20;state.settings.goalMetric='shown';
      state.stats[stats.dayKey(now)]={shown:20,known:2,snooze:1,seconds:5};
      state.stats[stats.dayKey(yesterday.getTime())]={shown:4,known:0,snooze:0,seconds:0};
    `);
    await reloadOptions();
    const viewExpression=`(async()=>{const {buildView}=await import(chrome.runtime.getURL('src/core/view.js'));return buildView((await chrome.storage.local.get('lingoSip')).lingoSip);})()`;
    const shown=await cdp.evaluate(options.sessionId,viewExpression);
    if(shown.goalCount!==20 || shown.goalPercent!==100 || shown.streak!==2)throw new Error('展示目标/连续天数口径错误');
    await cdp.evaluate(options.sessionId,`(()=>{const node=document.querySelector('#goalMetric');node.value='answered';node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(async()=> (await readState()).settings.goalMetric==='answered','主动作答目标未保存');
    const answered=await cdp.evaluate(options.sessionId,viewExpression);
    if(answered.goalCount!==3 || answered.goalPercent!==15 || answered.streak!==1 || answered.today.shown!==20)throw new Error('作答目标/连续天数或原展示记录错误');
    return {shown:{count:shown.goalCount,percent:shown.goalPercent,streak:shown.streak},answered:{count:answered.goalCount,percent:answered.goalPercent,streak:answered.streak},historyPreserved:true};
  });

  await check('automatic-waits-manual-early-review', async () => {
    await setupState(`
      Object.assign(state.settings,{enabled:true,bankTags:['qa-no-builtin'],maxNewPerDay:0,recycleMastered:false,triggerTabSwitch:false,triggerPageLoad:false,triggerIdle:false,triggerTimer:false,triggerReturn:false});
      state.customWords=[wordbank.normalizeWord({id:'qa-future',term:'qa future term',meaning:'稍后到期'})];
      state.progress['qa-future']={box:2,status:'learning',known:2,reps:2,seen:3,snooze:0,due:Date.now()+3600000,lastSeen:Date.now()-1000};
    `);
    const result=await cdp.evaluate(options.sessionId,`(async()=>{
      const {MESSAGES}=await import(chrome.runtime.getURL('src/core/constants.js'));
      const automatic=await chrome.runtime.sendMessage({type:MESSAGES.REQUEST_CARD,manual:false});
      const manual=await chrome.runtime.sendMessage({type:MESSAGES.REQUEST_CARD,manual:true});
      return {automatic,manual};
    })()`);
    if(result.automatic.ok || !result.automatic.nextDueAt || !result.manual.ok || result.manual.mode!=='early' || result.manual.word.id!=='qa-future')throw new Error('自动/主动取词规则不符：'+JSON.stringify(result));
    await cdp.evaluate(options.sessionId,`(async()=>{const {updateSettings}=await import(chrome.runtime.getURL('src/core/store.js'));await updateSettings({enabled:false});})()`);
    return {automatic:result.automatic,manual:{ok:result.manual.ok,mode:result.manual.mode,wordId:result.manual.word.id}};
  });

  await check('large-word-import-search-pagination-edit-undo', async () => {
    await setupState('');
    await reloadOptions();
    await cdp.evaluate(options.sessionId, `document.querySelector('#importText').value=JSON.stringify(Array.from({length:501},(_,i)=>({id:'qa-bank-'+String(i).padStart(3,'0'),term:'qa vocabulary '+String(i).padStart(3,'0'),meaning:'回归词条 '+i,example:'Original example '+i})));document.querySelector('#btnImport').click();`);
    await until(()=>cdp.evaluate(options.sessionId,`!document.querySelector('#btnConfirmWords').hidden`),'501词导入未预览');
    if((await readState()).customWords.length)throw new Error('大词库预览阶段提前写入');
    const started=Date.now();
    await cdp.evaluate(options.sessionId,`document.querySelector('#btnConfirmWords').click()`);
    await until(async()=> (await readState()).customWords.length===501,'501词导入未完成');
    const importMs=Date.now()-started;
    await until(()=>cdp.evaluate(options.sessionId,`document.querySelector('#customCount').textContent==='501' && document.querySelector('#customList').children.length>0`),'管理列表没刷新');
    const first=await cdp.evaluate(options.sessionId,`({rows:document.querySelector('#customList').children.length,page:document.querySelector('#wordPage').textContent})`);
    if(first.rows>=501)throw new Error('管理列表未分页');
    await cdp.evaluate(options.sessionId,`document.querySelector('#wordNext').click()`);
    await until(()=>cdp.evaluate(options.sessionId,`document.querySelector('#wordPage').textContent!==${JSON.stringify(first.page)}`),'下一页未生效');
    await cdp.evaluate(options.sessionId,`(()=>{const node=document.querySelector('#wordSearch');node.value='qa vocabulary 200';node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(()=>cdp.evaluate(options.sessionId,`document.querySelector('#customList').children.length===1 && document.querySelector('#customList').textContent.includes('qa vocabulary 200')`),'第201词无法搜索');
    await cdp.evaluate(options.sessionId,`(async()=>{const {update}=await import(chrome.runtime.getURL('src/core/store.js'));await update(s=>{s.progress['qa-bank-200']={box:4,status:'learning',known:4,reps:4,seen:9,snooze:1,due:Date.now()+3600000,lastSeen:Date.now()};});})()`);
    const originalProgress=(await readState()).progress['qa-bank-200'];
    await cdp.evaluate(options.sessionId,`[...document.querySelector('#customList').querySelectorAll('button')].find(b=>b.textContent.includes('编辑')).click()`);
    await until(()=>cdp.evaluate(options.sessionId,`document.querySelector('#wordEditor').open`),'编辑对话框未打开');
    if(!await cdp.evaluate(options.sessionId,`document.querySelector('#editTerm').readOnly`))throw new Error('编辑允许修改已有词身份');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false},options.sessionId);
    const editorScreenshot=await snapCurrent('word-editor-375',options.sessionId,375,900);
    await cdp.evaluate(options.sessionId,`(()=>{const example=document.querySelector('#editExample');example.value='Edited browser example.';example.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#wordEditForm').requestSubmit();})()`);
    await until(async()=> (await readState()).customWords.find(w=>w.id==='qa-bank-200')?.example==='Edited browser example.','编辑保存例句失败');
    await cdp.evaluate(options.sessionId,`if(document.querySelector('#wordEditor').open)document.querySelector('#btnCancelEdit').click()`);
    await until(()=>cdp.evaluate(options.sessionId,`!document.querySelector('#wordEditor').open`),'编辑对话框未关闭');
    if(JSON.stringify((await readState()).progress['qa-bank-200'])!==JSON.stringify(originalProgress))throw new Error('编辑重置了学习进度');
    await cdp.evaluate(options.sessionId,`[...document.querySelector('#customList').querySelectorAll('button')].find(b=>b.textContent.includes('删除')).click()`);
    await until(async()=>!(await readState()).customWords.some(w=>w.id==='qa-bank-200'),'删除词条未生效');
    if(JSON.stringify((await readState()).progress['qa-bank-200'])!==JSON.stringify(originalProgress))throw new Error('删除词条删除了学习进度');
    await until(()=>cdp.evaluate(options.sessionId,`!document.querySelector('#btnUndoDelete').hidden`),'删除未提供撤销入口');
    await cdp.evaluate(options.sessionId,`document.querySelector('#btnUndoDelete').click()`);
    const after=await until(async()=>{const s=await readState();return s.customWords.length===501 && s.customWords.some(w=>w.id==='qa-bank-200') && s;},'撤销删除未恢复');
    if(after.customWords.find(w=>w.id==='qa-bank-200').example!=='Edited browser example.')throw new Error('撤销丢失编辑字段');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},options.sessionId);
    return {count:501,importMs,pageRows:first.rows,searchedIndex:201,readonlyTerm:true,editedId:'qa-bank-200',progressPreserved:true,undoRestored:true,editorScreenshot};
  });

  await check('voices-native-list-and-mocked-failure-feedback', async () => {
    // 获取列表是本机只读操作。所有试听走页面消息 mock，绝不发送 TTS 播放请求。
    const native=await cdp.evaluate(options.sessionId,`(async()=>{
      const {MESSAGES}=await import(chrome.runtime.getURL('src/core/constants.js'));
      return await chrome.runtime.sendMessage({type:MESSAGES.LIST_VOICES});
    })()`);
    if(!native.ok || !Array.isArray(native.voices))throw new Error('真实后台没有返回本机声音列表');
    await cdp.evaluate(options.sessionId,`document.querySelector('#btnRefreshVoices').click()`);
    await until(()=>cdp.evaluate(options.sessionId,`!document.querySelector('#btnRefreshVoices').disabled && !document.querySelector('#voiceInfo').textContent.includes('正在读取')`),'本机声音下拉列表读取未完成');
    const nativeInfo=await cdp.evaluate(options.sessionId,`document.querySelector('#voiceInfo').textContent`);
    await cdp.evaluate(options.sessionId,`(() => {
      globalThis.qaVoiceOriginalSend=chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.qaVoiceMessages=[];
      chrome.runtime.sendMessage=(message,callback)=>{
        if(message.type==='tts:voices' || message.type==='tts:speak'){
          qaVoiceMessages.push(message);
          const response=message.type==='tts:voices'?{ok:true,voices:[]}:{ok:false,reason:'voice_unavailable',message:'所选声音当前不可用，请刷新声音列表。'};
          queueMicrotask(()=>callback?.(response));
          return Promise.resolve(response);
        }
        return qaVoiceOriginalSend(message,callback);
      };
      document.querySelector('#btnRefreshVoices').click();
    })()`);
    await until(()=>cdp.evaluate(options.sessionId,`document.querySelector('#voiceInfo').textContent.includes('没有找到本机英文声音') && !document.querySelector('#btnVoicePreview').disabled`),'空声音列表没有清楚反馈');
    await cdp.evaluate(options.sessionId,`(async()=>{const {updateSettings}=await import(chrome.runtime.getURL('src/core/store.js'));await updateSettings({voiceName:'QA Missing Voice'});})()`);
    await until(()=>cdp.evaluate(options.sessionId,`document.querySelector('#voiceInfo').textContent.includes('当前不可用')`),'已保存错误声音未显示不可用状态');
    await cdp.evaluate(options.sessionId,`document.querySelector('#btnVoicePreview').click()`);
    await until(()=>cdp.evaluate(options.sessionId,`document.querySelector('#voiceResult').textContent.includes('当前不可用') && !document.querySelector('#btnVoicePreview').disabled`),'试听失败没有反馈或无法重试');
    const mocked=await cdp.evaluate(options.sessionId,`({result:document.querySelector('#voiceResult').textContent,messages:qaVoiceMessages})`);
    const request=mocked.messages.find(message=>message.type==='tts:speak');
    if(request?.voiceName!=='QA Missing Voice' || !request.text)throw new Error('试听没有使用已选声音/文本');
    await cdp.evaluate(options.sessionId,`chrome.runtime.sendMessage=qaVoiceOriginalSend;delete globalThis.qaVoiceOriginalSend;`);
    return {nativeCount:native.voices.length,nativeInfo,noVoiceFeedback:true,missingVoiceFeedback:mocked.result,mockedCallbackAndPromise:true,realAudioPlayed:false};
  });

  await check('real-mv3-worker-stop-and-wake', async () => {
    const before=await readState();
    await cdp.evaluate(options.sessionId,`chrome.runtime.sendMessage({type:'data:refresh'})`);
    // 根据已加载的隔离扩展定位 worker；不触碰用户日常浏览器或其它扩展。
    const target=await until(async()=>{
      const list=(await cdp.send('Target.getTargets')).targetInfos;
      return list.find(item=>item.type==='service_worker' && item.url.startsWith('chrome-extension://'+extensionId+'/'));
    },'没有找到待停止的真实 worker');
    const method='Target.closeTarget';
    const result=await cdp.send('Target.closeTarget',{targetId:target.targetId});
    if(!result.success)throw new Error('浏览器未停止隔离 worker');
    await until(async()=>!(await cdp.send('Target.getTargets')).targetInfos.some(item=>item.targetId===target.targetId),'worker目标没有停止');
    const reply=await cdp.evaluate(options.sessionId,`chrome.runtime.sendMessage({type:'data:refresh'})`);
    if(!reply?.ok)throw new Error('worker停止后消息未唤醒后台');
    const awake=await until(async()=>{
      const list=(await cdp.send('Target.getTargets')).targetInfos;
      return list.find(item=>item.type==='service_worker' && item.url.startsWith('chrome-extension://'+extensionId+'/'));
    },'worker未重新创建');
    if(JSON.stringify((await readState()).progress)!==JSON.stringify(before.progress))throw new Error('worker重启丢失学习进度');
    return {method,previousTarget:target.targetId,newTarget:awake.targetId,messageRecovered:true,progressPreserved:true};
  });

  await check('onboarding-three-steps-preview-and-trial', async () => {
    await setupState(`state.settings.onboardingDone=false;state.progress.w001={box:5,status:'mastered',known:7,reps:7,seen:11,snooze:0,due:Date.now()+86400000,lastSeen:Date.now()-1000};`);
    const initial=await readState();
    await cdp.send('Target.closeTarget',{targetId:options.targetId});
    const guide=await page('guide-375','src/options/options.html',375,900);
    stateSession=guide.sessionId;
    await until(()=>cdp.evaluate(guide.sessionId,`document.querySelector('#guideDialog').open && !document.querySelector('#guideStep1').hidden`),'新用户引导没有自动打开');
    const screenshot=await snapCurrent('guide-open-375',guide.sessionId,375,900);
    await cdp.evaluate(guide.sessionId,`document.querySelector('#guideScene').value='office';document.querySelector('#guideScene').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#guideNext').click();`);
    await until(()=>cdp.evaluate(guide.sessionId,`!document.querySelector('#guideStep2').hidden`),'引导没有进入第二步');
    await cdp.evaluate(guide.sessionId,`document.querySelector('#guideRhythm').value='manual';document.querySelector('#guideRhythm').dispatchEvent(new Event('change',{bubbles:true}));const goal=document.querySelector('#guideGoal');goal.value='12';goal.dispatchEvent(new Event('input',{bubbles:true}));goal.dispatchEvent(new Event('change',{bubbles:true}));const metric=document.querySelector('#guideMetric');metric.value='answered';metric.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#guideNext').click();`);
    const summary=await until(()=>cdp.evaluate(guide.sessionId,`!document.querySelector('#guideStep3').hidden && document.querySelector('#guideSummary').textContent`),'引导没有进入确认步骤');
    const preview=await readState();
    if(JSON.stringify(preview.settings)!==JSON.stringify(initial.settings) || JSON.stringify(preview.progress)!==JSON.stringify(initial.progress))throw new Error('引导选择期间发生写入');
    const oldTargets=(await cdp.send('Target.getTargets')).targetInfos.map(target=>target.targetId);
    await cdp.evaluate(guide.sessionId,`document.querySelector('#guideFinish').click()`);
    await until(async()=> (await readState()).settings.onboardingDone===true,'引导完成偏好未保存');
    const saved=await readState();
    if(saved.settings.enabled || saved.settings.notifyEnabled || saved.settings.autoSpeak || saved.settings.goalMetric!=='answered' || saved.settings.dailyGoal!==12 || !saved.settings.bankTags.includes('office'))throw new Error('引导保存偏好错误');
    if(saved.progress.w001.known!==7 || saved.progress.w001.status!=='mastered')throw new Error('引导改变旧词学习进度');
    const trial=await until(async()=>{
      const list=(await cdp.send('Target.getTargets')).targetInfos;
      return list.find(target=>!oldTargets.includes(target.targetId)&&target.url.endsWith('/src/pages/study.html'));
    },'保存完成没有打开试学窗口');
    const {sessionId:trialSession}=await cdp.send('Target.attachToTarget',{targetId:trial.targetId,flatten:true});
    await cdp.send('Runtime.enable',{},trialSession);
    await until(()=>cdp.evaluate(trialSession,`!!document.querySelector('#stage > *')?.shadowRoot?.querySelector('.ls-term')`),'试学窗口没有真实加载卡片');
    return {threeSteps:true,previewNoWrite:true,summary,goal:12,metric:saved.settings.goalMetric,sceneTags:saved.settings.bankTags,oldProgressPreserved:true,trialWindowLoaded:true,screenshot};
  });
  for (const diag of report.pages) {
    if (diag.errors.length || diag.console.some((item) => item.type === 'error') || diag.failedNetwork.length) report.errors.push(`${diag.name}: 页面异常 / 控制台错误 / 网络失败`);
  }
} catch (error) {
  report.errors.push(error.message);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (cdp) await cdp.send('Browser.close').catch(() => {});
  browser.kill();
  console.log(JSON.stringify({ phase: 'complete', mode: report.mode, output, errors: report.errors, checks: report.checks }));
  if (report.errors.length) process.exitCode = 1;
}
