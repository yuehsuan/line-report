import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';

let mockGetOfficialFinalSnapshot = async () => null;
let mockRunBackfill = async () => ({ status: 'success', snapshot: null, rows: [] });
let mockRunReport = async () => {};
let mockWaitForOfficialFinal = async () => ({ monthKey: '2026-02', totalUsage: 9000, effectiveTs: '2026-02-31T15:58:00.000Z' });
let mockGetMonthState = async () => ({
  officialFinalSnapshotTs: '2026-02-31T15:58:00.000Z',
  reportPublished: false,
  publishedSnapshotTs: null,
  reportOutOfSync: false,
});

const { runMonthlyClose } = await esmock('../actions/monthlyClose.js', {
  '../lib/storage.js': {
    getOfficialFinalSnapshot: async (...args) => mockGetOfficialFinalSnapshot(...args),
  },
  '../actions/backfill.js': {
    runBackfill: async (...args) => mockRunBackfill(...args),
    waitForOfficialFinal: async (...args) => mockWaitForOfficialFinal(...args),
  },
  '../actions/report.js': {
    runPublishReport: async (...args) => mockRunReport(...args),
  },
  '../lib/storage.js': {
    getOfficialFinalSnapshot: async (...args) => mockGetOfficialFinalSnapshot(...args),
    getMonthState: async (...args) => mockGetMonthState(...args),
    classifyMonthState: (item) => {
      if (item.reportPublished === false && item.publishedSnapshotTs == null && item.reportOutOfSync === false) return 'unpublished_ready';
      if (item.reportPublished === true && item.publishedSnapshotTs && item.reportOutOfSync === false && item.officialFinalSnapshotTs === item.publishedSnapshotTs) return 'already_converged';
      if (item.reportPublished === true && item.publishedSnapshotTs && item.reportOutOfSync === true) return 'out_of_sync';
      return 'invalid_month_state';
    },
  },
});

beforeEach(() => {
  process.env.DRY_RUN = 'false';
  process.env.PATCH_A_CUTOVER_MONTH = '2026-01';
  process.env.MONTHLY_CLOSE_SCHEDULED = 'true';
  mockGetOfficialFinalSnapshot = async () => null;
  mockRunBackfill = async () => ({ status: 'success', snapshot: null, rows: [] });
  mockRunReport = async () => {};
  mockWaitForOfficialFinal = async () => ({ monthKey: '2026-02', totalUsage: 9000, effectiveTs: '2026-02-31T15:58:00.000Z' });
  mockGetMonthState = async () => ({
    officialFinalSnapshotTs: '2026-02-31T15:58:00.000Z',
    reportPublished: false,
    publishedSnapshotTs: null,
    reportOutOfSync: false,
  });
});

describe('runMonthlyClose', () => {
  test('已有 official final 時直接呼叫 runReport', async () => {
    const snapshot = { monthKey: '2026-02', totalUsage: 9000, effectiveTs: '2026-02-31T15:58:00.000Z' };
    mockGetOfficialFinalSnapshot = async () => snapshot;
    let received;
    mockRunReport = async (args) => {
      received = args;
    };

    await runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: false });

    assert.equal(received.snapshotOverride, snapshot);
    assert.equal(received.month, '2026-02');
  });

  test('dry-run 且缺 official final 時，應用 preview rows 產生報表，不寫正式資料', async () => {
    process.env.DRY_RUN = 'true';
    mockRunBackfill = async ({ dryRun }) => {
      assert.equal(dryRun, true);
      return {
        status: 'dry_run_success',
        rows: [
          { monthKey: '2026-02', effectiveTs: '2026-02-30T15:58:00.000Z', totalUsage: 8000 },
          { monthKey: '2026-02', effectiveTs: '2026-02-31T15:58:00.000Z', totalUsage: 9000 },
        ],
      };
    };
    let received;
    mockRunReport = async (args) => {
      received = args;
    };

    await runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: true });

    assert.equal(received.dryRun, true);
    assert.equal(received.snapshotOverride.totalUsage, 9000);
  });

  test('dry-run backfill 可重跑時，重複 monthly close 仍應可產生新 preview', async () => {
    let callCount = 0;
    mockRunBackfill = async () => {
      callCount += 1;
      return {
        status: 'dry_run_success',
        rows: [
          { monthKey: '2026-02', effectiveTs: '2026-02-31T15:58:00.000Z', totalUsage: 9000 + callCount },
        ],
      };
    };

    let received;
    mockRunReport = async (args) => {
      received = args;
    };

    await runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: true });
    assert.equal(received.snapshotOverride.totalUsage, 9001);

    await runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: true });
    assert.equal(received.snapshotOverride.totalUsage, 9002);
  });

  test('backfill 已在 running 時應等待 official final 後再 runReport', async () => {
    let reportCalled = false;
    mockRunBackfill = async () => ({ status: 'already_running' });
    mockRunReport = async (args) => {
      reportCalled = true;
      assert.equal(args.snapshotOverride.totalUsage, 9000);
    };

    await runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: false });

    assert.equal(reportCalled, true);
  });

  test('backfill 回傳 skipped_existing 且帶 snapshot 時，應直接用該 final 產生月報', async () => {
    let received;
    mockRunBackfill = async () => ({
      status: 'skipped_existing',
      snapshot: { monthKey: '2026-02', totalUsage: 9100, effectiveTs: '2026-02-31T15:58:00.000Z' },
    });
    mockRunReport = async (args) => {
      received = args;
    };

    await runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: false });

    assert.equal(received.snapshotOverride.totalUsage, 9100);
  });

  test('backfill 已 failed 時應直接拋出明確錯誤，不應繼續等待到 timeout', async () => {
    mockRunBackfill = async () => ({ status: 'already_running' });
    mockWaitForOfficialFinal = async () => {
      throw new Error('2026-02 backfill 已失敗：unready-day');
    };

    await assert.rejects(
      () => runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: false }),
      /backfill 已失敗：unready-day/,
    );
  });

  test('backfill terminal success 但無 official final 時，應明確失敗', async () => {
    mockRunBackfill = async () => ({ status: 'already_running' });
    mockWaitForOfficialFinal = async () => {
      throw new Error('2026-02 backfill job_runs=success 但 official final 不存在');
    };

    await assert.rejects(
      () => runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: false }),
      /job_runs=success 但 official final 不存在/,
    );
  });

  test('backfill terminal success 但 final 經 grace recheck 後出現時，monthly close 應可繼續', async () => {
    let received;
    mockRunBackfill = async () => ({ status: 'already_running' });
    mockWaitForOfficialFinal = async () => ({ monthKey: '2026-02', totalUsage: 9200, effectiveTs: '2026-02-31T15:58:00.000Z' });
    mockRunReport = async (args) => {
      received = args;
    };

    await runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: false });

    assert.equal(received.snapshotOverride.totalUsage, 9200);
  });

  test('讀取 official final 發生 storage error 時應直接拋錯', async () => {
    mockGetOfficialFinalSnapshot = async () => {
      throw new Error('ddb-query-fail');
    };

    await assert.rejects(
      () => runMonthlyClose({ mode: 'manual', month: '2026-02', confirmMonth: '2026-02', dryRun: false }),
      /ddb-query-fail/,
    );
  });
});
