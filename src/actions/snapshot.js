import { getNowTaipei, getMonthKey, getPrevMonthKey, getDateKey, toUtcIso } from '../lib/date.js';
import { getConsumption } from '../lib/lineApi.js';
import { writeSnapshot, querySnapshots, getPrevMonthFinalSnapshot, markPrevMonthFinal, getJobRun, upsertJobRun } from '../lib/storage.js';
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
    if (typeof totalUsage !== 'number') {
      throw new Error(`LINE API 回傳的 totalUsage 格式異常：${JSON.stringify(consumptionData)}`);
    }
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
 * 確認上月是否已封存，若未封存則嘗試標記最終快照。
 * 不依賴當月快照數量判斷，直接查詢上月 prevMonthFinal 狀態，
 * 避免「本月快照寫入成功但 job_run 更新失敗」時上月永遠無法封存的邊界案例。
 */
async function detectAndSealPrevMonth(currentMonthKey, now) {
  const prevMonthKey = getPrevMonthKey(now);

  const existing = await getPrevMonthFinalSnapshot(prevMonthKey);
  if (existing) {
    return;
  }

  log.info({ prevMonthKey }, '上月尚未封存，嘗試標記 prevMonthFinal');
  const sealed = await markPrevMonthFinal(prevMonthKey);
  if (sealed) {
    log.info({ prevMonthKey, ts: sealed.ts, totalUsage: sealed.totalUsage }, '上月封存完成');
  }
}
