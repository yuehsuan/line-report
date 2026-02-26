import { getNowTaipei, getMonthKey, getPrevMonthKey, getDateKey, toUtcIso } from '../lib/date.js';
import { getConsumption } from '../lib/lineApi.js';
import { writeSnapshot, querySnapshots, markPrevMonthFinal, getJobRun, upsertJobRun } from '../lib/storage.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ action: 'snapshot' });

export async function runSnapshot() {
  const now = getNowTaipei();
  const monthKey = getMonthKey(now);
  const dateKey = getDateKey(now);
  const ts = toUtcIso(now);
  const jobId = `snapshot#${dateKey}`;

  log.info({ monthKey, dateKey, ts }, '開始執行快照');

  // 幂等：若今日已成功執行則略過
  const existingRun = await getJobRun(jobId);
  if (existingRun?.status === 'success') {
    log.info({ jobId }, '今日快照已成功完成，略過（idempotent）');
    return;
  }

  const attempts = (existingRun?.attempts || 0) + 1;
  await upsertJobRun(jobId, { status: 'running', attempts, startedAt: ts });

  try {
    // 偵測跨月：取上月最後一筆快照的 monthKey
    await detectAndSealPrevMonth(monthKey, now);

    // 呼叫 LINE API 取得用量
    const consumptionData = await getConsumption();
    const { totalUsage } = consumptionData;
    log.info({ totalUsage }, '取得 LINE consumption（近似值）');

    // 寫入快照
    await writeSnapshot({
      monthKey,
      ts,
      totalUsage,
      rawJson: JSON.stringify(consumptionData),
    });

    await upsertJobRun(jobId, {
      status: 'success',
      attempts,
      startedAt: ts,
      finishedAt: new Date().toISOString(),
      totalUsage,
    });

    log.info({ jobId, monthKey, totalUsage }, '快照執行完成');
  } catch (err) {
    const errMsg = err.message || String(err);
    log.error({ jobId, error: errMsg, stack: err.stack }, '快照執行失敗');
    await upsertJobRun(jobId, {
      status: 'failed',
      attempts,
      startedAt: ts,
      finishedAt: new Date().toISOString(),
      lastError: errMsg,
    });
    process.exit(1);
  }
}

/**
 * 偵測是否跨月，若跨月則標記上月最終快照
 */
async function detectAndSealPrevMonth(currentMonthKey, now) {
  const prevMonthKey = getPrevMonthKey(now);

  // 取當前月份是否有任何快照（若沒有，代表本月第一次執行）
  const currentMonthItems = await querySnapshots(currentMonthKey, false);
  if (currentMonthItems.length > 0) {
    // 本月已有快照，無需檢查跨月
    return;
  }

  // 本月第一次執行 → 確認上月是否已封存
  log.info({ prevMonthKey }, '本月第一次執行，嘗試封存上月 prevMonthFinal');
  const sealed = await markPrevMonthFinal(prevMonthKey);
  if (sealed) {
    log.info({ prevMonthKey, ts: sealed.ts, totalUsage: sealed.totalUsage }, '上月封存完成');
  }
}
