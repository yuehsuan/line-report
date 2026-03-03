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
| `LINE_TARGETS` | 推播目標（逗號分隔；C=群組、U=個人、R=聊天室） | — | ✅ |
| `FREE_QUOTA` | 每月免費訊息額度（則） | `0` | |
| `PRICING_MODEL` | 計費模式：`single` 或 `tiers` | `single` | |
| `PLAN_FEE` | 月方案費（元），每月固定計收；設 0 表示不計入 | `0` | |
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
npm run snapshot
```

### 4. 執行回報（前月）

```bash
npm run report
```

### 5. 執行回報（指定月份）

```bash
node --env-file=.env src/index.js report --month=2026-01
```

### 6. DRY_RUN 模式（跳過 LINE push，僅印出訊息）

```bash
# 在 .env 中設定 DRY_RUN=true 後執行
npm run report
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
npm run test:report     # 回報失敗場景測試（使用 mock）
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

在 `.env` 填入 `IMAGE_TAG`、排程設定與告警 Email，再執行：

```bash
# 一鍵部署全部 stack（從 .env 讀取所有設定）
npm run deploy

# 只部署特定 stack（stack 名稱直接當參數）
npm run deploy -- LineReportSchedulerStack
```

**`.env` 排程相關欄位（deploy 時生效）：**

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `IMAGE_TAG` | Docker image tag（必填）| — |
| `REPORT_MODE` | 回報模式：`date` 或 `weekday` | `date` |
| `REPORT_DAY` | 每月固定日（`REPORT_MODE=date` 時用，1-28）| `11` |
| `REPORT_WEEK` | 第幾週（`REPORT_MODE=weekday` 時用，**建議 1-4**）| `2` |
| `REPORT_WEEKDAY` | 星期幾（`REPORT_MODE=weekday` 時用，1=一…5=五）| `3` |
| `REPORT_HOUR` | 每月回報時（台北時間）| `9` |
| `SNAPSHOT_HOUR` | 每日快照時（台北時間）| `23` |
| `SNAPSHOT_MINUTE` | 每日快照分 | `55` |
| `ALARM_EMAIL` | 告警 Email（見下方說明）| — |

**回報排程設定範例：**

```bash
# 模式一：每月固定 11 日（預設）
REPORT_MODE=date
REPORT_DAY=11

# 模式二：每月第 2 個星期三（避開週末，彈性月中）
REPORT_MODE=weekday
REPORT_WEEK=2
REPORT_WEEKDAY=3   # 1=一、2=二、3=三、4=四、5=五
```

> **提示：** 若固定日期（如 11 日）遇到週末，建議改用 `REPORT_MODE=weekday`，可確保回報一定落在工作日。
>
> **⚠️ 注意：** `REPORT_WEEK` 建議使用 **1-4**，避免設為 5。部分月份（如 2 月）不存在第 5 個指定星期幾，EventBridge Scheduler 將**靜悄悄跳過該月**，不報錯也不補發。

### Step 3：填入 SSM Parameter Store 機密值

```bash
# LINE Channel Access Token（SecureString）
aws ssm put-parameter \
  --profile srec \
  --name /line-report/LINE_CHANNEL_ACCESS_TOKEN \
  --type SecureString \
  --value "YOUR_LINE_TOKEN" \
  --overwrite

# LINE 推播目標（逗號分隔，C 開頭=群組，U 開頭=個人）
aws ssm put-parameter \
  --profile srec \
  --name /line-report/LINE_TARGETS \
  --type String \
  --value "C你的groupId,U你的userId" \
  --overwrite
```

### Step 4：首次推送 Docker Image

```bash
# 登入 ECR
aws ecr get-login-password --profile srec --region ap-northeast-1 | \
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
# 查詢 Security Group ID（首次執行前先確認）
aws ec2 describe-security-groups \
  --profile srec \
  --filters "Name=group-name,Values=line-report-task-sg" \
  --query "SecurityGroups[0].GroupId" \
  --output text
# → sg-085e167d9f0748a1e
```

```bash
# 手動執行快照（立即觸發）
aws ecs run-task \
  --profile srec \
  --cluster line-report \
  --task-definition line-report \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-06eb77ca7b4b4df06],securityGroups=[sg-085e167d9f0748a1e],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","src/index.js","snapshot"]}]}'

# 手動執行回報（需先有上月 prevMonthFinal 快照，否則報錯屬正常）
aws ecs run-task \
  --profile srec \
  --cluster line-report \
  --task-definition line-report \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-06eb77ca7b4b4df06],securityGroups=[sg-085e167d9f0748a1e],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","src/index.js","report","--month=prev"]}]}'
```

> **注意**：首次部署後 DynamoDB 是空的，`report` task 會因找不到上月 `prevMonthFinal` 快照而失敗——這是正常行為。需等每日快照累積到月底跨月時，系統才會自動標記 `prevMonthFinal`，之後 report 才能正常執行。

### Step 6：確認快照寫入（觸發後等 1-2 分鐘）

```bash
# 查詢當月快照（月份請替換為當前年月，格式 YYYY-MM）
aws dynamodb query \
  --profile srec \
  --table-name usage_snapshots \
  --key-condition-expression "monthKey = :mk" \
  --expression-attribute-values '{":mk":{"S":"2026-03"}}' \
  --no-scan-index-forward \
  --max-items 3
```

有資料出現（`Count > 0`）即代表 snapshot 成功、整個 AWS 部署驗證完成。

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

EventBridge Scheduler 設定為自動使用最新 ACTIVE Task Definition revision，因此回滾只需重新部署舊版 image tag，CDK 會建立指向舊 image 的新 revision，Scheduler 自動切換，**不需手動更新 Scheduler**。

### Step 1：確認可用的舊版 tag

```bash
aws ecr describe-images \
  --profile srec \
  --repository-name line-report \
  --query 'sort_by(imageDetails, &imagePushedAt)[*].{Tags:imageTags,PushedAt:imagePushedAt}' \
  --output table
```

### Step 2：修改 `.env` 的 `IMAGE_TAG` 並重新部署

```bash
# .env
IMAGE_TAG=v2.0.1   # 替換為目標版本

npm run deploy
```

CDK 會為 `line-report` Task Definition 建立新的 revision（使用舊 image），EventBridge Scheduler 下次觸發時自動使用該 revision。

---

## 告警設定

服務在 CDK 部署後自動建立 CloudWatch Alarm，偵測到 `level=error` 的 log 即觸發。  
告警路徑：**CloudWatch Alarm → SNS Topic `line-report-alarms` → Email**

### 方式一：部署時直接訂閱（推薦）

在 `.env` 填入 `ALARM_EMAIL`，再執行 `npm run deploy`，CDK 自動將 Email 加入 SNS 訂閱：

```bash
# .env
ALARM_EMAIL=you@example.com

npm run deploy
```

部署後 AWS 會寄確認信到該 Email，**必須點擊 "Confirm subscription" 連結才會收到告警**。

---

### 方式二：部署後手動訂閱（已部署可補設定）

```bash
# 取得 SNS Topic ARN
TOPIC_ARN=$(aws cloudformation describe-stacks \
  --profile srec \
  --stack-name LineReportMonitoringStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" \
  --output text)

# 新增 Email 訂閱
aws sns subscribe \
  --profile srec \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint "you@example.com"
```

執行後同樣需要點擊確認信。

---

### 查看現有訂閱

```bash
aws sns list-subscriptions-by-topic --profile srec --topic-arn "$TOPIC_ARN"
```

### 取消訂閱

```bash
aws sns unsubscribe --profile srec --subscription-arn "<SubscriptionArn>（從上方指令取得）"
```

---

### 告警觸發條件

| 告警名稱 | 條件 | Log Group |
|---------|------|-----------|
| `line-report-error-alarm` | 5 分鐘內 `level=error` ≥ 1 次 | `/ecs/line-report` |

> **常見觸發原因：** prevMonthFinal 快照不存在、LINE API 失敗、DynamoDB 連線逾時。  
> 錯誤詳情可至 CloudWatch Logs `line-report-error-alarm` 查詢。

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
# 查詢最近 1 小時的 log（macOS 用 python3 計算時間戳）
aws logs filter-log-events \
  --profile srec \
  --log-group-name /ecs/line-report \
  --start-time $(python3 -c "import time; print(int((time.time()-3600)*1000))") \
  --filter-pattern "ERROR"
```

---

## DynamoDB 資料驗證

### 查詢最近快照

```bash
# 月份格式 YYYY-MM，替換為當前月份
aws dynamodb query \
  --profile srec \
  --table-name usage_snapshots \
  --key-condition-expression "monthKey = :mk" \
  --expression-attribute-values '{":mk":{"S":"2026-03"}}' \
  --no-scan-index-forward \
  --max-items 5
```

### 查詢 prevMonthFinal

```bash
aws dynamodb query \
  --profile srec \
  --table-name usage_snapshots \
  --key-condition-expression "monthKey = :mk" \
  --filter-expression "isPrevMonthFinal = :t" \
  --expression-attribute-values '{":mk":{"S":"2026-02"},":t":{"BOOL":true}}'
```

### 查詢 job_runs 執行紀錄

```bash
aws dynamodb get-item \
  --profile srec \
  --table-name job_runs \
  --key '{"jobId":{"S":"snapshot#2026-03-03"}}'
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
