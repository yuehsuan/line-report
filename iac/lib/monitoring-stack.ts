import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';

export class MonitoringStack extends cdk.Stack {
  public readonly logGroup: logs.LogGroup;
  public readonly failureAlertTopic: sns.Topic;
  public readonly heartbeatAlertTopic: sns.Topic;
  public readonly debugOutcomeTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.logGroup = new logs.LogGroup(this, 'LineReportLogGroup', {
      logGroupName: '/ecs/line-report',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 保留舊 resource path `AlarmTopic`，避免 SchedulerStack 更新前先撞到 export 刪除。
    this.failureAlertTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'line-report-alarms',
      displayName: 'LINE 用量回報服務 Failure Alerts',
    });

    this.heartbeatAlertTopic = new sns.Topic(this, 'HeartbeatAlertTopic', {
      topicName: 'line-report-heartbeat-alerts',
      displayName: 'LINE 用量回報服務 Missing And Heartbeat Alerts',
    });

    this.debugOutcomeTopic = new sns.Topic(this, 'DebugOutcomeTopic', {
      topicName: 'line-report-debug-outcomes',
      displayName: 'LINE 用量回報服務 Debug Outcome Notices',
    });

    const legacyAlarmEmail = this.node.tryGetContext('alarmEmail') as string | undefined;
    const failureAlertEmail =
      (this.node.tryGetContext('failureAlertEmail') as string | undefined) || legacyAlarmEmail;
    const heartbeatAlertEmail =
      (this.node.tryGetContext('heartbeatAlertEmail') as string | undefined) || legacyAlarmEmail;
    const debugEmail = this.node.tryGetContext('debugEmail') as string | undefined;
    const enableDebugOutcomeNotices =
      String(this.node.tryGetContext('enableDebugOutcomeNotices') ?? 'true') !== 'false';
    const snapshotHour = String(this.node.tryGetContext('snapshotHour') ?? '23');
    const snapshotMinute = String(this.node.tryGetContext('snapshotMinute') ?? '55');
    const reportMode = String(this.node.tryGetContext('reportMode') ?? 'date');
    const reportDay = String(this.node.tryGetContext('reportDay') ?? '11');
    const reportWeek = String(this.node.tryGetContext('reportWeek') ?? '2');
    const reportWeekday = String(this.node.tryGetContext('reportWeekday') ?? '3');
    const reportHour = String(this.node.tryGetContext('reportHour') ?? '9');

    if (failureAlertEmail) {
      this.failureAlertTopic.addSubscription(new subscriptions.EmailSubscription(failureAlertEmail));
    }
    if (heartbeatAlertEmail) {
      this.heartbeatAlertTopic.addSubscription(
        new subscriptions.EmailSubscription(heartbeatAlertEmail)
      );
    }
    if (debugEmail) {
      this.debugOutcomeTopic.addSubscription(new subscriptions.EmailSubscription(debugEmail));
    }

    const outcomeRouter = new lambda.Function(this, 'OutcomeRouterFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/outcome_router'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        FAILURE_ALERT_TOPIC_ARN: this.failureAlertTopic.topicArn,
        DEBUG_OUTCOME_TOPIC_ARN: this.debugOutcomeTopic.topicArn,
        ENABLE_DEBUG_OUTCOME_NOTICES: String(enableDebugOutcomeNotices),
      },
    });

    this.failureAlertTopic.grantPublish(outcomeRouter);
    this.debugOutcomeTopic.grantPublish(outcomeRouter);

    new logs.SubscriptionFilter(this, 'OutcomeRouterSubscription', {
      logGroup: this.logGroup,
      destination: new destinations.LambdaDestination(outcomeRouter),
      filterPattern: logs.FilterPattern.allEvents(),
    });

    const errorMetricFilter = new logs.MetricFilter(this, 'ErrorMetricFilter', {
      logGroup: this.logGroup,
      metricNamespace: 'LineReport',
      metricName: 'ErrorCount',
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'error'),
      metricValue: '1',
      defaultValue: 0,
    });

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

    errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.failureAlertTopic));

    const heartbeatChecker = new lambda.Function(this, 'HeartbeatCheckerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/heartbeat_checker'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        JOB_RUNS_TABLE: 'job_runs',
        DAILY_SNAPSHOT_SCHEDULE_NAME: 'line-report-daily-snapshot',
        MONTHLY_REPORT_SCHEDULE_NAME: 'line-report-monthly-report',
        SNAPSHOT_HOUR: snapshotHour,
        SNAPSHOT_MINUTE: snapshotMinute,
        REPORT_MODE: reportMode,
        REPORT_DAY: reportDay,
        REPORT_WEEK: reportWeek,
        REPORT_WEEKDAY: reportWeekday,
        REPORT_HOUR: reportHour,
        HEARTBEAT_NAMESPACE: 'LineReportHeartbeat',
      },
    });

    heartbeatChecker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/job_runs`],
      })
    );
    heartbeatChecker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:GetSchedule'],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/line-report-daily-snapshot`,
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/line-report-monthly-report`,
        ],
      })
    );
    heartbeatChecker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );

    new events.Rule(this, 'SnapshotHeartbeatCheckSchedule', {
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '0',
      }),
      targets: [
        new targets.LambdaFunction(heartbeatChecker, {
          event: events.RuleTargetInput.fromObject({ checks: ['snapshot'] }),
        }),
      ],
    });

    new events.Rule(this, 'ReportHeartbeatCheckSchedule', {
      schedule: events.Schedule.cron({
        minute: '5',
        hour: '0',
      }),
      targets: [
        new targets.LambdaFunction(heartbeatChecker, {
          event: events.RuleTargetInput.fromObject({ checks: ['report'] }),
        }),
      ],
    });

    new events.Rule(this, 'ScheduleEnabledCheckSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [
        new targets.LambdaFunction(heartbeatChecker, {
          event: events.RuleTargetInput.fromObject({ checks: ['schedules'] }),
        }),
      ],
    });

    const snapshotMissingAlarm = new cloudwatch.Alarm(this, 'SnapshotMissingAlarm', {
      alarmName: 'line-report-snapshot-missing',
      alarmDescription: '每日快照在預期時間後仍未成功，請檢查 Scheduler、ECS 與 job_runs',
      metric: new cloudwatch.Metric({
        namespace: 'LineReportHeartbeat',
        metricName: 'SnapshotHealthy',
        period: cdk.Duration.days(1),
        statistic: 'Minimum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    snapshotMissingAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.heartbeatAlertTopic));

    const reportMissingAlarm = new cloudwatch.Alarm(this, 'ReportMissingAlarm', {
      alarmName: 'line-report-report-missing',
      alarmDescription: '每月回報在最近一次排程後仍未成功，請檢查 Scheduler、cron 與 job_runs',
      metric: new cloudwatch.Metric({
        namespace: 'LineReportHeartbeat',
        metricName: 'ReportHealthy',
        period: cdk.Duration.days(1),
        statistic: 'Minimum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    reportMissingAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.heartbeatAlertTopic));

    const dailySnapshotScheduleDisabledAlarm = new cloudwatch.Alarm(
      this,
      'DailySnapshotScheduleDisabledAlarm',
      {
        alarmName: 'line-report-daily-snapshot-schedule-disabled',
        alarmDescription: '每日快照排程不是 ENABLED，請檢查 EventBridge Scheduler 設定',
        metric: new cloudwatch.Metric({
          namespace: 'LineReportHeartbeat',
          metricName: 'DailySnapshotScheduleEnabled',
          period: cdk.Duration.hours(6),
          statistic: 'Minimum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }
    );

    dailySnapshotScheduleDisabledAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.heartbeatAlertTopic)
    );

    const monthlyReportScheduleDisabledAlarm = new cloudwatch.Alarm(
      this,
      'MonthlyReportScheduleDisabledAlarm',
      {
        alarmName: 'line-report-monthly-report-schedule-disabled',
        alarmDescription: '每月回報排程不是 ENABLED，請檢查 EventBridge Scheduler 設定',
        metric: new cloudwatch.Metric({
          namespace: 'LineReportHeartbeat',
          metricName: 'MonthlyReportScheduleEnabled',
          period: cdk.Duration.hours(6),
          statistic: 'Minimum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }
    );

    monthlyReportScheduleDisabledAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.heartbeatAlertTopic)
    );

    const heartbeatCheckerErrorAlarm = new cloudwatch.Alarm(this, 'HeartbeatCheckerErrorAlarm', {
      alarmName: 'line-report-heartbeat-checker-error',
      alarmDescription: 'Heartbeat checker Lambda 執行失敗，請檢查 Lambda log 與權限設定',
      metric: heartbeatChecker.metricErrors({
        period: cdk.Duration.hours(6),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    heartbeatCheckerErrorAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.failureAlertTopic)
    );

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      exportName: 'LineReportLogGroupName',
    });

    new cdk.CfnOutput(this, 'FailureAlertTopicArn', {
      value: this.failureAlertTopic.topicArn,
      exportName: 'LineReportFailureAlertTopicArn',
    });

    new cdk.CfnOutput(this, 'HeartbeatAlertTopicArn', {
      value: this.heartbeatAlertTopic.topicArn,
      exportName: 'LineReportHeartbeatAlertTopicArn',
    });

    new cdk.CfnOutput(this, 'DebugOutcomeTopicArn', {
      value: this.debugOutcomeTopic.topicArn,
      exportName: 'LineReportDebugOutcomeTopicArn',
    });
  }
}
