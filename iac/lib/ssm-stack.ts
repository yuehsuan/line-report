import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * SSM Parameter Store placeholder 定義
 *
 * 本 Stack 僅建立參數的「骨架」（placeholder 值）。
 * 實際機密值（LINE_CHANNEL_ACCESS_TOKEN 等）請部署後手動透過 CLI 更新：
 *
 *   aws ssm put-parameter \
 *     --name /line-report/LINE_CHANNEL_ACCESS_TOKEN \
 *     --type SecureString \
 *     --value "YOUR_TOKEN" \
 *     --overwrite
 */
export class SsmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SecureString：LINE Channel Access Token（機密，請手動更新值）
    new ssm.StringParameter(this, 'LineChannelAccessToken', {
      parameterName: '/line-report/LINE_CHANNEL_ACCESS_TOKEN',
      stringValue: 'PLACEHOLDER_UPDATE_MANUALLY',
      description: 'LINE Messaging API Channel Access Token（機密）',
      tier: ssm.ParameterTier.STANDARD,
    });

    // LINE 推播目標（逗號分隔，支援群組/個人/聊天室）
    new ssm.StringParameter(this, 'LineTargets', {
      parameterName: '/line-report/LINE_TARGETS',
      stringValue: 'PLACEHOLDER_UPDATE_MANUALLY',
      description: 'LINE 推播目標（逗號分隔：C=群組, U=個人, R=聊天室）',
      tier: ssm.ParameterTier.STANDARD,
    });

    // 免費額度則數
    new ssm.StringParameter(this, 'FreeQuota', {
      parameterName: '/line-report/FREE_QUOTA',
      stringValue: '1000',
      description: 'LINE 免費訊息額度則數',
      tier: ssm.ParameterTier.STANDARD,
    });

    // 計費模式
    new ssm.StringParameter(this, 'PricingModel', {
      parameterName: '/line-report/PRICING_MODEL',
      stringValue: 'single',
      description: '計費模式：single 或 tiers',
      tier: ssm.ParameterTier.STANDARD,
    });

    // 單一計費單價
    new ssm.StringParameter(this, 'SingleUnitPrice', {
      parameterName: '/line-report/SINGLE_UNIT_PRICE',
      stringValue: '0.2',
      description: 'single 模式：每則單價（TWD）',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Tiers 級距 JSON
    new ssm.StringParameter(this, 'TiersJson', {
      parameterName: '/line-report/TIERS_JSON',
      stringValue: '[{"upTo":10000,"price":0.2},{"upTo":50000,"price":0.18},{"upTo":null,"price":0.16}]',
      description: 'tiers 模式：級距計費 JSON',
      tier: ssm.ParameterTier.STANDARD,
    });

    new cdk.CfnOutput(this, 'SsmBasePath', {
      value: '/line-report/',
      description: 'SSM Parameter Store 基礎路徑',
    });
  }
}
