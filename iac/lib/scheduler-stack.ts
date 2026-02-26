import * as cdk from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

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

    // ── Schedule A：每日快照（23:55 Asia/Taipei）─────────────────
    new scheduler.CfnSchedule(this, 'DailySnapshotSchedule', {
      name: 'line-report-daily-snapshot',
      description: 'LINE 用量每日快照（23:55 Asia/Taipei）',
      scheduleExpression: 'cron(55 23 * * ? *)',
      scheduleExpressionTimezone: 'Asia/Taipei',
      state: 'ENABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: cluster.clusterArn,
        roleArn: schedulerRole.roleArn,
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
        },
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 600,
        },
      },
    });

    // ── Schedule B：每月回報（每月 11 日 09:00 Asia/Taipei）───────
    new scheduler.CfnSchedule(this, 'MonthlyReportSchedule', {
      name: 'line-report-monthly-report',
      description: 'LINE 用量每月回報（每月 11 日 09:00 Asia/Taipei）',
      scheduleExpression: 'cron(0 9 11 * ? *)',
      scheduleExpressionTimezone: 'Asia/Taipei',
      state: 'ENABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: cluster.clusterArn,
        roleArn: schedulerRole.roleArn,
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
        },
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
