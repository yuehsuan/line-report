import { compareMonthKey, getMonthKey, getNowTaipei, getPrevMonthKey } from '../lib/date.js';
import { createLogger } from '../lib/logger.js';
import { runBackfill, waitForOfficialFinal } from './backfill.js';
import { runPublishReport } from './report.js';
import { classifyMonthState, getMonthState, getOfficialFinalSnapshot } from '../lib/storage.js';

const log = createLogger({ action: 'monthly-close' });

const CUTOVER_ENV = 'PATCH_A_CUTOVER_MONTH';

function getCutoverMonth() {
  const value = process.env[CUTOVER_ENV];
  if (!/^\d{4}-\d{2}$/.test(value || '')) {
    throw new Error(`${CUTOVER_ENV} 未設定或格式錯誤`);
  }
  return value;
}

function resolveTargetMonth(month) {
  if (month === 'prev' || !month) {
    return getPrevMonthKey(getNowTaipei());
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('無效的 --month 參數，格式應為 "prev" 或 "YYYY-MM"');
  }
  return month;
}

function assertScheduledPreconditions(targetMonthKey) {
  if (process.env.MONTHLY_CLOSE_SCHEDULED !== 'true') {
    throw new Error('monthly-close-scheduled 需要 MONTHLY_CLOSE_SCHEDULED=true');
  }
  if (targetMonthKey !== getPrevMonthKey(getNowTaipei())) {
    throw new Error('monthly-close-scheduled 只能處理 prev month');
  }
}

function assertManualPreconditions(targetMonthKey, confirmMonth) {
  if (confirmMonth !== targetMonthKey) {
    throw new Error('monthly-close 需要 --confirm-month=YYYY-MM 且需等於 --month');
  }
  if (compareMonthKey(targetMonthKey, getMonthKey(getNowTaipei())) >= 0) {
    throw new Error('monthly-close 只允許處理 closed month');
  }
}

export async function runMonthlyClose({
  mode = 'scheduled',
  month = 'prev',
  confirmMonth,
  dryRun = process.env.DRY_RUN === 'true',
} = {}) {
  const targetMonthKey = resolveTargetMonth(month);
  const cutoverMonth = getCutoverMonth();

  if (mode === 'scheduled') {
    assertScheduledPreconditions(targetMonthKey);
  } else if (mode === 'manual') {
    assertManualPreconditions(targetMonthKey, confirmMonth);
  } else {
    throw new Error(`未知的 monthly close mode: ${mode}`);
  }

  if (compareMonthKey(targetMonthKey, cutoverMonth) < 0) {
    if (mode === 'scheduled') {
      log.info({ targetMonthKey, cutoverMonth }, 'legacy month out of scope，scheduled monthly close 略過');
      return { status: 'skipped', outcome: 'legacy_month_out_of_scope', targetMonthKey };
    }
    throw new Error(`${targetMonthKey} 屬於 pre-cutover legacy month，請改走 legacy runbook`);
  }

  let snapshot = await getOfficialFinalSnapshot(targetMonthKey);
  if (!snapshot) {
    const backfillResult = await runBackfill({
      month: targetMonthKey,
      dryRun,
      rebuild: false,
    });

    if (dryRun) {
      const previewSnapshot = backfillResult.rows?.at(-1);
      if (!previewSnapshot) {
        throw new Error(`${targetMonthKey} dry-run backfill 未產生任何預覽資料`);
      }
      return runPublishReport({
        month: targetMonthKey,
        dryRun,
        snapshotOverride: previewSnapshot,
        scheduled: mode === 'scheduled',
        confirmMonth,
      });
    }

    if (backfillResult.status === 'already_running') {
      snapshot = await waitForOfficialFinal(targetMonthKey);
    } else {
      snapshot = backfillResult.snapshot || await getOfficialFinalSnapshot(targetMonthKey);
    }
  }

  if (!snapshot) {
    throw new Error(`${targetMonthKey} 無法建立 official final，月結中止`);
  }

  const monthState = await getMonthState(targetMonthKey);
  const state = classifyMonthState(monthState);

  if (state === 'invalid_month_state') {
    throw new Error(`${targetMonthKey} month-state 非法，monthly close 中止`);
  }
  if (state === 'already_converged') {
    log.info({ targetMonthKey }, '每月回報已成功送出，略過（idempotent）');
    return { status: 'success', outcome: 'already_converged', targetMonthKey, snapshot };
  }
  if (state === 'out_of_sync') {
    throw new Error(`${targetMonthKey} 為 out_of_sync，需顯式 publish-report --republish=true`);
  }

  return runPublishReport({
    month: targetMonthKey,
    dryRun,
    snapshotOverride: snapshot,
    scheduled: mode === 'scheduled',
    confirmMonth,
  });
}
