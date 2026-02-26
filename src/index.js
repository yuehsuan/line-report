import { runSnapshot } from './actions/snapshot.js';
import { runReport } from './actions/report.js';
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
    logger.error('用法: node src/index.js <snapshot|report> [--month=prev|YYYY-MM]');
    process.exit(1);
  }

  const args = parseArgs(rest);

  if (action === 'snapshot') {
    await runSnapshot();
  } else if (action === 'report') {
    await runReport({ month: args.month || 'prev' });
  } else {
    logger.error({ action }, `未知的 action: ${action}，支援：snapshot, report`);
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, '未預期的頂層錯誤');
  process.exit(1);
});
