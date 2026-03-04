#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/database-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsStack } from '../lib/ecs-stack';
import { SchedulerStack } from '../lib/scheduler-stack';
import { SsmStack } from '../lib/ssm-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
};

// imageTag 透過 CDK context 傳入（e.g. cdk deploy --context imageTag=v20260225-1）
// 預設為 sha-unknown，明確禁止使用 latest
const imageTag = app.node.tryGetContext('imageTag') || 'sha-unknown';
if (imageTag === 'latest') {
  throw new Error('[CDK] imageTag 不得使用 "latest"，請指定明確版本 tag（如 v20260225-1 或 sha-xxxxxxx）');
}

const dbStack = new DatabaseStack(app, 'LineReportDatabaseStack', { env });

const ecrStack = new EcrStack(app, 'LineReportEcrStack', { env });

const ssmStack = new SsmStack(app, 'LineReportSsmStack', { env });

const monitoringStack = new MonitoringStack(app, 'LineReportMonitoringStack', { env });

const ecsStack = new EcsStack(app, 'LineReportEcsStack', {
  env,
  ecrRepo: ecrStack.repository,
  imageTag,
  snapshotsTable: dbStack.snapshotsTable,
  runsTable: dbStack.runsTable,
  logGroup: monitoringStack.logGroup,
});

new SchedulerStack(app, 'LineReportSchedulerStack', {
  env,
  alarmTopicArn: monitoringStack.alarmTopic.topicArn,
});

app.synth();
