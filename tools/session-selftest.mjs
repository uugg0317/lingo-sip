/** 后台工厂回归：仅使用隔离内存存储，无真实学习数据或 Windows 通知。 */
import assert from 'node:assert/strict';
import { STORAGE_KEY, MIN } from '../src/core/constants.js';
import { defaultState, read, snapshotKey } from '../src/core/store.js';
import { emptyRecord } from '../src/core/srs.js';
import { BUILTIN, makeId, normalizeWord } from '../src/core/wordbank.js';
import { today } from '../src/core/stats.js';
import { createLearningSession } from '../src/background/learning-session.js';
import { createDataHandlers } from '../src/background/data-handlers.js';

let count = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  count += 1;
}
const bag = {};
let lockDepth = 0;
let lockCalls = 0;
let failNextSet = false;
const uiEvents = [];
const locks = {
  async request(_name, callback) {
    assert.equal(lockDepth, 0, '禁止嵌套持有存储锁');
    lockCalls += 1;
    lockDepth += 1;
    try { return await callback(); }
    finally { lockDepth -= 1; }
  },
};
Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === null) return structuredClone(bag);
        const keys = Array.isArray(key) ? key : [key];
        return structuredClone(Object.fromEntries(keys.filter((item) => Object.hasOwn(bag, item)).map((item) => [item, bag[item]])));
      },
      async set(patch) {
        if (failNextSet) { failNextSet = false; throw new Error('隔离存储故障'); }
        Object.assign(bag, structuredClone(patch));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete bag[key];
      },
    },
  },
};
const dependencies = {
  async refreshBadge() {
    assert.equal(lockDepth, 0, '刷新角标发生在存储锁释放后');
    uiEvents.push('badge');
  },
  broadcastState() {
    assert.equal(lockDepth, 0, '广播发生在存储锁释放后');
    uiEvents.push('broadcast');
  },
  async ensureAlarm() {
    assert.equal(lockDepth, 0, '重建闹钟发生在存储锁释放后');
    uiEvents.push('alarm');
  },
};
let timestamp = Date.now();
const builtin = BUILTIN.find((word) => word.term === 'work');
const alias = makeId('work');
const session = createLearningSession({ ...dependencies, now: () => timestamp });

function load(state = defaultState()) {
  for (const key of Object.keys(bag)) delete bag[key];
  bag[STORAGE_KEY] = structuredClone(state);
  uiEvents.length = 0;
}

// 旧 alias 的展示/作答/跳过统一写主记录，旧记录保持历史快照。
{
  const state = defaultState();
  state.customWords = [normalizeWord({ term: 'work', meaning: '工作；作品' })];
  state.progress[alias] = { ...emptyRecord(timestamp), seen: 4, known: 1, reps: 1, box: 1, status: 'learning', due: timestamp + MIN, lastSeen: timestamp - 1000 };
  load(state);
  const before = lockCalls;
  await session.recordShown({ wordId: alias, mode: 'new' }, 42);
  let saved = await read();
  check('展示一次只申请一次锁', lockCalls - before, 1);
  check('展示写 canonical 记录', saved.progress[builtin.id].seen, 5);
  check('展示不再改旧 alias 记录', saved.progress[alias].seen, 4);
  check('展示 lastWordId 使用 canonical', saved.runtime.lastWordId, builtin.id);
  check('展示保存页面冷却', saved.runtime.tabShown['42'], timestamp);
  check('展示统计累加一次', today(saved, timestamp).shown, 1);
  check('明示新词统计累加', today(saved, timestamp).newShown, 1);
  check('展示不擅自广播调用方拥有的副作用', uiEvents, []);
  timestamp += 1000;
  const answer = await session.recordAction({ wordId: alias, action: 'known', mode: 'review', elapsedMs: 5000 });
  saved = await read();
  check('作答返回推进后的盒子', answer.box, 2);
  check('作答只改 canonical known', saved.progress[builtin.id].known, 2);
  check('旧 alias known 保持历史', saved.progress[alias].known, 1);
  check('主动作答累加一次', today(saved, timestamp).answered, 1);
  check('明示复习累计一次', today(saved, timestamp).reviewAnswered, 1);
  check('作答耗时按秒记入', today(saved, timestamp).seconds, 5);
  check('成功作答后刷新广播顺序', uiEvents, ['badge', 'broadcast']);
  timestamp += 1000;
  const due = saved.progress[builtin.id].due;
  await session.recordDismissed({ wordId: alias }, 'notice-closed');
  saved = await read();
  check('跳过不重复累计展示', today(saved, timestamp).shown, 1);
  check('跳过不累计作答', today(saved, timestamp).answered, 1);
  check('跳过不回滚已推迟的复习时间', saved.progress[builtin.id].due, due);
  check('跳过不回滚盒子', saved.progress[builtin.id].box, 2);
  check('三种操作各只有一次写锁', lockCalls - before, 3);
}

// 新通知明示 mode 跨工厂/SW 重启可读；旧通知和不匹配词条不推测分类。
{
  load();
  await session.recordShown({ wordId: builtin.id, mode: 'early' }, null, {
    lastNotifiedAt: timestamp, lastNoticeWordId: alias, lastNoticeMode: 'early',
  });
  const saved = await read();
  check('通知持久化 canonical 单词 ID', saved.runtime.lastNoticeWordId, builtin.id);
  check('通知持久化明示模式', saved.runtime.lastNoticeMode, 'early');
  const restarted = createLearningSession({ ...dependencies, now: () => timestamp });
  check('重启后读取同词通知模式', await restarted.noticeMode(alias), 'early');
  check('不对应的通知不猜模式', await restarted.noticeMode('another-word'), undefined);
  await restarted.recordAction({ wordId: alias, action: 'snooze', mode: await restarted.noticeMode(alias) });
  check('通知按钮按明示提前复习统计', today(await read(), timestamp).reviewAnswered, 1);
  load();
  bag[STORAGE_KEY].runtime.lastNoticeId = builtin.id; // 旧字段不带 mode
  check('旧通知没有模式继续未知', await restarted.noticeMode(builtin.id), undefined);
  await restarted.recordAction({ wordId: builtin.id, action: 'known' });
  check('旧无模式作答仍计主动完成', today(await read(), timestamp).answered, 1);
  check('旧无模式不冒充复习完成', today(await read(), timestamp).reviewAnswered, 0);
  check('未知模式标记分类不完整', today(await read(), timestamp).reviewAnsweredComplete, false);
}

// 写失败不广播成功，后续写队列仍能继续。
{
  load();
  failNextSet = true;
  await assert.rejects(session.recordAction({ wordId: builtin.id, action: 'known', mode: 'review' }), /隔离存储故障/);
  check('失败写入不触发成功副作用', uiEvents, []);
  check('失败写入不改落盘进度', (await read()).progress[builtin.id], undefined);
  await session.recordShown({ wordId: builtin.id, mode: 'new' }, null);
  check('失败后写队列仍可继续', today(await read(), timestamp).shown, 1);
}

// 数据端点返回与原消息契约一致，默认合并不回退、覆盖保持显式端点。
{
  load();
  const data = createDataHandlers(dependencies);
  const before = lockCalls;
  check('非数据消息交回主路由', await data({ type: 'tts:speak' }), null);
  check('非数据消息无存储写入', lockCalls, before);
  check('空合并失败文案保持', await data({ type: 'data:merge-backup' }), { ok: false, error: '备份内容为空' });
  check('空合并不广播', uiEvents, []);
  const current = defaultState();
  current.settings.dailyGoal = 99;
  current.progress[builtin.id] = { ...emptyRecord(timestamp), known: 4, seen: 6, box: 4, status: 'learning', due: timestamp + MIN, lastSeen: timestamp };
  load(current);
  const incoming = defaultState();
  incoming.settings.dailyGoal = 3;
  incoming.progress[builtin.id] = { ...emptyRecord(timestamp), known: 1, seen: 2, box: 1, status: 'learning', due: timestamp + 2 * MIN, lastSeen: timestamp - 1000 };
  incoming.progress.extra = { ...emptyRecord(timestamp), seen: 1 };
  const merged = await data({ type: 'data:merge-backup', state: incoming });
  check('合并返回成功 report', merged.ok, true);
  check('合并 report 新增词条保持', merged.report.added, ['extra']);
  check('合并不回退计数', (await read()).progress[builtin.id].known, 4);
  check('合并保留当前设置', (await read()).settings.dailyGoal, 99);
  check('合并后刷新广播一次', uiEvents, ['badge', 'broadcast']);
  const exported = JSON.parse(JSON.stringify(await read()));
  await data({ type: 'data:import-backup', state: exported });
  check('覆盖式导入显式端点返回成功', (await read()).progress.extra.seen, 1);
  check('不存在快照错误契约不变', await data({ type: 'snapshot:restore', key: 'missing' }), { ok: false, error: '这份快照不存在' });
  const saved = await data({ type: 'snapshot:save' });
  check('快照保存返回成功', saved.ok, true);
  check('快照保存返回当日key', saved.key, snapshotKey());
  check('快照列表能读取保存项', (await data({ type: 'snapshot:list' })).list[0].key, saved.key);
  await data({ type: 'data:reset-progress' });
  check('清进度端点不删自定义词库', (await read()).customWords, exported.customWords);
  check('清进度端点清空记录', (await read()).progress, {});
  const restored = await data({ type: 'snapshot:restore', key: saved.key });
  check('快照恢复返回成功', restored.ok, true);
  check('恢复前备份调用不嵌套写锁', lockDepth, 0);
  check('快照恢复原进度', (await read()).progress[builtin.id].known, 4);
  uiEvents.length = 0;
  await data({ type: 'data:reset-all' });
  check('重置工厂按原顺序重建闹钟并广播', uiEvents, ['alarm', 'badge', 'broadcast']);
  check('重置工厂清空学习数据', (await read()).progress, {});
  uiEvents.length = 0;
  check('刷新端点契约保持', await data({ type: 'data:refresh' }), { ok: true });
  check('刷新端点副作用顺序保持', uiEvents, ['badge', 'broadcast']);
  failNextSet = true;
  uiEvents.length = 0;
  await assert.rejects(data({ type: 'data:import-backup', state: exported }), /隔离存储故障/);
  check('备份写失败不发送成功广播', uiEvents, []);
  const legacyBackup = defaultState();
  legacyBackup.customWords = [normalizeWord({ term: 'work', meaning: '旧版自定义释义' })];
  legacyBackup.progress[alias] = { ...emptyRecord(timestamp), seen: 8, known: 3, status: 'learning', box: 3, due: timestamp + MIN };
  await data({ type: 'data:import-backup', state: JSON.parse(JSON.stringify(legacyBackup)) });
  check('恢复旧备份端点关联主身份', (await read()).progress[builtin.id].seen, 8);
  check('恢复旧备份端点保留历史 alias', (await read()).progress[alias].known, 3);
}

console.log(`后台会话与数据端点回归通过：${count} 项断言。`);
