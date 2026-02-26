import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DatabaseStack extends cdk.Stack {
  public readonly snapshotsTable: dynamodb.Table;
  public readonly runsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── usage_snapshots ──────────────────────────────────────────
    // PK: monthKey (S)  e.g. "2026-02"
    // SK: ts (S)        UTC ISO string e.g. "2026-02-25T15:55:00.000Z"
    this.snapshotsTable = new dynamodb.Table(this, 'UsageSnapshotsTable', {
      tableName: 'usage_snapshots',
      partitionKey: { name: 'monthKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // RETAIN 避免 cdk destroy 誤刪歷史資料
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // ── job_runs ──────────────────────────────────────────────────
    // PK: jobId (S)  e.g. "snapshot#2026-02-25" / "report#2026-01"
    this.runsTable = new dynamodb.Table(this, 'JobRunsTable', {
      tableName: 'job_runs',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // TTL：job run 紀錄保留 90 天後自動刪除（節省成本）
      timeToLiveAttribute: 'ttl',
    });

    new cdk.CfnOutput(this, 'SnapshotsTableName', {
      value: this.snapshotsTable.tableName,
      exportName: 'LineReportSnapshotsTableName',
    });

    new cdk.CfnOutput(this, 'RunsTableName', {
      value: this.runsTable.tableName,
      exportName: 'LineReportRunsTableName',
    });
  }
}
