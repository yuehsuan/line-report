#!/usr/bin/env node
import { DateTime } from 'luxon';
import { createLogger } from '../src/lib/logger.js';
import { compareMonthKey, getMonthKey, getNowTaipei } from '../src/lib/date.js';
import {
  createMonthStateIfAbsent,
  getMonthState,
  getOfficialFinalSnapshots,
} from '../src/lib/storage.js';

const log = createLogger({ action: 'bootstrap-month-state' });

function getArg(prefix) {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function parseMonthInput(value, label) {
  if (!value) throw new Error(`${label} 未設定`);
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error(`${label} 需要 YYYY-MM，收到 ${value}`);
  const dt = DateTime.fromFormat(value, 'yyyy-MM', { zone: 'Asia/Taipei' });
  if (!dt.isValid) throw new Error(`${label} 無效：${value}`);
  return value;
}

function enumerateMonths(start, end) {
  const months = [];
  let cursor = DateTime.fromFormat(start, 'yyyy-MM', { zone: 'Asia/Taipei' });
  const endDt = DateTime.fromFormat(end, 'yyyy-MM', { zone: 'Asia/Taipei' });
  while (cursor <= endDt) {
    months.push(cursor.toFormat('yyyy-MM'));
    cursor = cursor.plus({ months: 1 });
  }
  return months;
}

function uniqueMonths(list) {
  return Array.from(new Set(list));
}

function pickLatestOfficialTs(rows) {
  if (!rows || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const aTs = a.effectiveTs || a.ts;
    const bTs = b.effectiveTs || b.ts;
    return aTs.localeCompare(bTs);
  });
  const latest = sorted.at(-1);
  return latest?.effectiveTs || latest?.ts || null;
}

async function bootstrapMonth(monthKey, { dryRun }) {
  const monthState = await getMonthState(monthKey);
  if (monthState) {
    log.info({ monthKey }, 'month-state 已存在，略過');
    return { status: 'skipped_existing_state', monthKey };
  }

  const officials = await getOfficialFinalSnapshots(monthKey);
  if (!officials.length) {
    log.warn({ monthKey }, '查無 official final，無法建立 month-state');
    return { status: 'skipped_no_official_final', monthKey };
  }

  const finalTs = pickLatestOfficialTs(officials);
  if (!finalTs) {
    log.warn({ monthKey }, 'official final 缺少 effectiveTs/ts，略過');
    return { status: 'skipped_invalid_official_final', monthKey };
  }

  if (dryRun) {
    log.info({ monthKey, finalTs }, '[dry-run] 將建立 month-state');
    return { status: 'dry_run_ready', monthKey, finalTs };
  }

  const created = await createMonthStateIfAbsent(monthKey, {
    officialFinalSnapshotTs: finalTs,
  });
  log.info({ monthKey, finalTs }, 'month-state 建立完成');
  return { status: 'created', monthKey, finalTs, createdAt: created.updatedAt };
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const explicitMonths = getArg('--months=');
  const cutoverArg = getArg('--cutover=') || process.env.PATCH_A_CUTOVER_MONTH;
  const cutover = parseMonthInput(cutoverArg, 'cutover 月份');

  let targets;
  if (explicitMonths) {
    targets = uniqueMonths(explicitMonths.split(',').map((m) => parseMonthInput(m.trim(), '--months')));
  } else {
    const endArg = getArg('--end=') || getMonthKey(getNowTaipei());
    const end = parseMonthInput(endArg, 'end 月份');
    if (compareMonthKey(end, cutover) < 0) throw new Error(`end(${end}) 需 >= cutover(${cutover})`);
    targets = enumerateMonths(cutover, end);
  }

  log.info({ cutover, dryRun, count: targets.length }, '開始 month-state bootstrap');

  const results = [];
  for (const monthKey of targets) {
    try {
      const res = await bootstrapMonth(monthKey, { dryRun });
      results.push(res);
    } catch (err) {
      log.error({ monthKey, err }, '處理 month-state 失敗');
      results.push({ status: 'failed', monthKey, error: err.message });
    }
  }

  const summary = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  console.log('\n[bootstrap] 結果摘要:');
  Object.entries(summary).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}`);
  });

  const failures = results.filter((item) => item.status === 'failed');
  if (failures.length > 0) {
    console.error('\n[bootstrap] 下列月份失敗，需要人工處理:');
    failures.forEach((item) => {
      console.error(`  ${item.monthKey}: ${item.error}`);
    });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[bootstrap] 執行失敗', err);
  process.exitCode = 1;
});
