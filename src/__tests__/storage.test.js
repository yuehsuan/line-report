import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

// ── 設定 mock（必須在 import storage 之前）────────────────────────
const ddbMock = mockClient(DynamoDBDocumentClient);

// 動態 import 確保 mock 已設定
const { writeSnapshot, getPrevMonthFinalSnapshot, markPrevMonthFinal, getJobRun, upsertJobRun } =
  await import('../lib/storage.js');

beforeEach(() => {
  ddbMock.reset();
});

// ─────────────────────────────────────────────
// writeSnapshot：idempotent 防重
// ─────────────────────────────────────────────
describe('writeSnapshot', () => {
  test('正常寫入：PutCommand 被呼叫', async () => {
    ddbMock.on(PutCommand).resolves({});
    await assert.doesNotReject(() =>
      writeSnapshot({
        monthKey: '2026-02',
        ts: '2026-02-25T15:55:00.000Z',
        totalUsage: 1500,
        rawJson: '{"totalUsage":1500}',
      })
    );
    assert.equal(ddbMock.commandCalls(PutCommand).length, 1);
  });

  test('ConditionalCheckFailedException：應被吞掉，不拋出', async () => {
    const err = new Error('ConditionalCheckFailed');
    err.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(err);

    await assert.doesNotReject(() =>
      writeSnapshot({
        monthKey: '2026-02',
        ts: '2026-02-25T15:55:00.000Z',
        totalUsage: 1500,
        rawJson: '{}',
      })
    );
  });

  test('其他 DynamoDB 錯誤應重新拋出', async () => {
    const err = new Error('ProvisionedThroughputExceeded');
    err.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(PutCommand).rejects(err);

    await assert.rejects(() =>
      writeSnapshot({
        monthKey: '2026-02',
        ts: '2026-02-25T15:55:00.000Z',
        totalUsage: 1500,
        rawJson: '{}',
      })
    );
  });
});

// ─────────────────────────────────────────────
// getPrevMonthFinalSnapshot
// ─────────────────────────────────────────────
describe('getPrevMonthFinalSnapshot', () => {
  test('找不到 prevMonthFinal 時應回傳 null（非拋出）', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await getPrevMonthFinalSnapshot('2026-01');
    assert.equal(result, null);
  });

  test('找到 isPrevMonthFinal=true 的快照時回傳最後一筆', async () => {
    const items = [
      { monthKey: '2026-01', ts: '2026-01-30T15:55:00.000Z', totalUsage: 5000, isPrevMonthFinal: true },
      { monthKey: '2026-01', ts: '2026-01-31T15:55:00.000Z', totalUsage: 5200, isPrevMonthFinal: true },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });
    const result = await getPrevMonthFinalSnapshot('2026-01');
    assert.ok(result !== null);
    assert.equal(result.ts, '2026-01-31T15:55:00.000Z');
  });
});

// ─────────────────────────────────────────────
// markPrevMonthFinal
// ─────────────────────────────────────────────
describe('markPrevMonthFinal', () => {
  test('上月已有 prevMonthFinal 時略過（不重複 update）', async () => {
    const existingFinal = {
      monthKey: '2026-01',
      ts: '2026-01-31T15:55:00.000Z',
      totalUsage: 5200,
      isPrevMonthFinal: true,
    };
    ddbMock.on(QueryCommand).resolves({ Items: [existingFinal] });

    const result = await markPrevMonthFinal('2026-01');
    assert.equal(ddbMock.commandCalls(UpdateCommand).length, 0, 'Update 不應被呼叫');
    assert.deepEqual(result, existingFinal);
  });

  test('多筆快照時取 SK 最大（最後一筆）並 update', async () => {
    // 第一次 query（getPrevMonthFinalSnapshot）：無 final
    // 第二次 query（querySnapshots descending）：回傳兩筆，第一筆為最新
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [] })  // getPrevMonthFinalSnapshot → 無
      .resolvesOnce({               // querySnapshots → 回傳降序兩筆
        Items: [
          { monthKey: '2026-01', ts: '2026-01-31T15:55:00.000Z', totalUsage: 5200 },
          { monthKey: '2026-01', ts: '2026-01-30T15:55:00.000Z', totalUsage: 5000 },
        ],
      });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await markPrevMonthFinal('2026-01');
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    assert.equal(updateCalls.length, 1, 'Update 應被呼叫一次');

    const updateInput = updateCalls[0].args[0].input;
    assert.equal(updateInput.Key.ts, '2026-01-31T15:55:00.000Z', '應更新最後一筆（ts 最大）');
    assert.ok(result !== null);
  });

  test('上月無任何快照時回傳 null', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await markPrevMonthFinal('2026-01');
    assert.equal(result, null);
    assert.equal(ddbMock.commandCalls(UpdateCommand).length, 0);
  });
});

// ─────────────────────────────────────────────
// job_runs：getJobRun / upsertJobRun
// ─────────────────────────────────────────────
describe('getJobRun', () => {
  test('找到紀錄時正確回傳', async () => {
    const item = { jobId: 'snapshot#2026-02-25', status: 'success' };
    ddbMock.on(GetCommand).resolves({ Item: item });
    const result = await getJobRun('snapshot#2026-02-25');
    assert.deepEqual(result, item);
  });

  test('找不到時回傳 null', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await getJobRun('snapshot#2026-02-25');
    assert.equal(result, null);
  });
});

describe('upsertJobRun', () => {
  test('PutCommand 被呼叫並含 jobId', async () => {
    ddbMock.on(PutCommand).resolves({});
    await upsertJobRun('snapshot#2026-02-25', { status: 'running', attempts: 1 });

    const calls = ddbMock.commandCalls(PutCommand);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0].input.Item.jobId, 'snapshot#2026-02-25');
    assert.equal(calls[0].args[0].input.Item.status, 'running');
  });
});
