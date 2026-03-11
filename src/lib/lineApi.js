import axios from 'axios';
import { createLogger } from './logger.js';

const BASE_URL = 'https://api.line.me/v2/bot/message';
const log = createLogger({ module: 'lineApi' });

function getToken() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error('環境變數 LINE_CHANNEL_ACCESS_TOKEN 未設定');
  }
  return token;
}

function buildHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
    'Content-Type': 'application/json',
  };
}

function getPositiveIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRequestConfig() {
  return {
    headers: buildHeaders(),
    timeout: getPositiveIntEnv('LINE_API_TIMEOUT_MS', 10000),
  };
}

function isRetryableError(err) {
  const status = err.response?.status;
  return status === 429 || status >= 500 || !status;
}

function getRetryDelayMs(attempt) {
  const baseDelayMs = getPositiveIntEnv('LINE_API_RETRY_BASE_MS', 500);
  const jitterCapMs = getPositiveIntEnv('LINE_API_RETRY_JITTER_MS', 250);
  const exponentialDelay = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  const jitter = jitterCapMs > 0 ? Math.floor(Math.random() * jitterCapMs) : 0;
  return exponentialDelay + jitter;
}

/**
 * 將 axios 錯誤轉為可觀察的應用層錯誤
 */
function buildLineApiError(err, context) {
  if (err.response) {
    const { status, data, headers } = err.response;
    const requestId = headers['x-line-request-id'] || headers['x-request-id'] || 'N/A';
    const error = new Error(`LINE API error [${context}]: HTTP ${status}, requestId=${requestId}`);
    error.httpStatus = status;
    error.responseBody = data;
    error.requestId = requestId;
    return error;
  }

  const error = new Error(`LINE API network error [${context}]: ${err.message}`);
  error.code = err.code;
  return error;
}

async function requestWithRetry(context, requestFn) {
  const maxAttempts = getPositiveIntEnv('LINE_API_MAX_ATTEMPTS', 3);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      const retryable = isRetryableError(err);
      const normalizedError = buildLineApiError(err, context);

      if (!retryable || attempt === maxAttempts) {
        log.error(
          {
            context,
            attempt,
            maxAttempts,
            httpStatus: normalizedError.httpStatus,
            responseBody: normalizedError.responseBody,
            requestId: normalizedError.requestId,
            code: normalizedError.code,
          },
          `LINE API 呼叫失敗 [${context}]`,
        );
        throw normalizedError;
      }

      const delayMs = getRetryDelayMs(attempt);
      log.warn(
        {
          context,
          attempt,
          maxAttempts,
          delayMs,
          httpStatus: normalizedError.httpStatus,
          requestId: normalizedError.requestId,
          code: normalizedError.code,
        },
        `LINE API 呼叫失敗，準備重試 [${context}]`,
      );
      await sleep(delayMs);
    }
  }
}

/**
 * 取得當月已用量（近似值）
 * GET /v2/bot/message/quota/consumption
 * @returns {Promise<{totalUsage: number}>}
 */
export async function getConsumption() {
  try {
    const { data } = await requestWithRetry('getConsumption', () =>
      axios.get(`${BASE_URL}/quota/consumption`, getRequestConfig()),
    );
    log.debug({ consumption: data }, 'getConsumption 成功');
    return data;
  } catch (err) {
    throw err;
  }
}

/**
 * 推播文字訊息到指定 LINE 群組或使用者
 * POST /v2/bot/message/push
 * @param {string} to  群組 ID 或使用者 ID
 * @param {string} text 訊息內容
 * @returns {Promise<void>}
 */
export async function pushMessage(to, text) {
  if (!to) throw new Error('pushMessage: to 參數不得為空');

  if (process.env.DRY_RUN === 'true') {
    log.info({ to, text }, '[DRY_RUN] 跳過 LINE push，訊息內容如上');
    return;
  }

  try {
    const { headers } = await requestWithRetry('pushMessage', () =>
      axios.post(
        `${BASE_URL}/push`,
        {
          to,
          messages: [{ type: 'text', text }],
        },
        getRequestConfig(),
      ),
    );
    const requestId = headers['x-line-request-id'] || 'N/A';
    log.info({ to, requestId }, 'pushMessage 成功');
  } catch (err) {
    throw err;
  }
}
