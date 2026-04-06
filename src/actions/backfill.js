import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { compareMonthKey, getBackfillTs, getMonthDates, toLineInsightDate } from '../lib/date.js';
import { getDailyDelivery } from '../lib/lineApi.js';
import {
  claimJobRun,
  createMonthStateIfAbsent,
  deleteHistoricalBackfillBuildsExcept,
  deleteSnapshotsByBuild,
  getJobRun,
  getOfficialFinalSnapshot,
  getSnapshot,
  getBackfillStorageTs,
  isSameOfficialFinalRows,
  officialFinalComparableRows,
  promoteBackfillBuild,
  querySnapshotsByBuild,
  querySnapshotsBySource,
  updateMonthState,
  upsertJobRun,
  writeBackfillSnapshot,
} from '../lib/storage.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ action: 'backfill' });
const CUTOVER_ENV = 'PATCH_A_CUTOVER_MONTH';
const DEFAULT_BACKFILL_DAY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getBackfillDayDelayMs(env = process.env) {
  const raw = env.BACKFILL_DAY_DELAY_MS;
  if (raw === undefined) return DEFAULT_BACKFILL_DAY_DELAY_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BACKFILL_DAY_DELAY_MS;
}

function getLineApiTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.LINE_API_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

function getLineApiMaxAttempts(env = process.env) {
  const parsed = Number.parseInt(env.LINE_API_MAX_ATTEMPTS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function getLineApiRetryBaseMs(env = process.env) {
  const parsed = Number.parseInt(env.LINE_API_RETRY_BASE_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

function getLineApiRetryJitterMs(env = process.env) {
  const parsed = Number.parseInt(env.LINE_API_RETRY_JITTER_MS || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
}

function getRetryBudgetMs(env = process.env) {
  const maxAttempts = getLineApiMaxAttempts(env);
  const timeoutMs = getLineApiTimeoutMs(env);
  const baseMs = getLineApiRetryBaseMs(env);
  const jitterMs = getLineApiRetryJitterMs(env);
  let total = maxAttempts * timeoutMs;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    total += baseMs * (2 ** Math.max(0, attempt - 1));
    total += jitterMs;
  }
  return total;
}

function getCutoverMonth() {
  const value = process.env[CUTOVER_ENV];
  if (!/^\d{4}-\d{2}$/.test(value || '')) {
    throw new Error(`${CUTOVER_ENV} 未設定或格式錯誤`);
  }
  return value;
}

function validateMonthKey(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('backfill 需要 --month=YYYY-MM');
  const dt = DateTime.fromFormat(month, 'yyyy-MM', { zone: 'Asia/Taipei' });
  if (!dt.isValid) throw new Error(`無效的月份格式：${month}`);
  return month;
}

export function getBackfillJobId(targetMonthKey, dryRun) {
  return dryRun ? `backfill-dry-run#${targetMonthKey}` : `backfill#${targetMonthKey}`;
}

export function getMonthlyCloseWaitTimeoutMs(targetMonthKey, env = process.env) {
  const explicit = Number.parseInt(env.MONTHLY_CLOSE_WAIT_MS || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const perDayBudgetMs = getRetryBudgetMs(env) + getBackfillDayDelayMs(env);
  return Math.max(30000, getMonthDates(targetMonthKey).length * perDayBudgetMs);
}

export async function fetchMonthDailyUsage(targetMonthKey) {
  const dates = getMonthDates(targetMonthKey);
  const rows = [];
  let cumulativeTotal = 0;
  const delayMs = getBackfillDayDelayMs();

  for (const [index, dateKey] of dates.entries()) {
    log.info({
      monthKey: targetMonthKey,
      progress: `${index + 1}/${dates.length}`,
      dateKey,
      remainingDays: dates.length - index - 1,
    }, '開始抓取 historical backfill 當日資料');

    const daily = await getDailyDelivery(toLineInsightDate(dateKey));
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
      source: 'historical_backfill',
    });

    log.info({
      monthKey: targetMonthKey,
      progress: `${index + 1}/${dates.length}`,
      dateKey,
      dailyTotalUsage: daily.totalUsage,
      cumulativeTotal,
    }, 'historical backfill 當日資料抓取完成');

    if (index < dates.length - 1 && delayMs > 0) {
      log.info({
        monthKey: targetMonthKey,
        progress: `${index + 1}/${dates.length}`,
        nextDateKey: dates[index + 1],
        delayMs,
      }, '等待 backfill 固定節流後再抓下一天');
      await sleep(delayMs);
    }
  }

  return rows;
}

export async function stageBackfillBuild(targetMonthKey, rows, backfillBuildId, { dryRun = false } = {}) {
  if (dryRun) return { stagedCount: 0 };
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

export async function waitForOfficialFinal(targetMonthKey, { timeoutMs = getMonthlyCloseWaitTimeoutMs(targetMonthKey), intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await getOfficialFinalSnapshot(targetMonthKey);
    if (snapshot) return snapshot;
    const jobRun = await getJobRun(getBackfillJobId(targetMonthKey, false));
    if (jobRun?.status === 'failed') {
      throw new Error(`${targetMonthKey} backfill 已失敗：${jobRun.lastError || 'unknown error'}`);
    }
    if (jobRun?.status === 'success') {
      const lateSnapshot = await getOfficialFinalSnapshot(targetMonthKey);
      if (lateSnapshot) return lateSnapshot;
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
  const cutoverMonth = getCutoverMonth();
  if (compareMonthKey(targetMonthKey, cutoverMonth) < 0) {
    throw new Error(`${targetMonthKey} 屬於 pre-cutover legacy month，請改走 legacy runbook`);
  }

  const jobId = getBackfillJobId(targetMonthKey, dryRun);
  const startedAt = new Date().toISOString();
  const existingRun = await getJobRun(jobId);
  const attempts = (existingRun?.attempts || 0) + 1;

  if (!dryRun && !rebuild) {
    const existingOfficial = await getOfficialFinalSnapshot(targetMonthKey);
    if (existingOfficial) {
      return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: existingOfficial };
    }
  }

  if (existingRun?.status === 'running') {
    return { status: 'already_running', jobId, targetMonthKey, dryRun };
  }

  if (!dryRun && !rebuild && existingRun?.status === 'success') {
    const lateOfficial = await getOfficialFinalSnapshot(targetMonthKey);
    if (lateOfficial) {
      return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: lateOfficial };
    }
    throw new Error(`${targetMonthKey} backfill job_runs=success 但 official final 不存在`);
  }

  const claimed = await claimJobRun(jobId, {
    status: 'running',
    attempts,
    startedAt,
    targetMonthKey,
    dryRun,
    rebuild,
  }, { allowOverwriteStatuses: dryRun || rebuild ? ['failed', 'success'] : ['failed'] });
  if (!claimed) {
    const currentOfficial = !dryRun && !rebuild ? await getOfficialFinalSnapshot(targetMonthKey) : null;
    if (currentOfficial) {
      return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: currentOfficial };
    }
    const currentRun = await getJobRun(jobId);
    if (!dryRun && !rebuild && currentRun?.status === 'success') {
      const lateOfficial = await getOfficialFinalSnapshot(targetMonthKey);
      if (lateOfficial) {
        return { status: 'skipped_existing', jobId, targetMonthKey, dryRun, snapshot: lateOfficial };
      }
      throw new Error(`${targetMonthKey} backfill job_runs=success 但 official final 不存在`);
    }
    return { status: 'already_running', jobId, targetMonthKey, dryRun };
  }

  const backfillBuildId = `${targetMonthKey}-${randomUUID().slice(0, 8)}`;
  let promoted = false;
  try {
    const rows = await fetchMonthDailyUsage(targetMonthKey);
    const currentOfficial = dryRun ? null : await getOfficialFinalSnapshot(targetMonthKey);
    const currentRows = currentOfficial
      ? (await querySnapshotsBySource(targetMonthKey, 'historical_backfill', true))
        .filter((item) => item.isOfficialFinal === true)
      : [];

    if (!dryRun && rebuild && currentRows.length > 0 && isSameOfficialFinalRows(currentRows, rows)) {
      await upsertJobRun(jobId, {
        status: 'success',
        attempts,
        startedAt,
        finishedAt: new Date().toISOString(),
        targetMonthKey,
        dryRun,
        rebuild,
        outcome: 'no_data_change',
      });
      return { status: 'success', outcome: 'no_data_change', jobId, targetMonthKey, dryRun };
    }

    const { stagedCount } = await stageBackfillBuild(targetMonthKey, rows, backfillBuildId, { dryRun });
    let snapshot = null;

    if (!dryRun) {
      snapshot = await promoteBackfillBuild(targetMonthKey, backfillBuildId);
      promoted = true;
      try {
        await deleteHistoricalBackfillBuildsExcept(targetMonthKey, [backfillBuildId]);
      } catch (cleanupError) {
        log.warn({ monthKey: targetMonthKey, backfillBuildId, err: cleanupError }, '清理舊 historical_backfill build 失敗，保留已 promote 的 official final');
      }

      const monthState = await createMonthStateIfAbsent(targetMonthKey, {
        officialFinalSnapshotTs: snapshot.effectiveTs,
      });
      if (rebuild && monthState && monthState.officialFinalSnapshotTs !== snapshot.effectiveTs) {
        await updateMonthState(targetMonthKey, (current) => ({
          officialFinalSnapshotTs: snapshot.effectiveTs,
          reportOutOfSync: current.publishedSnapshotTs !== snapshot.effectiveTs,
          reportOutOfSyncReason: current.publishedSnapshotTs !== snapshot.effectiveTs ? 'official_final_rebuilt' : null,
          reportOutOfSyncSince: current.publishedSnapshotTs !== snapshot.effectiveTs ? new Date().toISOString() : null,
        }));
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
      });
    } catch (jobRunError) {
      if (!promoted) throw jobRunError;
      log.warn({ monthKey: targetMonthKey, backfillBuildId, err: jobRunError }, 'success job_run 寫入失敗，但 official final 已 promote');
    }

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
      lastError: err.message || String(err),
    }).catch(() => {});
    throw err;
  }
}

export async function getStagedBuildSnapshots(monthKey, backfillBuildId) {
  return querySnapshotsByBuild(monthKey, 'historical_backfill', backfillBuildId, true);
}

export { officialFinalComparableRows };
