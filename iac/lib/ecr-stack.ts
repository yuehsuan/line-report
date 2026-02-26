import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export class EcrStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, 'LineReportRepo', {
      repositoryName: 'line-report',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      // imageTagMutability=MUTABLE 允許相同 tag 重複推送（回滾時會重新指向）
      imageTagMutability: ecr.TagMutability.MUTABLE,
    });

    // Lifecycle policy：保留最近 30 個 tag 版本，避免無限堆積
    this.repository.addLifecycleRule({
      rulePriority: 1,
      description: '保留最近 30 個版本 image',
      tagStatus: ecr.TagStatus.TAGGED,
      tagPrefixList: ['v', 'sha-'],
      maxImageCount: 30,
    });

    // 清除 untagged images（建置失敗殘留的 dangling image）
    this.repository.addLifecycleRule({
      rulePriority: 2,
      description: '清除 7 天以上的 untagged image',
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: cdk.Duration.days(7),
    });

    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      exportName: 'LineReportRepositoryUri',
    });
  }
}
