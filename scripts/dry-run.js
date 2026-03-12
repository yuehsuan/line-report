/**
 * dry-run.js — 本機完整流程驗證腳本
 *
 * 使用方式：
 *   1. 啟動 DynamoDB Local：
 *      docker run -p 8000:8000 amazon/dynamodb-local
 *
 *   2. 設定環境變數：
 *      export AWS_ENDPOINT_URL=http://localhost:8000
 *      export AWS_REGION=ap-northeast-1
 *      export LINE_CHANNEL_ACCESS_TOKEN=your_token (或 DRY_RUN=true 跳過 LINE push)
 *      export LINE_TARGETS=C1234567890,Uabcdef1234
 *      export FREE_QUOTA=1000
 *      export PRICING_MODEL=single
 *      export SINGLE_UNIT_PRICE=0.2
 *      export DRY_RUN=true
 *
 *   3. 執行：
 *      node scripts/dry-run.js
 *      node scripts/dry-run.js --step=snapshot   # 只跑快照
 *      node scripts/dry-run.js --step=backfill   # 只跑回補
 *      node scripts/dry-run.js --step=report     # 只跑 monthly close dry-run
 *      node scripts/dry-run.js --inspect         # 顯示 DB 內容
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

import { runSnapshot } from '../src/actions/snapshot.js';
import { runBackfill } from '../src/actions/backfill.js';
import { runMonthlyClose } from '../src/actions/monthlyClose.js';
import { getNowTaipei, getMonthKey, getPrevMonthKey } from '../src/lib/date.js';

// 解析 CLI 參數
const args = process.argv.slice(2);
const stepArg = args.find((a) => a.startsWith('--step='))?.split('=')[1];
const inspect = args.includes('--inspect');

if (!process.env.AWS_ENDPOINT_URL) {
  console.warn('[dry-run] 警告：AWS_ENDPOINT_URL 未設定，將連接真實 AWS DynamoDB！');
  console.warn('[dry-run] 本機測試請設定：export AWS_ENDPOINT_URL=http://localhost:8000');
}

process.env.DRY_RUN = process.env.DRY_RUN || 'true';

const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
  ...(process.env.AWS_ENDPOINT_URL && {
    endpoint: process.env.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }),
});
const docClient = DynamoDBDocumentClient.from(ddbClient);

async function ensureTables() {
  const existing = await ddbClient.send(new ListTablesCommand({}));
  const tables = existing.TableNames || [];

  const tableDefs = [
    {
      TableName: process.env.DDB_TABLE_SNAPSHOTS || 'usage_snapshots',
      KeySchema: [
        { AttributeName: 'monthKey', KeyType: 'HASH' },
        { AttributeName: 'ts', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'monthKey', AttributeType: 'S' },
        { AttributeName: 'ts', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    },
    {
      TableName: process.env.DDB_TABLE_RUNS || 'job_runs',
      KeySchema: [{ AttributeName: 'jobId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'jobId', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    },
  ];

  for (const def of tableDefs) {
    if (!tables.includes(def.TableName)) {
      await ddbClient.send(new CreateTableCommand(def));
      console.log(`[dry-run] 建立資料表：${def.TableName}`);
    } else {
      console.log(`[dry-run] 資料表已存在：${def.TableName}`);
    }
  }
}

async function inspectDb() {
  const snapshotsTable = process.env.DDB_TABLE_SNAPSHOTS || 'usage_snapshots';
  const runsTable = process.env.DDB_TABLE_RUNS || 'job_runs';

  console.log('\n──── usage_snapshots ────────────────────────────────');
  const snapshots = await docClient.send(new ScanCommand({ TableName: snapshotsTable }));
  if (snapshots.Items?.length) {
    snapshots.Items.forEach((item) => {
      console.log(
        `  ${item.monthKey} | ${item.ts} | totalUsage=${item.totalUsage} | source=${item.source || 'live_snapshot'} | isOfficialFinal=${item.isOfficialFinal || false} | isPrevMonthFinal=${item.isPrevMonthFinal}`
      );
    });
  } else {
    console.log('  （空）');
  }

  console.log('\n──── job_runs ────────────────────────────────────────');
  const runs = await docClient.send(new ScanCommand({ TableName: runsTable }));
  if (runs.Items?.length) {
    runs.Items.forEach((item) => {
      console.log(`  ${item.jobId} | status=${item.status} | attempts=${item.attempts}`);
      if (item.lastError) console.log(`    lastError: ${item.lastError}`);
    });
  } else {
    console.log('  （空）');
  }
  console.log('');
}

async function main() {
  console.log('[dry-run] 開始本機驗證');
  console.log(`[dry-run] DRY_RUN=${process.env.DRY_RUN}`);
  console.log(`[dry-run] AWS_ENDPOINT_URL=${process.env.AWS_ENDPOINT_URL || '（未設定）'}`);

  const now = getNowTaipei();
  console.log(`[dry-run] 當前台北時間：${now.toISO()}`);
  console.log(`[dry-run] 當月：${getMonthKey(now)}  上月：${getPrevMonthKey(now)}`);

  await ensureTables();

  if (inspect) {
    await inspectDb();
    return;
  }

  if (!stepArg || stepArg === 'snapshot') {
    console.log('\n[dry-run] ── 執行 snapshot ──────────────────────────');
    await runSnapshot();
    console.log('[dry-run] snapshot 完成');
  }

  if (stepArg === 'backfill') {
    const prevMonthKey = getPrevMonthKey(now);
    console.log('\n[dry-run] ── 執行 backfill ─────────────────────────');
    await runBackfill({ month: prevMonthKey, dryRun: true });
    console.log('[dry-run] backfill 完成（DRY_RUN）');
  }

  if (!stepArg || stepArg === 'report') {
    console.log('\n[dry-run] ── 執行 report ───────────────────────────');
    await runMonthlyClose({ month: 'prev', dryRun: true });
    console.log('[dry-run] report 完成');
  }

  console.log('\n[dry-run] ── 最終 DB 狀態 ─────────────────────────');
  await inspectDb();
}

main().catch((err) => {
  console.error('[dry-run] 執行失敗:', err.message);
  console.error(err.stack);
  process.exit(1);
});
