import { getNowTaipei, getPrevMonthKey } from '../lib/date.js';
import { getOfficialFinalSnapshot } from '../lib/storage.js';
import { createLogger } from '../lib/logger.js';
import { runBackfill, waitForOfficialFinal } from './backfill.js';
import { runReport } from './report.js';

const log = createLogger({ action: 'monthly-close' });

function resolveTargetMonth(month) {
  if (month === 'prev' || !month) {
    return getPrevMonthKey(getNowTaipei());
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('無效的 --month 參數，格式應為 "prev" 或 "YYYY-MM"');
  }
  return month;
}

export async function runMonthlyClose({ month = 'prev', dryRun = process.env.DRY_RUN === 'true' } = {}) {
  const targetMonthKey = resolveTargetMonth(month);
  let snapshot = await getOfficialFinalSnapshot(targetMonthKey);

  if (!snapshot) {
    const backfillResult = await runBackfill({
      month: targetMonthKey,
      dryRun,
      rebuild: false,
    });

    if (dryRun) {
      const previewRows = backfillResult.rows || [];
      const previewSnapshot = previewRows.at(-1);
      if (!previewSnapshot) {
        throw new Error(`${targetMonthKey} dry-run backfill 未產生任何預覽資料，請確認 dry-run backfill 可重跑`);
      }
      log.info({ targetMonthKey }, '使用 dry-run backfill 預覽資料產生月報');
      return runReport({ month: targetMonthKey, dryRun, snapshotOverride: previewSnapshot });
    }

    if (backfillResult.status === 'already_running') {
      snapshot = await waitForOfficialFinal(targetMonthKey);
    } else {
      snapshot = backfillResult.snapshot || await getOfficialFinalSnapshot(targetMonthKey);
    }

    if (!snapshot) {
      throw new Error(`${targetMonthKey} 無法建立 official final，月報中止`);
    }
  }

  return runReport({ month: targetMonthKey, dryRun, snapshotOverride: snapshot });
}
