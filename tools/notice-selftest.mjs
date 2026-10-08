/** 真正后台通知 listener 的隔离回归；不创建或点击原生 Windows 通知。 */
import assert from 'node:assert/strict';
import { STORAGE_KEY } from '../src/core/constants.js';
import { defaultState, read, replace } from '../src/core/store.js';
import { emptyRecord } from '../src/core/srs.js';
import { makeId, normalizeWord } from '../src/core/wordbank.js';
import { today } from '../src/core/stats.js';

let count=0;
function check(name,actual,expected){assert.deepEqual(actual,expected,name);count+=1;}
function event(){return {listeners:[],addListener(fn){this.listeners.push(fn);}};}
async function emit(surface,...args){for(const fn of surface.listeners)await fn(...args);}
const bag={};
const cleared=[];
const opened=[];
const buttons=event(),closed=event(),clicked=event();
let failNextSet=false;
globalThis.chrome={
  runtime:{onInstalled:event(),onStartup:event(),onMessage:event(),async sendMessage(){return {ok:true};},getURL(path){return 'chrome-extension://notice-test/'+path;},openOptionsPage(){}},
  storage:{local:{async get(key){if(key===null)return structuredClone(bag);return structuredClone(Object.hasOwn(bag,key)?{[key]:bag[key]}:{});},async set(patch){if(failNextSet){failNextSet=false;throw new Error('隔离通知存储故障');}Object.assign(bag,structuredClone(patch));},async remove(keys){for(const key of keys)delete bag[key];}}},
  tabs:{onActivated:event(),onUpdated:event(),onRemoved:event()},
  alarms:{onAlarm:event(),async get(){return {name:'lingoSip:tick'};},create(){}},
  idle:{onStateChanged:event(),setDetectionInterval(){}},
  commands:{onCommand:event()},
  contextMenus:{onClicked:event()},
  action:{async setBadgeText(){},async setBadgeBackgroundColor(){}},
  windows:{async create(options){opened.push(options);return {id:1};}},
  notifications:{
    onButtonClicked:buttons,onClosed:closed,onClicked:clicked,
    async clear(id){cleared.push(id);await emit(closed,id,false);return true;},
    async getAll(){return {};},
    async create(){throw new Error('回归禁止原生通知创建');},
  },
};

const alias=makeId('work');
async function seed(mode='review'){
  const state=defaultState();
  Object.assign(state.settings,{enabled:false,notifyEnabled:false,autoSpeak:false});
  state.customWords=[normalizeWord({id:alias,term:'work',meaning:'旧通知释义'})];
  state.progress[alias]={...emptyRecord(),seen:3,known:2,reps:2,box:2,status:'learning',due:Date.now()+60000,lastSeen:Date.now()-1000};
  state.runtime.lastNoticeWordId=alias;
  if(mode)state.runtime.lastNoticeMode=mode;
  await replace(state);
  cleared.length=0;opened.length=0;
}
await import('../src/background/service-worker.js?notice-selftest=first');
check('实际 SW 注册按钮事件一次',buttons.listeners.length,1);
check('实际 SW 注册关闭事件一次',closed.listeners.length,1);

// 按钮随后触发关闭事件：一次作答，模式对应新通知，原别名进度保持。
await seed('review');
await emit(buttons,'lingo-'+alias,0);
let state=await read();
check('通知按钮写 canonical 身份',state.progress.w001.known,3);
check('通知按钮不再写旧 alias',state.progress[alias].known,2);
check('通知按钮仍计一次主动作答',today(state).answered,1);
check('明示复习通知计复习完成',today(state).reviewAnswered,1);
check('按钮通知随后close没有回滚盒子',state.progress.w001.box,3);
check('按钮即使伴随close仍只关闭一次',cleared,['lingo-'+alias]);

await seed('early');
await emit(buttons,'lingo-'+alias,1);
state=await read();
check('稍后复习按钮退一个盒子',state.progress.w001.box,1);
check('提前练习通知的稍后复习算主动复习',today(state).reviewAnswered,1);
check('稍后复习通知不误计known',today(state).known,0);

await seed('new');
await emit(buttons,'lingo-'+alias,0);
check('明示新词通知不冒充复习',today(await read()).reviewAnswered,0);
check('明示新词通知的分类仍完整',today(await read()).reviewAnsweredComplete,true);

await seed('');
await emit(buttons,'lingo-'+alias,0);
check('旧未知模式通知仍计主动完成',today(await read()).answered,1);
check('旧未知通知不猜复习分类',today(await read()).reviewAnswered,0);
check('旧未知通知标明分类不完整',today(await read()).reviewAnsweredComplete,false);

// 未作答关闭与通知正文点击都不能重复增加作答。
await seed('review');
await emit(closed,'lingo-'+alias,true);
check('手动关闭通知不增加作答',today(await read()).answered,0);
check('手动关闭通知不扣盒子', (await read()).progress.w001.box,2);
await seed('review');
await emit(clicked,'lingo-'+alias);
check('通知正文点击打开连学窗',opened[0]?.url.endsWith('/src/pages/study.html'),true);
check('通知正文点击不作答',today(await read()).answered,0);

// 作答存储失败仍在 finally 清通知；测试通知不写进度。
await seed('review');
failNextSet=true;
await emit(buttons,'lingo-'+alias,0);
check('失败作答仍关闭通知',cleared,['lingo-'+alias]);
check('失败作答不假装已记录', (await read()).progress.w001.known,2);
await seed('review');
const before=JSON.stringify((await read()).progress);
await emit(buttons,'lingo-test-w001',0);
check('测试通知仍关闭',cleared,['lingo-test-w001']);
check('测试通知不记账',JSON.stringify((await read()).progress),before);

// 重建 worker listener 集合：新的后台实例仍读持久化通知模式。
buttons.listeners.length=0;closed.listeners.length=0;clicked.listeners.length=0;
await import('../src/background/service-worker.js?notice-selftest=restarted');
await seed('recycle');
await emit(buttons,'lingo-'+alias,0);
check('重建后台仍能从存储识别通知模式',today(await read()).reviewAnswered,1);
check('重建后台没有丢失旧进度', (await read()).progress.w001.known,3);

console.log(`通知 listener 隔离回归通过：${count} 项断言；未创建或点击原生通知。`);
