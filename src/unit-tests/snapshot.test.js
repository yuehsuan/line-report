import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

// ── DynamoDB mock（必須在 import 之前設定）────────────────────────
const ddbMock = mockClient(DynamoDBDocumentClient);

// ── 設定環境變數 ──────────────────────────────────────────────────
const originalEnv = {};
const envKeys = [
  'DRY_RUN', 'LINE_CHANNEL_ACCESS_TOKEN',
  'AWS_ENDPOINT_URL', 'DDB_TABLE_SNAPSHOTS', 'DDB_TABLE_RUNS',
];

before(() => {
  for (const k of envKeys) originalEnv[k] = process.env[k];
  process.env.DRY_RUN                    = 'true';
  process.env.LINE_CHANNEL_ACCESS_TOKEN  = 'test-token';
  process.env.AWS_ENDPOINT_URL           = 'http://localhost:8000';
  process.env.DDB_TABLE_SNAPSHOTS        = 'usage_snapshots';
  process.env.DDB_TABLE_RUNS             = 'job_runs';
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

// ── mock lineApi（用 esmock 攔截 ESM 模組，取代 mock.module）──────
// mock.module() 在 Node.js v22+ ESM 環境下不穩定，esmock 是正式替代方案。
// mockGetConsumption 以 closure 包裝，讓各測試可在執行時替換行為。
let mockGetConsumption = async () => ({ totalUsage: 5000 });

const { runSnapshot } = await esmock('../actions/snapshot.js', {
  '../lib/lineApi.js': {
    getConsumption: async (...args) => mockGetConsumption(...args),
    pushMessage: async () => {},
  },
});

// ── 輔助：mock process.exit ──────────────────────────────────────
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
// 幂等略過：今日已成功執行則略過
// ─────────────────────────────────────────────
describe('runSnapshot - 幂等略過', () => {
  test('getJobRun 回傳 status=success → 直接 return，不呼叫 LINE API', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { jobId: 'snapshot#today', status: 'success' },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    let getConsumptionCalled = false;
    mockGetConsumption = async () => {
      getConsumptionCalled = true;
      return { totalUsage: 9999 };
    };

    await runSnapshot();

    assert.equal(getConsumptionCalled, false, 'getConsumption 不應被呼叫');
    assert.equal(ddbMock.commandCalls(PutCommand).length, 0, 'PutCommand 不應被呼叫');
  });
});

// ─────────────────────────────────────────────
// 正常執行：status=success，含 ttl 欄位驗證（L-2）
// ─────────────────────────────────────────────
describe('runSnapshot - 正常執行', () => {
  test('job_run 應記錄 status=success，且 ttl 欄位為 90 天後的 Unix timestamp', async () => {
    mockGetConsumption = async () => ({ totalUsage: 5000 });

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({});

    const beforeTs = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60 - 5;
    await runSnapshot();
    const afterTs = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60 + 5;

    const putCalls = ddbMock.commandCalls(PutCommand);
    const successCall = putCalls.find(
      (c) => c.args[0].input.Item?.status === 'success',
    );
    assert.ok(successCall, 'PutCommand 應有 status=success 的呼叫');

    const item = successCall.args[0].input.Item;
    assert.equal(item.totalUsage, 5000);
    assert.ok(typeof item.ttl === 'number', 'ttl 應為 number');
    assert.ok(item.ttl >= beforeTs && item.ttl <= afterTs, 'ttl 應在 90 天後的合理範圍');
  });
});

// ─────────────────────────────────────────────
// totalUsage 格式異常：靜默寫入 undefined 的防護（L-3）
// ─────────────────────────────────────────────
describe('runSnapshot - totalUsage 格式異常', () => {
  test('getConsumption 回傳 {} → status=failed，lastError 含「格式異常」', withMockedExit(async (t) => {
    mockGetConsumption = async () => ({});  // totalUsage 為 undefined

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await assert.rejects(
      () => runSnapshot(),
      (e) => e.message.startsWith(EXIT_SENTINEL) && e.message.endsWith('1'),
      'process.exit(1) 應被呼叫',
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    const failedCall = putCalls.find((c) => c.args[0].input.Item?.status === 'failed');
    assert.ok(failedCall, 'PutCommand 應有 status=failed 的呼叫');
    assert.match(failedCall.args[0].input.Item.lastError, /格式異常/, 'lastError 應含「格式異常」');
  }));
});

// ─────────────────────────────────────────────
// LINE API 失敗：process.exit(1) 並記錄 failed
// ─────────────────────────────────────────────
describe('runSnapshot - LINE API 失敗', () => {
  test('getConsumption 拋出例外 → status=failed，process.exit(1)', withMockedExit(async () => {
    mockGetConsumption = async () => {
      throw new Error('LINE API connection timeout');
    };

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await assert.rejects(
      () => runSnapshot(),
      (e) => e.message.startsWith(EXIT_SENTINEL) && e.message.endsWith('1'),
      'process.exit(1) 應被呼叫',
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    const failedCall = putCalls.find((c) => c.args[0].input.Item?.status === 'failed');
    assert.ok(failedCall, 'PutCommand 應有 status=failed 的呼叫');
    assert.match(
      failedCall.args[0].input.Item.lastError,
      /LINE API connection timeout/,
      'lastError 應含原始錯誤訊息',
    );
  }));
});

// ─────────────────────────────────────────────
// 跨月封存 Bug 修復驗證（M-3）
// ─────────────────────────────────────────────
describe('runSnapshot - 跨月封存邊界', () => {
  test('本月已有快照但上月 prevMonthFinal 為 null → markPrevMonthFinal 應被呼叫', async () => {
    mockGetConsumption = async () => ({ totalUsage: 3000 });

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    // QueryCommand 依序：
    // 1. detectAndSealPrevMonth → getPrevMonthFinalSnapshot（回傳空，表示上月未封存）
    // 2. detectAndSealPrevMonth → markPrevMonthFinal → getPrevMonthFinalSnapshot（空）
    // 3. detectAndSealPrevMonth → markPrevMonthFinal → querySnapshots（回傳上月快照）
    // 4. writeSnapshot 內部用到的 conditional check（直接 PutCommand）
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [] })         // getPrevMonthFinalSnapshot → 上月未封存
      .resolvesOnce({ Items: [] })         // markPrevMonthFinal → getPrevMonthFinalSnapshot → 無
      .resolvesOnce({                      // markPrevMonthFinal → querySnapshots → 有上月快照
        Items: [{ monthKey: '2026-02', ts: '2026-02-28T15:55:00.000Z', totalUsage: 4000 }],
      })
      .resolves({ Items: [] });            // 後續查詢

    ddbMock.on(UpdateCommand).resolves({});

    await runSnapshot();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    assert.ok(updateCalls.length >= 1, 'UpdateCommand（markPrevMonthFinal）應至少被呼叫一次');
  });

  test('上月 prevMonthFinal 已存在 → markPrevMonthFinal 不被呼叫', async () => {
    mockGetConsumption = async () => ({ totalUsage: 3000 });

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({                      // getPrevMonthFinalSnapshot → 上月已封存
        Items: [{ monthKey: '2026-02', ts: '2026-02-28T15:55:00.000Z', isPrevMonthFinal: true }],
      })
      .resolves({ Items: [] });

    await runSnapshot();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    assert.equal(updateCalls.length, 0, 'UpdateCommand（markPrevMonthFinal）不應被呼叫');
  });
});
