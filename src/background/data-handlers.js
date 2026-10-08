/** 设置页的数据维护与快照消息；预览/确认仍由设置页控制。 */
import {
  update, logEvent, resetProgress, resetAll, replace,
  ensureSnapshot, listSnapshots, readSnapshot,
} from '../core/store.js';
import { mergeState } from '../core/backup.js';

/** 返回 null 表示该消息不属于数据维护，交回后台的其它路由。 */
export function createDataHandlers({ refreshBadge, broadcastState, ensureAlarm }) {
  async function changed() {
    await refreshBadge();
    broadcastState();
  }

  return async function handleDataMessage(msg) {
    switch (msg?.type) {
      case 'data:reset-progress': {
        await resetProgress();
        await changed();
        return { ok: true };
      }
      case 'data:reset-all': {
        await resetAll();
        await ensureAlarm();
        await changed();
        return { ok: true };
      }
      case 'data:import-backup': {
        await replace(msg.state);
        await changed();
        return { ok: true };
      }
      case 'data:merge-backup': {
        if (!msg.state || typeof msg.state !== 'object') return { ok: false, error: '备份内容为空' };
        const merged = await update((state) => {
          const result = mergeState(state, msg.state);
          state.progress = result.state.progress;
          state.customWords = result.state.customWords;
          state.stats = result.state.stats;
          logEvent(state, `合并备份：新增 ${result.report.added.length}、更新 ${result.report.updated.length}、保持 ${result.report.kept.length}`);
          return result.report;
        });
        await changed();
        return { ok: true, report: merged };
      }
      case 'snapshot:list':
        return { ok: true, list: await listSnapshots() };
      case 'snapshot:save':
        return { ok: true, ...await ensureSnapshot() };
      case 'snapshot:restore': {
        const snap = await readSnapshot(msg.key);
        if (!snap) return { ok: false, error: '这份快照不存在' };
        // 恢复前给当前状态留快照；与原路由一致，快照保存失败不阻断恢复。
        await ensureSnapshot().catch(() => {});
        await replace(snap);
        await changed();
        return { ok: true };
      }
      case 'data:refresh': {
        await changed();
        return { ok: true };
      }
      default:
        return null;
    }
  };
}
