/**
 * cron-builder.ts
 *
 * 將 .env 排程設定轉換為 AWS EventBridge Scheduler cron 字串。
 * 純函式，不依賴 CDK，方便單元測試。
 *
 * AWS EventBridge cron weekday 編號：
 *   1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri, 7=Sat
 * 使用者設定（REPORT_WEEKDAY）：
 *   1=一(Mon), 2=二(Tue), 3=三(Wed), 4=四(Thu), 5=五(Fri)
 * 換算：awsWeekday = reportWeekday + 1
 *
 * 注意：REPORT_WEEK 建議使用 1-4，第 5 週在部分月份不存在，
 *       EventBridge 會靜悄悄跳過該月，不報錯也不補發。
 */

export interface CronResult {
  cron: string;
  description: string;
}

export interface ReportCronParams {
  reportMode: string;
  reportDay?: string;
  reportWeek?: string;
  reportWeekday?: string;
  reportHour: string;
}

const WEEKDAY_ZH = ['', '一', '二', '三', '四', '五'];

export function buildReportCron(params: ReportCronParams): CronResult {
  const { reportMode, reportHour } = params;

  if (reportMode === 'weekday') {
    const reportWeek    = params.reportWeek    ?? '2';
    const reportWeekday = params.reportWeekday ?? '3';
    const weekdayNum = parseInt(reportWeekday, 10);

    if (isNaN(weekdayNum) || weekdayNum < 1 || weekdayNum > 5) {
      throw new Error(
        `[CDK] reportWeekday 必須為 1-5（1=一…5=五），目前值：${reportWeekday}`
      );
    }

    const weekNum = parseInt(reportWeek, 10);
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 5) {
      throw new Error(
        `[CDK] reportWeek 必須為 1-5，目前值：${reportWeek}`
      );
    }

    const awsWeekday = weekdayNum + 1;
    return {
      cron: `cron(0 ${reportHour} ? * ${awsWeekday}#${reportWeek} *)`,
      description: `LINE 用量每月回報（每月第 ${reportWeek} 個星期${WEEKDAY_ZH[weekdayNum]} ${reportHour}:00 Asia/Taipei）`,
    };
  }

  // 預設 date 模式
  const reportDay = params.reportDay ?? '11';
  return {
    cron: `cron(0 ${reportHour} ${reportDay} * ? *)`,
    description: `LINE 用量每月回報（每月 ${reportDay} 日 ${reportHour}:00 Asia/Taipei）`,
  };
}

export function buildSnapshotCron(snapshotHour: string, snapshotMinute: string): string {
  return `cron(${snapshotMinute} ${snapshotHour} * * ? *)`;
}
