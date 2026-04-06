# LINE 訊息用量回報服務

LINE 官方帳號「訊息用量與加購費用估算」自動化服務，部署於 AWS ECS Fargate，以 EventBridge Scheduler 排程每日快照與每月回報，並支援按月回補 LINE 歷史用量作為正式月報依據。

---

## 技術概覽

### 使用語言與技術

| 層次 | 技術 |
|---|---|
| 應用程式 | JavaScript（Node.js 20+，ES Modules） |
| 基礎設施即程式碼（IaC） | TypeScript + AWS CDK v2 |
| 容器化 | Docker（`node:22-alpine`，多階段建置） |
| CI/CD | GitHub Actions |
| 測試 | Node.js built-in `node:test` |

### 部署平台

**AWS**（區域：`ap-northeast-1` 東京）

### 使用的 AWS 服務

| 服務 | 用途 |
|---|---|
| **ECS Fargate** | 執行 Docker 容器，無需管理伺服器 |
| **ECR** | 儲存 Docker Image |
| **DynamoDB** | 儲存每日用量快照（`usage_snapshots`）與執行紀錄（`job_runs`） |
| **SSM Parameter Store** | 加密儲存 LINE Token、推播目標、計費設定等機密 |
| **EventBridge Scheduler** | 排程觸發每日快照（23:55 台北時間）與每月回報 |
| **EventBridge Rule** | 觸發 heartbeat checker（每日 08:00 / 08:05 與每 6 小時） |
| **CloudWatch Logs** | 收集容器輸出的 JSON 結構化 Log |
| **Lambda** | 分流 outcome log、執行 heartbeat 檢查 |
| **CloudWatch Alarm + SNS** | Failure / Heartbeat 告警寄送 Email |

### 整體架構（簡覽）

```
EventBridge Scheduler
  │
  ├─ 每日 23:55 (台北時間)
  │       └──→ ECS Fargate：snapshot task
  │                 ├── 呼叫 LINE API 取得當月訊息用量
  │                 └── 寫入 DynamoDB (usage_snapshots[source=live_snapshot] + job_runs)
  │
  └─ 每月 (預設 11 日 09:00)
          └──→ ECS Fargate：monthly close task
                    ├── 確保 historical_backfill 的 official final 已存在
                    ├── 呼叫 report-only 讀取 official final
                    ├── 計算加購費用
                    └── 推播報告到 LINE 群組

手動 / 維運 CLI
  └──→ backfill --month=YYYY-MM
            ├── 呼叫 LINE daily delivery insight
            ├── 先 staged 寫入 usage_snapshots[source=historical_backfill]
            └── 成功後原子切換該月 isOfficialFinal=true

SSM Parameter Store  ──→  ECS 容器啟動時自動注入 Token / 設定
CloudWatch Logs      ←──  ECS 容器輸出 JSON log
CloudWatch Logs Subscription Filter ──→ Lambda(outcome router) ──→ SNS(debug/failure)
EventBridge Rule ──→ Lambda(heartbeat checker) ──→ CloudWatch Metric ──→ Alarm ──→ SNS(heartbeat)
CloudWatch Alarm     ──→  SNS Topic  ──→  Email 告警
```

**用一句話理解：** 每日 snapshot 提供即時觀測；正式月報改讀按月 backfill 後的 official final，再計算費用並推播到指定的 LINE 群組。

### IaC 架構與頻率

`iac/` 目前由 6 個 stack 組成：

| Stack | 職責 |
|---|---|
| `LineReportDatabaseStack` | 建立 `usage_snapshots` 與 `job_runs` |
| `LineReportEcrStack` | 建立 ECR repository |
| `LineReportSsmStack` | 建立/匯出 SSM 參數路徑 |
| `LineReportMonitoringStack` | 建立 log group、SNS topics、CloudWatch alarms、outcome router、heartbeat checker |
| `LineReportEcsStack` | 建立 ECS cluster、task definition、execution/task roles |
| `LineReportSchedulerStack` | 建立每日 snapshot 與每月 report 的 EventBridge Scheduler、DLQ 與對應 alarm |

監控與通知頻率如下：

| 項目 | AWS 服務 | 頻率 / 觸發方式 | 用途 |
|---|---|---|---|
| `snapshot` 正式執行 | EventBridge Scheduler | 每日 `23:55` Asia/Taipei | 寫入用量快照 |
| `report` 正式執行 | EventBridge Scheduler | 預設每月 `11` 日 `09:00` Asia/Taipei | 推送月報 |
| `snapshot heartbeat` | EventBridge Rule + Lambda | 每日 `08:00` Asia/Taipei | 檢查前一日快照是否成功 |
| `report heartbeat` | EventBridge Rule + Lambda | 每日 `08:05` Asia/Taipei | 檢查本月若已到回報時間，對應月份月報是否成功 |
| `schedule enabled` 檢查 | EventBridge Rule + Lambda | 每 `6` 小時 | 檢查兩個 Scheduler 是否仍為 `ENABLED` |
| `debug outcome` 通知 | CloudWatch Logs Subscription + Lambda | 每次 `success/skipped/failed` log | 測試期追蹤執行結果 |

---

## 功能說明

- **每日快照**（23:55 Asia/Taipei）：呼叫 LINE Messaging API 取得當月用量，存入 DynamoDB
- **跨月封存**：月份變更時自動標記上月最後一筆快照為 `prevMonthFinal`，並支援補封存
- **按月回補**（手動 / CLI）：呼叫 LINE daily delivery insight，重建指定月份累積用量並標記 `isOfficialFinal`
- **每月月結**（每月 11 日 09:00 Asia/Taipei）：由 orchestration 確保 `historical_backfill + isOfficialFinal=true` 已存在，再讀取正式月結資料推播繁中訊息到指定 LINE 群組
- **幂等性**：daily snapshot 同一天重複觸發不會重複寫入；monthly report 同月份成功送出後不會重送，失敗重跑時只會補送未成功 target

---

## 目錄結構

```
line-report/
├── src/
│   ├── index.js              # CLI entry
│   ├── actions/
│   │   ├── snapshot.js       # 每日快照邏輯
│   │   ├── backfill.js       # 指定月份歷史回補邏輯
│   │   ├── monthlyClose.js   # 月結 orchestration（確保 final 後再回報）
│   │   └── report.js         # 純讀取/推播正式月報
│   ├── lib/
│   │   ├── date.js           # Asia/Taipei 日期工具（luxon）
│   │   ├── db.js             # DynamoDB DocumentClient v3
│   │   ├── lineApi.js        # LINE API 封裝
│   │   ├── logger.js         # pino logger（JSON）
│   │   ├── pricing.js        # 計費模型
│   │   └── storage.js        # 快照 CRUD + prevMonthFinal / official final
│   └── unit-tests/           # 單元測試 / 整合測試
├── scripts/
│   ├── cdk-deploy.js         # CDK 一鍵部署腳本
│   ├── dry-run.js            # 本機驗證腳本（DynamoDB Local + snapshot/backfill/report）
│   ├── sync-ssm.sh           # 同步本機 .env 到 SSM Parameter
│   └── e2e-tests/            # E2E / smoke test 腳本
├── iac/                      # AWS CDK（TypeScript）
│   ├── bin/app.ts
│   ├── lib/
│   │   ├── database-stack.ts
│   │   ├── ecr-stack.ts
│   │   ├── ecs-stack.ts
│   │   ├── monitoring-stack.ts
│   │   ├── scheduler-stack.ts
│   │   └── ssm-stack.ts
│   └── unit-tests/           # CDK 層級測試
├── .github/workflows/
│   └── deploy.yml            # GitHub Actions CI/CD
├── doc/                      # 需求規劃、架構圖、ADR、Runbook
│   └── plan/                 # private Git submodule：design / review / decision docs
├── Dockerfile
└── .env.example
```

---

## 文件子模組說明

- `doc/plan/` 是 private Git submodule
- 用來放 design / review / decision docs
- 不屬於 runtime dependency，不影響應用程式執行或部署時的必要依賴
- 若要更新 `doc/plan/`：
  - 先進入 submodule 完成 commit / push
  - 再回主 repo 更新 submodule pointer

---

## 環境變數完整清單

複製 `.env.example` 並填入實際值：

```bash
cp .env.example .env
```

| 變數 | 說明 | 預設值 | 必填 |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel Access Token | — | ✅ |
| `LINE_TARGETS` | 推播目標 ID 列表（逗號分隔；C=群組、U=個人、R=聊天室） | — | ✅ |
| `FREE_QUOTA` | 每月免費訊息額度（則） | `1000` | |
| `PRICING_MODEL` | 計費模式：`single` 或 `tiers` | `single` | |
| `PLAN_FEE` | 方案月費（固定月租，0 表示不計入） | `0` | |
| `SINGLE_UNIT_PRICE` | single 模式：每則單價（TWD） | `0.2` | |
| `TIERS_JSON` | tiers 模式：級距 JSON（見下方說明） | — | tiers 時必填 |
| `AWS_REGION` | AWS 區域 | `ap-northeast-1` | |
| `DDB_TABLE_SNAPSHOTS` | DynamoDB 快照表名 | `usage_snapshots` | |
| `DDB_TABLE_RUNS` | DynamoDB 執行紀錄表名 | `job_runs` | |
| `CURRENCY` | 貨幣符號 | `TWD` | |
| `LOG_LEVEL` | pino log level | `info` | |
| `TZ` | 容器時區（影響系統預設時區） | `Asia/Taipei` | |
| `DRY_RUN` | `true` 時跳過 LINE 實際推播 | — | |
| `AWS_PROFILE` | AWS SSO profile 名稱（使用 IAM key 可留空） | — | |
| `AWS_ENDPOINT_URL` | 本機測試用 DynamoDB Local endpoint | — | |
| `IMAGE_TAG` | Docker image tag（部署時必填，禁止使用 latest） | — | 部署時必填 |
| `ALARM_EMAIL` | Failure/Heartbeat 告警 Email | — | 建議正式部署設定 |
| `DEBUG_EMAIL` | Debug/Outcome 通知 Email | — | 測試期建議設定 |

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

### 4. 執行月結回報（前月）

```bash
npm run report
```

若只想讀取既有 official final 並推播，可用：

```bash
node --env-file=.env src/index.js report-only --month=prev
```

### 5. 執行回補（指定月份）

```bash
npm run backfill -- --month=2026-03
```

若該月份已經有 official final，預設會略過；要重建該月正式資料時，需顯式使用：

```bash
npm run backfill -- --month=2026-03 --rebuild=true
```

### 6. 執行回報（指定月份）

```bash
node --env-file=.env src/index.js report --month=2026-01
```

### 7. DRY_RUN 模式（跳過 LINE push，僅印出訊息）

```bash
DRY_RUN=true npm run report
```

## 資料來源分工

- `live_snapshot`：每日即時觀測，來源為 `quota/consumption`，用於日常監控與估算
- `historical_backfill`：指定月份歷史回補，來源為 LINE daily delivery insight，作為正式月報依據
- `report`：CLI 預設執行 monthly close orchestration；真正唯讀的月報動作請使用 `report-only`
- `backfill --rebuild=true`：高風險操作，會重建指定月份的正式月結資料

---

## 部署防呆規則

- 正式環境**只能**從 repo root 執行 `npm run deploy -- [StackName...]`
- **禁止**直接進入 `iac/` 執行 `cdk deploy`；缺少部署 context 會導致 task definition 或通知設定被錯誤收斂
- `IMAGE_TAG` 為正式部署必填，且該 tag 必須已存在於 ECR
- 本機與 AWS 正式環境一律使用 `linux/arm64`；`CPU_ARCHITECTURE` 若有設定也只能是 `arm64`
- 若要收到 Failure/Heartbeat/Debug 信件，請在 `.env` 或 CI/CD variables 設定 `ALARM_EMAIL` / `DEBUG_EMAIL`
- 部署腳本會自動驗證：AWS 身分、ECR tag 存在、task definition image、task definition CPU 架構、Scheduler 狀態

---

## 執行測試

```bash
# 執行所有測試
npm test

# 個別執行
npm run test:backfill    # 按月回補與重建測試
npm run test:pricing    # 計費模型測試
npm run test:date       # 日期工具測試
npm run test:storage    # DynamoDB 整合測試（使用 mock）
npm run test:report     # 回報失敗場景測試（使用 mock）
node --test src/unit-tests/monthlyClose.test.js   # 月結 orchestration 測試
```

---

## 本機完整流程驗證（dry-run）

使用 DynamoDB Local 驗證完整 snapshot → monthly close 流程，**不需要真實 AWS 帳號**：

```bash
# 1. 啟動 DynamoDB Local
docker run -d -p 8000:8000 amazon/dynamodb-local

# 2. 在 .env 中取消 AWS_ENDPOINT_URL 的註解
# AWS_ENDPOINT_URL=http://localhost:8000  →  移除 # 號

# 3. 執行完整流程（會自動建表、跑 snapshot + monthly close dry-run）
npm run dry-run

# 4. 只跑快照
npm run dry-run -- --step=snapshot

# 5. 只跑回補（DRY_RUN）
npm run dry-run -- --step=backfill

# 6. 只跑月結回報
npm run dry-run -- --step=report

# 7. 查看 DB 內容
npm run dry-run -- --inspect
```

> **注意**：
> - `npm run dry-run` 內部會強制設定 `DRY_RUN=true`，不會真的推播 LINE 訊息
> - `report` CLI 目前執行的是 monthly close orchestration；真正唯讀的月報動作請使用 `report-only`
> - `backfill` 的 dry-run 與正式執行使用不同 `jobId`，不會互相阻塞

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

在 `.env` 填入 `IMAGE_TAG`、排程設定與通知 Email，再執行：

```bash
# 一鍵部署全部 stack（從 .env 讀取所有設定）
npm run deploy

# 只部署特定 stack
npm run deploy -- LineReportSchedulerStack
```

> 舊文件若寫 `npm run deploy -- --stacks LineReportSchedulerStack`，部署腳本目前仍相容，但正式文件以裸 stack 名稱為準。

**`.env` 排程相關欄位（deploy 時生效）：**

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `IMAGE_TAG` | Docker image tag（必填）| — |
| `CPU_ARCHITECTURE` | Docker / ECS 架構，固定 `arm64` | `arm64` |
| `REPORT_MODE` | 回報模式：`date` 或 `weekday` | `date` |
| `REPORT_DAY` | 每月固定日（`REPORT_MODE=date` 時用，1-28）| `11` |
| `REPORT_WEEK` | 第幾週（`REPORT_MODE=weekday` 時用，**建議 1-4**）| `2` |
| `REPORT_WEEKDAY` | 星期幾（`REPORT_MODE=weekday` 時用，1=一…5=五）| `3` |
| `REPORT_HOUR` | 每月回報時（台北時間）| `9` |
| `SNAPSHOT_HOUR` | 每日快照時（台北時間）| `23` |
| `SNAPSHOT_MINUTE` | 每日快照分 | `55` |
| `ALARM_EMAIL` | Failure/Heartbeat 告警 Email（見下方說明）| — |
| `DEBUG_EMAIL` | Debug/Outcome 通知 Email（測試期用）| — |

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
  --name /line-report/LINE_CHANNEL_ACCESS_TOKEN \
  --type SecureString \
  --value "YOUR_LINE_TOKEN" \
  --overwrite

# LINE 推播目標（逗號分隔，C 開頭=群組，U 開頭=個人）
aws ssm put-parameter \
  --name /line-report/LINE_TARGETS \
  --type String \
  --value "C你的groupId,U你的userId" \
  --overwrite
```

### Step 4：首次推送 Docker Image

> **平台注意：** 本專案的本機開發、手動 build、CI/CD 與 AWS ECS Fargate 全部統一使用 `linux/arm64`。若 image 平台與 ECS task definition 的 CPU architecture 不一致，部署後可能出現 `exec format error`。

```bash
# 登入 ECR
aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin <帳號>.dkr.ecr.ap-northeast-1.amazonaws.com

# Build 並推送（手動 build 固定使用 buildx + linux/arm64）
ECR_URI="<帳號>.dkr.ecr.ap-northeast-1.amazonaws.com/line-report"
VERSION_TAG="v20260225-1"
SHA_TAG="sha-$(git rev-parse --short HEAD)"

docker buildx build --platform linux/arm64 \
  -t "${ECR_URI}:${VERSION_TAG}" \
  -t "${ECR_URI}:${SHA_TAG}" \
  --push .
```

### Step 5：手動觸發測試

```bash
# 手動執行快照（立即觸發）
aws ecs run-task \
  --cluster line-report \
  --task-definition line-report-snapshot \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxxx],securityGroups=[sg-xxxx],assignPublicIp=ENABLED}"

# 手動執行回報
aws ecs run-task \
  --cluster line-report \
  --task-definition line-report-monthly-close \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxxx],securityGroups=[sg-xxxx],assignPublicIp=ENABLED}"
```

---

## GitHub Actions 設定

### 必要 Secrets / Variables

在 GitHub Repository Settings → Secrets and Variables 設定：

| 名稱 | 類型 | 說明 |
|---|---|---|
| `AWS_ACCOUNT_ID` | Variable | AWS 帳號 ID（預設 `307067291720`，跨帳號時覆蓋）|
| `AWS_REGION` | Variable | AWS 區域（預設 `ap-northeast-1`）|
| `ECR_REPOSITORY` | Variable | ECR 儲存庫名稱（預設 `line-report`）|
| `ALARM_EMAIL` | Variable | Failure/Heartbeat 告警收件人 Email |
| `DEBUG_EMAIL` | Variable | Debug/Outcome 通知收件人 Email（測試期）|
| `ENABLE_DEBUG_OUTCOME_NOTICES` | Variable | 是否建立 debug outcome 通知（預設 `true`）|

> CI/CD 會直接呼叫 repo root 的 `scripts/cdk-deploy.js`。`AWS_REGION` 與 `ECR_REPOSITORY` 未設定時會使用預設值；若不需要 debug 信，可將 `ENABLE_DEBUG_OUTCOME_NOTICES=false`。
> GitHub Actions 目前固定 build `linux/arm64`，並以 ARM64 task definition 部署到 ECS Fargate。

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

推送任意 `v*` git tag 即觸發 CI/CD：

```bash
git tag v20260225-1
git push origin v20260225-1
```

CI image tag 規則：

| 觸發方式 | ECR image tag |
|---|---|
| `push` Git tag（如 `v2.5.1`） | 與 git tag 相同，例如 `v2.5.1` |
| 任意部署 | 另附一個 `sha-<commit前7碼>` |
| `workflow_dispatch` | `ci-YYYYMMDD-<run_number>` |

> 建議把正式版 release 與 ECR image tag 對齊，用 git tag 作為唯一正式版本來源；`sha-*` 用於追 commit，`ci-*` 僅作手動流程或暫時驗證用途。

---

## 回滾到上一版本

### Step 1：確認可用的舊版 tag

```bash
aws ecr describe-images \
  --repository-name line-report \
  --query 'sort_by(imageDetails, &imagePushedAt)[*].{Tags:imageTags,PushedAt:imagePushedAt}' \
  --output table
```

### Step 2：從 repo root 重新部署舊版 image 到 ECS task definitions

```bash
TARGET_TAG="v20260224-1"   # 替換為目標版本
# 建議先把 .env 的 IMAGE_TAG 改成目標版本，再重新部署 ECS stack
IMAGE_TAG="$TARGET_TAG" npm run deploy -- LineReportEcsStack
```

> 不要直接進入 `iac/` 跑 `cdk deploy`。`iac/bin/app.ts` 明確要求 `imageTag` context，事故時請一律從 repo root 執行 `npm run deploy`。
>
> 若是手動 build 後要回滾或重 deploy，請確認 image 平台仍為 `linux/arm64`，且 ECS task definition 仍使用 ARM64；兩邊只要有一邊不一致，就可能在執行時出現 `exec format error`。

### Step 3：確認兩個 task definition family 都已切回舊版 image

```bash
TARGET_TAG="v20260224-1"
ECR_URI="<帳號>.dkr.ecr.<區域>.amazonaws.com/line-report"

aws ecs describe-task-definition --task-definition line-report-snapshot \
  --query 'taskDefinition.containerDefinitions[0].image' --output text

aws ecs describe-task-definition --task-definition line-report-monthly-close \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

預期兩者都應回傳 `${ECR_URI}:${TARGET_TAG}`。

另外可用下列指令確認 task definition 仍為 ARM64：

```bash
aws ecs describe-task-definition --task-definition line-report-snapshot \
  --query 'taskDefinition.runtimePlatform.cpuArchitecture' --output text

aws ecs describe-task-definition --task-definition line-report-monthly-close \
  --query 'taskDefinition.runtimePlatform.cpuArchitecture' --output text
```

預期兩者都應回傳 `ARM64`。

### Step 4：確認兩個 Scheduler 仍指向正確 family

```bash
aws scheduler get-schedule --name line-report-daily-snapshot \
  --query 'Target.EcsParameters.TaskDefinitionArn' --output text

aws scheduler get-schedule --name line-report-monthly-report \
  --query 'Target.EcsParameters.TaskDefinitionArn' --output text
```

若 Scheduler 被誤改，再從 repo root 重新套用：

```bash
npm run deploy -- LineReportSchedulerStack
```

---

## 告警與通知設定

目前通知分成 3 類，對應不同 AWS 服務與用途：

| 類型 | SNS Topic | AWS 服務 | 用途 |
|---|---|---|---|
| Failure Alert | `line-report-alarms` | CloudWatch Alarm + SNS；CloudWatch Logs Subscription + Lambda + SNS | 真正失敗、錯誤與 DLQ 告警 |
| Missing/Heartbeat Alert | `line-report-heartbeat-alerts` | EventBridge Rule + Lambda + CloudWatch Metric/Alarm + SNS | 任務未在預期時間成功、Scheduler 被停用 |
| Debug/Outcome Notice | `line-report-debug-outcomes` | CloudWatch Logs Subscription + Lambda + SNS | 測試期追蹤 success / skipped / failed |

### Failure Alert

路徑：
- `CloudWatch Alarm -> SNS Topic line-report-alarms -> Email`
- `CloudWatch Logs -> Subscription Filter -> outcome router Lambda -> SNS Topic line-report-alarms -> Email`

涵蓋事件：
- `line-report-error-alarm`
- `line-report-heartbeat-checker-error`
- `line-report-scheduler-dlq-alarm`
- `snapshot_failed`
- `report_failed`
- 其他 `level=error` 的應用程式 log

### Missing/Heartbeat Alert

路徑：
- `EventBridge Rule -> heartbeat checker Lambda -> CloudWatch custom metric -> CloudWatch Alarm -> SNS Topic line-report-heartbeat-alerts -> Email`

涵蓋事件與頻率：

| 檢查項目 | 頻率 | 內容 |
|---|---|---|
| `snapshot heartbeat` | 每日 `08:00` Asia/Taipei | 檢查前一日 snapshot 是否成功 |
| `report heartbeat` | 每日 `08:05` Asia/Taipei | 檢查本月若已到回報時間，對應月份 report 是否成功 |
| `schedule enabled` | 每 `6` 小時 | 檢查 `line-report-daily-snapshot` / `line-report-monthly-report` 是否仍為 `ENABLED` |

對應 alarm：
- `line-report-snapshot-missing`
- `line-report-report-missing`
- `line-report-daily-snapshot-schedule-disabled`
- `line-report-monthly-report-schedule-disabled`

### Debug/Outcome Notice

路徑：
- `CloudWatch Logs -> Subscription Filter -> outcome router Lambda -> SNS Topic line-report-debug-outcomes -> Email`

涵蓋事件：
- `snapshot_success`
- `snapshot_skipped`
- `snapshot_failed`
- `report_success`
- `report_skipped`
- `report_failed`

> `Debug/Outcome Notice` 是測試期用機制，穩定後可透過 `ENABLE_DEBUG_OUTCOME_NOTICES=false` 停用並在後續版本移除。

### 部署時設定 Email 訂閱

```bash
# .env
ALARM_EMAIL=you@example.com
DEBUG_EMAIL=debug@example.com

npm run deploy
```

部署後 AWS 會寄確認信到對應 Email，**必須點擊 "Confirm subscription" 連結才會收到信件**。  
若使用同一個已確認過的 Email 重新部署，subscription 會沿用既有確認狀態。

### 查看現有訂閱

```bash
aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:ap-northeast-1:<帳號>:line-report-alarms
aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:ap-northeast-1:<帳號>:line-report-heartbeat-alerts
aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:ap-northeast-1:<帳號>:line-report-debug-outcomes
```

### 常見觸發原因

- prevMonthFinal 快照不存在
- LINE API timeout / 429 / 5xx
- DynamoDB 連線逾時
- task definition image 不存在
- Scheduler `RunTask` 失敗
- monthly report 對應月份尚未成功
- Scheduler 被停用或排程被改壞

詳情請一起檢查：
- CloudWatch Alarm history
- CloudWatch Logs `/ecs/line-report`
- `job_runs`
- Scheduler DLQ

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

### 查詢 official final

```bash
aws dynamodb query \
  --table-name usage_snapshots \
  --key-condition-expression "monthKey = :mk" \
  --filter-expression "#source = :src AND isOfficialFinal = :t" \
  --expression-attribute-names '{"#source":"source"}' \
  --expression-attribute-values '{":mk":{"S":"2026-03"},":src":{"S":"historical_backfill"},":t":{"BOOL":true}}'
```

### 查詢 job_runs 執行紀錄

```bash
aws dynamodb get-item \
  --table-name job_runs \
  --key '{"jobId":{"S":"snapshot#2026-02-25"}}'
```

---

## 注意事項

- LINE consumption API 回傳的 `totalUsage` 為**近似值**，最終帳單請以 LINE OA Manager 後台為準
- `isPrevMonthFinal` 為舊版跨月封存欄位；正式月報改以 `historical_backfill + isOfficialFinal=true` 為準
- 若指定月份任一天 LINE insight 回傳 `unready`，該次 backfill 不會標記 `isOfficialFinal`
- `backfill` 目前採 staged build + promote 策略；新 build 全數寫入成功後，才會原子切換 official final
- `backfill` 成功 promote 後會清理舊 staged build；失敗時也會清理當次 build 已寫入的殘留 rows
- `monthly close` 遇到同月份 backfill 已在執行時，會按月份大小與 LINE API timeout/retry 預算等待，不再固定只等 30 秒
- `cdk destroy` 不會刪除 DynamoDB 資料表（`RemovalPolicy.RETAIN`），請手動清理
- image tag 禁止使用 `latest`，任何 CI/CD 與 CDK 部署均強制使用明確版本 tag
- 正式環境若需重新部署，請至少確認 `.env` 內 `IMAGE_TAG` 已設定；若要收到通知，再補 `ALARM_EMAIL` / `DEBUG_EMAIL`
- `scripts/sync-ssm.sh` 會沿用 `AWS_PROFILE`；若未設定，則使用 AWS CLI 預設 credentials chain

### Patch A Rollout Ops Checklist

完整的 rollout 檢查清單與 runbook/SOP 已放在 `doc/plan/2026-04-06_ops_patchA_rollout.md`，on-call / 維運若需要進行 cutover 或處理 unknown delivery state，請直接參考該文件。
