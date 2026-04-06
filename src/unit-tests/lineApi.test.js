import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';

const originalEnv = {};
const envKeys = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_API_TIMEOUT_MS',
  'LINE_API_MAX_ATTEMPTS',
  'LINE_API_RETRY_BASE_MS',
  'LINE_API_RETRY_JITTER_MS',
  'DRY_RUN',
];

before(() => {
  for (const k of envKeys) originalEnv[k] = process.env[k];
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
  process.env.LINE_API_TIMEOUT_MS = '1234';
  process.env.LINE_API_MAX_ATTEMPTS = '5';
  process.env.LINE_API_RETRY_BASE_MS = '1';
  process.env.LINE_API_RETRY_JITTER_MS = '1';
  process.env.DRY_RUN = 'false';
});

after(() => {
  for (const k of envKeys) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

let axiosGetCalls = [];
let axiosPostCalls = [];
let mockAxiosGet = async () => ({ data: { totalUsage: 123 } });
let mockAxiosPost = async () => ({ headers: { 'x-line-request-id': 'req-1' } });

const { getConsumption, getDailyDelivery, pushMessage } = await esmock('../lib/lineApi.js', {
  axios: {
    default: {
      get: async (...args) => {
        axiosGetCalls.push(args);
        return mockAxiosGet(...args);
      },
      post: async (...args) => {
        axiosPostCalls.push(args);
        return mockAxiosPost(...args);
      },
    },
  },
});

beforeEach(() => {
  axiosGetCalls = [];
  axiosPostCalls = [];
  mockAxiosGet = async () => ({ data: { totalUsage: 123 } });
  mockAxiosPost = async () => ({ headers: { 'x-line-request-id': 'req-1' } });
});

describe('getConsumption', () => {
  test('應帶入 timeout 與 headers', async () => {
    const result = await getConsumption();

    assert.deepEqual(result, { totalUsage: 123 });
    assert.equal(axiosGetCalls.length, 1);
    assert.equal(axiosGetCalls[0][1].timeout, 1234);
    assert.equal(axiosGetCalls[0][1].headers.Authorization, 'Bearer test-token');
  });

  test('遇到 429 應重試後成功', async () => {
    let attempts = 0;
    mockAxiosGet = async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('rate limited');
        err.response = {
          status: 429,
          data: { message: 'Too Many Requests' },
          headers: { 'x-line-request-id': 'req-rate-limit' },
        };
        throw err;
      }
      return { data: { totalUsage: 456 } };
    };

    const result = await getConsumption();

    assert.deepEqual(result, { totalUsage: 456 });
    assert.equal(axiosGetCalls.length, 3);
  });

  test('一般 400 不應重試', async () => {
    mockAxiosGet = async () => {
      const err = new Error('bad request');
      err.response = {
        status: 400,
        data: { message: 'Bad Request' },
        headers: { 'x-line-request-id': 'req-bad-request' },
      };
      throw err;
    };

    await assert.rejects(
      () => getConsumption(),
      /HTTP 400, requestId=req-bad-request/,
    );
    assert.equal(axiosGetCalls.length, 1);
  });
});

describe('pushMessage', () => {
  test('timeout 網路錯誤應重試後成功', async () => {
    let attempts = 0;
    mockAxiosPost = async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('timeout');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return { headers: { 'x-line-request-id': 'req-ok' } };
    };

    await assert.doesNotReject(() => pushMessage('U_test', 'hello'));
    assert.equal(axiosPostCalls.length, 3);
    assert.equal(axiosPostCalls[0][2].timeout, 1234);
  });

  test('5xx 重試到上限後應拋錯', async () => {
    mockAxiosPost = async () => {
      const err = new Error('server error');
      err.response = {
        status: 503,
        data: { message: 'Service Unavailable' },
        headers: { 'x-line-request-id': 'req-503' },
      };
      throw err;
    };

    await assert.rejects(
      () => pushMessage('U_test', 'hello'),
      /HTTP 503, requestId=req-503/,
    );
    assert.equal(axiosPostCalls.length, 5);
  });
});

describe('getDailyDelivery', () => {
  test('應把 OA Manager 與 targeting/narrowcast 欄位納入 totalUsage', async () => {
    mockAxiosGet = async () => ({
      data: {
        status: 'ready',
        broadcast: 10,
        targeting: 20,
        narrowcast: 30,
        apiBroadcast: 1,
        apiPush: 2,
        apiMulticast: 3,
        apiNarrowcast: 4,
        apiReply: 5,
        autoResponse: 6,
        welcomeResponse: 7,
        chat: 8,
      },
    });

    const result = await getDailyDelivery('20260331');

    assert.equal(result.totalUsage, 96);
    assert.equal(result.breakdown.broadcast, 10);
    assert.equal(result.breakdown.targeting, 20);
    assert.equal(result.breakdown.narrowcast, 30);
  });

  test('未提供 OA Manager 欄位時應維持既有加總結果', async () => {
    mockAxiosGet = async () => ({
      data: {
        status: 'ready',
        apiBroadcast: 1,
        apiPush: 2,
        apiMulticast: 3,
        apiNarrowcast: 4,
        apiReply: 5,
        autoResponse: 6,
        welcomeResponse: 7,
        chat: 8,
      },
    });

    const result = await getDailyDelivery('20260330');

    assert.equal(result.totalUsage, 36);
    assert.equal(result.breakdown.broadcast, 0);
    assert.equal(result.breakdown.targeting, 0);
    assert.equal(result.breakdown.narrowcast, 0);
  });
});
