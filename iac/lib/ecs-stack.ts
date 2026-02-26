import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
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
  public readonly taskDefinition: ecs.FargateTaskDefinition;
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

    // ── Task Definition ───────────────────────────────────────────
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: 'line-report',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
    });

    const imageUri = `${ecrRepo.repositoryUri}:${imageTag}`;

    this.taskDefinition.addContainer('app', {
      containerName: 'app',
      image: ecs.ContainerImage.fromRegistry(imageUri),
      essential: true,
      environment: {
        TZ: 'Asia/Taipei',
        AWS_REGION: this.region,
        DDB_TABLE_SNAPSHOTS: snapshotsTable.tableName,
        DDB_TABLE_RUNS: runsTable.tableName,
        LOG_LEVEL: 'info',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'line-report',
        logGroup,
      }),
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      exportName: 'LineReportClusterArn',
    });

    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: this.taskDefinition.taskDefinitionArn,
      exportName: 'LineReportTaskDefinitionArn',
    });

    new cdk.CfnOutput(this, 'ImageUri', {
      value: imageUri,
      exportName: 'LineReportImageUri',
    });
  }
}
