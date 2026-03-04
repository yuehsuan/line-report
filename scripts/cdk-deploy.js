/**
 * cdk-deploy.js — CDK 部署輔助腳本
 *
 * 從 .env 讀取排程設定與告警 Email，轉換為 CDK context 傳入。
 * 透過 npm run deploy 呼叫（--env-file=.env 已在 package.json 設定）。
 *
 * 使用方式：
 *   npm run deploy                                       # 部署全部 stack（--all）
 *   npm run deploy -- LineReportSchedulerStack           # 只部署指定 stack
 *
 * 支援的 .env 欄位：
 *   IMAGE_TAG        Docker image tag（必填）
 *   REPORT_MODE      date（預設）或 weekday
 *   REPORT_DAY       每月回報日（REPORT_MODE=date 時使用，預設 11）
 *   REPORT_WEEK      第幾週（REPORT_MODE=weekday 時使用，預設 2）
 *   REPORT_WEEKDAY   星期幾 1=一…5=五（REPORT_MODE=weekday 時使用，預設 3）
 *   REPORT_HOUR      每月回報時（預設 9）
 *   SNAPSHOT_HOUR    每日快照時（預設 23）
 *   SNAPSHOT_MINUTE  每日快照分（預設 55）
 *   ALARM_EMAIL      告警 Email（選填）
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const imageTag = process.env.IMAGE_TAG;
if (!imageTag) {
  console.error('[cdk-deploy] 錯誤：IMAGE_TAG 未設定，請在 .env 填入版本 tag（如 v20260226-1）');
  process.exit(1);
}
if (imageTag === 'latest') {
  console.error('[cdk-deploy] 錯誤：IMAGE_TAG 不得使用 "latest"，請指定明確版本 tag');
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
  `reportMode=${reportMode}`,
  `reportDay=${process.env.REPORT_DAY      || '11'}`,
  `reportWeek=${process.env.REPORT_WEEK    || '2'}`,
  `reportWeekday=${process.env.REPORT_WEEKDAY || '3'}`,
  `reportHour=${process.env.REPORT_HOUR    || '9'}`,
  `snapshotHour=${process.env.SNAPSHOT_HOUR  || '23'}`,
  `snapshotMinute=${process.env.SNAPSHOT_MINUTE || '55'}`,
  ...(process.env.ALARM_EMAIL ? [`alarmEmail=${process.env.ALARM_EMAIL}`] : []),
].flatMap((ctx) => ['--context', ctx]);

// AWS_PROFILE → --profile（確保 SSO profile 正確傳入 CDK）
const profileArgs = process.env.AWS_PROFILE
  ? ['--profile', process.env.AWS_PROFILE]
  : [];

// CLI 追加參數（如 stack 名稱）
// 例：npm run deploy -- LineReportSchedulerStack   ← 只部署該 stack
//     npm run deploy                               ← 部署全部（--all）
const extraArgs = process.argv.slice(2);
// 判斷是否有傳入 stack 名稱（不以 -- 開頭的參數視為 stack 名稱）
const hasStackNames = extraArgs.some((a) => !a.startsWith('--'));

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

process.exit(result.status ?? 1);
