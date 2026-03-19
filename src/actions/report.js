import { createHash } from 'node:crypto';
import { compareMonthKey, getNowTaipei, getPrevMonthKey } from '../lib/date.js';
import {
  classifyMonthState,
  claimJobRun,
  getJobRun,
  getMonthState,
  getOfficialFinalSnapshot,
  updateMonthState,
  upsertJobRun,
} from '../lib/storage.js';
import { calculateFee } from '../lib/pricing.js';
import { pushMessage } from '../lib/lineApi.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ action: 'publish-report' });

const CUTOVER_ENV = 'PATCH_A_CUTOVER_MONTH';
const STALE_MS = () => Number.parseInt(process.env.PUBLISH_RUN_STALE_AFTER_MS || '300000', 10);

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
  if (/^\d{4}-\d{2}$/.test(month)) return month;
  throw new Error('無效的 --month 參數，格式應為 "prev" 或 "YYYY-MM"');
}

function getJobId(targetMonthKey, dryRun) {
  return dryRun ? `report-dry-run#${targetMonthKey}` : `publish-report#${targetMonthKey}`;
}

function hashTargets(targets) {
  return createHash('sha256').update(targets.join(',')).digest('hex');
}

function getTargets() {
  const targets = (process.env.LINE_TARGETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (targets.length === 0) throw new Error('環境變數 LINE_TARGETS 未設定');
  return targets;
}

function buildDeliverySessionKey(targetMonthKey, snapshotTs, targetSetHash) {
  return `${targetMonthKey}#${snapshotTs}#${targetSetHash}`;
}

function appendPreviousSession(existing, overrides = {}) {
  const session = {
    deliverySessionKey: existing.deliverySessionKey,
    status: existing.status,
    outcome: existing.outcome,
    dispatchStartedAt: existing.dispatchStartedAt || null,
    finishedAt: existing.finishedAt || null,
    deliveredTargets: existing.deliveredTargets || [],
    manualRecoveryDecision: existing.manualRecoveryDecision || null,
    manualRecoveryConfirmedAt: existing.manualRecoveryConfirmedAt || null,
    manualRecoveryConfirmedBy: existing.manualRecoveryConfirmedBy || null,
    officialFinalSnapshotTs: existing.officialFinalSnapshotTs,
    targetSetHash: existing.targetSetHash,
    ...overrides,
  };
  return [...(existing.previousSessions || []), session];
}

async function failPublish(jobId, fields) {
  await upsertJobRun(jobId, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    ...fields,
  });
}

async function handleUnknownDeliveryRecovery(existing, jobId, targetMonthKey, targets, observedSnapshotTs) {
  const decision = existing.manualRecoveryDecision;

  if (decision === 'confirm_delivered_then_finalize') {
    const previousSessions = appendPreviousSession(existing);
    await upsertJobRun(jobId, {
      ...existing,
      previousSessions,
      status: 'running',
    });

    await updateMonthState(targetMonthKey, (current) => ({
      reportPublished: true,
      reportPublishedAt: new Date().toISOString(),
      publishedSnapshotTs: observedSnapshotTs,
      reportOutOfSync: false,
      reportOutOfSyncSince: null,
      reportOutOfSyncReason: null,
    }));

    await upsertJobRun(jobId, {
      ...existing,
      status: 'success',
      outcome: 'published',
      deliveredTargets: [...targets],
      previousSessions,
      manualRecoveryDecision: null,
      manualRecoveryConfirmedAt: null,
      manualRecoveryConfirmedBy: null,
      finishedAt: new Date().toISOString(),
    });
    return { status: 'success', outcome: 'published', targetMonthKey };
  }

  if (decision === 'confirm_not_delivered_then_restart_publish') {
    const previousSessions = appendPreviousSession(existing, {
      outcome: 'publish_unknown_delivery_state',
    });
    return {
      resetToNewSession: true,
      previousSessions,
    };
  }

  return {
    status: 'failed',
    outcome: 'publish_unknown_delivery_state',
    targetMonthKey,
  };
}

export async function runPublishReport({
  month = 'prev',
  confirmMonth,
  dryRun = process.env.DRY_RUN === 'true',
  snapshotOverride = null,
  republish = false,
  scheduled = false,
} = {}) {
  const targetMonthKey = resolveTargetMonth(month);
  const cutoverMonth = getCutoverMonth();

  if (compareMonthKey(targetMonthKey, cutoverMonth) < 0) {
    throw new Error(`${targetMonthKey} 屬於 pre-cutover legacy month，請改走 legacy runbook`);
  }
  if (!scheduled && confirmMonth && confirmMonth !== targetMonthKey) {
    throw new Error('publish-report 的 --confirm-month 必須等於 --month');
  }

  const snapshot = snapshotOverride || await getOfficialFinalSnapshot(targetMonthKey);
  if (!snapshot) {
    throw new Error(`找不到 ${targetMonthKey} 的 official final 快照`);
  }

  const monthState = await getMonthState(targetMonthKey);
  const state = classifyMonthState(monthState);
  if (state === 'invalid_month_state') {
    throw new Error(`${targetMonthKey} month-state 非法，publish-report 中止`);
  }
  if (state === 'already_converged' && !republish) {
    return { status: 'success', outcome: 'already_converged', targetMonthKey };
  }
  if (state === 'out_of_sync' && !republish) {
    throw new Error(`${targetMonthKey} 為 out_of_sync，需顯式 --republish=true`);
  }

  const targets = getTargets();
  const targetSetHash = hashTargets(targets);
  const officialFinalSnapshotTs = snapshot.effectiveTs || snapshot.ts;
  const deliverySessionKey = buildDeliverySessionKey(targetMonthKey, officialFinalSnapshotTs, targetSetHash);
  const jobId = getJobId(targetMonthKey, dryRun);
  const existing = await getJobRun(jobId);

  if (existing?.status === 'running' && existing.deliverySessionKey === deliverySessionKey) {
    const updatedAtMs = new Date(existing.updatedAt || existing.startedAt || 0).getTime();
    const stale = Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) > STALE_MS();
    if (!stale) {
      return { status: 'failed', outcome: 'publish_already_running', targetMonthKey };
    }
    if (existing.dispatchStartedAt) {
      await failPublish(jobId, {
        ...existing,
        outcome: 'publish_unknown_delivery_state',
        targetMonthKey,
      });
      return { status: 'failed', outcome: 'publish_unknown_delivery_state', targetMonthKey };
    }
  }

  if (existing?.status === 'failed' && existing.deliverySessionKey === deliverySessionKey) {
    if (existing.outcome === 'publish_unknown_delivery_state') {
      const recovery = await handleUnknownDeliveryRecovery(existing, jobId, targetMonthKey, targets, officialFinalSnapshotTs);
      if (!recovery?.resetToNewSession) {
        return recovery;
      }
      await upsertJobRun(jobId, {
        jobId,
        status: 'running',
        targetMonthKey,
        deliverySessionKey,
        officialFinalSnapshotTs,
        deliveredTargets: [],
        targetSetHash,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        dispatchStartedAt: null,
        lastError: null,
        previousSessions: recovery.previousSessions,
        previousDeliverySessionKey: existing.deliverySessionKey,
        outcome: null,
      });
    }
  }

  const deliveredTargets = new Set(existing?.deliveredTargets || []);
  const startedAt = new Date().toISOString();
  const claimed = await claimJobRun(jobId, {
    status: 'running',
    targetMonthKey,
    deliverySessionKey,
    officialFinalSnapshotTs,
    deliveredTargets: [...deliveredTargets],
    targetSetHash,
    dispatchStartedAt: null,
    startedAt,
    finishedAt: null,
    lastError: null,
    previousSessions: existing?.previousSessions || [],
    previousDeliverySessionKey: existing?.previousDeliverySessionKey || null,
    outcome: null,
  }, { allowOverwriteStatuses: dryRun ? ['failed', 'success'] : ['failed'] });

  if (!claimed) {
    const latest = await getJobRun(jobId);
    if (latest?.status === 'success' && latest.deliverySessionKey === deliverySessionKey) {
      return { status: 'success', outcome: 'already_converged', targetMonthKey };
    }
    return { status: 'failed', outcome: 'publish_already_running', targetMonthKey };
  }

  const [year, mm] = targetMonthKey.split('-');
  const periodDisplay = `${year}/${mm}`;
  const currency = process.env.CURRENCY || 'TWD';
  const currencySymbol = currency === 'TWD' ? 'NT$' : currency;
  const { additionalCount, feeRounded, planFee, totalFeeRounded } = calculateFee(snapshot.totalUsage);
  const message = buildReportMessage({
    periodDisplay,
    monthLabel: month === 'prev' ? '前月' : '指定月份',
    totalUsage: snapshot.totalUsage,
    additionalCount,
    feeRounded,
    planFee,
    totalFeeRounded,
    currencySymbol,
  });

  try {
    await upsertJobRun(jobId, {
      ...(await getJobRun(jobId)),
      dispatchStartedAt: new Date().toISOString(),
      status: 'running',
    });

    for (const target of targets) {
      if (deliveredTargets.has(target)) continue;
      if (!dryRun) {
        await pushMessage(target, message);
      }
      deliveredTargets.add(target);
      await upsertJobRun(jobId, {
        ...(await getJobRun(jobId)),
        deliveredTargets: [...deliveredTargets],
        status: 'running',
      });
    }

    await updateMonthState(targetMonthKey, (current) => ({
      reportPublished: true,
      reportPublishedAt: new Date().toISOString(),
      publishedSnapshotTs: officialFinalSnapshotTs,
      reportOutOfSync: false,
      reportOutOfSyncSince: null,
      reportOutOfSyncReason: null,
    }));

    await upsertJobRun(jobId, {
      ...(await getJobRun(jobId)),
      status: 'success',
      outcome: 'published',
      finishedAt: new Date().toISOString(),
      deliveredTargets: [...deliveredTargets],
      totalUsage: snapshot.totalUsage,
      additionalCount,
      feeRounded,
      planFee,
      totalFeeRounded,
    });

    return { status: 'success', outcome: 'published', targetMonthKey };
  } catch (err) {
    const latest = await getJobRun(jobId);
    const outcome = latest?.dispatchStartedAt ? 'publish_unknown_delivery_state' : 'publish_failed';
    await failPublish(jobId, {
      ...(latest || {}),
      targetMonthKey,
      outcome,
      lastError: err.message || String(err),
    });
    if (outcome === 'publish_unknown_delivery_state') {
      return { status: 'failed', outcome, targetMonthKey };
    }
    throw err;
  }
}

export const runReport = runPublishReport;

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
