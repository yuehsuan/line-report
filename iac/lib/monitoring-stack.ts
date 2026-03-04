import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';

export class MonitoringStack extends cdk.Stack {
  public readonly logGroup: logs.LogGroup;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── CloudWatch Log Group ──────────────────────────────────────
    this.logGroup = new logs.LogGroup(this, 'LineReportLogGroup', {
      logGroupName: '/ecs/line-report',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── SNS Topic for Alarms（告警接口）──────────────────────────
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'line-report-alarms',
      displayName: 'LINE 用量回報服務告警',
    });

    // 告警接收 Email（替換為實際 Email 後 CDK deploy）
    const alarmEmail = this.node.tryGetContext('alarmEmail') as string | undefined;
    if (alarmEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
    }

    // ── Log Metric Filter：擷取 ERROR 等級 log ───────────────────
    const errorMetricFilter = new logs.MetricFilter(this, 'ErrorMetricFilter', {
      logGroup: this.logGroup,
      metricNamespace: 'LineReport',
      metricName: 'ErrorCount',
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'error'),
      metricValue: '1',
      defaultValue: 0,
    });

    // ── CloudWatch Alarm：5 分鐘內 ERROR >= 1 次即告警 ───────────
    const errorAlarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmName: 'line-report-error-alarm',
      alarmDescription: 'LINE 用量回報服務出現錯誤',
      metric: errorMetricFilter.metric({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // ── Log Metric Filter：快照成功計數（含 idempotent 略過）────────────────
    // 兩種訊息皆視為「今日快照已成功」，否則 idempotent 略過時會誤觸 snapshot-missing 告警
    const snapshotSuccessFilter = new logs.MetricFilter(this, 'SnapshotSuccessFilter', {
      logGroup: this.logGroup,
      metricNamespace: 'LineReport',
      metricName: 'SnapshotSuccessCount',
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', '快照執行完成'),
      metricValue: '1',
      defaultValue: 0,
    });

    const snapshotIdempotentFilter = new logs.MetricFilter(this, 'SnapshotIdempotentFilter', {
      logGroup: this.logGroup,
      metricNamespace: 'LineReport',
      metricName: 'SnapshotSuccessCount',
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', '今日快照已成功完成，略過（idempotent）'),
      metricValue: '1',
      defaultValue: 0,
    });

    // ── CloudWatch Alarm：26 小時無快照成功即告警（偵測容器完全沒執行）──
    // treatMissingData=BREACHING 確保若 log group 完全沒有資料也會觸發告警
    const snapshotMissingAlarm = new cloudwatch.Alarm(this, 'SnapshotMissingAlarm', {
      alarmName: 'line-report-snapshot-missing',
      alarmDescription: '超過 26 小時未收到快照成功 log，任務可能未執行（容器啟動失敗或靜默錯誤）',
      metric: snapshotSuccessFilter.metric({
        period: cdk.Duration.hours(26),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    snapshotMissingAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      exportName: 'LineReportLogGroupName',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      exportName: 'LineReportAlarmTopicArn',
    });
  }
}
