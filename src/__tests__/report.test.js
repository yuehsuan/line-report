import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

// ── DynamoDB mock（必須在 import 之前設定）────────────────────────
const ddbMock = mockClient(DynamoDBDocumentClient);

// ── 設定環境變數（跳過真實 LINE push 與 AWS）─────────────────────
const originalEnv = {};
const envKeys = ['DRY_RUN', 'LINE_TARGETS', 'FREE_QUOTA', 'PRICING_MODEL',
  'SINGLE_UNIT_PRICE', 'PLAN_FEE', 'CURRENCY', 'AWS_ENDPOINT_URL',
  'DDB_TABLE_SNAPSHOTS', 'DDB_TABLE_RUNS'];

before(() => {
  for (const k of envKeys) originalEnv[k] = process.env[k];
  process.env.DRY_RUN             = 'true';
  process.env.LINE_TARGETS        = 'U_test_user';
  process.env.FREE_QUOTA          = '6000';
  process.env.PRICING_MODEL       = 'single';
  process.env.SINGLE_UNIT_PRICE   = '0.2';
  process.env.PLAN_FEE            = '1200';
  process.env.CURRENCY            = 'TWD';
  process.env.AWS_ENDPOINT_URL    = 'http://localhost:8000';
  process.env.DDB_TABLE_SNAPSHOTS = 'usage_snapshots';
  process.env.DDB_TABLE_RUNS      = 'job_runs';
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

// 動態 import 確保 mock 已設定
const { runReport } = await import('../actions/report.js');

// ─────────────────────────────────────────────
// 輔助：mock process.exit，讓它丟例外以中斷後續執行
// （模擬真實 process.exit 停止程序的行為）
// ─────────────────────────────────────────────
const EXIT_SENTINEL = '__process_exit__';
function withMockedExit(fn) {
  return async (t) => {
    const exitMock = t.mock.method(process, 'exit', (code) => {
      throw new Error(`${EXIT_SENTINEL}${code}`);
    });
    try {
      await fn(t, exitMock);
    } finally {
      exitMock.mock.restore();
    }
  };
}

// ─────────────────────────────────────────────
// 失敗場景：找不到 prevMonthFinal 快照
// ─────────────────────────────────────────────
describe('runReport - 找不到 prevMonthFinal', () => {
  test('job_run 應記錄 status=failed 且含 lastError', withMockedExit(async (t) => {
    // GetItem（getJobRun）→ 尚無執行紀錄
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    // PutCommand → upsertJobRun（running + failed 各一次）
    ddbMock.on(PutCommand).resolves({});

    // QueryCommand → getPrevMonthFinalSnapshot 回傳空陣列
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    // runReport 因 process.exit mock 拋出 sentinel error
    await assert.rejects(
      () => runReport({ month: '2026-01' }),
      (e) => e.message.startsWith(EXIT_SENTINEL) && e.message.endsWith('1'),
      'process.exit(1) 應被呼叫'
    );

    // 確認 PutCommand 有寫入 status=failed
    const putCalls = ddbMock.commandCalls(PutCommand);
    const failedCall = putCalls.find(
      (c) => c.args[0].input.Item?.status === 'failed'
    );
    assert.ok(failedCall, 'PutCommand 應有一次寫入 status=failed');

    const item = failedCall.args[0].input.Item;
    assert.ok(item.lastError, 'lastError 應有錯誤訊息');
    assert.match(item.lastError, /prevMonthFinal/, 'lastError 應提及 prevMonthFinal');
    assert.ok(item.finishedAt, 'finishedAt 應有時間戳記');
  }));
});

// ─────────────────────────────────────────────
// 失敗場景：DynamoDB 查詢拋出例外
// ─────────────────────────────────────────────
describe('runReport - DynamoDB 查詢異常', () => {
  test('job_run 應記錄 status=failed 且 lastError 含錯誤訊息', withMockedExit(async (t) => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB connection timeout'));

    await assert.rejects(
      () => runReport({ month: '2026-01' }),
      (e) => e.message.startsWith(EXIT_SENTINEL) && e.message.endsWith('1'),
      'process.exit(1) 應被呼叫'
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    const failedCall = putCalls.find(
      (c) => c.args[0].input.Item?.status === 'failed'
    );
    assert.ok(failedCall, 'PutCommand 應有一次寫入 status=failed');
    assert.match(
      failedCall.args[0].input.Item.lastError,
      /DynamoDB connection timeout/,
      'lastError 應包含原始錯誤訊息'
    );
  }));
});

// ─────────────────────────────────────────────
// 正常場景：有 prevMonthFinal → DRY_RUN 跳過推播
// ─────────────────────────────────────────────
describe('runReport - 正常執行（DRY_RUN）', () => {
  test('job_run 應記錄 status=success', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        monthKey: '2026-01',
        ts: '2026-01-31T15:55:00.000Z',
        totalUsage: 8000,
        isPrevMonthFinal: true,
      }],
    });

    await runReport({ month: '2026-01' });

    const putCalls = ddbMock.commandCalls(PutCommand);
    const successCall = putCalls.find(
      (c) => c.args[0].input.Item?.status === 'success'
    );
    assert.ok(successCall, 'PutCommand 應有一次寫入 status=success');

    const item = successCall.args[0].input.Item;
    assert.equal(item.totalUsage, 8000);
    assert.equal(item.additionalCount, 2000);   // 8000 - 6000
    assert.equal(item.feeRounded, 400);          // 2000 × 0.2
    assert.equal(item.planFee, 1200);
    assert.equal(item.totalFeeRounded, 1600);    // 400 + 1200
  });
});
