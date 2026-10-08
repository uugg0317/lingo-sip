/** 轻量引导使用的本地词库场景与提醒预设，不覆盖进度或自定义词。 */
export const SCENES = {
  all: { label: '全部场景', tags: [] },
  daily: { label: '日常表达', tags: ['core', 'daily', 'spoken'] },
  office: { label: '办公沟通', tags: ['office', 'meeting', 'email'] },
  tech: { label: '技术英语', tags: ['tech', 'office'] },
  academic: { label: '学术阅读', tags: ['academic', 'core'] },
};

export const RHYTHMS = {
  light: { label: '轻提醒', note: '间隔至少 15 分钟，每小时最多 2 张', patch: { enabled: true, cooldownMinutes: 15, hourlyCap: 2, dailyCap: 12, triggerTabSwitch: true, triggerPageLoad: false, triggerIdle: true, triggerTimer: false, triggerReturn: false } },
  standard: { label: '标准节奏', note: '间隔至少 4 分钟，每小时最多 5 张', patch: { enabled: true, cooldownMinutes: 4, hourlyCap: 5, dailyCap: 30, triggerTabSwitch: true, triggerPageLoad: true, triggerIdle: true, triggerTimer: true, timerMinutes: 45, triggerReturn: false } },
  manual: { label: '主动学习', note: '仅在你打开学习页面时练习', patch: { enabled: false } },
};

export function preferencePatch({ scene = 'all', rhythm = 'light', dailyGoal = 10, goalMetric = 'answered', notifyEnabled = false } = {}) {
  const selectedScene = SCENES[scene];
  const selectedRhythm = RHYTHMS[rhythm];
  if (!selectedScene || !selectedRhythm) throw new Error('请选择有效的学习场景与节奏。');
  return {
    ...selectedRhythm.patch,
    bankTags: [...selectedScene.tags],
    dailyGoal: Math.max(1, Math.min(200, Math.round(Number(dailyGoal) || 10))),
    goalMetric: goalMetric === 'shown' ? 'shown' : 'answered',
    notifyEnabled: !!notifyEnabled && rhythm !== 'manual',
    notifySound: false,
    autoSpeak: false,
    onboardingDone: true,
  };
}
