/**
 * cdk-deploy.js — CDK 部署輔助腳本
 *
 * 從 .env 讀取排程設定與通知 Email，轉換為 CDK context 傳入。
 * 透過 npm run deploy 呼叫（--env-file=.env 已在 package.json 設定）。
 *
 * 使用方式：
 *   npm run deploy                                       # 部署全部 stack（--all）
 *   npm run deploy -- LineReportSchedulerStack           # 只部署指定 stack
 *
 * 支援的 .env 欄位：
 *   IMAGE_TAG        Docker image tag（必填）
 *   CPU_ARCHITECTURE ECS / Docker 平台架構（固定 arm64，預設 arm64）
 *   REPORT_MODE      date（預設）或 weekday
 *   REPORT_DAY       每月回報日（REPORT_MODE=date 時使用，預設 11）
 *   REPORT_WEEK      第幾週（REPORT_MODE=weekday 時使用，預設 2）
 *   REPORT_WEEKDAY   星期幾 1=一…5=五（REPORT_MODE=weekday 時使用，預設 3）
 *   REPORT_HOUR      每月回報時（預設 9）
 *   SNAPSHOT_HOUR    每日快照時（預設 23）
 *   SNAPSHOT_MINUTE  每日快照分（預設 55）
 *   ALARM_EMAIL      Failure/Heartbeat 告警 Email（選填）
 *   DEBUG_EMAIL      Debug/Outcome 通知 Email（選填）
 *   ENABLE_DEBUG_OUTCOME_NOTICES Debug 通知開關（預設 true）
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { parseDeployArgs } from './lib/deploy-args.js';

const imageTag = process.env.IMAGE_TAG;
if (!imageTag) {
  console.error('[cdk-deploy] 錯誤：IMAGE_TAG 未設定，請在 .env 填入版本 tag（如 v20260226-1）');
  process.exit(1);
}
if (imageTag === 'latest') {
  console.error('[cdk-deploy] 錯誤：IMAGE_TAG 不得使用 "latest"，請指定明確版本 tag');
  process.exit(1);
}

const cpuArchitecture = process.env.CPU_ARCHITECTURE || 'arm64';
if (cpuArchitecture !== 'arm64') {
  console.error(`[cdk-deploy] 錯誤：目前只允許 ARM64 部署，CPU_ARCHITECTURE 必須為 "arm64"，目前值：${cpuArchitecture}`);
  process.exit(1);
}

const alarmEmail = process.env.ALARM_EMAIL;
const debugEmail = process.env.DEBUG_EMAIL;
if (alarmEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alarmEmail)) {
  console.error(`[cdk-deploy] 錯誤：ALARM_EMAIL 格式不合法：${alarmEmail}`);
  process.exit(1);
}
if (debugEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(debugEmail)) {
  console.error(`[cdk-deploy] 錯誤：DEBUG_EMAIL 格式不合法：${debugEmail}`);
  process.exit(1);
}

const reportMode = process.env.REPORT_MODE || 'date';
if (reportMode !== 'date' && reportMode !== 'weekday') {
  console.error(`[cdk-deploy] 錯誤：REPORT_MODE 必須為 "date" 或 "weekday"，目前值：${reportMode}`);
  process.exit(1);
}

const reportDay = parseInt(process.env.REPORT_DAY || '11', 10);
if (isNaN(reportDay) || reportDay < 1 || reportDay > 28) {
  console.error(`[cdk-deploy] 錯誤：REPORT_DAY 必須為 1–28（避免 2 月沒有 29–31 日），目前值：${process.env.REPORT_DAY}`);
  process.exit(1);
}

const contextArgs = [
  `imageTag=${imageTag}`,
  `cpuArchitecture=${cpuArchitecture}`,
  `reportMode=${reportMode}`,
  `reportDay=${process.env.REPORT_DAY      || '11'}`,
  `reportWeek=${process.env.REPORT_WEEK    || '2'}`,
  `reportWeekday=${process.env.REPORT_WEEKDAY || '3'}`,
  `reportHour=${process.env.REPORT_HOUR    || '9'}`,
  `snapshotHour=${process.env.SNAPSHOT_HOUR  || '23'}`,
  `snapshotMinute=${process.env.SNAPSHOT_MINUTE || '55'}`,
  ...(alarmEmail
    ? [`failureAlertEmail=${alarmEmail}`, `heartbeatAlertEmail=${alarmEmail}`]
    : []),
  ...(debugEmail ? [`debugEmail=${debugEmail}`] : []),
  `enableDebugOutcomeNotices=${process.env.ENABLE_DEBUG_OUTCOME_NOTICES || 'true'}`,
].flatMap((ctx) => ['--context', ctx]);

// AWS_PROFILE → --profile（確保 SSO profile 正確傳入 CDK）
const profileArgs = process.env.AWS_PROFILE
  ? ['--profile', process.env.AWS_PROFILE]
  : [];

// CLI 追加參數（如 stack 名稱）
// 例：npm run deploy -- LineReportSchedulerStack   ← 只部署該 stack
//     npm run deploy -- --stacks LineReportSchedulerStack ← 相容舊文件寫法
//     npm run deploy                               ← 部署全部（--all）
const {
  normalizedArgs: extraArgs,
  hasStackNames,
  requestedStacks,
} = parseDeployArgs(process.argv.slice(2));

function shouldVerifyStack(stackName) {
  return requestedStacks.length === 0 || requestedStacks.includes(stackName);
}

function runAwsJson(args, failureMessage) {
  const profileArgs = process.env.AWS_PROFILE ? ['--profile', process.env.AWS_PROFILE] : [];
  const regionArgs = ['--region', process.env.AWS_REGION || 'ap-northeast-1'];
  const result = spawnSync('aws', [...args, ...profileArgs, ...regionArgs, '--output', 'json'], {
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status !== 0) {
    console.error(failureMessage);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status ?? 1);
  }

  return JSON.parse(result.stdout);
}

function ensureAwsIdentity() {
  const identity = runAwsJson(
    ['sts', 'get-caller-identity'],
    '[cdk-deploy] 無法取得 AWS 身分，請先確認 AWS_PROFILE / AWS SSO 已登入'
  );
  console.log(`[cdk-deploy] AWS 身分：${identity.Arn}`);
  return identity;
}

function ensureImageTagExists() {
  runAwsJson(
    ['ecr', 'describe-images', '--repository-name', 'line-report', '--image-ids', `imageTag=${imageTag}`],
    `[cdk-deploy] ECR 中找不到 image tag：${imageTag}。請先 build/push image，再部署 EcsStack。`
  );
  console.log(`[cdk-deploy] ECR 已確認存在 image tag：${imageTag}`);
}

function verifyTaskDefinitionImage(family, expectedImage, expectedCpuArchitecture) {
  const data = runAwsJson(
    ['ecs', 'describe-task-definition', '--task-definition', family, '--query', 'taskDefinition'],
    `[cdk-deploy] 無法查詢 ECS task definition：${family}`
  );
  const actualImage = data.containerDefinitions?.[0]?.image;
  const actualCpuArchitecture = data.runtimePlatform?.cpuArchitecture;
  if (actualImage !== expectedImage) {
    console.error(`[cdk-deploy] 部署後驗證失敗：${family} image=${actualImage}，預期=${expectedImage}`);
    process.exit(1);
  }
  if (actualCpuArchitecture !== expectedCpuArchitecture.toUpperCase()) {
    console.error(
      `[cdk-deploy] 部署後驗證失敗：${family} cpuArchitecture=${actualCpuArchitecture}，預期=${expectedCpuArchitecture.toUpperCase()}`
    );
    process.exit(1);
  }
  console.log(`[cdk-deploy] 驗證通過：${family} 使用 ${actualImage}，架構 ${actualCpuArchitecture}`);
}

function verifyScheduleState(name, expectedTaskFamily) {
  const data = runAwsJson(
    ['scheduler', 'get-schedule', '--name', name],
    `[cdk-deploy] 無法查詢 Scheduler：${name}`
  );
  const taskArn = data.Target?.EcsParameters?.TaskDefinitionArn || '';
  if (data.State !== 'ENABLED') {
    console.error(`[cdk-deploy] 部署後驗證失敗：${name} 狀態不是 ENABLED，而是 ${data.State}`);
    process.exit(1);
  }
  if (!taskArn.includes(expectedTaskFamily)) {
    console.error(`[cdk-deploy] 部署後驗證失敗：${name} 指向 ${taskArn}，未對應 ${expectedTaskFamily}`);
    process.exit(1);
  }
  console.log(`[cdk-deploy] 驗證通過：${name} 已啟用，指向 ${expectedTaskFamily}`);
}

// fileURLToPath 正確處理路徑中的中文/特殊字元
const iacDir = fileURLToPath(new URL('../iac', import.meta.url));
// 直接使用 iac/node_modules/.bin/cdk，不依賴 PATH 裡有沒有 npx
const cdkBin = resolve(iacDir, 'node_modules', '.bin', 'cdk');

const cdkArgs = [
  'deploy',
  ...(hasStackNames ? [] : ['--all']),  // 指定 stack 名稱時不加 --all
  '--require-approval', 'never',
  ...profileArgs,
  ...contextArgs,
  ...extraArgs,
];

const identity = ensureAwsIdentity();
ensureImageTagExists();

console.log('[cdk-deploy] 工作目錄：', iacDir);
console.log('[cdk-deploy] CDK 執行檔：', cdkBin);
console.log('[cdk-deploy] 執行：cdk', cdkArgs.join(' '));

const result = spawnSync(cdkBin, cdkArgs, {
  cwd: iacDir,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('[cdk-deploy] 執行失敗，無法啟動子程序：', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`[cdk-deploy] CDK 部署失敗，exit code：${result.status}`);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const expectedImage = `${identity.Account}.dkr.ecr.${process.env.AWS_REGION || 'ap-northeast-1'}.amazonaws.com/line-report:${imageTag}`;

if (shouldVerifyStack('LineReportEcsStack')) {
  verifyTaskDefinitionImage('line-report-snapshot', expectedImage, cpuArchitecture);
  verifyTaskDefinitionImage('line-report-monthly-close', expectedImage, cpuArchitecture);
}

if (shouldVerifyStack('LineReportSchedulerStack') || shouldVerifyStack('LineReportEcsStack')) {
  verifyScheduleState('line-report-daily-snapshot', 'line-report-snapshot');
  verifyScheduleState('line-report-monthly-report', 'line-report-monthly-close');
}

console.log('[cdk-deploy] 部署後驗證全部通過');
process.exit(0);
