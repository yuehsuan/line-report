import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

const originalEnv = {};
const envKeys = ['DRY_RUN', 'AWS_ENDPOINT_URL', 'DDB_TABLE_SNAPSHOTS', 'DDB_TABLE_RUNS'];

before(() => {
  for (const k of envKeys) originalEnv[k] = process.env[k];
  process.env.DRY_RUN = 'false';
  process.env.AWS_ENDPOINT_URL = 'http://localhost:8000';
  process.env.DDB_TABLE_SNAPSHOTS = 'usage_snapshots';
  process.env.DDB_TABLE_RUNS = 'job_runs';
});

after(() => {
  for (const k of envKeys) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

beforeEach(() => {
  ddbMock.reset();
});

let mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 100, raw: {} });

const { runBackfill, getMonthlyCloseWaitTimeoutMs, waitForOfficialFinal } = await esmock('../actions/backfill.js', {
  '../lib/lineApi.js': {
    getDailyDelivery: async (...args) => mockGetDailyDelivery(...args),
  },
});

describe('runBackfill', () => {
  test('完整月份回補成功，最後一筆應標記 isOfficialFinal', async () => {
    let callCount = 0;
    mockGetDailyDelivery = async () => {
      callCount += 1;
      return { status: 'ready', totalUsage: 10, raw: { status: 'ready' } };
    };

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .callsFake((input) => {
        const values = input?.ExpressionAttributeValues || {};
        if (values[':buildId']) {
          return {
            Items: Array.from({ length: 31 }, (_, idx) => ({
              monthKey: '2026-03',
              ts: `2026-03-${String(idx + 1).padStart(2, '0')}T15:58:00.000Z#historical_backfill#build-test`,
              effectiveTs: `2026-03-${String(idx + 1).padStart(2, '0')}T15:58:00.000Z`,
              source: 'historical_backfill',
              backfillBuildId: values[':buildId'],
              totalUsage: (idx + 1) * 10,
            })),
          };
        }
        return { Items: [] };
      });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await runBackfill({ month: '2026-03', dryRun: false });

    const putCalls = ddbMock.commandCalls(PutCommand);
    const backfillCalls = putCalls.filter((c) => c.args[0].input.Item?.source === 'historical_backfill');
    const successCall = putCalls.find((c) => c.args[0].input.Item?.jobId === 'backfill#2026-03' && c.args[0].input.Item?.status === 'success');
    const transactCalls = ddbMock.commandCalls(TransactWriteCommand);

    assert.equal(callCount, 31);
    assert.equal(backfillCalls.length, 31);
    assert.ok(successCall, '應寫入 success job_run');
    assert.equal(backfillCalls.at(-1).args[0].input.Item.isOfficialFinal, false);
    assert.equal(backfillCalls.at(-1).args[0].input.Item.totalUsage, 310);
    assert.match(backfillCalls.at(-1).args[0].input.Item.ts, /#historical_backfill#/);
    assert.equal(transactCalls.length, 1, '應以 transact write promote official final');
    assert.equal(result.snapshot?.isOfficialFinal, true);
    assert.equal(result.snapshot?.totalUsage, 310);
  });

  test('遇到 unready 應失敗且不寫入 backfill snapshot', async () => {
    let callCount = 0;
    mockGetDailyDelivery = async () => {
      callCount += 1;
      if (callCount === 3) {
        return { status: 'unready', totalUsage: 0, raw: { status: 'unready' } };
      }
      return { status: 'ready', totalUsage: 10, raw: { status: 'ready' } };
    };

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});

    await assert.rejects(
      () => runBackfill({ month: '2026-03', dryRun: false }),
      /未就緒日資料/,
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    const backfillCalls = putCalls.filter((c) => c.args[0].input.Item?.source === 'historical_backfill');
    const failedCall = putCalls.find((c) => c.args[0].input.Item?.jobId === 'backfill#2026-03' && c.args[0].input.Item?.status === 'failed');

    assert.equal(backfillCalls.length, 0);
    assert.ok(failedCall, '應寫入 failed job_run');
  });

  test('DRY_RUN=true 時應使用 backfill-dry-run jobId，不阻塞正式回補', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 5, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await runBackfill({ month: '2026-03', dryRun: true });

    const jobIds = ddbMock.commandCalls(PutCommand)
      .map((c) => c.args[0].input.Item?.jobId)
      .filter(Boolean);
    assert.ok(jobIds.includes('backfill-dry-run#2026-03'));
    assert.ok(!jobIds.includes('backfill#2026-03'));
  });

  test('DRY_RUN backfill 成功後應可再次重跑以產生新 preview', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 5, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill-dry-run#2026-03', status: 'success', attempts: 1 } });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await runBackfill({ month: '2026-03', dryRun: true });

    assert.equal(result.status, 'dry_run_success');
    assert.equal(result.rows.length, 31);
    const claimCall = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.Item?.jobId === 'backfill-dry-run#2026-03');
    assert.ok(claimCall, '應重新 claim dry-run job');
    assert.match(claimCall.args[0].input.ConditionExpression, /:allowed1/);
    assert.equal(claimCall.args[0].input.ExpressionAttributeValues[':allowed1'], 'success');
  });

  test('已有 official final 時，未指定 rebuild 應略過', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({
      Items: [{ monthKey: '2026-03', ts: '2026-03-31T15:58:00.000Z#historical_backfill#old', source: 'historical_backfill', isOfficialFinal: true }],
    });

    const result = await runBackfill({ month: '2026-03', dryRun: false, rebuild: false });

    assert.equal(result.status, 'skipped_existing');
    assert.equal(ddbMock.commandCalls(PutCommand).length, 0);
  });

  test('job_runs=running 但 official final 已存在時，不應視為 already_running', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'running' } });
    ddbMock.on(QueryCommand).resolves({
      Items: [{ monthKey: '2026-03', ts: '2026-03-31T15:58:00.000Z#historical_backfill#old', source: 'historical_backfill', isOfficialFinal: true, totalUsage: 310 }],
    });

    const result = await runBackfill({ month: '2026-03', dryRun: false, rebuild: false });

    assert.equal(result.status, 'skipped_existing');
    assert.equal(result.snapshot?.totalUsage, 310);
  });

  test('job_runs=success 但 official final 不存在時，不可直接 skipped_existing', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 10, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'success', attempts: 1 } });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).rejects(Object.assign(new Error('ConditionalCheckFailed'), { name: 'ConditionalCheckFailedException' }));

    await assert.rejects(
      () => runBackfill({ month: '2026-03', dryRun: false, rebuild: false }),
      /job_runs=success 但 official final 不存在/,
    );
  });

  test('job_runs=success 且 final 在 grace recheck 後出現時，應回 skipped_existing', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 10, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'success', attempts: 1 } });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [{ monthKey: '2026-03', ts: '2026-03-31T15:58:00.000Z#historical_backfill#late', source: 'historical_backfill', isOfficialFinal: true, totalUsage: 310 }] });
    ddbMock.on(PutCommand).rejects(Object.assign(new Error('ConditionalCheckFailed'), { name: 'ConditionalCheckFailedException' }));

    const result = await runBackfill({ month: '2026-03', dryRun: false, rebuild: false });

    assert.equal(result.status, 'skipped_existing');
    assert.equal(result.snapshot?.totalUsage, 310);
  });

  test('rebuild 寫入失敗時，舊 official final 不應先被刪掉', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 10, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'success', attempts: 1 } });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).rejectsOnce(new Error('ddb-put-fail'));

    await assert.rejects(
      () => runBackfill({ month: '2026-03', dryRun: false, rebuild: true }),
      /ddb-put-fail/,
    );

    assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 0, '失敗前不應 promote build');
  });

  test('讀取 official final 失敗時應直接拋錯，不應誤判成缺資料', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 10, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).rejectsOnce(new Error('ddb-query-fail'));

    await assert.rejects(
      () => runBackfill({ month: '2026-03', dryRun: false, rebuild: false }),
      /ddb-query-fail/,
    );

    assert.equal(ddbMock.commandCalls(PutCommand).length, 0, '讀取 official final 失敗時不應開始寫入 backfill');
    assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 0, '讀取 official final 失敗時不應 promote');
  });

  test('promote 成功後若 cleanup 失敗，仍應保留新 official final 並回傳 success', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 10, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand)
      .callsFake((input) => {
        const values = input?.ExpressionAttributeValues || {};
        if (values[':buildId']) {
          return {
            Items: Array.from({ length: 31 }, (_, idx) => ({
              monthKey: '2026-03',
              ts: `2026-03-${String(idx + 1).padStart(2, '0')}T15:58:00.000Z#historical_backfill#${values[':buildId']}`,
              effectiveTs: `2026-03-${String(idx + 1).padStart(2, '0')}T15:58:00.000Z`,
              source: 'historical_backfill',
              backfillBuildId: values[':buildId'],
              totalUsage: (idx + 1) * 10,
            })),
          };
        }
        return {
          Items: [
            { monthKey: '2026-03', ts: '2026-03-31T15:58:00.000Z#historical_backfill#old-build', source: 'historical_backfill', backfillBuildId: 'old-build', isOfficialFinal: true },
          ],
        };
      });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(PutCommand).callsFake((input) => ({ Attributes: input.Item }));
    ddbMock.on(DeleteCommand).rejects(new Error('cleanup-delete-fail'));

    const result = await runBackfill({ month: '2026-03', dryRun: false, rebuild: true });

    assert.equal(result.status, 'success');
    assert.equal(result.snapshot?.isOfficialFinal, true);
    const buildQueries = ddbMock.commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.ExpressionAttributeValues?.[':buildId']);
    assert.equal(buildQueries.length, 1, 'cleanup 失敗後不應再 rollback 當前 promoted build');
  });

  test('promote 成功後若 success job_run 寫入失敗，仍應保留新 official final 並回傳 success', async () => {
    mockGetDailyDelivery = async () => ({ status: 'ready', totalUsage: 10, raw: { status: 'ready' } });
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .callsFake((input) => {
        const values = input?.ExpressionAttributeValues || {};
        if (values[':buildId']) {
          return {
            Items: Array.from({ length: 31 }, (_, idx) => ({
              monthKey: '2026-03',
              ts: `2026-03-${String(idx + 1).padStart(2, '0')}T15:58:00.000Z#historical_backfill#${values[':buildId']}`,
              effectiveTs: `2026-03-${String(idx + 1).padStart(2, '0')}T15:58:00.000Z`,
              source: 'historical_backfill',
              backfillBuildId: values[':buildId'],
              totalUsage: (idx + 1) * 10,
            })),
          };
        }
        return { Items: [] };
      });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(PutCommand).callsFake((input) => {
      if (input.Item?.jobId === 'backfill#2026-03' && input.Item?.status === 'success') {
        throw new Error('job-run-success-fail');
      }
      return {};
    });
    ddbMock.on(DeleteCommand).resolves({});

    const result = await runBackfill({ month: '2026-03', dryRun: false });

    assert.equal(result.status, 'success');
    assert.equal(result.snapshot?.isOfficialFinal, true);
    const buildQueries = ddbMock.commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.ExpressionAttributeValues?.[':buildId']);
    assert.equal(buildQueries.length, 1, 'success job_run 寫入失敗後不應 rollback 當前 promoted build');
  });
});

describe('getMonthlyCloseWaitTimeoutMs', () => {
  test('預設等待時間應大於固定 30 秒，足以覆蓋整月 backfill', () => {
    const timeoutMs = getMonthlyCloseWaitTimeoutMs('2026-03', {
      LINE_API_TIMEOUT_MS: '10000',
      LINE_API_MAX_ATTEMPTS: '3',
      LINE_API_RETRY_BASE_MS: '500',
      LINE_API_RETRY_JITTER_MS: '250',
    });

    assert.ok(timeoutMs > 30000);
    assert.ok(timeoutMs >= 31 * 30000, '應至少大於 31 天 sequential API 的粗略預算');
  });

  test('若設定 MONTHLY_CLOSE_WAIT_MS，應優先使用顯式值', () => {
    const timeoutMs = getMonthlyCloseWaitTimeoutMs('2026-03', {
      MONTHLY_CLOSE_WAIT_MS: '45000',
    });

    assert.equal(timeoutMs, 45000);
  });
});

describe('waitForOfficialFinal', () => {
  test('已有進行中的 backfill 成功完成時，應等待到 official final 出現', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [{ monthKey: '2026-03', ts: '2026-03-31T15:58:00.000Z#historical_backfill#build-new', totalUsage: 310, isOfficialFinal: true }] });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'running' } });

    const result = await waitForOfficialFinal('2026-03', { timeoutMs: 50, intervalMs: 1 });

    assert.equal(result?.totalUsage, 310);
  });

  test('已有進行中的 backfill 若已 failed，應提早停止等待', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'failed', lastError: 'unready-day' } });

    await assert.rejects(
      () => waitForOfficialFinal('2026-03', { timeoutMs: 100, intervalMs: 10 }),
      /backfill 已失敗：unready-day/,
    );
  });

  test('backfill job 已 success 但 official final 仍不存在時，應立即視為不一致狀態', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'success' } });

    await assert.rejects(
      () => waitForOfficialFinal('2026-03', { timeoutMs: 100, intervalMs: 10 }),
      /job_runs=success 但 official final 不存在/,
    );
  });

  test('backfill job 已 success 且 final 在 grace recheck 後出現時，不應誤判為不一致', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [{ monthKey: '2026-03', ts: '2026-03-31T15:58:00.000Z#historical_backfill#late', totalUsage: 310, isOfficialFinal: true }] });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'success' } });

    const result = await waitForOfficialFinal('2026-03', { timeoutMs: 100, intervalMs: 10, finalGraceMs: 0 });

    assert.equal(result?.totalUsage, 310);
  });

  test('若 concurrent backfill 持續 running 且未完成，應在 timeout 後回傳 null', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: { jobId: 'backfill#2026-03', status: 'running' } });

    const result = await waitForOfficialFinal('2026-03', { timeoutMs: 5, intervalMs: 1 });

    assert.equal(result, null);
  });
});
