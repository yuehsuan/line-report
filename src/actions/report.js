import { getNowTaipei, getPrevMonthKey, getMonthKey } from '../lib/date.js';
import { getPrevMonthFinalSnapshot, upsertJobRun } from '../lib/storage.js';
import { calculateFee } from '../lib/pricing.js';
import { pushMessage } from '../lib/lineApi.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ action: 'report' });

/**
 * 執行每月回報
 * @param {Object} options
 * @param {string} [options.month]  "prev"（預設）或 "YYYY-MM"
 */
export async function runReport({ month = 'prev' } = {}) {
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

  const jobId = `report#${targetMonthKey}`;
  const startedAt = new Date().toISOString();

  log.info({ targetMonthKey }, '開始執行每月回報');
  await upsertJobRun(jobId, { status: 'running', startedAt });

  try {
    // 取得上月 prevMonthFinal 快照
    const snapshot = await getPrevMonthFinalSnapshot(targetMonthKey);
    if (!snapshot) {
      const errMsg = `找不到 ${targetMonthKey} 的 prevMonthFinal 快照，請確認快照排程是否正常執行，或手動補跑 snapshot`;
      log.error({ targetMonthKey }, errMsg);
      await upsertJobRun(jobId, {
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        lastError: errMsg,
      });
      process.exit(1);
    }

    const { totalUsage } = snapshot;
    log.info({ targetMonthKey, totalUsage, snapshotTs: snapshot.ts }, '取得 prevMonthFinal 快照');

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
      totalUsage,
      additionalCount,
      feeRounded,
      planFee,
      totalFeeRounded,
      currencySymbol,
    });

    log.info({ message }, '準備推播訊息');

    const targets = (process.env.LINE_TARGETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (targets.length === 0) {
      throw new Error('環境變數 LINE_TARGETS 未設定');
    }

    for (const target of targets) {
      await pushMessage(target, message);
    }

    await upsertJobRun(jobId, {
      status: 'success',
      startedAt,
      finishedAt: new Date().toISOString(),
      targetMonthKey,
      totalUsage,
      additionalCount,
      feeRounded,
      planFee,
      totalFeeRounded,
    });

    log.info({ jobId, targetMonthKey }, '每月回報執行完成');
  } catch (err) {
    const errMsg = err.message || String(err);
    log.error({ jobId, error: errMsg, stack: err.stack }, '每月回報執行失敗');
    await upsertJobRun(jobId, {
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      lastError: errMsg,
    }).catch(() => {});
    process.exit(1);
  }
}

/**
 * 組成符合規格的繁中推播訊息
 */
function buildReportMessage({ periodDisplay, totalUsage, additionalCount, feeRounded, planFee, totalFeeRounded, currencySymbol }) {
  const fmt = (n) => n.toLocaleString('zh-TW');
  const lines = [
    '【LINE 訊息用量回報】',
    `期間：${periodDisplay}（前月）`,
    `前月總用量：${fmt(totalUsage)} 則（consumption 近似）`,
    `前月加購訊息量：${fmt(additionalCount)} 則`,
    `前月加購費用：${currencySymbol} ${fmt(feeRounded)}（依設定估算）`,
  ];

  if (planFee > 0) {
    lines.push(`前月方案費：${currencySymbol} ${fmt(planFee)}`);
    lines.push(`前月費用合計：${currencySymbol} ${fmt(totalFeeRounded)}（含稅前，依設定估算）`);
  }

  lines.push('備註：用量含 OA Manager；consumption 為近似值，帳單以 OA Manager 後台為準。');
  return lines.join('\n');
}
