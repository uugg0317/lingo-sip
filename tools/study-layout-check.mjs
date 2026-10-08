/**
 * 连学窗口的真实外框 / 视口验收。仅使用全新临时 Edge profile。
 * node tools/study-layout-check.mjs [--output=dist/study-qa] [--baseline]
 * 不模拟 480×580 内容视口：实际通过 chrome.windows.create 创建该尺寸窗口。
 * 禁止真实声音和通知；截图仅保留当前视口，不能以整页长截图掩盖裁切。
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultState } from '../src/core/store.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (key) => process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const browserPath = arg('browser') || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output = resolve(arg('output') || join(repo, 'dist', 'study-qa'));
const profile = await mkdtemp(join(tmpdir(), 'lingo-sip-study-layout-'));
const baseline = process.argv.includes('--baseline');
await Promise.all([access(browserPath), mkdir(output, { recursive: true })]);

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (!message.id) { for (const listener of this.listeners) listener(message); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result || {});
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((done, fail) => {
      ws.addEventListener('open', done, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((done, fail) => {
      const timeout = setTimeout(() => { this.pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 12000);
      this.pending.set(id, { timeout, resolve: done, reject: fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, message, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await check();
    if (result) return result;
    await delay(60);
  }
  throw new Error(message);
}
const shortWord = {
  id: 'qa-price', term: 'price', type: 'word', tags: ['core', 'office'], phonetic: '/praɪs/', pos: 'n. / v.',
  meaning: '价格；给…定价', example: 'The price includes tax and delivery.', exampleZh: '这个价格包含税费和运费。',
};
const longWord = {
  id: 'qa-long', term: 'make a meaningful difference in the long run through consistent daily improvements',
  type: 'phrase', tags: ['qa', 'office'], phonetic: '/meɪk ə ˈmiːnɪŋfəl ˈdɪfərəns ɪn ðə lɒŋ rʌn/', pos: 'phrase',
  meaning: ['从长远来看产生有意义的影响；使情况有所不同。', '通过持续学习和日常实践积累成果。', '这条完整释义最后一句不能因为紧凑布局而丢失。'].join('\n'),
  example: Array.from({ length: 8 }, (_, i) => `Example ${i + 1}: Small daily improvements can make a meaningful difference in the long run, especially when we stay consistent and learn from our mistakes.`).join('\n'),
  exampleZh: Array.from({ length: 8 }, (_, i) => `例句${i + 1}：每天取得的小进步从长远来看能够产生有意义的影响，尤其是在我们持续学习并不断从错误中吸取经验的时候。`).join('\n'),
};

const layoutExpression = `(() => {
  const root = document.querySelector('#stage > *')?.shadowRoot;
  const visible = element => !!element && !element.hidden && getComputedStyle(element).display !== 'none';
  const rect = element => { if (!visible(element)) return null; const r=element.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
  const inside = r => !!r && r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  const page = element => ({rect:rect(element),clientHeight:element?.clientHeight,scrollHeight:element?.scrollHeight,overflowY:element?getComputedStyle(element).overflowY:null});
  const cardButtons = [...(root?.querySelectorAll('.ls-foot button, .ls-head button, .ls-speak, .ls-fulltext-btn, .ls-reveal-btn') || [])].filter(visible).map(button=>{
    const r=rect(button); const point=r && root.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    const hostPoint=r && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {text:button.textContent || button.getAttribute('aria-label'),class:button.className,rect:r,inViewport:inside(r),unobstructed:!!point && (point===button || button.contains(point)) && !!hostPoint && hostPoint===root.host,disabled:button.disabled};
  });
  const buttons=cardButtons.filter(button=>button.class.includes('ls-btn'));
  const textFields = ['.ls-term','.ls-meaning','.ls-en','.ls-zh'].map(selector=>{
    const element=root?.querySelector(selector);if(!visible(element))return null;const r=rect(element);let clipBottom=innerHeight,clipTop=0;
    for(let parent=element.parentElement;parent;parent=parent.parentElement){
      if(['hidden','clip','auto','scroll'].includes(getComputedStyle(parent).overflowY)){const p=parent.getBoundingClientRect();clipTop=Math.max(clipTop,p.y);clipBottom=Math.min(clipBottom,p.bottom);}
    }
    // 字体glyph/leading可能让scrollHeight略大于line box；真正的半行裁切按overflow祖先边界判断。
    return {selector,rect:r,text:element.textContent,clipTop,clipBottom,fullyVisible:r.y>=clipTop-1 && r.bottom<=clipBottom+1};
  }).filter(Boolean);
  const pageButtons = ['#nextBtn','#pauseBtn','#closeBtn'].map(selector=>{
    const button=document.querySelector(selector); if(!visible(button))return null;const r=rect(button); const point=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {selector,rect:r,inViewport:inside(r),unobstructed:point===button || button.contains(point),disabled:button.disabled};
  }).filter(Boolean);
  const doc=document.documentElement;
  return {innerWidth,innerHeight,outerWidth,outerHeight,dpr:devicePixelRatio,scrollX,scrollY,scrollWidth:doc.scrollWidth,scrollHeight:doc.scrollHeight,clientWidth:doc.clientWidth,clientHeight:doc.clientHeight,
    body:page(document.body),stage:page(document.querySelector('#stage')),header:rect(document.querySelector('.topbar')),footer:rect(document.querySelector('footer')),
    card:rect(root?.querySelector('.ls-card')),term:root?.querySelector('.ls-term')?.textContent,answerButtons:buttons,cardButtons,pageButtons,textFields,
    cardError:root?.querySelector('.ls-error')?.hidden===false?root.querySelector('.ls-error').textContent:'',empty:document.querySelector('.empty')?.textContent || '',
    rootScrollbar:doc.scrollHeight>innerHeight+1 || doc.scrollWidth>innerWidth+1,
    stageScrollbar:document.querySelector('#stage').scrollHeight>document.querySelector('#stage').clientHeight+1};
})()`;

const report = { mode: 'real-extension-popup', browser: browserPath, profile, output, baseline, startedAt: new Date().toISOString(), cases: [], errors: [], limitations: ['未播放真实声音和系统通知。', '125%为chrome.tabs.setZoom页面缩放；未修改Windows显示比例。'] };
const browser = spawn(browserPath, [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', '--disable-default-apps', '--enable-unsafe-extension-debugging',
  `--disable-extensions-except=${repo}`, `--load-extension=${repo}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
let cdp;
let setupSession;
let extensionId;
const diagnostics = new Map();

async function screenshot(sessionId, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  const path = join(output, `${name}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}
async function key(sessionId, name, code = name) {
  const virtualKeyCode = { Escape: 27, PageDown: 34, PageUp: 33, Tab: 9, Enter: 13 }[name];
  const event = { key: name, code, ...(virtualKeyCode ? { windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode } : {}) };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event }, sessionId);
}
async function click(sessionId, expression) {
  const point = await cdp.evaluate(sessionId, `(() => { const e=${expression}; if(!e)throw new Error('button missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
}
function assertLayout(layout, requireCard = true) {
  const failures = [];
  if (layout.rootScrollbar) failures.push(`页面溢出：${layout.scrollWidth}×${layout.scrollHeight} > ${layout.innerWidth}×${layout.innerHeight}`);
  if (layout.stageScrollbar) failures.push(`学习区域溢出：scrollHeight ${layout.stage.scrollHeight} > clientHeight ${layout.stage.clientHeight}`);
  for (const [name, rect] of [['页头', layout.header], ['底栏', layout.footer]]) {
    if (rect && (rect.y < -1 || rect.bottom > layout.innerHeight + 1 || rect.right > layout.innerWidth + 1)) failures.push(`${name}超出视口`);
  }
  if (requireCard && (!layout.card || layout.answerButtons.length !== 2)) failures.push('学习卡片或两个答题按钮缺失');
  if (layout.card && (layout.card.y < -1 || layout.card.bottom > layout.innerHeight + 1 || layout.card.right > layout.innerWidth + 1)) failures.push('学习卡片超出视口');
  if (layout.card && layout.header && layout.card.y < layout.header.bottom - 1) failures.push('学习卡片与页头重叠');
  if (layout.card && layout.footer && layout.card.bottom > layout.footer.y + 1) failures.push('学习卡片与底栏重叠');
  for (const button of [...layout.cardButtons, ...layout.pageButtons]) {
    if (!button.inViewport || !button.unobstructed) failures.push(`${button.text || button.selector}裁切或被遮挡`);
  }
  return failures;
}
async function seed(word, quizMode) {
  const state = defaultState();
  Object.assign(state.settings, { enabled: false, notifyEnabled: false, notifySound: false, autoSpeak: false, bankTags: ['qa-no-builtins'], quizMode, cardSeconds: 45, onboardingDone: true });
  state.customWords = [word];
  // tabs.onRemoved会写清理日志；种子也必须经过真实共享Web Lock，不能clear/set两步留下空状态竞态。
  await cdp.evaluate(setupSession, `(async()=>{const store=await import(chrome.runtime.getURL('src/core/store.js'));await store.replace(${JSON.stringify(state)});return true;})()`);
}
async function createPopup(name, dark, zoom, word, quizMode) {
  await seed(word, quizMode);
  const url = `chrome-extension://${extensionId}/src/pages/study.html?layout-qa=${name}`;
  const popup = await cdp.evaluate(setupSession, `chrome.windows.create({url:${JSON.stringify(url)},type:'popup',width:480,height:580,focused:false})`);
  const target = await until(async()=> (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url===url), '真实连学窗口没有创建');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const diag = { errors: [], console: [], failedNetwork: [] };
  diagnostics.set(sessionId, diag);
  await Promise.all([
    cdp.send('Runtime.enable', {}, sessionId), cdp.send('Page.enable', {}, sessionId), cdp.send('Network.enable', {}, sessionId),
    cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId),
  ]);
  await until(()=>cdp.evaluate(sessionId, `!!document.querySelector('#stage > *')?.shadowRoot?.querySelector('.ls-term') && !document.querySelector('#stage > *').shadowRoot.querySelector('.ls-btn--primary').disabled`), '卡片加载或展示记账未完成');
  const actualTerm = await cdp.evaluate(sessionId, `document.querySelector('#stage > *').shadowRoot.querySelector('.ls-term').textContent`);
  if (actualTerm !== word.term) throw new Error(`隔离词条错误：${actualTerm} != ${word.term}`);
  // 默认缩放按扩展origin共享；每个case显式重设，避免前一125%case污染后续100%。
  await cdp.evaluate(setupSession, `chrome.tabs.setZoom(${popup.tabs[0].id},${zoom})`);
  const actualZoom = await cdp.evaluate(setupSession, `chrome.tabs.getZoom(${popup.tabs[0].id})`);
  if (Math.abs(actualZoom - zoom) > .001) throw new Error(`缩放未保存：${actualZoom} != ${zoom}`);
  await cdp.send('Page.bringToFront', {}, sessionId);
  await cdp.evaluate(sessionId, `document.querySelector('#stage > *').shadowRoot.querySelector('.ls-term').focus?.();document.querySelector('#stage > *').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));true`);
  await delay(80);
  return { targetId: target.targetId, sessionId, diag, outer: { width: popup.width, height: popup.height }, tabId: popup.tabs[0].id, actualZoom };
}

async function fullTextCheck(sessionId, word, caseName) {
  const root = `document.querySelector('#stage > *').shadowRoot`;
  // 使用稳定语义而不是全文按钮的文案或位置；全文原生dialog必须只有一个。
  await click(sessionId, `${root}.querySelector('.ls-fulltext-btn')`);
  await until(()=>cdp.evaluate(sessionId, `${root}.querySelector('dialog')?.open`), '全文对话框未打开');
  const initial = await cdp.evaluate(sessionId, `(() => {
    const root=${root},dialog=root.querySelector('dialog');
    const r=dialog.getBoundingClientRect(); const elements=[dialog,...dialog.querySelectorAll('*')];
    const scroller=elements.find(e=>e.scrollHeight>e.clientHeight+1 && ['auto','scroll'].includes(getComputedStyle(e).overflowY)) || dialog;
    const text=dialog.textContent;
    return {rect:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height},text,scrollTop:scroller.scrollTop,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,
      scrollbarWidth:getComputedStyle(scroller).scrollbarWidth,webkitScrollbarDisplay:getComputedStyle(scroller,'::-webkit-scrollbar').display,
      scrollbarThickness:scroller.offsetWidth-scroller.clientWidth-parseFloat(getComputedStyle(scroller).borderLeftWidth || 0)-parseFloat(getComputedStyle(scroller).borderRightWidth || 0),
      focusInside:dialog.contains(root.activeElement),documentScrollHeight:document.documentElement.scrollHeight,innerHeight};
  })()`);
  for (const field of ['term', 'phonetic', 'pos', 'meaning', 'example', 'exampleZh']) {
    if (word[field] && !initial.text.includes(word[field])) throw new Error(`全文丢失${field}`);
  }
  if (initial.rect.x < -1 || initial.rect.y < -1 || initial.rect.right > await cdp.evaluate(sessionId, 'innerWidth + 1') || initial.rect.bottom > initial.innerHeight + 1) throw new Error('全文对话框超出窗口');
  if (initial.documentScrollHeight > initial.innerHeight + 1) throw new Error('全文打开后出现页面滚动');
  if (!initial.focusInside) throw new Error('全文打开后焦点未进入对话框');
  await key(sessionId, '1', 'Digit1');
  const noAccidentalGrade = await cdp.evaluate(sessionId, `${root}.querySelector('dialog')?.open && ${root}.querySelector('.ls-term')?.textContent===${JSON.stringify(word.term)}`);
  if (!noAccidentalGrade) throw new Error('阅读全文时数字快捷键误作答或关闭卡片');
  const screenshotPath = await screenshot(sessionId, `${caseName}-fulltext`);
  let scrolling = null;
  if (initial.scrollHeight > initial.clientHeight + 1) {
    if (initial.scrollbarWidth !== 'none' && initial.webkitScrollbarDisplay !== 'none' && initial.scrollbarThickness > 1) throw new Error('全文内部滚动条未隐藏');
    const getScroll = `(() => {const d=${root}.querySelector('dialog');const e=[d,...d.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(e).overflowY));return e?.scrollTop || 0;})()`;
    const point = { x: initial.rect.x + initial.rect.width / 2, y: initial.rect.y + initial.rect.height / 2 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 450 }, sessionId);
    const wheelTop = await until(()=>cdp.evaluate(sessionId,getScroll),'鼠标滚轮无法阅读全文',2000);
    const scrollerFocusable = await cdp.evaluate(sessionId, `(() => {const d=${root}.querySelector('dialog');const e=[d,...d.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(e).overflowY));e.scrollTop=0;e.focus();return ${root}.activeElement===e;})()`);
    if (!scrollerFocusable) throw new Error('全文内部滚动区域不能取得键盘焦点');
    await key(sessionId, 'PageDown');
    const keyTop = await until(()=>cdp.evaluate(sessionId,getScroll),'键盘无法阅读全文',2000);
    scrolling = { wheelTop, keyTop };
  }
  await key(sessionId, 'Escape');
  await until(()=>cdp.evaluate(sessionId, `!${root}.querySelector('dialog').open`),'Esc未关闭全文');
  const focusReturned = await cdp.evaluate(sessionId, `${root}.activeElement?.matches('.ls-fulltext-btn')`);
  if (!focusReturned) throw new Error('全文关闭后焦点未返回入口');
  return { rect: initial.rect, fullContentPreserved: true, focusInside: initial.focusInside, focusReturned, noAccidentalGrade, scrolling, screenshot: screenshotPath };
}

try {
  const portFile = await until(async()=> { try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; } }, 'Edge没有启动CDP');
  const [port, wsPath] = portFile.trim().split(/\r?\n/);
  cdp = await CDP.open(`ws://127.0.0.1:${port}${wsPath}`);
  report.browserVersion = await cdp.send('Browser.getVersion');
  cdp.listeners.add(message=>{
    const diag=diagnostics.get(message.sessionId);if(!diag)return;
    if(message.method==='Runtime.exceptionThrown')diag.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if(message.method==='Runtime.consoleAPICalled' && ['error','warning'].includes(message.params.type))diag.console.push({type:message.params.type,text:message.params.args.map(x=>x.value??x.description).join(' ')});
    if(message.method==='Network.loadingFailed')diag.failedNetwork.push(message.params.errorText);
  });
  let worker = (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.endsWith('/src/background/service-worker.js'));
  if (!worker) {
    await cdp.send('Extensions.loadUnpacked', { path: repo });
    worker = await until(async()=> (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.endsWith('/src/background/service-worker.js')), '扩展后台未加载');
  }
  extensionId = new URL(worker.url).hostname;
  report.extensionId = extensionId;
  const {targetId:setupTarget}=await cdp.send('Target.createTarget',{url:`chrome-extension://${extensionId}/src/options/options.html`});
  ({sessionId:setupSession}=await cdp.send('Target.attachToTarget',{targetId:setupTarget,flatten:true}));
  await cdp.send('Runtime.enable',{},setupSession);
  await until(()=>cdp.evaluate(setupSession,`typeof chrome !== 'undefined' && !!chrome.storage?.local`),'隔离存储未就绪');
  const scenarios = baseline ? ['short'] : ['short','full-short','long','quiz','pause','tts-error'];
  for (const dark of baseline ? [false] : [false,true]) for (const zoom of baseline ? [1] : [1,1.25]) for (const scenario of scenarios) {
    const name=`${dark?'dark':'light'}-${Math.round(zoom*100)}-${scenario}`;
    const word = ['long','quiz'].includes(scenario) ? longWord : shortWord;
    const result={name,dark,zoom,scenario,failures:[]};
    report.cases.push(result);
    let popup;
    try {
      popup=await createPopup(name,dark,zoom,word,scenario==='quiz');
      result.requestedOuter={width:480,height:580};result.createdOuter=popup.outer;
      result.actualZoom=popup.actualZoom;
      const root=`document.querySelector('#stage > *').shadowRoot`;
      if(scenario==='pause') {
        await click(popup.sessionId,`document.querySelector('#pauseBtn')`);
        await until(()=>cdp.evaluate(popup.sessionId,`!!document.querySelector('.empty')`),'暂停未进入空态');
      } else if(scenario==='tts-error') {
        await cdp.evaluate(popup.sessionId,`(() => {const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(message,...rest)=>message?.type==='tts:speak'?Promise.resolve({ok:false,reason:'qa-error',message:'播放失败，请重试。'}):send(message,...rest);return true;})()`);
        await click(popup.sessionId,`${root}.querySelector('.ls-speak')`);
        await until(()=>cdp.evaluate(popup.sessionId,`${root}.querySelector('.ls-error')?.hidden===false`),'发音失败反馈未出现');
      } else if(scenario==='quiz') {
        const masked=await cdp.evaluate(popup.sessionId,`${root}.querySelector('.ls-answer').getAttribute('aria-hidden')==='true'`);
        if(!masked)throw new Error('回忆模式提前显示答案');
        result.maskedLayout=await cdp.evaluate(popup.sessionId,layoutExpression);
        result.failures.push(...assertLayout(result.maskedLayout));
        result.maskedScreenshot=await screenshot(popup.sessionId,`${name}-masked`);
        await click(popup.sessionId,`${root}.querySelector('.ls-reveal-btn')`);
        await until(()=>cdp.evaluate(popup.sessionId,`${root}.querySelector('.ls-answer').getAttribute('aria-hidden')!=='true'`),'回忆模式揭晓失败');
      }
      result.layout=await cdp.evaluate(popup.sessionId,layoutExpression);
      result.failures.push(...assertLayout(result.layout,scenario!=='pause'));
      if(scenario!=='pause') for(const field of result.layout.textFields) {
        if(!field.fullyVisible)result.failures.push(`词条预览${field.selector}被裁成半行`);
      }
      result.screenshot=await screenshot(popup.sessionId,name);
      if(['full-short','long','quiz'].includes(scenario) && !result.failures.length) {
        result.fullText=await fullTextCheck(popup.sessionId,word,name);
        const after=await cdp.evaluate(popup.sessionId,layoutExpression);
        result.failures.push(...assertLayout(after));
        result.afterDialog=after;
        if(name==='light-100-full-short') {
          // 原生modal关闭后的焦点仍在全文按钮上；数字快捷键应恢复并且只记一次。
          await key(popup.sessionId,'1','Digit1');
          const counter=await until(()=>cdp.evaluate(popup.sessionId,`/本次完成\\s*1\\s*张/.test(document.querySelector('#counter').textContent) && document.querySelector('#counter').textContent`),'全文返回后数字快捷键未恢复');
          const known=await cdp.evaluate(setupSession,`(async()=>{const store=await import(chrome.runtime.getURL('src/core/store.js'));const state=await store.read();return Object.values(state.progress).reduce((sum,p)=>sum+(p.known||0),0);})()`);
          if(known!==1)throw new Error(`全文返回后作答记账不是一次：${known}`);
          result.shortcutAfterFullText={counter,known,focusOnFullTextButton:true};
        }
      }
      result.diagnostics=popup.diag;
      if(popup.diag.errors.length || popup.diag.console.some(x=>x.type==='error') || popup.diag.failedNetwork.length)result.failures.push('脚本/控制台/网络错误');
    } catch(error) { result.failures.push(error.message); }
    finally { if(popup)await cdp.send('Target.closeTarget',{targetId:popup.targetId}).catch(()=>{}); }
    result.passed=result.failures.length===0;
    if(!result.passed)report.errors.push(`${name}: ${result.failures.join('；')}`);
    console.log(JSON.stringify({name,passed:result.passed,viewport:result.layout?`${result.layout.innerWidth}×${result.layout.innerHeight}`:null,scrollHeight:result.layout?.scrollHeight,failures:result.failures}));
  }
} catch(error) { report.errors.push(error.stack || error.message);report.browserStderr=stderr; }
finally {
  report.finishedAt=new Date().toISOString();
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  if(cdp)await cdp.send('Browser.close').catch(()=>{});
  browser.kill();
  console.log(JSON.stringify({phase:'complete',output,cases:report.cases.length,passed:report.cases.filter(c=>c.passed).length,errors:report.errors}));
  if(report.errors.length)process.exitCode=1;
}
