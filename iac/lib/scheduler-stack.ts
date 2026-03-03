import * as cdk from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { buildReportCron, buildSnapshotCron } from './cron-builder';

export interface SchedulerStackProps extends cdk.StackProps {
  taskDefinition: ecs.FargateTaskDefinition;
  cluster: ecs.Cluster;
  securityGroup: ec2.SecurityGroup;
  subnets: ec2.SubnetSelection;
}

export class SchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const { taskDefinition, cluster, securityGroup, subnets } = props;

    // ── Scheduler 執行 Role ───────────────────────────────────────
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: 'line-report-scheduler-role',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsRunTask',
      effect: iam.Effect.ALLOW,
      actions: ['ecs:RunTask'],
      resources: [taskDefinition.taskDefinitionArn],
    }));

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'IamPassRole',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        taskDefinition.executionRole!.roleArn,
        taskDefinition.taskRole.roleArn,
      ],
    }));

    // 解析 subnet IDs
    const vpc = cluster.vpc;
    const resolvedSubnets = vpc.selectSubnets(subnets).subnetIds;

    const ecsParameters: scheduler.CfnSchedule.EcsParametersProperty = {
      taskDefinitionArn: taskDefinition.taskDefinitionArn,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: resolvedSubnets,
          securityGroups: [securityGroup.securityGroupId],
          assignPublicIp: 'ENABLED',
        },
      },
      taskCount: 1,
    };

    // 排程時間從 CDK context 讀取（deploy 時透過 --context 傳入，預設值對應 .env.example）
    const snapshotHour   = this.node.tryGetContext('snapshotHour')   ?? '23';
    const snapshotMinute = this.node.tryGetContext('snapshotMinute') ?? '55';
    const reportHour     = this.node.tryGetContext('reportHour')     ?? '9';
    const reportMode     = this.node.tryGetContext('reportMode')     ?? 'date';

    // ── 回報 cron 依 reportMode 產生（邏輯集中於 cron-builder.ts）──
    const { cron: reportCron, description: reportDescription } = buildReportCron({
      reportMode,
      reportDay:      String(this.node.tryGetContext('reportDay')      ?? '11'),
      reportWeek:     String(this.node.tryGetContext('reportWeek')     ?? '2'),
      reportWeekday:  String(this.node.tryGetContext('reportWeekday')  ?? '3'),
      reportHour,
    });

    // ── Schedule A：每日快照（預設 23:55 Asia/Taipei）────────────
    new scheduler.CfnSchedule(this, 'DailySnapshotSchedule', {
      name: 'line-report-daily-snapshot',
      description: `LINE 用量每日快照（${snapshotHour}:${snapshotMinute.padStart(2,'0')} Asia/Taipei）`,
      scheduleExpression: buildSnapshotCron(snapshotHour, snapshotMinute),
      scheduleExpressionTimezone: 'Asia/Taipei',
      state: 'ENABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: cluster.clusterArn,
        roleArn: schedulerRole.roleArn,
        // CDK 型別定義缺少 overrides，但 CloudFormation 支援；用 double cast 繞過
        ecsParameters: {
          ...ecsParameters,
          overrides: {
            containerOverrides: [
              {
                name: 'app',
                command: ['node', 'src/index.js', 'snapshot'],
              },
            ],
          },
        } as unknown as scheduler.CfnSchedule.EcsParametersProperty,
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 600,
        },
      },
    });

    // ── Schedule B：每月回報 ──────────────────────────────────────
    new scheduler.CfnSchedule(this, 'MonthlyReportSchedule', {
      name: 'line-report-monthly-report',
      description: reportDescription,
      scheduleExpression: reportCron,
      scheduleExpressionTimezone: 'Asia/Taipei',
      state: 'ENABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: cluster.clusterArn,
        roleArn: schedulerRole.roleArn,
        // CDK 型別定義缺少 overrides，但 CloudFormation 支援；用 double cast 繞過
        ecsParameters: {
          ...ecsParameters,
          overrides: {
            containerOverrides: [
              {
                name: 'app',
                command: ['node', 'src/index.js', 'report', '--month=prev'],
              },
            ],
          },
        } as unknown as scheduler.CfnSchedule.EcsParametersProperty,
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 1800,
        },
      },
    });

    new cdk.CfnOutput(this, 'SchedulerRoleArn', {
      value: schedulerRole.roleArn,
      exportName: 'LineReportSchedulerRoleArn',
    });
  }
}
