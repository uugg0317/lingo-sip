/**
 * 闸门判断：决定"这一秒能不能弹卡片"
 *
 * 整个扩展的"低打扰"就靠这一个文件。判断分两层：
 *   第一层（时机）由 background 的触发器决定——什么时候"可能"弹出；
 *   第二层（闸门）在这里——即使时机到了，也必须所有闸门都放行。
 * 未放行时返回中文原因，设置页会把它显示出来，方便用户理解"为什么没弹"。
 */

import { MIN } from './constants.js';

/** 把 `*.example.com` 这类通配符转成正则。 */
export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义正则特殊字符（* 和 ? 稍后处理）
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * 免打扰名单匹配：既支持域名（例 `mail.google.com`、`*.bank.com`），
 * 也支持整条 URL 通配（例 `*://*.example.com/inbox*`）。
 */
export function isBlacklisted(settings, url = '', hostname = '') {
  const list = Array.isArray(settings.blacklist) ? settings.blacklist : [];
  for (const raw of list) {
    const pattern = String(raw).trim();
    if (!pattern) continue;
    try {
      const re = globToRegExp(pattern);
      if (re.test(hostname) || re.test(url)) return pattern;
    } catch {
      /* 用户写错的正则直接跳过，不影响其他规则 */
    }
  }
  return '';
}

/** 是否处于安静时段（支持跨天，例如 22:00 - 08:00）。 */
export function inQuietHours(settings, now = Date.now()) {
  const q = settings.quietHours;
  if (!q || !q.enabled) return false;
  const hour = new Date(now).getHours();
  const start = Number(q.start) || 0;
  const end = Number(q.end) || 0;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * 主判断。
 * @param {object} state 完整状态
 * @param {object} ctx   { now, url, hostname, tabId, manual, isNew }
 * @returns {{ allowed: boolean, reason: string, waitMs: number }}
 */
export function evaluate(state, ctx = {}) {
  const now = ctx.now || Date.now();
  const s = state.settings;
  const r = state.runtime;
  const deny = (reason, waitMs = 0) => ({ allowed: false, reason, waitMs });

  // —— 手动触发：自动提醒开关不阻止用户主动学习；页面限制仍由内容脚本检查。
  if (!ctx.manual) {
    if (!s.enabled) return deny('已关闭自动提醒');

    if (r.pausedUntil > now) {
      return deny(`暂停中，还有 ${Math.ceil((r.pausedUntil - now) / MIN)} 分钟`, r.pausedUntil - now);
    }

    if (inQuietHours(s, now)) {
      return deny(`安静时段 ${pad(s.quietHours.start)}:00 - ${pad(s.quietHours.end)}:00`);
    }

    const blockedSite = isBlacklisted(s, ctx.url, ctx.hostname);
    if (blockedSite) return deny(`免打扰站点：${blockedSite}`);

    if (r.dayCount >= s.dailyCap) return deny(`今日已达上限（${s.dailyCap} 张）`);

    if (r.hourCount >= s.hourlyCap) {
      return deny(`本小时已达上限（${s.hourlyCap} 张）`);
    }

    const sinceLast = now - (r.lastShownAt || 0);
    const cooldown = s.cooldownMinutes * MIN;
    if (sinceLast < cooldown) {
      const wait = cooldown - sinceLast;
      return deny(`冷却中，${Math.ceil(wait / 1000)} 秒后可出现`, wait);
    }

    // 同一个标签页不要反复出现
    if (ctx.tabId != null) {
      const lastInTab = r.tabShown?.[String(ctx.tabId)] || 0;
      const tabCooldown = s.tabCooldownMinutes * MIN;
      if (now - lastInTab < tabCooldown) {
        return deny('这个标签页刚刚出现过卡片', tabCooldown - (now - lastInTab));
      }
    }
  }

  // —— 新词额度：不影响复习，只挡住"引入新词"
  const newQuotaLeft = Math.max(0, (s.maxNewPerDay || 0) - r.newCount);
  if (ctx.isNew && newQuotaLeft <= 0) {
    return deny(`今天的新词额度已用完（${s.maxNewPerDay} 个）`);
  }

  return { allowed: true, reason: '', waitMs: 0 };
}

function pad(n) {
  return `${Number(n) || 0}`.padStart(2, '0');
}

/** 给设置页用的一句人类可读的当前状态。 */
export function describeState(state, now = Date.now()) {
  const s = state.settings;
  const r = state.runtime;
  if (!s.enabled) return '自动提醒已关闭';
  if (r.pausedUntil > now) return `暂停中 · ${new Date(r.pausedUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 恢复`;
  if (inQuietHours(s, now)) return '安静时段';
  return '学习中';
}
