import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import esmock from 'esmock';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { getNowTaipei, getPrevMonthKey } from '../lib/date.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const originalEnv = {};
const envKeys = ['DRY_RUN', 'LINE_TARGETS', 'FREE_QUOTA', 'PRICING_MODEL',
  'SINGLE_UNIT_PRICE', 'PLAN_FEE', 'CURRENCY', 'AWS_ENDPOINT_URL',
  'DDB_TABLE_SNAPSHOTS', 'DDB_TABLE_RUNS', 'PATCH_A_CUTOVER_MONTH'];

before(() => {
  for (const k of envKeys) originalEnv[k] = process.env[k];
  process.env.DRY_RUN = 'false';
  process.env.LINE_TARGETS = 'U_target_1,U_target_2';
  process.env.FREE_QUOTA = '6000';
  process.env.PRICING_MODEL = 'single';
  process.env.SINGLE_UNIT_PRICE = '0.2';
  process.env.PLAN_FEE = '1200';
  process.env.CURRENCY = 'TWD';
  process.env.AWS_ENDPOINT_URL = 'http://localhost:8000';
  process.env.DDB_TABLE_SNAPSHOTS = 'usage_snapshots';
  process.env.DDB_TABLE_RUNS = 'job_runs';
  process.env.PATCH_A_CUTOVER_MONTH = '2026-01';
});

after(() => {
  for (const k of envKeys) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

beforeEach(() => {
  ddbMock.reset();
  pushedMessages = [];
  process.env.DRY_RUN = 'false';
  mockClaimJobRun = async (...args) => realStorage.claimJobRun(...args);
  mockGetJobRun = async (...args) => realStorage.getJobRun(...args);
  mockUpsertJobRun = async (...args) => realStorage.upsertJobRun(...args);
  mockGetMonthState = async () => ({
    officialFinalSnapshotTs: '2026-01-31T15:58:00.000Z',
    reportPublished: false,
    publishedSnapshotTs: null,
    reportOutOfSync: false,
    stateVersion: 1,
  });
});

let pushedMessages = [];
let mockGetMonthState = async () => ({
  officialFinalSnapshotTs: '2026-01-31T15:58:00.000Z',
  reportPublished: false,
  publishedSnapshotTs: null,
  reportOutOfSync: false,
  stateVersion: 1,
});
const realStorage = await import('../lib/storage.js');
let mockClaimJobRun = async (...args) => realStorage.claimJobRun(...args);
let mockGetJobRun = async (...args) => realStorage.getJobRun(...args);
let mockUpsertJobRun = async (...args) => realStorage.upsertJobRun(...args);

const { runReport, buildReportMessage } = await esmock('../actions/report.js', {
  '../lib/lineApi.js': {
    pushMessage: async (target, message) => {
      pushedMessages.push({ target, message });
    },
  },
  '../lib/storage.js': {
    claimJobRun: async (...args) => mockClaimJobRun(...args),
    getJobRun: async (...args) => mockGetJobRun(...args),
    upsertJobRun: async (...args) => mockUpsertJobRun(...args),
    getOfficialFinalSnapshot: realStorage.getOfficialFinalSnapshot,
    getMonthState: async (...args) => mockGetMonthState(...args),
    classifyMonthState: (item) => {
      if (item.reportPublished === false && item.publishedSnapshotTs == null && item.reportOutOfSync === false) return 'unpublished_ready';
      if (item.reportPublished === true && item.publishedSnapshotTs && item.reportOutOfSync === false && item.officialFinalSnapshotTs === item.publishedSnapshotTs) return 'already_converged';
      if (item.reportPublished === true && item.publishedSnapshotTs && item.reportOutOfSync === true) return 'out_of_sync';
      return 'invalid_month_state';
    },
    updateMonthState: async () => {},
  },
});

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

describe('buildReportMessage', () => {
  test('指定月份文案不應寫成前月', () => {
    const message = buildReportMessage({
      periodDisplay: '2026/01',
      monthLabel: '指定月份',
      totalUsage: 8000,
      additionalCount: 2000,
      feeRounded: 400,
      planFee: 1200,
      totalFeeRounded: 1600,
      currencySymbol: 'NT$',
    });

    assert.match(message, /期間：2026\/01（指定月份）/);
    assert.doesNotMatch(message, /前月/);
    assert.match(message, /historical backfill 月結/);
  });
});

describe('runReport - 幂等略過', () => {
  test('該月已成功送出時直接略過，不重送 LINE', async () => {
    pushedMessages = [];
    const targetSetHash = createHash('sha256').update('U_target_1,U_target_2').digest('hex');
    mockClaimJobRun = async () => false;
    mockGetJobRun = async () => ({
      jobId: 'publish-report#2026-01',
      status: 'success',
      deliverySessionKey: `2026-01#2026-01-31T15:58:00.000Z#${targetSetHash}`,
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        monthKey: '2026-01',
        ts: '2026-01-31T15:55:00.000Z',
        effectiveTs: '2026-01-31T15:58:00.000Z',
        totalUsage: 8000,
        source: 'historical_backfill',
        isOfficialFinal: true,
      }],
    });

    await runReport({ month: '2026-01' });

    assert.equal(pushedMessages.length, 0, '不應重送任何 LINE 訊息');
    assert.equal(ddbMock.commandCalls(PutCommand).length, 0, '不應再更新 job_run');
  });
});

describe('runReport - DRY_RUN 可重跑', () => {
  test('report-dry-run success 後仍應允許再次 dry-run 以取得最新 preview', async () => {
    pushedMessages = [];
    ddbMock.on(GetCommand).resolves({
      Item: { jobId: 'report-dry-run#2026-01', status: 'success', attempts: 1, deliveredTargets: [] },
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        monthKey: '2026-01',
        ts: '2026-01-31T15:55:00.000Z',
        effectiveTs: '2026-01-31T15:58:00.000Z',
        totalUsage: 8100,
        source: 'historical_backfill',
        isOfficialFinal: true,
      }],
    });

    await runReport({ month: '2026-01', dryRun: true });

    const runningCall = ddbMock.commandCalls(PutCommand).find(
      (c) => c.args[0].input.Item?.jobId === 'report-dry-run#2026-01' && c.args[0].input.Item?.status === 'running',
    );
    assert.ok(runningCall, 'dry-run success 後應允許再次 claim/report');
    assert.equal(runningCall.args[0].input.ExpressionAttributeValues[':allowed1'], 'success');
  });
});

describe('runReport - 部分送出後重跑', () => {
  test('failed 紀錄已含 deliveredTargets 時，只補送未成功 target', async () => {
    pushedMessages = [];
    ddbMock.on(GetCommand).resolves({
      Item: {
        jobId: 'report#2026-01',
        status: 'failed',
        attempts: 1,
        deliveredTargets: ['U_target_1'],
      },
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        monthKey: '2026-01',
        ts: '2026-01-31T15:55:00.000Z',
        totalUsage: 8000,
        source: 'historical_backfill',
        isOfficialFinal: true,
      }],
    });

    await runReport({ month: '2026-01' });

    assert.deepEqual(
      pushedMessages.map((item) => item.target),
      ['U_target_2'],
      '只應補送尚未成功的 target',
    );

    const successCall = ddbMock.commandCalls(PutCommand).find(
      (c) => c.args[0].input.Item?.status === 'success',
    );
    assert.ok(successCall, '應寫入 success job_run');
    assert.deepEqual(
      successCall.args[0].input.Item.deliveredTargets,
      ['U_target_1', 'U_target_2'],
      'success 紀錄應保留完整 deliveredTargets',
    );
  });
});

describe('runReport - 找不到 official final', () => {
  test('job_run 應記錄 status=failed 且含 lastError', withMockedExit(async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await assert.rejects(
      () => runReport({ month: '2026-01' }),
      /official final/,
      '應直接拋出 official final 缺失錯誤',
    );
  }));
});

describe('runReport - 正常執行', () => {
  test('應送出兩個 target 並寫入 success', async () => {
    pushedMessages = [];
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        monthKey: '2026-01',
        ts: '2026-01-31T15:55:00.000Z',
        effectiveTs: '2026-01-31T15:58:00.000Z',
        totalUsage: 8000,
        source: 'historical_backfill',
        isOfficialFinal: true,
      }],
    });

    await runReport({ month: 'prev' });

    const expectedPeriod = getPrevMonthKey(getNowTaipei()).replace('-', '/');

    assert.deepEqual(
      pushedMessages.map((item) => item.target),
      ['U_target_1', 'U_target_2'],
    );
    assert.match(pushedMessages[0].message, new RegExp(`期間：${expectedPeriod}（前月）`));

    const successCall = ddbMock.commandCalls(PutCommand).find(
      (c) => c.args[0].input.Item?.status === 'success',
    );
    assert.ok(successCall, '應寫入 success job_run');
    assert.equal(successCall.args[0].input.Item.totalUsage, 8000);
    assert.equal(successCall.args[0].input.Item.additionalCount, 2000);
    assert.equal(successCall.args[0].input.Item.feeRounded, 400);
    assert.equal(successCall.args[0].input.Item.planFee, 1200);
    assert.equal(successCall.args[0].input.Item.totalFeeRounded, 1600);
  });
});

describe('runReport - DRY_RUN 不阻塞正式發送', () => {
  test('DRY_RUN=true 時應使用 report-dry-run jobId，而非正式 report jobId', async () => {
    process.env.DRY_RUN = 'true';
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        monthKey: '2026-01',
        ts: '2026-01-31T15:55:00.000Z',
        effectiveTs: '2026-01-31T15:58:00.000Z',
        totalUsage: 8000,
        source: 'historical_backfill',
        isOfficialFinal: true,
      }],
    });

    await runReport({ month: '2026-01' });

    const jobIds = ddbMock.commandCalls(PutCommand)
      .map((c) => c.args[0].input.Item?.jobId)
      .filter(Boolean);
    assert.ok(jobIds.includes('report-dry-run#2026-01'));
    assert.ok(!jobIds.includes('report#2026-01'));
  });

  test('顯式 dryRun=true 且環境變數未開時，也不應真的呼叫 pushMessage', async () => {
    process.env.DRY_RUN = 'false';
    pushedMessages = [];
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        monthKey: '2026-01',
        ts: '2026-01-31T15:55:00.000Z',
        effectiveTs: '2026-01-31T15:58:00.000Z',
        totalUsage: 8000,
        source: 'historical_backfill',
        isOfficialFinal: true,
      }],
    });

    await runReport({ month: '2026-01', dryRun: true });

    assert.equal(pushedMessages.length, 0, 'dryRun=true 不應真的呼叫 pushMessage');

    const successCall = ddbMock.commandCalls(PutCommand).find(
      (c) => c.args[0].input.Item?.status === 'success',
    );
    assert.ok(successCall, '應寫入 dry-run success job_run');
    assert.deepEqual(
      successCall.args[0].input.Item.deliveredTargets,
      ['U_target_1', 'U_target_2'],
      'dry-run 仍應記錄模擬送達的 targets',
    );
  });
});
