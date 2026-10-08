/**
 * 全局常量 / 默认配置 / 消息协议
 *
 * 设计原则：所有"可调参数"只在这里定义一次，其余模块一律引用，
 * 避免出现散落各处的魔法数字。用户改过的值保存在 storage 里，
 * 这里只是出厂默认值（升级时新增的字段会自动补上默认值）。
 */

/** chrome.storage.local 中的根键。所有数据都存在这一个键下，方便整体备份 / 恢复。 */
export const STORAGE_KEY = 'lingoSip';

/** 数据结构版本号，将来做迁移时使用。 */
export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 时间单位
 * ------------------------------------------------------------------ */
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ *
 * 间隔重复（SRS）参数
 *
 * 采用"莱特纳盒子 + 间隔表"的极简模型：一个词只会待在 0~6 号盒子里，
 * 记住一次进一格，点"稍后复习"退一格并推迟出现。规则简单到用户
 * 不需要理解算法本身，也不会有"复习雪崩"。
 * ------------------------------------------------------------------ */

/** 每个盒子对应的间隔（分钟），索引即盒子编号。 */
export const BOX_INTERVALS = [
  10, // 0 刚认识，10 分钟后再见
  45, // 1
  12 * 60, // 2 半天
  24 * 60, // 3 一天
  3 * 24 * 60, // 4 三天
  7 * 24 * 60, // 5 一周
  21 * 24 * 60, // 6 三周
];

/** 盒子达到该值即视为"已掌握"，不再进入自动队列（仍可被保温复习）。 */
export const BOX_MASTERED = 5;

/** 点"稍后复习"时，按当前盒子推迟多久再出现（分钟）。 */
export const SNOOZE_INTERVALS = [
  10, // 0
  30, // 1
  3 * 60, // 2
  12 * 60, // 3
  24 * 60, // 4
  3 * 24 * 60, // 5
  7 * 24 * 60, // 6
];

/** 卡片自动淡出（用户没作答）时，多久后重新排队（分钟）。不视为遗忘。 */
export const SEEN_DELAY = 20;

/** 每日统计保留天数，超出自动清理。 */
export const STATS_KEEP_DAYS = 90;

/** 事件日志保留条数（设置页的"最近发生了什么"面板）。 */
export const LOG_KEEP = 60;

/** 自动备份快照保留份数（一天一份，超出删最旧的）。 */
export const SNAPSHOT_KEEP = 7;

/**
 * 开发监听端口，必须与 tools/watch.mjs 的默认端口一致。
 * 只在 settings.devReload 打开时才会用到（见 service-worker.js 的开发重载）。
 */
export const DEV_RELOAD_PORT = 3199;

/** 开发重载的轮询间隔；2 秒足够跟手，又不至于把 service worker 吵醒太频繁。 */
export const DEV_POLL_MS = 2000;

/** 卡片可选停留时长（秒）。 */
export const CARD_SECONDS = [10, 15, 20, 25, 30, 45];

/** 暂停选项（分钟）。 */
export const PAUSE_OPTIONS = [
  { label: '15 分钟', minutes: 15 },
  { label: '1 小时', minutes: 60 },
  { label: '4 小时', minutes: 4 * 60 },
  { label: '今天', minutes: 12 * 60 },
];

/* ------------------------------------------------------------------ *
 * 消息协议（content / popup / options  <->  service worker）
 * ------------------------------------------------------------------ */
export const MESSAGES = {
  /** 页面或弹窗请求来一张卡：{ trigger, manual } */
  REQUEST_CARD: 'card:request',
  /** 后台下发卡片：{ word, meta } */
  SHOW_CARD: 'card:show',
  /** 页面确认已展示：{ wordId, mode } */
  CARD_SHOWN: 'card:shown',
  /** 用户作答：{ wordId, action: 'known' | 'snooze', elapsedMs } */
  CARD_ACTION: 'card:action',
  /** 卡片消失：{ wordId, reason: 'timeout' | 'close' | 'replaced' } */
  CARD_DISMISSED: 'card:dismissed',
  /** 暂停 / 恢复 */
  PAUSE: 'app:pause',
  RESUME: 'app:resume',
  /** 读取完整状态（popup / options 用） */
  GET_STATE: 'app:get-state',
  /** 局部更新设置：{ patch } */
  SET_SETTINGS: 'app:set-settings',
  /** 词库变更后通知后台刷新（队列与角标） */
  BANK_CHANGED: 'app:bank-changed',
  /** 朗读：{ text } */
  SPEAK: 'tts:speak',
  STOP_SPEAK: 'tts:stop',
  LIST_VOICES: 'tts:voices',
  /** 设置页的"发一条测试通知" */
  NOTIFY_TEST: 'notice:test',
  /** 后台广播状态变化，popup/options 刷新界面 */
  STATE_CHANGED: 'app:state-changed',
};

/* ------------------------------------------------------------------ *
 * 出厂默认设置
 * ------------------------------------------------------------------ */
export const DEFAULT_SETTINGS = {
  /* —— 总开关与节奏 —— */
  enabled: true, // 总开关
  dailyGoal: 20, // 每日目标卡片数
  goalMetric: 'shown', // 兼容已有目标；首次引导可选择主动完成 answered
  cardSeconds: 25, // 单张卡停留秒数（10~30 秒内可完成）
  quizMode: false, // 回忆模式：先只给单词，想好了再看释义
  autoSpeak: false, // 出现即自动发音（默认关闭：避免开会/共享屏幕时突然出声）
  speechRate: 0.95, // 语速 0.5~1.5
  voiceLang: 'en-US', // 发音语言
  voiceName: '', // 空值使用系统默认本机声音
  onboardingDone: true, // 旧用户不被强制重新引导；首次安装后台设为 false

  /* —— 可介入时机（第一类：什么时候允许出现）—— */
  triggerTabSwitch: true, // 切换标签后
  triggerPageLoad: true, // 页面加载完成后
  triggerIdle: true, // 页面内长时间无操作（发呆/阅读停顿）
  idleSeconds: 30, // "停顿"的判定阈值（秒）
  triggerTimer: true, // 定时兜底（长时间没有自然时机时）
  timerMinutes: 45, // 兜底间隔（分钟）
  triggerReturn: false, // 离开电脑后回来时（默认关闭，最谨慎）

  /* —— 频率闸门（第二类：多久最多打扰一次）—— */
  cooldownMinutes: 4, // 全局冷却：两次卡片之间的最小间隔
  hourlyCap: 5, // 每小时上限
  dailyCap: 30, // 每天上限
  tabCooldownMinutes: 5, // 同一个标签页的最小重复间隔
  quietHours: { enabled: false, start: 22, end: 8 }, // 安静时段（跨天自动处理）

  /* —— 词库与展示 —— */
  bankTags: [], // 启用的内置分类，空数组 = 全部启用
  recycleMastered: true, // 已掌握的词偶尔回来"保温"
  maxNewPerDay: 20, // 每天最多引入多少新词

  /* —— 桌面提醒（系统通知）—— */
  notifyEnabled: true, // 浏览器不在前台时，用系统通知把单词送到桌面
  notifyMinutes: 30, // 两条桌面通知之间的最小间隔（分钟）
  notifySound: true, // 通知到达时是否发出系统提示音（关掉 = 完全静音）

  /* —— 开发 —— */
  // 开发时自动重载：打开后扩展会轮询本机的 tools/watch.mjs，代码一变就自己刷新。
  // 默认关闭；打包时会从 manifest 里剥掉，不影响正式包。
  devReload: false,

  /* —— 其他 —— */
  showBadge: 'due', // 角标显示：'due' 待学数 | 'today' 今日已学 | 'off'
  blacklist: [], // 不打扰的站点（域名或 URL 通配符，每行一条）
  pausedUntil: 0, // 暂停到这个时间戳（0 = 未暂停）
};

/** 角标可选项，供设置页渲染。 */
export const BADGE_MODES = [
  { value: 'due', label: '待学数量' },
  { value: 'today', label: '今日已学' },
  { value: 'off', label: '不显示' },
];

/** 内置词库分类的展示名。 */
export const TAG_LABELS = {
  core: '核心高频',
  office: '办公通用',
  meeting: '会议沟通',
  email: '邮件往来',
  tech: '技术协作',
  travel: '出行差旅',
  daily: '日常生活',
  academic: '学术书面',
  spoken: '口语表达',
};
