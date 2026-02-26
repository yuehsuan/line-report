import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    pid: process.pid,
    service: 'line-report',
  },
});

/**
 * 建立帶有 requestId 與 jobType context 的子 logger
 * @param {Object} ctx
 * @param {string} [ctx.requestId]
 * @param {string} [ctx.jobType]
 * @param {string} [ctx.action]
 */
export function createLogger(ctx = {}) {
  return logger.child(ctx);
}

export default logger;
