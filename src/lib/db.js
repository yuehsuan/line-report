import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createLogger } from './logger.js';

const log = createLogger({ module: 'db' });

function buildClientConfig() {
  const config = {
    region: process.env.AWS_REGION || 'ap-northeast-1',
  };
  if (process.env.AWS_ENDPOINT_URL) {
    config.endpoint = process.env.AWS_ENDPOINT_URL;
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
    };
  }
  return config;
}

let _client;

export function getDocumentClient() {
  if (!_client) {
    const ddbClient = new DynamoDBClient(buildClientConfig());
    _client = DynamoDBDocumentClient.from(ddbClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

export const TABLE_SNAPSHOTS = () =>
  process.env.DDB_TABLE_SNAPSHOTS || 'usage_snapshots';

export const TABLE_RUNS = () =>
  process.env.DDB_TABLE_RUNS || 'job_runs';

/**
 * PutItem - 若需要 ConditionExpression 防重，請傳入 options
 * @param {string} tableName
 * @param {Object} item
 * @param {Object} [options]  額外的 DDB 參數（如 ConditionExpression）
 */
export async function dbPut(tableName, item, options = {}) {
  const client = getDocumentClient();
  const cmd = new PutCommand({ TableName: tableName, Item: item, ...options });
  log.debug({ tableName, pk: item.pk || item.monthKey || item.jobId }, 'dbPut');
  return client.send(cmd);
}

/**
 * GetItem
 * @param {string} tableName
 * @param {Object} key
 */
export async function dbGet(tableName, key) {
  const client = getDocumentClient();
  const cmd = new GetCommand({ TableName: tableName, Key: key });
  log.debug({ tableName, key }, 'dbGet');
  const result = await client.send(cmd);
  return result.Item || null;
}

/**
 * Query（支援 KeyConditionExpression + FilterExpression + ScanIndexForward）
 * @param {string} tableName
 * @param {Object} params  部分 QueryCommand 參數
 */
export async function dbQuery(tableName, params) {
  const client = getDocumentClient();
  const cmd = new QueryCommand({ TableName: tableName, ...params });
  log.debug({ tableName, keyCondition: params.KeyConditionExpression }, 'dbQuery');
  const result = await client.send(cmd);
  return result.Items || [];
}

/**
 * UpdateItem
 * @param {string} tableName
 * @param {Object} key
 * @param {Object} params  UpdateExpression / ExpressionAttributeValues / ExpressionAttributeNames 等
 */
export async function dbUpdate(tableName, key, params) {
  const client = getDocumentClient();
  const cmd = new UpdateCommand({ TableName: tableName, Key: key, ...params });
  log.debug({ tableName, key }, 'dbUpdate');
  return client.send(cmd);
}
