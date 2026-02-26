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
