# LINE 訊息用量回報服務

LINE 官方帳號「訊息用量與加購費用估算」自動化服務，部署於 AWS ECS Fargate，以 EventBridge Scheduler 排程每日快照與每月回報。

## 功能說明

- **每日快照**（23:55 Asia/Taipei）：呼叫 LINE Messaging API 取得當月用量，存入 DynamoDB
- **跨月封存**：月份變更時自動標記上月最後一筆快照為 `prevMonthFinal`，並支援補封存
- **每月回報**（每月 11 日 09:00 Asia/Taipei）：計算加購費用，推播繁中訊息到指定 LINE 群組
- **幂等性**：同一天重複觸發不會重複寫入（conditional put + job_runs 防重）

---

## 目錄結構

```
line-report/
├── src/
│   ├── index.js              # CLI entry
│   ├── actions/
│   │   ├── snapshot.js       # 每日快照邏輯
│   │   └── report.js         # 每月回報邏輯
│   ├── lib/
│   │   ├── date.js           # Asia/Taipei 日期工具（luxon）
│   │   ├── db.js             # DynamoDB DocumentClient v3
│   │   ├── lineApi.js        # LINE API 封裝
│   │   ├── logger.js         # pino logger（JSON）
│   │   ├── pricing.js        # 計費模型
│   │   └── storage.js        # 快照 CRUD + prevMonthFinal
│   └── __tests__/            # 單元測試 / 整合測試
├── scripts/
│   └── dry-run.js            # 本機驗證腳本
├── iac/                      # AWS CDK（TypeScript）
│   ├── bin/app.ts
│   └── lib/
│       ├── database-stack.ts
│       ├── ecr-stack.ts
│       ├── ecs-stack.ts
│       ├── monitoring-stack.ts
│       ├── scheduler-stack.ts
│       └── ssm-stack.ts
├── .github/workflows/
│   └── deploy.yml            # GitHub Actions CI/CD
├── Dockerfile
└── .env.example
```

---

## 環境變數完整清單

複製 `.env.example` 並填入實際值：

```bash
cp .env.example .env
```

| 變數 | 說明 | 預設值 | 必填 |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel Access Token | — | ✅ |
| `LINE_GROUP_ID` | 推播目標群組 ID | — | ✅ |
| `FREE_QUOTA` | 每月免費訊息額度（則） | `0` | |
| `PRICING_MODEL` | 計費模式：`single` 或 `tiers` | `single` | |
| `SINGLE_UNIT_PRICE` | single 模式：每則單價（TWD） | `0.2` | |
| `TIERS_JSON` | tiers 模式：級距 JSON（見下方說明） | — | tiers 時必填 |
| `AWS_REGION` | AWS 區域 | `ap-northeast-1` | |
| `DDB_TABLE_SNAPSHOTS` | DynamoDB 快照表名 | `usage_snapshots` | |
| `DDB_TABLE_RUNS` | DynamoDB 執行紀錄表名 | `job_runs` | |
| `CURRENCY` | 貨幣符號 | `TWD` | |
| `LOG_LEVEL` | pino log level | `info` | |
| `TZ` | 容器時區（影響系統預設時區） | `Asia/Taipei` | |
| `DRY_RUN` | `true` 時跳過 LINE 實際推播 | — | |
| `AWS_ENDPOINT_URL` | 本機測試用 DynamoDB Local endpoint | — | |

### TIERS_JSON 格式範例

```json
[
  { "upTo": 10000, "price": 0.2 },
  { "upTo": 50000, "price": 0.18 },
  { "upTo": null,  "price": 0.16 }
]
```

`upTo: null` 表示無上限最後一級，費用依級距累進計算。

---

## 本機執行

### 1. 安裝相依套件

```bash
npm install
```

### 2. 設定環境變數

```bash
cp .env.example .env
# 編輯 .env 填入 LINE token 等資訊
```

### 3. 執行快照

```bash
node src/index.js snapshot
```

### 4. 執行回報（前月）

```bash
node src/index.js report --month=prev
```

### 5. 執行回報（指定月份）

```bash
node src/index.js report --month=2026-01
```

### 6. DRY_RUN 模式（跳過 LINE push，僅印出訊息）

```bash
DRY_RUN=true node src/index.js report --month=prev
```

---

## 執行測試

```bash
# 執行所有測試
npm test

# 個別執行
npm run test:pricing    # 計費模型測試
npm run test:date       # 日期工具測試
npm run test:storage    # DynamoDB 整合測試（使用 mock）
```

---

## 本機完整流程驗證（dry-run）

使用 DynamoDB Local 驗證完整 snapshot → report 流程，**不需要真實 AWS 帳號**：

```bash
# 1. 啟動 DynamoDB Local
docker run -d -p 8000:8000 amazon/dynamodb-local

# 2. 在 .env 中取消 AWS_ENDPOINT_URL 的註解
# AWS_ENDPOINT_URL=http://localhost:8000  →  移除 # 號

# 3. 執行完整流程（會自動建表、seed 上月假資料、跑 snapshot + report）
npm run dry-run

# 4. 只跑快照
npm run dry-run -- --step=snapshot

# 5. 只跑回報
npm run dry-run -- --step=report

# 6. 查看 DB 內容
npm run dry-run -- --inspect
```

> **注意**：`npm run dry-run` 內部會強制設定 `DRY_RUN=true`，不會真的推播 LINE 訊息。若要測試真實推播，請直接執行 `npm run report`（需確保 `.env` 中 `LINE_TARGETS` 已填入正確 ID）。

---

## AWS 部署

### 前置條件

- AWS CLI 已設定，帳號有 ECR/ECS/DynamoDB/SSM 相關權限
- CDK 已安裝：`npm install -g aws-cdk`

### Step 1：Bootstrap CDK（首次部署時）

```bash
cd iac
npm install
cdk bootstrap aws://<帳號ID>/<區域>
```

### Step 2：部署基礎設施

```bash
cd iac

# 依序部署各 stack
cdk deploy LineReportDatabaseStack
cdk deploy LineReportEcrStack
cdk deploy LineReportMonitoringStack
cdk deploy LineReportSsmStack

# 部署 ECS（需要指定 image tag，禁用 latest）
cdk deploy LineReportEcsStack --context imageTag=v20260225-1

# 部署排程
cdk deploy LineReportSchedulerStack

# 或一鍵部署全部
cdk deploy --all --context imageTag=v20260225-1
```

### Step 3：填入 SSM Parameter Store 機密值

```bash
# LINE Channel Access Token（SecureString）
aws ssm put-parameter \
  --name /line-report/LINE_CHANNEL_ACCESS_TOKEN \
  --type SecureString \
  --value "YOUR_LINE_TOKEN" \
  --overwrite

# LINE 群組 ID
aws ssm put-parameter \
  --name /line-report/LINE_GROUP_ID \
  --type String \
  --value "C1234567890abcdef" \
  --overwrite
```

### Step 4：首次推送 Docker Image

```bash
# 登入 ECR
aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin <帳號>.dkr.ecr.ap-northeast-1.amazonaws.com

# Build 並推送
ECR_URI="<帳號>.dkr.ecr.ap-northeast-1.amazonaws.com/line-report"
VERSION_TAG="v20260225-1"
SHA_TAG="sha-$(git rev-parse --short HEAD)"

docker build -t "${ECR_URI}:${VERSION_TAG}" -t "${ECR_URI}:${SHA_TAG}" .
docker push "${ECR_URI}:${VERSION_TAG}"
docker push "${ECR_URI}:${SHA_TAG}"
```

### Step 5：手動觸發測試

```bash
# 手動執行快照（立即觸發）
aws ecs run-task \
  --cluster line-report \
  --task-definition line-report \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxxx],securityGroups=[sg-xxxx],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","src/index.js","snapshot"]}]}'

# 手動執行回報
aws ecs run-task \
  --cluster line-report \
  --task-definition line-report \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxxx],securityGroups=[sg-xxxx],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","src/index.js","report","--month=prev"]}]}'
```

---

## GitHub Actions 設定

### 必要 Secrets / Variables

在 GitHub Repository Settings → Secrets and Variables 設定：

| 名稱 | 類型 | 說明 |
|---|---|---|
| `AWS_ROLE_ARN` | Secret | OIDC Role ARN（格式：`arn:aws:iam::帳號:role/xxx`）|
| `ECR_REPOSITORY` | Secret | ECR 儲存庫名稱（如 `line-report`，不含 registry）|
| `AWS_REGION` | Variable | AWS 區域（如 `ap-northeast-1`）|

### OIDC Role 設定

在 AWS IAM 建立 Role，信任策略允許 GitHub Actions OIDC：

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<帳號>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<組織>/<儲存庫>:*" }
    }
  }]
}
```

### 觸發部署

推送任意 `v*` tag 即觸發 CI/CD：

```bash
git tag v20260225-1
git push origin v20260225-1
```

---

## 回滾到上一版本

### Step 1：確認可用的舊版 tag

```bash
aws ecr describe-images \
  --repository-name line-report \
  --query 'sort_by(imageDetails, &imagePushedAt)[*].{Tags:imageTags,PushedAt:imagePushedAt}' \
  --output table
```

### Step 2：建立回滾版本的 Task Definition

```bash
TARGET_TAG="v20260224-1"   # 替換為目標版本
ECR_URI="<帳號>.dkr.ecr.<區域>.amazonaws.com/line-report"
FAMILY="line-report"

aws ecs describe-task-definition --task-definition $FAMILY \
  --query 'taskDefinition' \
  | jq --arg img "$ECR_URI:$TARGET_TAG" \
       'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy) |
        .containerDefinitions[0].image = $img' \
  > /tmp/td-rollback.json

NEW_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-rollback.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

echo "已建立回滾 Task Definition: $NEW_ARN"
```

### Step 3：更新 EventBridge Scheduler 指向回滾版本

```bash
# 確認目前 Scheduler 指向的版本
aws scheduler get-schedule --name line-report-daily-snapshot \
  --query 'Target.EcsParameters.TaskDefinitionArn'

# 更新 Scheduler（daily-snapshot 與 monthly-report 皆需更新）
# 注意：--target 參數需填入完整 JSON，請先取得當前設定再更新
aws scheduler get-schedule --name line-report-daily-snapshot > /tmp/current-schedule.json

# 參考 /tmp/current-schedule.json 修改 TaskDefinitionArn 後執行 update-schedule
```

> **提示**：若使用 CDK 管理，可直接重新部署指定舊版本：
> ```bash
> cd iac && cdk deploy LineReportEcsStack --context imageTag=$TARGET_TAG
> ```

---

## Log 查詢

### CloudWatch Logs Insights

```
# 查詢最近 24 小時所有 ERROR
fields @timestamp, @message
| filter level = "error"
| sort @timestamp desc
| limit 50
```

```
# 查詢特定 job 執行結果
fields @timestamp, action, jobId, status, totalUsage
| filter action in ["snapshot", "report"]
| sort @timestamp desc
| limit 20
```

### AWS CLI

```bash
# 查詢最近 1 小時的 log
aws logs filter-log-events \
  --log-group-name /ecs/line-report \
  --start-time $(date -d '1 hour ago' +%s000) \
  --filter-pattern "ERROR"
```

---

## DynamoDB 資料驗證

### 查詢最近快照

```bash
aws dynamodb query \
  --table-name usage_snapshots \
  --key-condition-expression "monthKey = :mk" \
  --expression-attribute-values '{":mk":{"S":"2026-02"}}' \
  --scan-index-forward false \
  --max-items 5
```

### 查詢 prevMonthFinal

```bash
aws dynamodb query \
  --table-name usage_snapshots \
  --key-condition-expression "monthKey = :mk" \
  --filter-expression "isPrevMonthFinal = :t" \
  --expression-attribute-values '{":mk":{"S":"2026-01"},":t":{"BOOL":true}}'
```

### 查詢 job_runs 執行紀錄

```bash
aws dynamodb get-item \
  --table-name job_runs \
  --key '{"jobId":{"S":"snapshot#2026-02-25"}}'
```

---

## 架構說明

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

## 注意事項

- LINE consumption API 回傳的 `totalUsage` 為**近似值**，最終帳單請以 LINE OA Manager 後台為準
- `isPrevMonthFinal` 快照一旦標記，建議不要手動修改（影響回報計算）
- `cdk destroy` 不會刪除 DynamoDB 資料表（`RemovalPolicy.RETAIN`），請手動清理
- image tag 禁止使用 `latest`，任何 CI/CD 與 CDK 部署均強制使用明確版本 tag
