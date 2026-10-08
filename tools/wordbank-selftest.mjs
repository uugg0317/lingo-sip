/** 词条身份与导入回归：隔离构造数据，不读写浏览器学习数据。 */
import assert from 'node:assert/strict';
import { defaultState } from '../src/core/store.js';
import { emptyRecord, grade } from '../src/core/srs.js';
import {
  BUILTIN, pool, makeId, normalizeWord, parseImport, toCSV, toJSON,
  previewWordImport, applyWordImport, normalizeWordProgress, canonicalWordId,
} from '../src/core/wordbank.js';

let count = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  count += 1;
}
const now = 1_800_000_000_000;
const builtin = BUILTIN.find((word) => word.term === 'work');
const learned = { ...emptyRecord(now), seen: 9, known: 5, reps: 5, box: 5, status: 'mastered', due: now + 5000, lastSeen: now - 1000 };

// 覆盖内置释义沿用发布身份；未提供的音标、类型、例句不被清空。
{
  const state = defaultState();
  state.progress[builtin.id] = learned;
  const input = parseImport('work,工作；作品').words;
  const preview = previewWordImport(state, input);
  check('内置同名导入归为更新', preview.summary.updated, 1);
  check('内置同名沿用已有 ID', preview.words[0].id, builtin.id);
  check('仅改释义保留音标', preview.words[0].phonetic, builtin.phonetic);
  check('仅改释义保留例句', preview.words[0].example, builtin.example);
  const applied = applyWordImport(state, input).state;
  check('学习池覆盖释义', pool(applied).find((word) => word.id === builtin.id).meaning, '工作；作品');
  check('原内置进度不变', applied.progress[builtin.id], learned);
  check('原状态不被纯函数修改', state.customWords.length, 0);
  check('反复导入仍只有一个 custom', applyWordImport(applied, input).state.customWords.length, 1);
  check('相同内容列为未变', previewWordImport(applied, input).summary.unchanged, 1);
}

// 旧版覆盖已持久化为 c_work_*：保留旧词条 ID、旧进度，并关联主记录。
{
  const alias = makeId('work');
  const state = defaultState();
  state.customWords = [normalizeWord({ term: 'work', meaning: '旧的自定义释义' })];
  state.progress[builtin.id] = { ...learned, due: now + 9000, seen: 4, reps: 3, known: 3 };
  state.progress[alias] = { ...emptyRecord(now), seen: 7, known: 2, snooze: 3, reps: 2, box: 2, status: 'learning', due: now + 1000, lastSeen: now };
  const normalized = { ...state, progress: normalizeWordProgress(state) };
  check('兼容关联保留原 custom ID', normalized.customWords[0].id, alias);
  check('兼容关联学习池仍用内置 ID', pool(normalized).find((word) => word.term === 'work').id, builtin.id);
  check('同词两个进度不降低掌握状态', normalized.progress[builtin.id].status, 'mastered');
  check('同词两个进度不降低盒子', normalized.progress[builtin.id].box, 5);
  check('同词两个进度 seen 取较大值', normalized.progress[builtin.id].seen, 7);
  check('同词两个进度已记得次数不回退', normalized.progress[builtin.id].known, 3);
  check('同词两个进度 snooze 不回退', normalized.progress[builtin.id].snooze, 3);
  check('同词两个进度保留较早到期', normalized.progress[builtin.id].due, now + 1000);
  check('原别名记录保留', normalized.progress[alias], state.progress[alias]);
  check('兼容函数不改原主记录', state.progress[builtin.id].seen, 4);
  check('runtime 可以关联旧别名', canonicalWordId(normalized, alias), builtin.id);
  normalized.progress[builtin.id] = grade(normalized.progress[builtin.id], 'snooze', now + 500);
  const graded = { ...normalized.progress[builtin.id] };
  check('重复读取不被旧别名回滚作答', normalizeWordProgress(normalized)[builtin.id], graded);
  const backupRoundtrip = JSON.parse(JSON.stringify(normalized));
  check('备份序列化后兼容标记仍生效', normalizeWordProgress(backupRoundtrip)[builtin.id], graded);
  backupRoundtrip.progress[alias] = { ...backupRoundtrip.progress[alias], seen: 15, lastSeen: now + 10000 };
  check('备份带来别名新记录继续合并', normalizeWordProgress(backupRoundtrip)[builtin.id].seen, 15);
  const updated = applyWordImport(normalized, [{ id: 'explicit_other_work', term: 'work', meaning: '新版释义' }]).state;
  check('已有 custom 同名不同 incoming ID 保留原 ID', updated.customWords[0].id, alias);
  check('已有 custom 同名更新不会增加条数', updated.customWords.length, 1);
  check('更新释义后保留已作答记录', updated.progress[builtin.id].box, graded.box);
}

// 无内置身份时保留最早的已有 custom id，最新条目只负责内容。
{
  const state = defaultState();
  state.customWords = [
    normalizeWord({ id: 'old-custom-a', term: 'ultramarine', meaning: '群青' }),
    normalizeWord({ id: 'old-custom-b', term: 'Ultramarine', meaning: '深蓝色' }),
  ];
  state.progress['old-custom-a'] = learned;
  state.progress['old-custom-b'] = { ...emptyRecord(now), seen: 3, due: now + 100, status: 'learning', box: 1 };
  const next = applyWordImport(state, [{ id: 'new-custom-id', term: 'ULTRAMARINE', meaning: '群青色' }]).state;
  const item = pool(next).find((word) => word.term.toLowerCase() === 'ultramarine');
  check('纯 custom 使用最早持久化 ID', item.id, 'old-custom-a');
  check('旧的第二条 custom ID 仍不改', next.customWords[1].id, 'old-custom-b');
  check('同词学习池去重', pool(next).filter((word) => word.term.toLowerCase() === 'ultramarine').length, 1);
  check('纯 custom 更新内容生效', item.meaning, '群青色');
  check('纯 custom 合并状态不回退', next.progress['old-custom-a'].status, 'mastered');
  check('纯 custom 保留更早到期', next.progress['old-custom-a'].due, now + 100);
  check('custom 别名备份往返不损失', normalizeWordProgress(JSON.parse(JSON.stringify(next))), next.progress);
}

// ID 冲突必须拒绝；混合文件仍可明确应用合法部分。
{
  const state = defaultState();
  const preview = previewWordImport(state, [
    { id: builtin.id, term: 'something else', meaning: '别的词' },
    { id: 'brand-new', term: 'ultramarine', meaning: '群青' },
    { id: 'duplicate-id', term: 'alpha custom', meaning: '一' },
    { id: 'duplicate-id', term: 'beta custom', meaning: '二' },
  ]);
  check('同 ID 不同 term 和文件内碰撞列冲突', preview.summary.conflicts, 3);
  check('合法条目单独列新增', preview.summary.added, 1);
  check('应用拒绝冲突条目', applyWordImport(state, preview.words).state.customWords.map((word) => word.id), ['brand-new']);
  check('词条缺字段列冲突', previewWordImport(state, [{ term: 'blank' }]).summary.conflicts, 1);
  check('不可用 ID 列冲突', previewWordImport(state, [{ id: '__proto__', term: 'unsafe', meaning: '测试' }]).summary.conflicts, 1);
  check('导入不能抢占另一个词的兼容 ID', previewWordImport(state, [
    { id: 'new-id', term: 'ultramarine', meaning: '群青', aliases: [builtin.id] },
  ]).summary.conflicts, 1);
  check('导入不能抢占旧版自动生成别名', previewWordImport(state, [
    { id: makeId('work'), term: 'unrelated custom', meaning: '不同词' },
  ]).summary.conflicts, 1);
  check('同一个新词重复输入仍归新增', previewWordImport(state, [
    { term: 'ultramarine', meaning: '群青' }, { term: 'ULTRAMARINE', meaning: '群青色' },
  ]).summary.added, 1);
  const applied = applyWordImport(state, [{ id: 'brand-new', term: 'ultramarine', meaning: '群青', example: 'Blue sky.' }]).state;
  check('明示清空例句可以生效', applyWordImport(applied, [{ term: 'ultramarine', meaning: '群青色', example: '' }]).state.customWords[0].example, '');
}

// 有声短语最简导入保留类型；CSV/JSON 往返仍有稳定 ID。
{
  const phrase = BUILTIN.find((word) => word.type === 'phrase');
  const next = applyWordImport(defaultState(), parseImport(`${phrase.term},我的短语释义`).words).state;
  check('只改短语释义不变成 word', next.customWords[0].type, 'phrase');
  check('CSV 往返保持沿用的 ID', parseImport(toCSV(next.customWords)).words[0].id, phrase.id);
  check('JSON 往返保持沿用的 ID', parseImport(toJSON(next.customWords)).words[0].id, phrase.id);
  const state = defaultState();
  state.progress[makeId('work')] = learned;
  check('custom 词条删除后仍能关联旧默认别名', normalizeWordProgress(state)[builtin.id].seen, learned.seen);
  check('未知 progress key 不被删除', normalizeWordProgress({ ...state, progress: { ...state.progress, orphan: learned } }).orphan, learned);
}

console.log(`词条身份与导入回归通过：${count} 项断言。`);
