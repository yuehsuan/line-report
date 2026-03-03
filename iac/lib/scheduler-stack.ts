import * as cdk from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { buildReportCron, buildSnapshotCron } from './cron-builder';

// SchedulerStack 不依賴任何 EcsStack CDK 物件，完全從已知常數或 lookup 取值。
// 這樣 CDK 不會在 CloudFormation 產生跨 stack 的 export/import，
// 也不會把 EcsStack 列為 SchedulerStack 的 dependency，
// 因此每次更新 imageTag 不會再遇到「export in use」的部署卡住問題。
export class SchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // VPC lookup（context 已在首次 cdk synth 時快取）
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // Security Group lookup by name（首次 synth 會查 AWS API 並快取至 cdk.context.json）
    const securityGroup = ec2.SecurityGroup.fromLookupByName(
      this, 'TaskSg', 'line-report-task-sg', vpc,
    );

    // Public subnet IDs（從 context 快取取出，與 EcsStack 相同的 VPC）
    const resolvedSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds;

    // 固定名稱 cluster ARN，不引用 EcsStack 物件
    const clusterArn = `arn:aws:ecs:${this.region}:${this.account}:cluster/line-report`;

    // 固定 family 名稱：不帶版本號，EventBridge 自動選最新 ACTIVE revision
    const taskDefFamily = 'line-report';
    const taskDefinitionArn = `arn:aws:ecs:${this.region}:${this.account}:task-definition/${taskDefFamily}`;
    const taskDefinitionArnWildcard = `${taskDefinitionArn}:*`;
    // Role ARN 用固定名稱建構
    const executionRoleArn = `arn:aws:iam::${this.account}:role/line-report-task-execution-role`;
    const taskRoleArn      = `arn:aws:iam::${this.account}:role/line-report-task-role`;

    // ── Scheduler 執行 Role ───────────────────────────────────────
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: 'line-report-scheduler-role',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsRunTask',
      effect: iam.Effect.ALLOW,
      actions: ['ecs:RunTask'],
      resources: [taskDefinitionArnWildcard],
    }));

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'IamPassRole',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [executionRoleArn, taskRoleArn],
    }));

    const ecsParameters: scheduler.CfnSchedule.EcsParametersProperty = {
      taskDefinitionArn,
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
        arn: clusterArn,
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
        arn: clusterArn,
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
