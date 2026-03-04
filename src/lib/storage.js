import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { dbPut, dbGet, dbQuery, dbUpdate, TABLE_SNAPSHOTS, TABLE_RUNS } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger({ module: 'storage' });

// ─────────────────────────────────────────────
// usage_snapshots 操作
// ─────────────────────────────────────────────

/**
 * 寫入快照（conditional put 防重：同一 monthKey + ts 不重複）
 * @param {Object} params
 * @param {string} params.monthKey  e.g. "2026-02"
 * @param {string} params.ts        UTC ISO string
 * @param {number} params.totalUsage
 * @param {string} params.rawJson   LINE API 原始回應 JSON.stringify
 */
export async function writeSnapshot({ monthKey, ts, totalUsage, rawJson }) {
  const item = {
    monthKey,
    ts,
    totalUsage,
    rawJson,
    isPrevMonthFinal: false,
    createdAt: new Date().toISOString(),
  };

  try {
    await dbPut(TABLE_SNAPSHOTS(), item, {
      ConditionExpression:
        'attribute_not_exists(monthKey) AND attribute_not_exists(ts)',
    });
    log.info({ monthKey, ts, totalUsage }, '快照寫入成功');
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err.name === 'ConditionalCheckFailedException') {
      log.warn({ monthKey, ts }, '快照已存在，略過（idempotent）');
      return;
    }
    throw err;
  }
}

/**
 * 查詢指定月份的所有快照，依 ts 排序
 * @param {string} monthKey
 * @param {boolean} [ascending=true]
 */
export async function querySnapshots(monthKey, ascending = true) {
  return dbQuery(TABLE_SNAPSHOTS(), {
    KeyConditionExpression: 'monthKey = :mk',
    ExpressionAttributeValues: { ':mk': monthKey },
    ScanIndexForward: ascending,
  });
}

/**
 * 取得指定月份 isPrevMonthFinal=true 的最終快照
 * @param {string} monthKey
 * @returns {Object|null}
 */
export async function getPrevMonthFinalSnapshot(monthKey) {
  const items = await dbQuery(TABLE_SNAPSHOTS(), {
    KeyConditionExpression: 'monthKey = :mk',
    FilterExpression: 'isPrevMonthFinal = :t',
    ExpressionAttributeValues: { ':mk': monthKey, ':t': true },
  });
  if (items.length === 0) return null;
  return items[items.length - 1];
}

/**
 * 將指定月份的最後一筆快照（SK=ts 最大值）標記為 isPrevMonthFinal=true
 * 若該月份已有 prevMonthFinal，則略過
 * @param {string} prevMonthKey
 */
export async function markPrevMonthFinal(prevMonthKey) {
  const existing = await getPrevMonthFinalSnapshot(prevMonthKey);
  if (existing) {
    log.info({ prevMonthKey }, 'prevMonthFinal 已存在，略過補封存');
    return existing;
  }

  const items = await querySnapshots(prevMonthKey, false);
  if (items.length === 0) {
    log.warn({ prevMonthKey }, '上月無任何快照，無法標記 prevMonthFinal');
    return null;
  }

  const lastItem = items[0];
  await dbUpdate(TABLE_SNAPSHOTS(), { monthKey: prevMonthKey, ts: lastItem.ts }, {
    UpdateExpression: 'SET isPrevMonthFinal = :t',
    ExpressionAttributeValues: { ':t': true },
  });
  log.info({ prevMonthKey, ts: lastItem.ts, totalUsage: lastItem.totalUsage }, '已標記 prevMonthFinal');
  return { ...lastItem, isPrevMonthFinal: true };
}

// ─────────────────────────────────────────────
// job_runs 操作
// ─────────────────────────────────────────────

/**
 * 讀取 job run 紀錄
 * @param {string} jobId  例如 "snapshot#2026-02-25"
 */
export async function getJobRun(jobId) {
  return dbGet(TABLE_RUNS(), { jobId });
}

/**
 * 建立或更新 job run 紀錄
 * @param {string} jobId
 * @param {Object} fields
 */
const JOB_RUN_TTL_SECONDS = 90 * 24 * 60 * 60;

export async function upsertJobRun(jobId, fields) {
  const ttl = Math.floor(Date.now() / 1000) + JOB_RUN_TTL_SECONDS;
  const item = { jobId, ...fields, updatedAt: new Date().toISOString(), ttl };
  await dbPut(TABLE_RUNS(), item);
}
