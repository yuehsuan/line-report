import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface EcsStackProps extends cdk.StackProps {
  ecrRepo: ecr.Repository;
  imageTag: string;
  snapshotsTable: dynamodb.Table;
  runsTable: dynamodb.Table;
  logGroup: logs.LogGroup;
}

export class EcsStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly snapshotTaskDefinition: ecs.FargateTaskDefinition;
  public readonly reportTaskDefinition: ecs.FargateTaskDefinition;
  public readonly taskSecurityGroup: ec2.SecurityGroup;
  public readonly taskSubnets: ec2.SubnetSelection;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { ecrRepo, imageTag, snapshotsTable, runsTable, logGroup } = props;

    // ── VPC：使用預設 VPC（可改為自訂 VPC）────────────────────────
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // ── ECS Cluster ───────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'LineReportCluster', {
      clusterName: 'line-report',
      vpc,
      containerInsights: true,
    });

    // ── Task Security Group（Fargate 無法 inbound；只需 egress HTTPS）
    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc,
      securityGroupName: 'line-report-task-sg',
      description: 'ECS Fargate task SG for line-report',
      allowAllOutbound: true,
    });

    this.taskSubnets = { subnetType: ec2.SubnetType.PUBLIC };

    // ── Execution Role（拉 image + 推 CloudWatch logs）──────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: 'line-report-task-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    ecrRepo.grantPull(executionRole);
    logGroup.grantWrite(executionRole);

    // SSM secrets 注入權限（容器啟動前由 execution role 拉取）
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmSecretsAccess',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/line-report/*`,
      ],
    }));

    // ── Task Role（程式執行時的 AWS 權限）────────────────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'line-report-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // DynamoDB 最小權限
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDbAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:PutItem',
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
      ],
      resources: [
        snapshotsTable.tableArn,
        runsTable.tableArn,
      ],
    }));

    // SSM Parameter Store 最小權限（/line-report/* 路徑）
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmParameterAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/line-report/*`,
      ],
    }));

    const imageUri = `${ecrRepo.repositoryUri}:${imageTag}`;

    // ── 共用 SSM secrets 設定（兩個 task definition 共用）────────────
    const ssmSecrets = {
      LINE_CHANNEL_ACCESS_TOKEN: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SsmToken', {
          parameterName: '/line-report/LINE_CHANNEL_ACCESS_TOKEN',
        })
      ),
      LINE_TARGETS: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'SsmTargets',
          '/line-report/LINE_TARGETS')
      ),
      FREE_QUOTA: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'SsmFreeQuota',
          '/line-report/FREE_QUOTA')
      ),
      PRICING_MODEL: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'SsmPricingModel',
          '/line-report/PRICING_MODEL')
      ),
      PLAN_FEE: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'SsmPlanFee',
          '/line-report/PLAN_FEE')
      ),
      SINGLE_UNIT_PRICE: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'SsmSingleUnitPrice',
          '/line-report/SINGLE_UNIT_PRICE')
      ),
      CURRENCY: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, 'SsmCurrency',
          '/line-report/CURRENCY')
      ),
    };

    const sharedEnv = {
      TZ: 'Asia/Taipei',
      AWS_REGION: this.region,
      DDB_TABLE_SNAPSHOTS: snapshotsTable.tableName,
      DDB_TABLE_RUNS: runsTable.tableName,
      LOG_LEVEL: 'info',
    };

    // ── Task Definition A：每日快照（command bake in，Scheduler 無需 override）
    this.snapshotTaskDefinition = new ecs.FargateTaskDefinition(this, 'SnapshotTaskDefinition', {
      family: 'line-report-snapshot',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
    });

    this.snapshotTaskDefinition.addContainer('app', {
      containerName: 'app',
      image: ecs.ContainerImage.fromRegistry(imageUri),
      essential: true,
      command: ['node', 'src/index.js', 'snapshot'],
      environment: sharedEnv,
      secrets: ssmSecrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'line-report',
        logGroup,
      }),
    });

    // ── Task Definition B：每月回報（command bake in，Scheduler 無需 override）
    this.reportTaskDefinition = new ecs.FargateTaskDefinition(this, 'ReportTaskDefinition', {
      family: 'line-report-report',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
    });

    this.reportTaskDefinition.addContainer('app', {
      containerName: 'app',
      image: ecs.ContainerImage.fromRegistry(imageUri),
      essential: true,
      command: ['node', 'src/index.js', 'report', '--month=prev'],
      environment: sharedEnv,
      secrets: ssmSecrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'line-report',
        logGroup,
      }),
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      exportName: 'LineReportClusterArn',
    });

    new cdk.CfnOutput(this, 'SnapshotTaskDefinitionArn', {
      value: this.snapshotTaskDefinition.taskDefinitionArn,
      exportName: 'LineReportSnapshotTaskDefinitionArn',
    });

    new cdk.CfnOutput(this, 'ReportTaskDefinitionArn', {
      value: this.reportTaskDefinition.taskDefinitionArn,
      exportName: 'LineReportReportTaskDefinitionArn',
    });

    new cdk.CfnOutput(this, 'ImageUri', {
      value: imageUri,
      exportName: 'LineReportImageUri',
    });
  }
}
