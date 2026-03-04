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

/**
 * 處理 axios 錯誤，記錄詳細 HTTP 資訊後重新拋出
 */
function handleAxiosError(err, context) {
  if (err.response) {
    const { status, data, headers } = err.response;
    const requestId = headers['x-line-request-id'] || headers['x-request-id'] || 'N/A';
    log.error(
      { context, httpStatus: status, responseBody: data, requestId },
      `LINE API 呼叫失敗 [${context}]: HTTP ${status}, requestId=${requestId}`
    );
    const error = new Error(`LINE API error [${context}]: HTTP ${status}, requestId=${requestId}`);
    error.httpStatus = status;
    error.responseBody = data;
    error.requestId = requestId;
    throw error;
  }
  log.error({ context, message: err.message }, `LINE API 網路錯誤 [${context}]`);
  throw err;
}

/**
 * 取得當月已用量（近似值）
 * GET /v2/bot/message/quota/consumption
 * @returns {Promise<{totalUsage: number}>}
 */
export async function getConsumption() {
  try {
    const { data } = await axios.get(`${BASE_URL}/quota/consumption`, {
      headers: buildHeaders(),
    });
    log.debug({ consumption: data }, 'getConsumption 成功');
    return data;
  } catch (err) {
    handleAxiosError(err, 'getConsumption');
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
    const { headers } = await axios.post(
      `${BASE_URL}/push`,
      {
        to,
        messages: [{ type: 'text', text }],
      },
      { headers: buildHeaders() }
    );
    const requestId = headers['x-line-request-id'] || 'N/A';
    log.info({ to, requestId }, 'pushMessage 成功');
  } catch (err) {
    handleAxiosError(err, 'pushMessage');
  }
}
