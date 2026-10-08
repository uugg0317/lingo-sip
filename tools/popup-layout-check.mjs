/**
 * 真正的工具栏 Action Popup 验收，使用全新临时 Edge profile。
 * node tools/popup-layout-check.mjs [--output=dist/popup-qa] [--scale=1.25] [--baseline]
 * 通过 chrome.action.openPopup 触发浏览器原生自动尺寸；不覆盖 popup 视口。
 * --baseline 只记录原问题，不因布局断言失败设置非零退出码。
 * --scale=1.25 只改变临时浏览器进程的显示缩放；不改用户的系统显示设置。
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultState } from '../src/core/store.js';
import { dayKey } from '../src/core/stats.js';
import { pool } from '../src/core/wordbank.js';
import { emptyRecord } from '../src/core/srs.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = key => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3);
const browserPath = arg('browser') || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const output = resolve(arg('output') || join(repo, 'dist', 'popup-qa'));
const baseline = process.argv.includes('--baseline');
const scale = Number(arg('scale') || 1);
if (![1, 1.25].includes(scale)) throw new Error('Supported display scale is 1 or 1.25');
const profile = await mkdtemp(join(tmpdir(), 'lingo-sip-action-popup-'));
await Promise.all([access(browserPath), mkdir(output, { recursive: true })]);
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(fn, message, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await fn(); if (value) return value; await delay(80); }
  throw new Error(message);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Set();
    ws.addEventListener('message', ({ data }) => {
      const m = JSON.parse(String(data));
      if (!m.id) { for (const listener of this.listeners) listener(m); return; }
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timeout); this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result || {});
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((done, fail) => { ws.addEventListener('open', done, { once: true }); ws.addEventListener('error', fail, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
const browser = spawn(browserPath, [
  '--headless=new', '--screen-info={1440x1000}', '--window-size=1440,1000', `--force-device-scale-factor=${scale}`, `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', '--disable-default-apps', '--enable-unsafe-extension-debugging',
  `--disable-extensions-except=${repo}`, `--load-extension=${repo}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', cdp;
browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
const report = { mode: 'real-toolbar-action-popup', browser: browserPath, profile, output, baseline, displayScale: scale, startedAt: new Date().toISOString(), cases: [], checks: [], errors: [], limitations: ['125% uses the temporary Edge process display scale; toolbar action popup does not follow chrome.tabs.setZoom.', 'No real notifications or audio are emitted.'] };
const layoutExpression = `(() => {
  const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const doc = document.documentElement;
  const inside = r => r.x>=-1 && r.y>=-1 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;
  const controls=[...document.querySelectorAll('button,input')].filter(visible).map(e=>{
    const r=rect(e),target=e.matches('input')?e.closest('label'):e;
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {id:e.id,text:e.textContent,rect:r,inViewport:inside(r),unobstructed:hit===target || target.contains(hit),disabled:e.disabled};
  });
  const textFields=['.name','.status','.progress-text','#progressLine','#streakLine','#shownToday','#answeredToday','#todayCount','.category-note','.feedback'].map(selector=>{
    const e=document.querySelector(selector); if(!e||!visible(e))return null;
    const style=getComputedStyle(e),r=rect(e); const range=document.createRange();range.selectNodeContents(e);
    const textRect=range.getBoundingClientRect();
    return {selector,text:e.textContent,rect:r,textRect:{left:textRect.left,right:textRect.right,bottom:textRect.bottom},lineHeight:parseFloat(style.lineHeight),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight};
  }).filter(Boolean);
  return {innerWidth,innerHeight,outerWidth,outerHeight,dpr:devicePixelRatio,screen:{width:screen.width,height:screen.height},firstObservedViewport:window.__popupFirstObservedViewport || null,
    body:rect(document.body),scrollWidth:doc.scrollWidth,scrollHeight:doc.scrollHeight,clientWidth:doc.clientWidth,clientHeight:doc.clientHeight,
    rootScrollbar:doc.scrollHeight>innerHeight+1 || doc.scrollWidth>innerWidth+1,controls,textFields,footer:rect(document.querySelector('.foot')),
    status:document.querySelector('#status').textContent,shown:document.querySelector('#shownToday').textContent,answered:document.querySelector('#answeredToday').textContent,ring:document.querySelector('#ring').getAttribute('aria-valuetext'),feedback:document.querySelector('#feedback').textContent};
})()`;
function assertLayout(layout) {
  const failures=[];
  if (layout.innerWidth<350 || layout.innerWidth>430) failures.push(`Popup width unstable: ${layout.innerWidth}`);
  if (layout.rootScrollbar) failures.push(`Page overflow ${layout.scrollWidth}×${layout.scrollHeight} > ${layout.innerWidth}×${layout.innerHeight}`);
  if (layout.body.width > layout.innerWidth+1) failures.push('Body exceeds the real popup viewport');
  if (layout.footer.bottom>layout.innerHeight+1) failures.push('Footer clipped');
  for(const control of layout.controls) if(!control.inViewport || !control.unobstructed) failures.push(`Control clipped: ${control.id || control.text}`);
  for(const field of layout.textFields) {
    if(field.scrollWidth>field.clientWidth+2) failures.push(`Text overflow: ${field.selector}`);
    if(field.textRect.bottom>layout.innerHeight+2) failures.push(`Text clipped at viewport: ${field.selector}`);
  }
  const goal=layout.textFields.find(x=>x.selector==='#progressLine');
  if(goal?.rect.height>goal?.lineHeight*2+2) failures.push('Progress heading wraps into an abnormal narrow column');
  return [...new Set(failures)];
}
function makeState(kind) {
  const state=defaultState();
  Object.assign(state.settings,{enabled:true,notifyEnabled:false,notifySound:false,autoSpeak:false,onboardingDone:true,quietHours:{enabled:false,start:22,end:8}});
  state.runtime.lastShownAt=Date.now();
  for(const [index,word] of pool(state).slice(0,26).entries()){
    state.progress[word.id]={...emptyRecord(),seen:3,reps:2,known:2,box:index<21?2:6,status:index<21?'learning':'mastered',lastSeen:Date.now(),due:Date.now()-60000};
  }
  for(let offset=0;offset<14;offset++){
    const date=new Date();date.setDate(date.getDate()-offset);
    state.stats[dayKey(date.getTime())]={shown:offset?10:142,known:offset?4:30,snooze:offset?1:15,seconds:0};
  }
  if(kind==='large-paused'){
    state.settings.dailyGoal=200;
    state.runtime.pausedUntil=Date.now()+4*60*60*1000;
    state.stats[dayKey()]={shown:10000,known:9999,snooze:1,seconds:0,newShown:8000,reviewAnswered:9000,newShownComplete:true,reviewAnsweredComplete:true};
  }
  if(kind==='new-empty'){
    state.stats={};state.progress={};state.settings.goalMetric='answered';state.settings.enabled=false;
  }
  return state;
}
try {
  const portFile = await until(async () => { try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; } }, 'Edge没有启动CDP');
  const [port, wsPath] = portFile.trim().split(/\r?\n/);
  cdp = await CDP.open(`ws://127.0.0.1:${port}${wsPath}`);
  report.browserVersion = await cdp.send('Browser.getVersion');
  let worker = (await cdp.send('Target.getTargets')).targetInfos.find(x => x.type === 'service_worker' && x.url.includes('/src/background/service-worker.js'));
  if (!worker) { await cdp.send('Extensions.loadUnpacked', { path: repo }); worker = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(x => x.type === 'service_worker' && x.url.includes('/src/background/service-worker.js')), '未加载真实扩展'); }
  const extensionId = new URL(worker.url).hostname;
  report.extensionId = extensionId;
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/src/options/options.html` });
  const { sessionId: setupSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, setupSession);
  await until(() => cdp.evaluate(setupSession, `!!chrome.storage?.local && typeof chrome.action?.openPopup === 'function'`), '扩展API没有就绪');
  report.screen = await cdp.evaluate(setupSession, `({width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,innerWidth,innerHeight,dpr:devicePixelRatio})`);
  console.log(JSON.stringify({phase:'screen',screen:report.screen}));
  const diagnostics=new Map();
  cdp.listeners.add(message=>{
    const diag=diagnostics.get(message.sessionId);if(!diag)return;
    if(message.method==='Runtime.exceptionThrown')diag.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if(message.method==='Runtime.consoleAPICalled' && ['error','warning'].includes(message.params.type))diag.console.push(message.params.args.map(x=>x.value??x.description).join(' '));
    if(message.method==='Network.loadingFailed')diag.failedNetwork.push(message.params.errorText);
  });
  const seed=state=>cdp.evaluate(setupSession,`(async()=>{const store=await import(chrome.runtime.getURL('src/core/store.js'));await store.replace(${JSON.stringify(state)});return true;})()`);
  const readState=()=>cdp.evaluate(setupSession,`(async()=>{const store=await import(chrome.runtime.getURL('src/core/store.js'));return store.read();})()`);
  async function openPopup(theme='dark'){
    // Wait for teardown and explicitly focus the host browser; openPopup requires an active host window.
    await delay(160);
    const opening=cdp.evaluate(setupSession,`(async()=>{const win=await chrome.windows.getCurrent();await chrome.windows.update(win.id,{focused:true});await chrome.action.openPopup({windowId:win.id});return true;})()`);
    const target=await until(async()=> (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.includes('/src/popup/popup.html')), '真实工具栏popup没有创建');
    const attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    diagnostics.set(attached.sessionId,{errors:[],console:[],failedNetwork:[]});
    await Promise.all([cdp.send('Runtime.enable',{},attached.sessionId),cdp.send('Page.enable',{},attached.sessionId),cdp.send('Network.enable',{},attached.sessionId)]);
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]},attached.sessionId);
    await cdp.evaluate(attached.sessionId,'window.__popupFirstObservedViewport={innerWidth,innerHeight,dpr:devicePixelRatio};true');
    await opening;
    const sessionId=attached.sessionId;
    await until(()=>cdp.evaluate(sessionId,`document.readyState==='complete' && document.querySelector('#status')?.textContent!=='加载中…' && document.querySelector('#pauseChips')?.childElementCount>0`),'工具栏popup没有完成读取');
    await delay(180);
    return {targetId:target.targetId,sessionId,diagnostics:diagnostics.get(sessionId)};
  }
  async function closePopup(popup){
    try{await cdp.evaluate(popup.sessionId,'window.close();true');}catch{}
    await until(async()=> !(await cdp.send('Target.getTargets')).targetInfos.some(t=>t.targetId===popup.targetId),'工具栏popup未关闭');
  }
  async function capture(popup,name){
    const layout=await cdp.evaluate(popup.sessionId,layoutExpression);
    const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},popup.sessionId);
    const screenshot=join(output,`${name}.png`);await writeFile(screenshot,Buffer.from(data,'base64'));
    const failures=assertLayout(layout);
    report.cases.push({name,layout,screenshot,diagnostics:popup.diagnostics,passed:failures.length===0,failures});
    if(!baseline)report.errors.push(...failures.map(x=>`${name}: ${x}`));
    console.log(JSON.stringify({phase:'case',name,viewport:[layout.innerWidth,layout.innerHeight],firstObservedViewport:layout.firstObservedViewport,body:layout.body,scrollbar:layout.rootScrollbar,passed:failures.length===0,failures}));
    return layout;
  }
  async function click(popup,selector){
    const point=await cdp.evaluate(popup.sessionId,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1},popup.sessionId);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1},popup.sessionId);
  }
  async function check(name,fn){
    try{const detail=await fn();report.checks.push({name,passed:true,detail});console.log(JSON.stringify({phase:'interaction',name,passed:true}));}
    catch(error){report.checks.push({name,passed:false,error:error.message});report.errors.push(`${name}: ${error.message}`);console.error(`${name}: ${error.message}`);}
  }
  for(const theme of ['dark','light'])for(const kind of ['legacy-142','large-paused','new-empty']){
    await seed(makeState(kind));const popup=await openPopup(theme);
    await capture(popup,`${theme}-${Math.round(scale*100)}-${kind}`);
    await closePopup(popup);
  }
  if(!baseline){
    await seed(makeState('legacy-142'));let popup=await openPopup('dark');
    await check('pause-15-minutes',async()=>{
      await click(popup,'#pauseChips .chip');
      await until(async()=> (await readState()).runtime.pausedUntil>Date.now(),'Pause did not persist');
      await until(()=>cdp.evaluate(popup.sessionId,`document.querySelector('#pauseChips .chip')?.textContent.includes('恢复')`),'Resume chip missing');
      return {layout:await capture(popup,`dark-${Math.round(scale*100)}-pause`)};
    });
    await check('resume-learning',async()=>{
      await click(popup,'#pauseChips .chip');
      await until(async()=> !(await readState()).runtime.pausedUntil,'Resume did not persist');
      await until(()=>cdp.evaluate(popup.sessionId,`document.querySelector('#pauseChips').children.length===4`),'Pause chips not restored');
      return {pausedUntil:(await readState()).runtime.pausedUntil};
    });
    await check('toggle-auto-reminders',async()=>{
      await click(popup,'.switch');await until(async()=> !(await readState()).settings.enabled,'Disable did not persist');
      await until(()=>cdp.evaluate(popup.sessionId,`!document.querySelector('#enabled').disabled && !document.querySelector('#enabled').checked`),'Toggle did not settle');
      await click(popup,'.switch');await until(async()=> (await readState()).settings.enabled,'Enable did not persist');
      return {enabled:(await readState()).settings.enabled};
    });
    await check('visible-error-feedback',async()=>{
      await cdp.evaluate(popup.sessionId,`chrome.runtime.sendMessage=async()=>({ok:false,error:'这次操作未完成，请稍后重试。学习进度仍然保留，你可以重新打开设置检查。'});true`);
      await click(popup,'#pauseChips .chip');
      await until(()=>cdp.evaluate(popup.sessionId,`document.querySelector('#feedback').textContent.includes('操作未完成')`),'Error feedback missing');
      return {layout:await capture(popup,`dark-${Math.round(scale*100)}-feedback`)};
    });
    await closePopup(popup);popup=await openPopup('dark');
    await check('open-study-window',async()=>{
      await click(popup,'#studyNow');
      const study=await until(async()=> (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.includes('/src/pages/study.html')),'Study window missing');
      const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:study.targetId,flatten:true});
      await until(()=>cdp.evaluate(sessionId,`!!document.querySelector('#stage > *')?.shadowRoot?.querySelector('.ls-term')`),'Study card missing');
      await cdp.send('Target.closeTarget',{targetId:study.targetId});
      return {url:study.url};
    });
    popup=await openPopup('light');
    await check('open-settings',async()=>{
      await click(popup,'#openOptions');
      await until(async()=> !(await cdp.send('Target.getTargets')).targetInfos.some(t=>t.targetId===popup.targetId),'Popup not closed after options');
      return {optionsPageOpened:true};
    });
    popup=await openPopup('light');
    await check('open-diagnostics',async()=>{
      await click(popup,'#openLog');
      const target=await until(async()=> (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/src/options/options.html#diagnostics')),'Diagnostics page missing');
      await cdp.send('Target.closeTarget',{targetId:target.targetId});
      return {url:target.url};
    });
  }
  for(const row of report.cases){
    const diag=row.diagnostics;
    if(diag.errors.length || diag.failedNetwork.length)report.errors.push(`${row.name}: browser errors ${[...diag.errors,...diag.failedNetwork].join('; ')}`);
  }
} catch (error) { report.errors.push(error.message); console.error(error.message); }
finally {
  report.finishedAt = new Date().toISOString(); report.browserStderr = stderr;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  try { await cdp?.send('Browser.close'); } catch {} cdp?.ws.close(); browser.kill();
}
if (report.errors.length && !baseline) process.exitCode = 1;
