import {
  getDailyLiveSnapshotTs,
  getDateKey,
  getMonthKey,
  getNowTaipei,
  getPrevMonthKey,
} from '../lib/date.js';
import { getConsumption, pushMessage } from '../lib/lineApi.js';
import {
  getJobRun,
  getPrevMonthFinalSnapshot,
  getSnapshot,
  markPrevMonthFinal,
  upsertJobRun,
  writeSnapshot,
} from '../lib/storage.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ action: 'snapshot' });

function getAlertThreshold() {
  const raw = process.env.SNAPSHOT_ALERT_DAILY_DELTA_THRESHOLD;
  if (raw == null || raw === '') return 10000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('SNAPSHOT_ALERT_DAILY_DELTA_THRESHOLD 必須是 > 0 的整數');
  }
  return value;
}

function buildSnapshotAlertMessage({ dateKey, monthKey, totalUsage, dailyDelta, threshold }) {
  return [
    '【LINE 用量異常提醒】',
    `日期：${dateKey}`,
    `月份：${monthKey}`,
    `當前累積用量：${totalUsage.toLocaleString('zh-TW')}`,
    `較昨日增加：${dailyDelta.toLocaleString('zh-TW')}`,
    `告警門檻：${threshold.toLocaleString('zh-TW')}`,
    '請確認是否有異常發送、活動投放或設定變更',
  ].join('\n');
}

async function detectAndSealPrevMonth(currentMonthKey, now) {
  const prevMonthKey = getPrevMonthKey(now);
  const existing = await getPrevMonthFinalSnapshot(prevMonthKey);
  if (existing || prevMonthKey === currentMonthKey) return;
  await markPrevMonthFinal(prevMonthKey);
}

async function evaluateSecondary({ monthKey, dateKey, totalUsage, ts, jobId, attempts }) {
  const prevDate = getNowTaipei().minus({ days: 1 }).toFormat('yyyy-MM-dd');
  const prevTs = getDailyLiveSnapshotTs(prevDate);
  const prevSnapshot = await getSnapshot(getMonthKey(getNowTaipei().minus({ days: 1 })), prevTs);

  if (!prevSnapshot) {
    await upsertJobRun(jobId, {
      status: 'success',
      primaryStatus: 'success',
      secondaryStatus: 'skipped',
      outcome: 'snapshot_alert_skipped_insufficient_signal',
      attempts,
      startedAt: ts,
      finishedAt: new Date().toISOString(),
      totalUsage,
    });
    return;
  }

  if (prevSnapshot.monthKey !== monthKey) {
    await upsertJobRun(jobId, {
      status: 'success',
      primaryStatus: 'success',
      secondaryStatus: 'skipped',
      outcome: 'snapshot_alert_skipped_cross_month',
      attempts,
      startedAt: ts,
      finishedAt: new Date().toISOString(),
      totalUsage,
    });
    return;
  }

  const threshold = getAlertThreshold();
  const dailyDelta = totalUsage - prevSnapshot.totalUsage;

  if (dailyDelta < threshold) {
    await upsertJobRun(jobId, {
      status: 'success',
      primaryStatus: 'success',
      secondaryStatus: 'success',
      outcome: 'snapshot_alert_not_triggered',
      attempts,
      startedAt: ts,
      finishedAt: new Date().toISOString(),
      totalUsage,
      dailyDelta,
      threshold,
    });
    return;
  }

  const message = buildSnapshotAlertMessage({
    dateKey,
    monthKey,
    totalUsage,
    dailyDelta,
    threshold,
  });

  const targets = (process.env.LINE_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (targets.length === 0) {
    throw new Error('環境變數 LINE_TARGETS 未設定');
  }

  for (const target of targets) {
    if (process.env.DRY_RUN !== 'true') {
      await pushMessage(target, message);
    }
  }

  await upsertJobRun(jobId, {
    status: 'success',
    primaryStatus: 'success',
    secondaryStatus: 'success',
    outcome: 'snapshot_alert_sent',
    attempts,
    startedAt: ts,
    finishedAt: new Date().toISOString(),
    totalUsage,
    dailyDelta,
    threshold,
  });
}

export async function runSnapshot() {
  const now = getNowTaipei();
  const monthKey = getMonthKey(now);
  const dateKey = getDateKey(now);
  const ts = getDailyLiveSnapshotTs(dateKey);
  const jobId = `snapshot#${dateKey}`;

  log.info({ monthKey, dateKey, ts }, '開始執行快照');

  const existingSnapshot = await getSnapshot(monthKey, ts);
  const existingRun = await getJobRun(jobId);
  if (existingSnapshot) {
    await upsertJobRun(jobId, {
      ...(existingRun || {}),
      status: 'skipped',
      primaryStatus: 'success',
      outcome: 'already_recorded_same_day',
      startedAt: existingRun?.startedAt || ts,
      finishedAt: new Date().toISOString(),
    });
    log.info({ jobId, monthKey, dateKey, ts }, '今日快照已成功完成，略過（idempotent）');
    return;
  }

  const attempts = (existingRun?.attempts || 0) + 1;
  await upsertJobRun(jobId, {
    status: 'running',
    primaryStatus: 'pending',
    secondaryStatus: 'pending',
    attempts,
    startedAt: ts,
  });

  try {
    await detectAndSealPrevMonth(monthKey, now);
    const consumptionData = await getConsumption();
    const { totalUsage } = consumptionData;
    if (typeof totalUsage !== 'number') {
      throw new Error(`LINE API 回傳的 totalUsage 格式異常：${JSON.stringify(consumptionData)}`);
    }

    await writeSnapshot({
      monthKey,
      ts,
      totalUsage,
      rawJson: JSON.stringify(consumptionData),
    });

    await upsertJobRun(jobId, {
      status: 'running',
      primaryStatus: 'success',
      secondaryStatus: 'pending',
      attempts,
      startedAt: ts,
      totalUsage,
    });

    await evaluateSecondary({ monthKey, dateKey, totalUsage, ts, jobId, attempts });
    log.info({ jobId, monthKey, dateKey, ts, totalUsage }, '快照執行完成');
  } catch (err) {
    await upsertJobRun(jobId, {
      status: 'failed',
      primaryStatus: existingSnapshot ? 'success' : 'failed',
      secondaryStatus: 'failed',
      attempts,
      startedAt: ts,
      finishedAt: new Date().toISOString(),
      lastError: err.message || String(err),
      outcome: 'snapshot_secondary_failed',
    });
    log.error({
      jobId,
      monthKey,
      dateKey,
      ts,
      error: err.message || String(err),
    }, '快照執行失敗');
    process.exit(1);
  }
}
