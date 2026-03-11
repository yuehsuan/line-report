import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MonitoringStack } from '../lib/monitoring-stack';

describe('MonitoringStack', () => {
  it('應建立三個通知主題與 heartbeat checker 相關告警', () => {
    const app = new cdk.App({
      context: {
        alarmEmail: 'alerts@example.com',
        debugEmail: 'debug@example.com',
      },
    });
    const stack = new MonitoringStack(app, 'TestMonitoringStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'line-report-alarms',
    });

    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'line-report-heartbeat-alerts',
    });

    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'line-report-debug-outcomes',
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'python3.12',
      Environment: {
        Variables: Match.objectLike({
          JOB_RUNS_TABLE: 'job_runs',
          DAILY_SNAPSHOT_SCHEDULE_NAME: 'line-report-daily-snapshot',
          MONTHLY_REPORT_SCHEDULE_NAME: 'line-report-monthly-report',
        }),
      },
    });

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 0 * * ? *)',
    });

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(5 0 * * ? *)',
    });

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(6 hours)',
    });

    for (const alarmName of [
      'line-report-snapshot-missing',
      'line-report-report-missing',
      'line-report-daily-snapshot-schedule-disabled',
      'line-report-monthly-report-schedule-disabled',
      'line-report-heartbeat-checker-error',
    ]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
      });
    }

    const subscriptions = template.findResources('AWS::SNS::Subscription');
    assert.equal(Object.keys(subscriptions).length, 3);
  });
});
