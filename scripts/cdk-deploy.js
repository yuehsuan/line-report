/**
 * cdk-deploy.js — CDK 部署輔助腳本
 *
 * 從 .env 讀取排程設定與告警 Email，轉換為 CDK context 傳入。
 * 透過 npm run deploy 呼叫（--env-file=.env 已在 package.json 設定）。
 *
 * 使用方式：
 *   npm run deploy                              # 部署全部 stack
 *   npm run deploy -- --stacks LineReportSchedulerStack   # 只部署排程
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

// CLI 追加參數（如 --stacks xxx）
const extraArgs = process.argv.slice(2);

const cdkArgs = ['cdk', 'deploy', '--all', ...contextArgs, ...extraArgs];

console.log('[cdk-deploy] 執行：npx', cdkArgs.join(' '));

const result = spawnSync('npx', cdkArgs, {
  cwd: new URL('../iac', import.meta.url).pathname,
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
