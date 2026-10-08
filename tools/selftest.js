/**
 * 核心逻辑自测：node tools/selftest.js
 *
 * 测试核心纯逻辑，并用隔离的内存存储验证写入竞争；不读写真实学习数据。
 * 使用浏览器 API 的小型替身，因此在 Node 里就能跑，
 * 改完算法不用开浏览器就知道有没有改坏。
 */

import { MIN, DAY, STORAGE_KEY } from '../src/core/constants.js';
import { defaultState, read, update, replace, resetAll, ensureSnapshot, SKIP_WRITE } from '../src/core/store.js';
import { grade, emptyRecord, pickNext, queueSummary, isMastered } from '../src/core/srs.js';
import { evaluate, isBlacklisted, inQuietHours, globToRegExp } from '../src/core/scheduler.js';
import * as stats from '../src/core/stats.js';
import { parseImport, toCSV, makeId, pool, normalizeWord } from '../src/core/wordbank.js';
import { mergeState, previewMerge } from '../src/core/backup.js';
import { BUILTIN_WORDS, BUILTIN_PHRASES } from '../src/data/words.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ================================================================== *
 * 1. 间隔重复
 * ================================================================== */
{
  const t0 = 1_700_000_000_000;

  // 新词初始状态
  const fresh = emptyRecord(t0);
  eq('新词盒子为 0', fresh.box, 0);
  eq('新词状态为 new', fresh.status, 'new');

  // 答对一次 → 进 1 格，45 分钟后复习
  const k1 = grade(fresh, 'known', t0);
  eq('答对后进入 1 号盒', k1.box, 1);
  eq('答对后状态为 learning', k1.status, 'learning');
  eq('答对后 45 分钟再见', k1.due - t0, 45 * MIN);

  // 连续答对到 5 号盒 → 已掌握
  let rec = fresh;
  for (let i = 0; i < 5; i += 1) rec = grade(rec, 'known', t0);
  eq('连对 5 次进入 5 号盒', rec.box, 5);
  check('5 号盒视为已掌握', isMastered(rec));
  eq('已掌握后间隔为 7 天', rec.due - t0, 7 * DAY);

  // 继续答对不会超过最高盒子
  const capped = grade(rec, 'known', t0);
  eq('盒子封顶在 6', capped.box, 6);

  // 点"稍后复习" → 退 1 格，短期后再来
  const back = grade(k1, 'snooze', t0);
  eq('稍后复习退到 0 号盒', back.box, 0);
  eq('0 号盒 10 分钟后再来', back.due - t0, 10 * MIN);
  eq('稍后复习不会增加 known 计数', back.known, k1.known);
  eq('稍后复习会累加 snooze 计数', back.snooze, 1);

  // 超时淡出：不动盒子，只把"已到期"的词往后推
  const overdue = { ...emptyRecord(t0), status: 'learning', seen: 1, box: 1, due: t0 - 1000 };
  const seen = grade(overdue, 'seen', t0);
  eq('超时不改变盒子', seen.box, 1);
  eq('超时后 20 分钟再来', seen.due - t0, 20 * MIN);
  check('超时不改变掌握状态', seen.status === 'learning');

  // 还没到期就被跳过的词，不应该被推得更远
  const future = { ...emptyRecord(t0), status: 'learning', seen: 1, box: 3, due: t0 + 5 * MIN };
  eq('未到期的词跳过时保持原计划', grade(future, 'seen', t0).due, future.due);
}

/* ================================================================== *
 * 2. 取词队列
 * ================================================================== */
{
  const now = 1_700_000_000_000;
  const state = defaultState();
  const words = [{ id: 'a', term: 'alpha' }, { id: 'b', term: 'beta' }, { id: 'c', term: 'gamma' }];

  // 全是新词 → 出 new
  const first = pickNext(state, words, now, {});
  eq('空进度时出新词', first.mode, 'new');

  // 让 a 到期 → 应优先复习 a
  state.progress.a = { ...emptyRecord(now), status: 'learning', seen: 1, box: 2, due: now - 1000 };
  const second = pickNext(state, words, now, {});
  eq('到期复习优先于新词', second.word.id, 'a');
  eq('到期词的模式是 review', second.mode, 'review');

  // 关闭新词 → 没有到期的就只剩保温/兜底
  state.progress.b = { ...emptyRecord(now), status: 'learning', seen: 1, box: 1, due: now + DAY };
  state.progress.c = { ...emptyRecord(now), status: 'mastered', seen: 9, box: 6, due: now + DAY, lastSeen: now - 30 * DAY };
  state.progress.a.due = now + DAY;
  const recycle = pickNext(state, words, now, { allowNew: false, recycleMastered: true });
  eq('已掌握很久的词会被回收', recycle.mode, 'recycle');

  // 队列概览
  const sum = queueSummary(state, words, now);
  eq('概览统计到已掌握 1 个', sum.mastered, 1);
  eq('概览总数为 3', sum.total, 3);

  // 避免连续出同一个词
  const avoid = pickNext(state, words, now, { allowNew: true, avoidId: 'a' });
  check('avoidId 不会立刻重复同一个词', avoid.word.id !== 'a');
}

/* ================================================================== *
 * 3. 闸门
 * ================================================================== */
{
  const now = 1_700_000_000_000;
  const ctx = { now, url: 'https://example.com/x', hostname: 'example.com', tabId: 1 };

  const s1 = defaultState();
  s1.runtime.lastShownAt = 0;
  check('默认状态放行', evaluate(s1, ctx).allowed);

  const s2 = defaultState();
  s2.settings.enabled = false;
  eq('关闭自动提醒后被拦', evaluate(s2, ctx).allowed, false);

  const s3 = defaultState();
  s3.runtime.pausedUntil = now + 10 * MIN;
  eq('暂停期内被拦', evaluate(s3, ctx).allowed, false);

  const s4 = defaultState();
  s4.runtime.lastShownAt = now - 1 * MIN;
  eq('冷却期内被拦', evaluate(s4, ctx).allowed, false);

  const s5 = defaultState();
  s5.runtime.hourCount = 5;
  eq('达到每小时上限被拦', evaluate(s5, ctx).allowed, false);

  const s6 = defaultState();
  s6.runtime.dayCount = 30;
  eq('达到每天上限被拦', evaluate(s6, ctx).allowed, false);

  const s7 = defaultState();
  s7.settings.blacklist = ['*.bank.com'];
  eq('免打扰名单生效', evaluate(s7, { ...ctx, url: 'https://www.bank.com/a', hostname: 'www.bank.com' }).allowed, false);

  const s8 = defaultState();
  s8.runtime.tabShown = { 1: now - 1000 };
  eq('同一标签页冷却生效', evaluate(s8, ctx).allowed, false);
  check('换个标签页就放行', evaluate(s8, { ...ctx, tabId: 2 }).allowed);

  // 手动触发（点"立即学一张"）绕过冷却、配额、单页冷却与安静时段
  const s9 = defaultState();
  s9.runtime.lastShownAt = now;
  s9.runtime.dayCount = 30;
  s9.runtime.hourCount = 5;
  s9.runtime.tabShown = { 1: now };
  s9.settings.quietHours = { enabled: true, start: 0, end: 23 };
  check('手动触发绕过冷却、配额与安静时段', evaluate(s9, { ...ctx, manual: true }).allowed);
  eq('但自动触发在同一状态下被拦', evaluate(s9, ctx).allowed, false);

  // 自动提醒关闭后仍可主动学习，与 popup 开关和 README 的约定一致。
  const s9b = defaultState();
  s9b.settings.enabled = false;
  check('关闭自动提醒后仍可手动学习', evaluate(s9b, { ...ctx, manual: true }).allowed);
  eq('关闭自动提醒后自动触发仍被拦', evaluate(s9b, ctx).allowed, false);

  // 新词额度
  const s10 = defaultState();
  s10.runtime.newCount = 20;
  eq('新词额度用完时挡住新词', evaluate(s10, { ...ctx, isNew: true }).allowed, false);
  check('但复习仍然放行', evaluate(s10, { ...ctx, isNew: false }).allowed);

  // 安静时段（跨天）
  const quiet = { quietHours: { enabled: true, start: 22, end: 8 } };
  const at23 = new Date(2026, 0, 5, 23, 30).getTime();
  const at07 = new Date(2026, 0, 5, 7, 30).getTime();
  const at12 = new Date(2026, 0, 5, 12, 0).getTime();
  check('23:30 处于安静时段', inQuietHours(quiet, at23));
  check('07:30 处于安静时段', inQuietHours(quiet, at07));
  check('12:00 不在安静时段', !inQuietHours(quiet, at12));

  // 通配符
  check('域名通配符匹配', isBlacklisted({ blacklist: ['*.bank.com'] }, '', 'www.bank.com') !== '');
  check('URL 通配符匹配', isBlacklisted({ blacklist: ['*://*.example.com/inbox*'] }, 'https://mail.example.com/inbox/1', 'mail.example.com') !== '');
  check('不相关域名不匹配', isBlacklisted({ blacklist: ['*.bank.com'] }, '', 'example.com') === '');
  check('glob 转义正确', globToRegExp('a.b.com').test('a.b.com') && !globToRegExp('a.b.com').test('axb.com'));
}

/* ================================================================== *
 * 4. 统计
 * ================================================================== */
{
  const now = Date.now();
  const state = defaultState();
  stats.rollover(state, now);
  stats.bump(state, 'shown', { isNew: true }, now);
  stats.bump(state, 'shown', {}, now);
  stats.bump(state, 'known', { seconds: 12 }, now);
  stats.bump(state, 'snooze', {}, now);

  eq('今日展示 2 张', stats.today(state, now).shown, 2);
  eq('今日已掌握 1 个', stats.today(state, now).known, 1);
  eq('今日跳过 1 个', stats.today(state, now).snooze, 1);
  eq('今日用时 12 秒', stats.today(state, now).seconds, 12);
  eq('运行时计数同步', state.runtime.dayCount, 2);
  eq('新词计数同步', state.runtime.newCount, 1);

  // 连续天数：昨天、前天都有记录，今天没有 → 连续 2 天
  const s2 = defaultState();
  s2.stats[stats.dayKey(now - DAY)] = { shown: 3, known: 0, snooze: 0, seconds: 0 };
  s2.stats[stats.dayKey(now - 2 * DAY)] = { shown: 3, known: 0, snooze: 0, seconds: 0 };
  eq('今天没学但昨天学了，连续天数不断', stats.streak(s2, now), 2);

  s2.stats[stats.dayKey(now)] = { shown: 1, known: 0, snooze: 0, seconds: 0 };
  eq('今天也学了，连续 3 天', stats.streak(s2, now), 3);

  // 跨天归零
  const s3 = defaultState();
  stats.rollover(s3, now);
  s3.runtime.dayCount = 7;
  s3.runtime.hourCount = 3;
  stats.rollover(s3, now + 2 * DAY);
  eq('跨天后当日计数归零', s3.runtime.dayCount, 0);
  eq('跨天后小时计数归零', s3.runtime.hourCount, 0);

  eq('最近 7 天返回 7 条', stats.lastDays(s3, 7, now).length, 7);
}

/* ================================================================== *
 * 5. 词库与导入
 * ================================================================== */
{
  eq('内置词表可加载', BUILTIN_WORDS.length > 100 && BUILTIN_PHRASES.length > 20, true);
  const state = defaultState();
  eq('未筛选时学习池等于全集', pool(state).length, BUILTIN_WORDS.length + BUILTIN_PHRASES.length);
  state.settings.bankTags = ['meeting'];
  const meetingPool = pool(state);
  check('按分类筛选后池子变小', meetingPool.length < BUILTIN_WORDS.length + BUILTIN_PHRASES.length);
  check('筛选结果都带该标签', meetingPool.every((w) => (w.tags || []).includes('meeting')));

  // id 稳定：同一个词两次生成必须一致
  eq('id 生成稳定', makeId('Follow up ON'), makeId('follow up on'));

  // CSV（带表头）
  const csv = 'term,phonetic,pos,meaning,example,exampleZh,tags,level\nresilient,/rɪˈz/,adj.,有韧性的,Be resilient.,要有韧性。,office|core,2';
  const r1 = parseImport(csv);
  eq('CSV 带表头导入 1 条', r1.words.length, 1);
  eq('CSV 解析出释义', r1.words[0].meaning, '有韧性的');
  eq('CSV 解析出标签数组', r1.words[0].tags.join('|'), 'office|core');
  eq('CSV 解析出 level', r1.words[0].level, 2);

  // 中文表头
  const r2 = parseImport('单词,释义,例句\nbudget,预算,We are over budget.');
  eq('中文表头可识别', r2.words.length, 1);
  eq('中文表头释义正确', r2.words[0].meaning, '预算');

  // 两列清单
  const r3 = parseImport('invoice,发票\nvendor,供应商');
  eq('两列清单导入 2 条', r3.words.length, 2);

  // TSV
  const r4 = parseImport('term\tmeaning\nquota\t配额');
  eq('TSV 可导入', r4.words.length, 1);

  // JSON
  const r5 = parseImport('[{"term":"agenda","meaning":"议程"}]');
  eq('JSON 可导入', r5.words[0].term, 'agenda');

  // 带引号与逗号的 CSV
  const r6 = parseImport('term,meaning\n"scope, in PM","范围，项目管理里的"');
  eq('带引号逗号解析正确', r6.words[0].term, 'scope, in PM');

  // 非法输入不崩
  eq('空输入返回空', parseImport('').words.length, 0);
  eq('坏 JSON 不抛异常', parseImport('[坏数据').words.length, 0);

  // 导出再导入应该等价
  const custom = [normalizeWord({ term: 'deadline', meaning: '截止日期', example: 'The deadline is tight.' })];
  const round = parseImport(toCSV(custom));
  eq('导出后可原样导入', round.words.length, 1);
  eq('往返后释义一致', round.words[0].meaning, '截止日期');
  eq('往返后 id 一致', round.words[0].id, custom[0].id);

  // 重复导入同一个词只留一条
  const dup = parseImport('deadline,截止时间\ndeadline,截止日期');
  eq('同词去重', dup.words.length, 1);

  // 导出的例句允许换行和引号，再导入时必须仍是同一个词。
  const multiline = [{
    ...normalizeWord({ term: 'keep going', meaning: '继续', type: 'phrase' }),
    id: 'existing-custom-id',
    example: 'She said, "Keep going."\r\n\n# A new line\nOne\ttab.',
    exampleZh: '她说：继续。\n下一行',
  }];
  const multilineRound = parseImport(toCSV(multiline));
  eq('CSV 多行往返只生成一个词条', multilineRound.words.length, 1);
  eq('CSV 多行往返没有解析错误', multilineRound.errors.length, 0);
  eq('CSV 完整保留多行例句与引号', multilineRound.words[0]?.example, multiline[0].example);
  eq('CSV 完整保留多行例句翻译', multilineRound.words[0]?.exampleZh, multiline[0].exampleZh);
  eq('CSV 往返保留原始词条 id', multilineRound.words[0]?.id, 'existing-custom-id');
  eq('CSV 往返保留短语类型', multilineRound.words[0]?.type, 'phrase');
  const tsv = parseImport('term\tmeaning\texample\nalpha\t第一个\t"line one\nline two"');
  eq('TSV 支持引号内换行', tsv.words[0]?.example, 'line one\nline two');
  const single = parseImport('alpha,第一个');
  eq('单行两列清单的释义正确', single.words[0]?.meaning, '第一个');
  eq('单行两列清单不把释义写进音标', single.words[0]?.phonetic, '');
  const malformed = parseImport('term,meaning\nvalid,有效\nbroken,"未闭合\n下一行');
  eq('未闭合引号不生成损坏词条', malformed.words.length, 1);
  check('未闭合引号报告原始行号', malformed.errors[0]?.includes('第 3 行'));
  const commented = parseImport('# comment with " quote\nterm,meaning\nalpha,第一个');
  eq('注释里的引号不干扰后续词条', commented.words[0]?.term, 'alpha');
}

/* ================================================================== *
 * 6. 备份合并
 *
 * 这一节使用人工构造的状态验证小备份与大状态的合并。核心不变量是
 * **绝不允许把"学过"变成"没学过"**。
 * ================================================================== */
{
  const rec = (over = {}) => ({
    box: 0, due: 1000, known: 0, lastSeen: 1000, reps: 0, seen: 1, snooze: 0,
    status: 'learning', ...over,
  });

  const mk = (progress, extra = {}) => ({
    ...defaultState(),
    progress,
    ...extra,
  });

  // —— 关键回归：当前有 25 个词、备份只有 3 个，合并后一个都不能少 ——
  // 词 id 刻意错开：当前占 w101..w125，备份占 w001/w015/w028，
  // 这样"3 个词里 2 个是新的"才成立（若两边都有 w001，新增就只有 1 个）。
  {
    const curProgress = {};
    for (let i = 1; i <= 25; i += 1) curProgress[`w${100 + i}`] = rec({ seen: 2, lastSeen: 5000 });
    const cur = mk(curProgress);
    const inc = mk({
      w001: rec({ seen: 9, known: 2, lastSeen: 9000 }),
      w015: rec({ seen: 6, known: 1, lastSeen: 8000 }),
      w028: rec({ seen: 7, lastSeen: 7000 }),
    });

    const { state, report } = mergeState(cur, inc);
    eq('合并后总词数 = 当前 + 备份独有（25 + 3）', Object.keys(state.progress).length, 28);
    eq('两边 id 完全错开时，备份 3 个都是新的', report.added.length, 3);
    eq('当前独有词一个都没丢', Object.keys(cur.progress).filter((k) => !state.progress[k]).length, 0);
    check('且没有任何词被删成"没学过"', Object.values(state.progress).every((r) => r.seen >= 1));
    // 这是覆盖式导入会造成的后果——合并必须避免
    check('合并结果严格多于备份本身', Object.keys(state.progress).length > Object.keys(inc.progress).length);
    eq('备份里没有的词保持原样', state.progress.w125.seen, 2);
  }

  // —— 计数器只增不减 ——
  {
    const cur = mk({ w001: rec({ seen: 9, known: 3, snooze: 1, reps: 3, lastSeen: 9000 }) });
    const inc = mk({ w001: rec({ seen: 2, known: 1, snooze: 5, reps: 1, lastSeen: 1000 }) });
    const { state } = mergeState(cur, inc);
    const r = state.progress.w001;
    eq('seen 取较大值', r.seen, 9);
    eq('known 取较大值', r.known, 3);
    eq('snooze 取较大值', r.snooze, 5);
    eq('reps 取较大值', r.reps, 3);
  }

  // —— 反向也算：备份的计数器更大时必须采纳，不许被当前压住 ——
  {
    const cur = mk({ w001: rec({ seen: 1, known: 0, lastSeen: 9000 }) });
    const inc = mk({ w001: rec({ seen: 8, known: 4, lastSeen: 1000 }) });
    const { state } = mergeState(cur, inc);
    eq('备份更大时采纳备份的 seen', state.progress.w001.seen, 8);
    eq('备份更大时采纳备份的 known', state.progress.w001.known, 4);
    eq('基底仍取最近活动的当前记录', state.progress.w001.lastSeen, 9000);
  }

  // —— due 取更早的：宁可提前复习，不要拖后 ——
  {
    const cur = mk({ w001: rec({ due: 8000 }) });
    const inc = mk({ w001: rec({ due: 3000 }) });
    eq('due 取更早的那个', mergeState(cur, inc).state.progress.w001.due, 3000);
    eq('反向同样取更早', mergeState(inc, cur).state.progress.w001.due, 3000);
  }

  // —— 一边缺少 due 时不能算出 0 ——
  {
    const cur = mk({ w001: rec({ due: 0 }) });
    const inc = mk({ w001: rec({ due: 7500 }) });
    eq('缺 due 时回落到另一边', mergeState(cur, inc).state.progress.w001.due, 7500);
  }

  // —— 统计按天相加 ——
  {
    const cur = mk({}, { stats: { '2026-09-20': { shown: 10, known: 2, snooze: 1, seconds: 30 } } });
    const inc = mk({}, { stats: { '2026-09-20': { shown: 4, known: 1, snooze: 3, seconds: 12 }, '2026-09-19': { shown: 5, known: 0, snooze: 0, seconds: 0 } } });
    const { state } = mergeState(cur, inc);
    eq('同一天 shown 相加', state.stats['2026-09-20'].shown, 14);
    eq('同一天 known 相加', state.stats['2026-09-20'].known, 3);
    eq('同一天 snooze 相加', state.stats['2026-09-20'].snooze, 4);
    eq('同一天 seconds 相加', state.stats['2026-09-20'].seconds, 42);
    eq('备份带来的新日期被保留', state.stats['2026-09-19'].shown, 5);
  }

  // —— 自定义词条按 id 合并，当前的编辑不被备份覆盖 ——
  {
    const cur = mk({}, { customWords: [{ id: 'c1', term: 'mine', meaning: '我改过的' }] });
    const inc = mk({}, { customWords: [{ id: 'c1', term: 'mine', meaning: '旧释义' }, { id: 'c2', term: 'other', meaning: '新的' }] });
    const { state } = mergeState(cur, inc);
    eq('自定义词条不重复', state.customWords.length, 2);
    eq('同 id 保留当前编辑', state.customWords.find((w) => w.id === 'c1').meaning, '我改过的');
    check('备份独有的词条被加入', !!state.customWords.find((w) => w.id === 'c2'));
  }

  // —— 设置与运行时以当前为准 ——
  {
    const cur = mk({});
    cur.settings = { ...cur.settings, dailyGoal: 20 };
    const inc = mk({});
    inc.settings = { ...inc.settings, dailyGoal: 99 };
    const { state } = mergeState(cur, inc);
    eq('设置不被备份覆盖', state.settings.dailyGoal, 20);
  }

  // —— 预览报告如实反映差异；覆盖警告只在"会掉词"时出现 ——
  // 同样让两边 id 错开：当前 25 个（w101..w125）vs 备份 3 个（w001/w015/w028），
  // 合并后共 28 个，3 个都是新增。
  {
    const curProgress = {};
    for (let i = 1; i <= 25; i += 1) curProgress[`w${100 + i}`] = rec({ seen: 3 });
    const cur = mk(curProgress);
    const inc = mk({ w001: rec({ known: 1 }), w015: rec({ known: 1 }), w028: rec({ known: 0 }) });
    const { text, report } = previewMerge(cur, inc);
    eq('预览统计总词数', Object.keys(mergeState(cur, inc).state.progress).length, 28);
    eq('预览算出新增 3 个', report.added.length, 3);
    check('预览文案含合并后词数', text.includes('28'));
    check('已掌握数量一并给出', text.includes('已掌握'));
    // 这份备份比当前状态"薄"（3 < 25），覆盖会掉词，必须警告
    check('备份更薄时警告覆盖会掉词', text.includes('覆盖式导入'));

    // 反过来：备份比当前厚时不存在掉词风险，不该报警
    const thick = mk({});
    for (let i = 1; i <= 40; i += 1) thick.progress[`w${200 + i}`] = rec({ seen: 1 });
    check('备份更厚时不误报覆盖警告', !previewMerge(mk({ w301: rec() }), thick).text.includes('覆盖式导入'));
  }

  // —— 空备份不得破坏任何东西 ——
  {
    const cur = mk({ w001: rec({ seen: 5, known: 2 }) });
    const { state, report } = mergeState(cur, {});
    eq('空备份不改变词数', Object.keys(state.progress).length, 1);
    eq('空备份不丢进度', state.progress.w001.known, 2);
    eq('空备份没有新增', report.added.length, 0);
  }

  // —— 合并是幂等的：同样的备份合两次，结果不变 ——
  {
    const cur = mk({ w001: rec({ seen: 5, known: 2 }) });
    const inc = mk({ w002: rec({ seen: 4, known: 1, due: 500 }) });
    const once = mergeState(cur, inc).state;
    const twice = mergeState(once, inc).state;
    eq('合并两次与一次词数相同', Object.keys(twice.progress).length, Object.keys(once.progress).length);
    eq('合并两次 seen 不翻倍', twice.progress.w002.seen, 4);
    eq('合并两次 known 不翻倍', twice.progress.w002.known, 1);
  }
}

/* ================================================================== *
 * 7. 存储并发与故障恢复（完全隔离的内存替身）
 * ================================================================== */
{
  const chromeBefore = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let memory = {};
  let writes = 0;
  const lockQueues = new Map();
  const locks = {
    request(name, operation) {
      const task = (lockQueues.get(name) || Promise.resolve()).then(operation);
      lockQueues.set(name, task.catch(() => {}));
      return task;
    },
  };
  const storage = {
    async get(key) {
      return structuredClone(key === null ? memory : { [key]: memory[key] });
    },
    async set(values) {
      writes += 1;
      Object.assign(memory, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key];
    },
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  try {
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: storage } } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
    // query 参数制造第二个独立模块实例，模拟设置页与后台各有自己的 Promise 队列。
    const otherPage = await import('../src/core/store.js?selftest-other-page');
    await replace(defaultState());
    const entered = deferred();
    const release = deferred();
    const first = update(async (state) => {
      entered.resolve();
      await release.promise;
      state.runtime.dayCount += 1;
    });
    await entered.promise;
    const second = otherPage.update((state) => { state.runtime.dayCount += 1; });
    release.resolve();
    await Promise.all([first, second]);
    eq('独立页面并发更新不丢计数', (await read()).runtime.dayCount, 2);
    eq('所有页面使用同一个写锁', lockQueues.size, 1);

    // 覆盖导入必须排在已经开始的旧写入后，否则旧写入会把导入内容覆盖掉。
    for (const useLocks of [true, false]) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: useLocks ? { locks } : {} });
      const label = useLocks ? 'Web Locks' : '本地队列';
      await replace(defaultState());
      const editing = deferred();
      const continueEdit = deferred();
      const oldWrite = update(async (state) => {
        editing.resolve();
        await continueEdit.promise;
        state.progress.old = { seen: 1 };
      });
      await editing.promise;
      const imported = defaultState();
      imported.progress.imported = { seen: 3 };
      const replacing = replace(imported);
      continueEdit.resolve();
      await Promise.all([oldWrite, replacing]);
      eq(`${label}：覆盖导入不会被旧写入覆盖`, (await read()).progress.imported?.seen, 3);
      eq(`${label}：覆盖导入保持用户选择的整体替换语义`, Object.keys((await read()).progress).length, 1);

      const resetting = resetAll();
      const afterReset = update((state) => { state.progress.afterReset = { seen: 2 }; });
      await Promise.all([resetting, afterReset]);
      eq(`${label}：重置之后的新写入得到保留`, (await read()).progress.afterReset?.seen, 2);
      check(`${label}：重置会清除先前的导入词`, !(await read()).progress.imported);

      const beforeFailure = writes;
      const failed = await update(() => { throw new Error('模拟写操作失败'); }).then(() => false, () => true);
      check(`${label}：写入异常透传调用方`, failed);
      eq(`${label}：失败操作不会落盘`, writes, beforeFailure);
      await update((state) => { state.runtime.dayCount = 4; });
      eq(`${label}：失败不阻塞后续写入`, (await read()).runtime.dayCount, 4);
      const beforeSkip = writes;
      await update(() => SKIP_WRITE);
      eq(`${label}：SKIP_WRITE 不产生存储写入`, writes, beforeSkip);
    }

    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
    memory = {};
    await replace(defaultState());
    eq('空学习数据不会误报已保存快照', (await ensureSnapshot()).saved, false);
    await update((state) => { state.progress.a = { seen: 1 }; });
    const snapshots = await Promise.all([ensureSnapshot(), otherPage.ensureSnapshot()]);
    eq('跨页面同时保存只创建一份每日快照', snapshots.filter((result) => result.saved).length, 1);
    await update((state) => { state.progress.a.seen = 2; });
    eq('再次保存不会覆盖当天原始快照', (await ensureSnapshot()).saved, false);
    eq('当天快照保留第一次保存的学习进度', memory[snapshots[0].key].state.progress.a.seen, 1);
    eq('快照操作不回退当前学习进度', memory[STORAGE_KEY].progress.a.seen, 2);
  } finally {
    if (chromeBefore) Object.defineProperty(globalThis, 'chrome', chromeBefore);
    else delete globalThis.chrome;
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
    else delete globalThis.navigator;
  }
}

/* ================================================================== *
 * 汇总
 * ================================================================== */
console.log(`\n通过 ${passed} 项`);
if (failures.length === 0) {
  console.log('核心逻辑自测全部通过 ✅\n');
} else {
  console.log(`失败 ${failures.length} 项：`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  console.log('');
  process.exitCode = 1;
}
