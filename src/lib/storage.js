import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { dbPut, dbGet, dbQuery, dbUpdate, dbDelete, dbTransactWrite, TABLE_SNAPSHOTS, TABLE_RUNS } from './db.js';
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
    isOfficialFinal: false,
    source: 'live_snapshot',
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

export async function getSnapshot(monthKey, ts) {
  return dbGet(TABLE_SNAPSHOTS(), { monthKey, ts });
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
 * 查詢指定月份、來源的所有快照，依 ts 排序
 * @param {string} monthKey
 * @param {string} source
 * @param {boolean} [ascending=true]
 */
export async function querySnapshotsBySource(monthKey, source, ascending = true) {
  return dbQuery(TABLE_SNAPSHOTS(), {
    KeyConditionExpression: 'monthKey = :mk',
    FilterExpression: '#source = :source',
    ExpressionAttributeNames: { '#source': 'source' },
    ExpressionAttributeValues: { ':mk': monthKey, ':source': source },
    ScanIndexForward: ascending,
  });
}

/**
 * 查詢指定月份、來源、buildId 的快照
 * @param {string} monthKey
 * @param {string} source
 * @param {string} backfillBuildId
 * @param {boolean} [ascending=true]
 */
export async function querySnapshotsByBuild(monthKey, source, backfillBuildId, ascending = true) {
  return dbQuery(TABLE_SNAPSHOTS(), {
    KeyConditionExpression: 'monthKey = :mk',
    FilterExpression: '#source = :source AND backfillBuildId = :buildId',
    ExpressionAttributeNames: { '#source': 'source' },
    ExpressionAttributeValues: {
      ':mk': monthKey,
      ':source': source,
      ':buildId': backfillBuildId,
    },
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
 * 取得指定月份正式月結快照（historical_backfill + isOfficialFinal=true）
 * @param {string} monthKey
 * @returns {Object|null}
 */
export async function getOfficialFinalSnapshot(monthKey) {
  const items = await dbQuery(TABLE_SNAPSHOTS(), {
    KeyConditionExpression: 'monthKey = :mk',
    FilterExpression: '#source = :source AND isOfficialFinal = :t',
    ExpressionAttributeNames: { '#source': 'source' },
    ExpressionAttributeValues: {
      ':mk': monthKey,
      ':source': 'historical_backfill',
      ':t': true,
    },
  });
  if (items.length === 0) return null;
  if (items.length > 1) {
    throw new Error(`${monthKey} 存在多筆 official final，請先修復 historical_backfill 資料`);
  }
  return items[items.length - 1];
}

/**
 * 取得指定月份所有 official final 快照
 * @param {string} monthKey
 * @returns {Promise<Object[]>}
 */
export async function getOfficialFinalSnapshots(monthKey) {
  return dbQuery(TABLE_SNAPSHOTS(), {
    KeyConditionExpression: 'monthKey = :mk',
    FilterExpression: '#source = :source AND isOfficialFinal = :t',
    ExpressionAttributeNames: { '#source': 'source' },
    ExpressionAttributeValues: {
      ':mk': monthKey,
      ':source': 'historical_backfill',
      ':t': true,
    },
  });
}

export async function getLatestLiveSnapshot(monthKey) {
  const items = await dbQuery(TABLE_SNAPSHOTS(), {
    KeyConditionExpression: 'monthKey = :mk',
    FilterExpression: '#source = :source',
    ExpressionAttributeNames: { '#source': 'source' },
    ExpressionAttributeValues: {
      ':mk': monthKey,
      ':source': 'live_snapshot',
    },
    ScanIndexForward: false,
    Limit: 1,
  });
  return items[0] || null;
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

/**
 * 寫入 historical_backfill 快照，允許同月多日資料重建。
 * @param {Object} params
 * @param {string} params.monthKey
 * @param {string} params.ts
 * @param {number} params.totalUsage
 * @param {string} params.rawJson
 * @param {string} params.sourceDate
 * @param {boolean} [params.isOfficialFinal=false]
 */
export async function writeBackfillSnapshot({
  monthKey,
  ts,
  effectiveTs,
  totalUsage,
  rawJson,
  sourceDate,
  backfillBuildId,
  isOfficialFinal = false,
}) {
  const item = {
    monthKey,
    ts,
    effectiveTs,
    totalUsage,
    rawJson,
    source: 'historical_backfill',
    sourceDate,
    backfillBuildId,
    isPrevMonthFinal: false,
    isOfficialFinal,
    createdAt: new Date().toISOString(),
  };

  try {
    await dbPut(TABLE_SNAPSHOTS(), item, {
      ConditionExpression:
        'attribute_not_exists(monthKey) AND attribute_not_exists(ts)',
    });
    log.info({ monthKey, ts, totalUsage, sourceDate, isOfficialFinal }, 'historical_backfill 寫入成功');
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err.name === 'ConditionalCheckFailedException') {
      log.warn({ monthKey, ts, sourceDate }, 'historical_backfill 已存在，略過（idempotent）');
      return;
    }
    throw err;
  }
}

/**
 * 產生 historical_backfill row 的實際 sort key
 * @param {string} effectiveTs
 * @param {string} backfillBuildId
 * @returns {string}
 */
export function getBackfillStorageTs(effectiveTs, backfillBuildId) {
  return `${effectiveTs}#historical_backfill#${backfillBuildId}`;
}

/**
 * 原子切換 official final：保留舊資料直到新 build 完整 staged。
 * @param {string} monthKey
 * @param {string} backfillBuildId
 * @returns {Promise<Object>}
 */
export async function promoteBackfillBuild(monthKey, backfillBuildId) {
  const buildItems = await querySnapshotsByBuild(monthKey, 'historical_backfill', backfillBuildId, true);
  if (buildItems.length === 0) {
    throw new Error(`${monthKey} 找不到 buildId=${backfillBuildId} 的 staged backfill`);
  }

  const currentOfficials = await getOfficialFinalSnapshots(monthKey);
  const newFinal = buildItems[buildItems.length - 1];

  const transactItems = [
    ...currentOfficials.map((item) => ({
      Update: {
        TableName: TABLE_SNAPSHOTS(),
        Key: { monthKey: item.monthKey, ts: item.ts },
        UpdateExpression: 'SET isOfficialFinal = :f',
        ExpressionAttributeValues: { ':f': false },
      },
    })),
    {
      Update: {
        TableName: TABLE_SNAPSHOTS(),
        Key: { monthKey: newFinal.monthKey, ts: newFinal.ts },
        UpdateExpression: 'SET isOfficialFinal = :t',
        ExpressionAttributeValues: { ':t': true },
      },
    },
  ];

  await dbTransactWrite(transactItems);
  log.info({ monthKey, backfillBuildId, promotedTs: newFinal.ts }, '已切換 official final');
  return { ...newFinal, isOfficialFinal: true };
}

export function getMonthStateJobId(monthKey) {
  return `month-state#${monthKey}`;
}

export async function getMonthState(monthKey) {
  return getJobRun(getMonthStateJobId(monthKey));
}

export async function putMonthState(monthKey, fields) {
  return upsertJobRun(getMonthStateJobId(monthKey), fields);
}

export async function createMonthStateIfAbsent(monthKey, {
  officialFinalSnapshotTs,
} = {}) {
  const ttl = Math.floor(Date.now() / 1000) + JOB_RUN_TTL_SECONDS;
  const item = {
    jobId: getMonthStateJobId(monthKey),
    stateVersion: 1,
    officialFinalSnapshotTs,
    reportPublished: false,
    reportPublishedAt: null,
    publishedSnapshotTs: null,
    reportOutOfSync: false,
    reportOutOfSyncSince: null,
    reportOutOfSyncReason: null,
    updatedAt: new Date().toISOString(),
    ttl,
  };
  try {
    await dbPut(TABLE_RUNS(), item, {
      ConditionExpression: 'attribute_not_exists(jobId)',
    });
    return item;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err.name === 'ConditionalCheckFailedException') {
      return getMonthState(monthKey);
    }
    throw err;
  }
}

export function classifyMonthState(item) {
  if (!item?.officialFinalSnapshotTs) return 'invalid_month_state';
  if (
    item.reportPublished === false
    && item.publishedSnapshotTs == null
    && item.reportOutOfSync === false
  ) {
    return 'unpublished_ready';
  }
  if (
    item.reportPublished === true
    && item.publishedSnapshotTs
    && item.reportOutOfSync === false
    && item.officialFinalSnapshotTs === item.publishedSnapshotTs
  ) {
    return 'already_converged';
  }
  if (
    item.reportPublished === true
    && item.publishedSnapshotTs
    && item.reportOutOfSync === true
    && item.officialFinalSnapshotTs !== item.publishedSnapshotTs
  ) {
    return 'out_of_sync';
  }
  return 'invalid_month_state';
}

export async function updateMonthState(monthKey, updater) {
  const current = await getMonthState(monthKey);
  if (!current) {
    throw new Error(`${monthKey} 找不到 month-state`);
  }
  const nextFields = updater(current);
  const next = {
    ...current,
    ...nextFields,
    stateVersion: (current.stateVersion || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  await dbPut(TABLE_RUNS(), next, {
    ConditionExpression: 'attribute_exists(jobId) AND stateVersion = :version',
    ExpressionAttributeValues: {
      ':version': current.stateVersion,
    },
  });
  return next;
}

export function officialFinalComparableRows(rows = []) {
  return rows.map((row) => ({
    monthKey: row.monthKey,
    source: row.source,
    sourceDate: row.sourceDate,
    effectiveTs: row.effectiveTs,
    totalUsage: row.totalUsage,
  }));
}

export function isSameOfficialFinalRows(currentRows = [], candidateRows = []) {
  return JSON.stringify(officialFinalComparableRows(currentRows))
    === JSON.stringify(officialFinalComparableRows(candidateRows));
}

/**
 * 刪除指定月份、來源的所有快照
 * @param {string} monthKey
 * @param {string} source
 * @returns {Promise<number>}
 */
export async function deleteSnapshotsBySource(monthKey, source) {
  const items = await querySnapshotsBySource(monthKey, source, true);
  for (const item of items) {
    await dbDelete(TABLE_SNAPSHOTS(), { monthKey: item.monthKey, ts: item.ts });
  }
  log.info({ monthKey, source, count: items.length }, '已刪除指定來源快照');
  return items.length;
}

/**
 * 刪除指定月份、來源、buildId 的所有快照
 * @param {string} monthKey
 * @param {string} source
 * @param {string} backfillBuildId
 * @returns {Promise<number>}
 */
export async function deleteSnapshotsByBuild(monthKey, source, backfillBuildId) {
  const items = await querySnapshotsByBuild(monthKey, source, backfillBuildId, true);
  for (const item of items) {
    await dbDelete(TABLE_SNAPSHOTS(), { monthKey: item.monthKey, ts: item.ts });
  }
  log.info({ monthKey, source, backfillBuildId, count: items.length }, '已刪除指定 build 快照');
  return items.length;
}

/**
 * 刪除指定月份 historical_backfill 中，不在保留清單內的 build。
 * @param {string} monthKey
 * @param {string[]} keepBuildIds
 * @returns {Promise<number>}
 */
export async function deleteHistoricalBackfillBuildsExcept(monthKey, keepBuildIds = []) {
  const items = await querySnapshotsBySource(monthKey, 'historical_backfill', true);
  const keepSet = new Set(keepBuildIds.filter(Boolean));
  const deletions = items.filter((item) => !keepSet.has(item.backfillBuildId));
  for (const item of deletions) {
    await dbDelete(TABLE_SNAPSHOTS(), { monthKey: item.monthKey, ts: item.ts });
  }
  log.info({ monthKey, keepBuildIds: [...keepSet], deletedCount: deletions.length }, '已清理舊 historical_backfill build');
  return deletions.length;
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
 * 嘗試取得 job run 執行權。
 * 僅當紀錄不存在，或狀態為允許覆寫的狀態時才會成功。
 * @param {string} jobId
 * @param {Object} fields
 * @param {Object} [options]
 * @param {string[]} [options.allowOverwriteStatuses=[]]
 * @returns {Promise<boolean>}
 */
export async function claimJobRun(jobId, fields, { allowOverwriteStatuses = [] } = {}) {
  const ttl = Math.floor(Date.now() / 1000) + JOB_RUN_TTL_SECONDS;
  const item = { jobId, ...fields, updatedAt: new Date().toISOString(), ttl };

  const conditions = ['attribute_not_exists(jobId)'];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  if (allowOverwriteStatuses.length > 0) {
    expressionAttributeNames['#status'] = 'status';
    for (const [idx, status] of allowOverwriteStatuses.entries()) {
      const key = `:allowed${idx}`;
      conditions.push(`#status = ${key}`);
      expressionAttributeValues[key] = status;
    }
  }

  try {
    await dbPut(TABLE_RUNS(), item, {
      ConditionExpression: conditions.join(' OR '),
      ...(Object.keys(expressionAttributeNames).length > 0 ? { ExpressionAttributeNames: expressionAttributeNames } : {}),
      ...(Object.keys(expressionAttributeValues).length > 0 ? { ExpressionAttributeValues: expressionAttributeValues } : {}),
    });
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err.name === 'ConditionalCheckFailedException') {
      log.info({ jobId }, 'job_run 已存在且不可覆寫，略過 claim');
      return false;
    }
    throw err;
  }
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
