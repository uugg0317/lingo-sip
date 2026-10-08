/**
 * 桌面系统通知
 *
 * 这是整个扩展唯一能"离开浏览器"的通道。
 * chrome.notifications 调的是操作系统自己的通知中心：Windows 上就是右下角
 * 滑出来的那种提示，盖在任何软件上面都能看到，桌面状态下也在。
 * 卡片浮层做不到这一点——内容脚本只能画在网页里。
 *
 * 通知 ID 里编码了单词 id（`lingo-<wordId>`），这样用户点按钮时不用查表
 * 就知道他在回应哪个词；点通知本体则打开连学窗。
 */

const ID_PREFIX = 'lingo-';
/** 测试通知用另一个前缀：它不参与记账，不会被写进学习进度。 */
const TEST_PREFIX = 'lingo-test-';

/** 由单词 id 生成通知 id。 */
export function noticeId(wordId, isTest = false) {
  return isTest ? `${TEST_PREFIX}${wordId}` : `${ID_PREFIX}${wordId}`;
}

/** 从通知 id 反解出单词 id（测试通知与非本扩展的通知返回空串）。 */
export function wordIdFromNotice(notificationId) {
  const id = String(notificationId || '');
  if (id.startsWith(TEST_PREFIX)) return ''; // 测试通知不记账
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : '';
}

const MODE_TITLE = { new: '新词', review: '复习', recycle: '保温', early: '提前练习' };

/**
 * 弹一条单词通知。
 *
 * @param {object} word  词条
 * @param {'new'|'review'|'recycle'} mode
 * @param {{test?: boolean}} options test=true 时用测试前缀，点按钮不会改动学习进度
 * @returns {Promise<boolean>} 是否成功交给系统
 */
export async function showWordNotice(word, mode, options = {}) {
  if (typeof chrome === 'undefined' || !chrome.notifications) return false;

  const id = noticeId(word.id, !!options.test);

  // 先清掉本扩展之前发出的所有通知。
  // 因为 requireInteraction 确实生效（已在 Edge 153 / Windows 上实测：通知会一直
  // 停在右下角不消失），只清理"同一个单词"的旧通知是不够的——每 30 分钟来一个
  // 新词就会在屏幕上堆一条，几小时下来糊成一片。
  // getAll() 只返回本扩展自己的通知，不会碰到系统里别人的。
  // 被清掉的那些会走 onClosed，按"只看过没作答"处理，语义正确。
  await clearAllNotices();

  // 英文单词当大标题：title 在系统通知里字号最大、最醒目；
  // 中文释义放正文（message）；模式与例句收在最下面的小字行（contextMessage）。
  const head = [word.term, word.phonetic].filter(Boolean).join('  ');
  const sub = [MODE_TITLE[mode] || '学习', truncate(word.example, 60)]
    .filter(Boolean)
    .join(' · ');
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
      title: options.test ? `${head}（测试）` : head,
      message: String(word.meaning || ''),
      contextMessage: sub, // 小字：模式 + 一行例句，过长会被系统截断
      buttons: [{ title: '记得了' }, { title: '稍后复习' }],
      // 提示音开关：settings.notifySound 为 false 时传 silent，系统就不会出声。
      // 调用方没传 sound 时按"有声音"处理，保持原行为。
      silent: options.sound === false,
      // 实测确认：Windows 上会一直停留，直到你点按钮或手动划掉。
      // 这正是我们要的——放在那儿等你忙完再看，不会几秒就溜走。
      requireInteraction: true,
      priority: 1,
    });
    return true;
  } catch {
    // 系统通知被策略禁用、图标路径错误等，静默失败即可，不影响其他功能
    return false;
  }
}

/** 截断长文本（系统通知的小字行长度有限）。 */
function truncate(text, n) {
  const s = String(text || '').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 清掉一条通知。 */
export async function clearNotice(id) {
  try {
    await chrome.notifications.clear(id);
  } catch {
    /* 本来就不存在，忽略 */
  }
}

/** 清掉本扩展发出的全部通知（关闭桌面提醒时用）。 */
export async function clearAllNotices() {
  try {
    const all = await chrome.notifications.getAll();
    await Promise.all(Object.keys(all || {}).map((id) => clearNotice(id)));
  } catch {
    /* 忽略 */
  }
}
