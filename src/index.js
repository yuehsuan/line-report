import { runSnapshot } from './actions/snapshot.js';
import { runBackfill } from './actions/backfill.js';
import { runMonthlyClose } from './actions/monthlyClose.js';
import { runPublishReport } from './actions/report.js';
import logger from './lib/logger.js';

const [, , action, ...rest] = process.argv;

/**
 * 解析 --key=value 或 --key value 格式的 CLI 參數
 */
function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        result[key] = val;
      } else {
        const key = arg.slice(2);
        const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
        result[key] = val;
      }
    }
  }
  return result;
}

async function main() {
  if (!action) {
    logger.error('用法: node src/index.js <snapshot|backfill|monthly-close-scheduled|monthly-close|publish-report> [--month=prev|YYYY-MM] [--rebuild=true]');
    process.exit(1);
  }

  const args = parseArgs(rest);
  const dryRun = args['dry-run'] === undefined ? undefined : args['dry-run'] === 'true';

  if (action === 'snapshot') {
    await runSnapshot();
  } else if (action === 'backfill') {
    await runBackfill({
      month: args.month,
      dryRun,
      rebuild: args.rebuild === 'true',
    });
  } else if (action === 'monthly-close-scheduled') {
    await runMonthlyClose({
      mode: 'scheduled',
      month: args.month || 'prev',
      dryRun,
    });
  } else if (action === 'monthly-close') {
    await runMonthlyClose({
      mode: 'manual',
      month: args.month,
      confirmMonth: args['confirm-month'],
      dryRun,
    });
  } else if (action === 'publish-report') {
    await runPublishReport({
      month: args.month || 'prev',
      confirmMonth: args['confirm-month'],
      dryRun,
      republish: args.republish === 'true',
    });
  } else {
    logger.error({ action }, '未知的 action: snapshot, backfill, monthly-close-scheduled, monthly-close, publish-report；backfill 若要覆寫既有 official final 請加 --rebuild=true');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, '未預期的頂層錯誤');
  process.exit(1);
});
