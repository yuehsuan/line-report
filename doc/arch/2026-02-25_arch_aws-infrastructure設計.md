# AWS 基礎設施設計

**日期**：2026-02-25
**狀態**：已部署

---

## 架構總覽

```
EventBridge Scheduler
  ├── 每日 23:55 Asia/Taipei  ──→  ECS Fargate (snapshot task)
  │                                    ├── GET LINE /quota/consumption
  │                                    ├── DynamoDB PutItem (usage_snapshots)
  │                                    └── DynamoDB PutItem (job_runs)
  │
  └── 每月 11 日 09:00 Asia/Taipei  ──→  ECS Fargate (report task)
                                          ├── DynamoDB Query (prevMonthFinal)
                                          ├── calculateFee()
                                          └── POST LINE /message/push

SSM Parameter Store /line-report/*  ──→  LINE token, group ID, pricing config
CloudWatch Logs /ecs/line-report    ──→  JSON structured logs (pino)
CloudWatch Alarm + SNS              ──→  Error alert
```

---

## CDK Stacks

| Stack | 資源 | 說明 |
|-------|------|------|
| `LineReportDatabaseStack` | DynamoDB `usage_snapshots`, `job_runs` | 快照與執行紀錄，`RemovalPolicy.RETAIN` |
| `LineReportEcrStack` | ECR Repository `line-report` | Docker image 儲存庫 |
| `LineReportSsmStack` | SSM Parameters | LINE token、群組 ID、計費設定 |
| `LineReportMonitoringStack` | CloudWatch Alarm + SNS | 錯誤告警 |
| `LineReportEcsStack` | ECS Cluster + Task Definition | Fargate 容器設定，image tag 由 `--context imageTag` 注入 |
| `LineReportSchedulerStack` | EventBridge Scheduler × 2 | snapshot / report cron 排程 |

### 部署順序

```
DatabaseStack → EcrStack → MonitoringStack → SsmStack → EcsStack → SchedulerStack
```

---

## DynamoDB 資料模型

### usage_snapshots

| 欄位 | 類型 | 說明 |
|------|------|------|
| `monthKey` | String (PK) | 格式 `YYYY-MM`，分區鍵 |
| `date` | String (SK) | 格式 `YYYY-MM-DD`，排序鍵 |
| `totalUsage` | Number | 當月累計訊息數 |
| `isPrevMonthFinal` | Boolean | 是否為上月最終快照 |
| `capturedAt` | String | ISO8601 時間戳記 |

### job_runs（幂等防重）

| 欄位 | 類型 | 說明 |
|------|------|------|
| `jobId` | String (PK) | 格式 `snapshot#YYYY-MM-DD` 或 `report#YYYY-MM` |
| `status` | String | `completed` / `failed` |
| `runAt` | String | ISO8601 時間戳記 |

---

## 機密管理

所有敏感設定透過 SSM Parameter Store 注入 ECS Task：

| SSM 路徑 | 說明 |
|----------|------|
| `/line-report/LINE_CHANNEL_ACCESS_TOKEN` | SecureString |
| `/line-report/LINE_TARGETS` | String（逗號分隔多目標）|
| `/line-report/PRICING_MODEL` | String |
| `/line-report/SINGLE_UNIT_PRICE` | String |
| `/line-report/TIERS_JSON` | String |
| `/line-report/FREE_QUOTA` | String |

---

## 幂等性設計

1. **snapshot**：使用 DynamoDB Conditional Put，`attribute_not_exists(date)` 防止重複寫入
2. **report**：寫入 `job_runs` 前先 `GetItem`，存在則跳過

---

## CI/CD 流程

```
git push --tags v*
  └── GitHub Actions (deploy.yml)
        ├── Docker build
        ├── ECR push (version tag + sha tag)
        └── CDK deploy LineReportEcsStack --context imageTag=$VERSION_TAG
```

### OIDC 認證

GitHub Actions 透過 OIDC 取得 AWS 臨時憑證，無需儲存長期 Access Key。

```json
{
  "Condition": {
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:<組織>/<儲存庫>:*"
    }
  }
}
```
