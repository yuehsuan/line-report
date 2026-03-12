import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { getMonthDates, getBackfillTs, toLineInsightDate } from '../lib/date.js';
import { getDailyDelivery } from '../lib/lineApi.js';
import {
  claimJobRun,
  deleteHistoricalBackfillBuildsExcept,
  deleteSnapshotsByBuild,
  getJobRun,
  getOfficialFinalSnapshot,
  getBackfillStorageTs,
  promoteBackfillBuild,
  querySnapshotsByBuild,
  writeBackfillSnapshot,
  upsertJobRun,
} from '../lib/storage.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ action: 'backfill' });

function validateMonthKey(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('backfill 需要 --month=YYYY-MM');
  }
  const dt = DateTime.fromFormat(month, 'yyyy-MM', { zone: 'Asia/Taipei' });
  if (!dt.isValid) {
    throw new Error(`無效的月份格式：${month}`);
  }
  return month;
}

export function getBackfillJobId(targetMonthKey, dryRun) {
  return dryRun ? `backfill-dry-run#${targetMonthKey}` : `backfill#${targetMonthKey}`;
}

export function getMonthlyCloseWaitTimeoutMs(targetMonthKey, env = process.env) {
  const explicit = Number.parseInt(env.MONTHLY_CLOSE_WAIT_MS || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const days = getMonthDates(targetMonthKey).length;
  const requestTimeoutMs = Number.parseInt(env.LINE_API_TIMEOUT_MS || '10000', 10);
  const maxAttempts = Number.parseInt(env.LINE_API_MAX_ATTEMPTS || '3', 10);
  const retryBaseMs = Number.parseInt(env.LINE_API_RETRY_BASE_MS || '500', 10);
  const retryJitterMs = Number.parseInt(env.LINE_API_RETRY_JITTER_MS || '250', 10);
  const attemptCount = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 3;
  const perAttemptTimeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 10000;
  const baseDelay = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : 500;
  const jitterCap = Number.isFinite(retryJitterMs) && retryJitterMs >= 0 ? retryJitterMs : 250;

  let retryDelayBudget = 0;
  for (let attempt = 1; attempt < attemptCount; attempt += 1) {
    retryDelayBudget += baseDelay * (2 ** Math.max(0, attempt - 1));
    retryDelayBudget += jitterCap;
  }

  const perDayBudget = (attemptCount * perAttemptTimeout) + retryDelayBudget;
  const promoteBudget = 30000;
  const minBudget = 30000;
  return Math.max(minBudget, (days * perDayBudget) + promoteBudget);
}

function getOfficialFinalGraceMs(env = process.env) {
  const explicit = Number.parseInt(env.OFFICIAL_FINAL_GRACE_MS || '', 10);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return 200;
}

export async function fetchMonthDailyUsage(targetMonthKey) {
  const dates = getMonthDates(targetMonthKey);
  const rows = [];
  let cumulativeTotal = 0;

  for (const dateKey of dates) {
    const insightDate = toLineInsightDate(dateKey);
    const daily = await getDailyDelivery(insightDate);
    if (daily.status !== 'ready') {
      throw new Error(`${targetMonthKey} 存在未就緒日資料：${dateKey} status=${daily.status}`);
    }

    cumulativeTotal += daily.totalUsage;
    rows.push({
      monthKey: targetMonthKey,
      effectiveTs: getBackfillTs(dateKey),
      totalUsage: cumulativeTotal,
      rawJson: JSON.stringify(daily.raw),
      sourceDate: dateKey,
    });
  }

  return rows;
}

export async function stageBackfillBuild(targetMonthKey, rows, backfillBuildId, { dryRun = false } = {}) {
  if (dryRun) {
    log.info({
      targetMonthKey,
      backfillBuildId,
      dryRun,
      dailyCount: rows.length,
      firstDate: rows[0]?.sourceDate,
      lastDate: rows.at(-1)?.sourceDate,
      finalTotalUsage: rows.at(-1)?.totalUsage || 0,
    }, 'DRY_RUN: 模擬 staged historical_backfill');
    return { stagedCount: 0 };
  }

  let stagedCount = 0;
  for (const row of rows) {
    await writeBackfillSnapshot({
      monthKey: row.monthKey,
      ts: getBackfillStorageTs(row.effectiveTs, backfillBuildId),
      effectiveTs: row.effectiveTs,
      totalUsage: row.totalUsage,
      rawJson: row.rawJson,
      sourceDate: row.sourceDate,
      backfillBuildId,
      isOfficialFinal: false,
    });
    stagedCount += 1;
  }
  return { stagedCount };
}

async function recheckOfficialFinalAfterGrace(targetMonthKey, graceMs = getOfficialFinalGraceMs()) {
  if (graceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
  }
  return getOfficialFinalSnapshot(targetMonthKey);
}

export async function waitForOfficialFinal(targetMonthKey, {
  timeoutMs = getMonthlyCloseWaitTimeoutMs(targetMonthKey),
  intervalMs = parseInt(process.env.MONTHLY_CLOSE_POLL_MS || '1000', 10),
  finalGraceMs = getOfficialFinalGraceMs(),
} = {}) {
  const backfillJobId = getBackfillJobId(targetMonthKey, false);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await getOfficialFinalSnapshot(targetMonthKey);
    if (snapshot) return snapshot;
    const jobRun = await getJobRun(backfillJobId);
    if (jobRun?.status === 'failed') {
      throw new Error(`${targetMonthKey} backfill 已失敗：${jobRun.lastError || 'unknown error'}`);
    }
    if (jobRun?.status === 'success') {
      const retriedSnapshot = await recheckOfficialFinalAfterGrace(targetMonthKey, finalGraceMs);
      if (retriedSnapshot) return retriedSnapshot;
      throw new Error(`${targetMonthKey} backfill job_runs=success 但 official final 不存在`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export async function runBackfill({
  month,
  dryRun = process.env.DRY_RUN === 'true',
  rebuild = false,
} = {}) {
  const targetMonthKey = validateMonthKey(month);
  const jobId = getBackfillJobId(targetMonthKey, dryRun);
  const startedAt = new Date().toISOString();
  const existingRun = await getJobRun(jobId);
  const finalGraceMs = getOfficialFinalGraceMs();

  if (existingRun?.status === 'running') {
    if (!dryRun) {
      const existingOfficial = await getOfficialFinalSnapshot(targetMonthKey);
      if (existingOfficial) {
        log.info({ jobId, targetMonthKey }, 'job_runs 顯示 running，但 official final 已存在，改以既有 final 當作可用結果');
        return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: existingOfficial };
      }
    }
    log.warn({ jobId, targetMonthKey, dryRun }, 'backfill 已有進行中的執行');
    return { status: 'already_running', jobId, targetMonthKey, dryRun };
  }

  if (!dryRun && !rebuild) {
    const existingOfficial = await getOfficialFinalSnapshot(targetMonthKey);
    if (existingOfficial) {
      log.info({ jobId, targetMonthKey }, 'official final 已存在，略過 backfill；若要重建請使用 --rebuild=true');
      return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: existingOfficial };
    }
  }

  const attempts = (existingRun?.attempts || 0) + 1;
  const allowOverwriteStatuses = dryRun || rebuild ? ['failed', 'success'] : ['failed'];
  const claimed = await claimJobRun(jobId, {
    status: 'running',
    attempts,
    startedAt,
    targetMonthKey,
    dryRun,
    rebuild,
  }, { allowOverwriteStatuses });

  if (!claimed) {
    const latestRun = await getJobRun(jobId);
    if (latestRun?.status === 'running') {
      if (!dryRun) {
        const existingOfficial = await getOfficialFinalSnapshot(targetMonthKey);
        if (existingOfficial) {
          log.info({ jobId, targetMonthKey }, 'claim 失敗且 job_runs=running，但 official final 已存在，改以既有 final 當作可用結果');
          return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: existingOfficial };
        }
      }
      log.warn({ jobId, targetMonthKey, dryRun }, 'backfill 已有進行中的執行');
      return { status: 'already_running', jobId, targetMonthKey, dryRun };
    }
    if (latestRun?.status === 'success' && !dryRun && !rebuild) {
      let existingOfficial = await getOfficialFinalSnapshot(targetMonthKey);
      if (!existingOfficial) {
        existingOfficial = await recheckOfficialFinalAfterGrace(targetMonthKey, finalGraceMs);
      }
      if (!existingOfficial) {
        throw new Error(`${targetMonthKey} backfill job_runs=success 但 official final 不存在`);
      }
      return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: existingOfficial };
    }
    throw new Error(`無法取得 ${jobId} 的執行權，請檢查 job_runs 狀態後再重試`);
  }

  const backfillBuildId = `${targetMonthKey}-${randomUUID().slice(0, 8)}`;
  let promoted = false;

  try {
    const rows = await fetchMonthDailyUsage(targetMonthKey);
    const { stagedCount } = await stageBackfillBuild(targetMonthKey, rows, backfillBuildId, { dryRun });

    let snapshot = null;
    let cleanupError = null;
    if (!dryRun) {
      snapshot = await promoteBackfillBuild(targetMonthKey, backfillBuildId);
      promoted = true;
      try {
        await deleteHistoricalBackfillBuildsExcept(targetMonthKey, [backfillBuildId]);
      } catch (err) {
        cleanupError = err;
        log.error({ jobId, targetMonthKey, backfillBuildId, error: err.message || String(err) }, 'official final 已切換，但舊 build 清理失敗');
      }
    }

    try {
      await upsertJobRun(jobId, {
        status: 'success',
        attempts,
        startedAt,
        finishedAt: new Date().toISOString(),
        targetMonthKey,
        dryRun,
        rebuild,
        backfillBuildId,
        dailyCount: rows.length,
        stagedCount,
        finalTotalUsage: rows.at(-1)?.totalUsage || 0,
        cleanupPending: Boolean(cleanupError),
        cleanupError: cleanupError?.message,
      });
    } catch (err) {
      if (!dryRun && promoted) {
        log.error({ jobId, targetMonthKey, backfillBuildId, error: err.message || String(err) }, 'official final 已切換，但 success job_run 寫入失敗');
      } else {
        throw err;
      }
    }
    log.info({ jobId, targetMonthKey, dryRun, rebuild, backfillBuildId, stagedCount }, 'backfill 執行完成');
    return {
      status: dryRun ? 'dry_run_success' : 'success',
      jobId,
      targetMonthKey,
      dryRun,
      rebuild,
      backfillBuildId,
      rows,
      snapshot,
    };
  } catch (err) {
    const errMsg = err.message || String(err);
    log.error({ jobId, error: errMsg, stack: err.stack }, 'backfill 執行失敗');
    if (!dryRun && !promoted) {
      await deleteSnapshotsByBuild(targetMonthKey, 'historical_backfill', backfillBuildId).catch(() => {});
    }
    await upsertJobRun(jobId, {
      status: 'failed',
      attempts,
      startedAt,
      finishedAt: new Date().toISOString(),
      targetMonthKey,
      dryRun,
      rebuild,
      backfillBuildId,
      lastError: errMsg,
    }).catch(() => {});
    throw err;
  }
}

export async function getStagedBuildSnapshots(monthKey, backfillBuildId) {
  return querySnapshotsByBuild(monthKey, 'historical_backfill', backfillBuildId, true);
}
