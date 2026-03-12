import { getNowTaipei, getPrevMonthKey } from '../lib/date.js';
import { claimJobRun, getJobRun, getOfficialFinalSnapshot, upsertJobRun } from '../lib/storage.js';
import { calculateFee } from '../lib/pricing.js';
import { pushMessage } from '../lib/lineApi.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ action: 'report' });

/**
 * 執行每月回報
 * @param {Object} options
 * @param {string} [options.month]  "prev"（預設）或 "YYYY-MM"
 * @param {boolean} [options.dryRun]
 * @param {Object|null} [options.snapshotOverride]
 */
export async function runReport({ month = 'prev', dryRun = process.env.DRY_RUN === 'true', snapshotOverride = null } = {}) {
  const now = getNowTaipei();

  let targetMonthKey;
  if (month === 'prev') {
    targetMonthKey = getPrevMonthKey(now);
  } else if (/^\d{4}-\d{2}$/.test(month)) {
    targetMonthKey = month;
  } else {
    log.error({ month }, '無效的 --month 參數，格式應為 "prev" 或 "YYYY-MM"');
    process.exit(1);
  }

  const jobId = dryRun ? `report-dry-run#${targetMonthKey}` : `report#${targetMonthKey}`;
  const startedAt = new Date().toISOString();
  const existingRun = await getJobRun(jobId);

  if (!dryRun && existingRun?.status === 'success') {
    log.info({ jobId, targetMonthKey, dryRun }, '每月回報已成功送出，略過（idempotent）');
    return;
  }

  const attempts = (existingRun?.attempts || 0) + 1;
  const deliveredTargets = new Set(existingRun?.deliveredTargets || []);

  log.info({ targetMonthKey, dryRun }, '開始執行每月回報');
  const claimed = await claimJobRun(jobId, {
    status: 'running',
    attempts,
    startedAt,
    targetMonthKey,
    deliveredTargets: [...deliveredTargets],
  }, { allowOverwriteStatuses: dryRun ? ['failed', 'success'] : ['failed'] });

  if (!claimed) {
    const latestRun = await getJobRun(jobId);
    if (!dryRun && latestRun?.status === 'success') {
      log.info({ jobId, targetMonthKey, dryRun }, '每月回報已成功送出，略過（idempotent）');
      return;
    }
    if (latestRun?.status === 'running') {
      log.warn({ jobId, targetMonthKey, dryRun }, '每月回報已有進行中的執行，略過重複觸發');
      return;
    }
    throw new Error(`無法取得 ${jobId} 的執行權，請檢查 job_runs 狀態後再重試`);
  }

  try {
    // 取得正式月結快照（historical_backfill + isOfficialFinal=true）
    const snapshot = snapshotOverride || await getOfficialFinalSnapshot(targetMonthKey);
    if (!snapshot) {
      const errMsg = `找不到 ${targetMonthKey} 的 official final 快照`;
      log.error({ targetMonthKey }, errMsg);
      await upsertJobRun(jobId, {
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        dryRun,
        lastError: errMsg,
      });
      process.exit(1);
    }

    const { totalUsage } = snapshot;
    log.info({ targetMonthKey, totalUsage, snapshotTs: snapshot.effectiveTs || snapshot.ts, dryRun }, '取得 official final 快照');

    // 計算加購費用與總費用
    const { additionalCount, feeRounded, planFee, totalFeeRounded } = calculateFee(totalUsage);
    log.info({ additionalCount, feeRounded, planFee, totalFeeRounded }, '費用計算完成');

    // 組成推播訊息
    const [year, mm] = targetMonthKey.split('-');
    const periodDisplay = `${year}/${mm}`;
    const currency = process.env.CURRENCY || 'TWD';
    const currencySymbol = currency === 'TWD' ? 'NT$' : currency;

    const message = buildReportMessage({
      periodDisplay,
      monthLabel: month === 'prev' ? '前月' : '指定月份',
      totalUsage,
      additionalCount,
      feeRounded,
      planFee,
      totalFeeRounded,
      currencySymbol,
    });

    log.info({ targetMonthKey, dryRun, targetCountHint: (process.env.LINE_TARGETS || '').split(',').filter(Boolean).length }, '準備推播訊息');

    const targets = (process.env.LINE_TARGETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (targets.length === 0) {
      throw new Error('環境變數 LINE_TARGETS 未設定');
    }

    for (const target of targets) {
      if (deliveredTargets.has(target)) {
        log.info({ jobId, target }, '此 target 已於前次嘗試送出，略過重送');
        continue;
      }
      if (dryRun) {
        log.info({ jobId, targetType: target[0] || 'N/A', textLength: message.length }, '[DRY_RUN] 跳過 LINE push');
      } else {
        await pushMessage(target, message);
      }
      deliveredTargets.add(target);
      await upsertJobRun(jobId, {
        status: 'running',
        attempts,
        startedAt,
        targetMonthKey,
        deliveredTargets: [...deliveredTargets],
        dryRun,
      });
    }

    await upsertJobRun(jobId, {
      status: 'success',
      attempts,
      startedAt,
      finishedAt: new Date().toISOString(),
      targetMonthKey,
      deliveredTargets: [...deliveredTargets],
      totalUsage,
      additionalCount,
      feeRounded,
      planFee,
      totalFeeRounded,
      dryRun,
    });

    log.info({ jobId, targetMonthKey, dryRun }, '每月回報執行完成');
  } catch (err) {
    const errMsg = err.message || String(err);
    log.error({ jobId, error: errMsg, stack: err.stack }, '每月回報執行失敗');
    await upsertJobRun(jobId, {
      status: 'failed',
      attempts,
      startedAt,
      finishedAt: new Date().toISOString(),
      targetMonthKey,
      deliveredTargets: [...deliveredTargets],
      dryRun,
      lastError: errMsg,
    }).catch(() => {});
    process.exit(1);
  }
}

/**
 * 組成符合規格的繁中推播訊息
 */
export function buildReportMessage({
  periodDisplay,
  monthLabel,
  totalUsage,
  additionalCount,
  feeRounded,
  planFee,
  totalFeeRounded,
  currencySymbol,
}) {
  const fmt = (n) => n.toLocaleString('zh-TW');
    const lines = [
      '【LINE 訊息用量回報】',
      `期間：${periodDisplay}（${monthLabel}）`,
      `總用量：${fmt(totalUsage)} 則（historical backfill 月結）`,
      `加購訊息量：${fmt(additionalCount)} 則`,
      `加購費用：${currencySymbol} ${fmt(feeRounded)}（依設定估算）`,
    ];

  if (planFee > 0) {
    lines.push(`方案費：${currencySymbol} ${fmt(planFee)}`);
    lines.push(`費用合計：${currencySymbol} ${fmt(totalFeeRounded)}（含稅前，依設定估算）`);
  }

  lines.push('備註：月報依 LINE daily delivery historical backfill 計算；帳單仍以 OA Manager 後台為準。');
  return lines.join('\n');
}
