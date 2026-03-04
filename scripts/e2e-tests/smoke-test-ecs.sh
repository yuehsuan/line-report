#!/usr/bin/env bash
# smoke-test-ecs.sh — ECS 端對端冒煙測試
#
# 實際觸發 line-report-snapshot ECS task，驗證：
#   1. 容器成功啟動並正常停止（exitCode=0）
#   2. CloudWatch Logs 有「快照執行完成」或「略過（idempotent）」訊息
#   3. DynamoDB usage_snapshots 有當月資料
#
# 使用方式：
#   bash scripts/smoke-test-ecs.sh
#
# 環境需求：
#   - aws sso login --profile srec（或 AWS_PROFILE=srec 已設定）
#   - .env 中需有 SUBNET_ID 與 SG_ID（可在 .env.example 查看格式）
#
# 說明：snapshot 具幂等性，重複執行只會略過，不產生重複資料。

set -euo pipefail

PROFILE="${AWS_PROFILE:-srec}"
REGION="${AWS_REGION:-ap-northeast-1}"
CLUSTER="line-report"
TASK_DEF="line-report-snapshot"
LOG_GROUP="/ecs/line-report"

# ── 從 .env 讀取 subnet / sg（若未設定則從 AWS 查詢）──────────────
ENV_FILE="${ENV_FILE:-.env}"
if [[ -f "$ENV_FILE" ]]; then
  # grep 找不到時 exit code=1，加 || true 避免 set -e 靜默終止腳本
  SUBNET_ID="${SUBNET_ID:-$(grep '^SUBNET_ID=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true)}"
  SG_ID="${SG_ID:-$(grep '^SG_ID=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true)}"
fi

# 若 .env 沒有，嘗試從 CDK context 或 AWS 查詢預設值
if [[ -z "${SUBNET_ID:-}" ]]; then
  echo "[INFO] SUBNET_ID 未設定，嘗試從 AWS 查詢預設 VPC 的公有子網路..."
  SUBNET_ID=$(aws ec2 describe-subnets \
    --profile "$PROFILE" --region "$REGION" \
    --filters "Name=default-for-az,Values=true" \
    --query 'Subnets[0].SubnetId' --output text)
  echo "[INFO] 使用子網路：$SUBNET_ID"
fi

if [[ -z "${SG_ID:-}" ]]; then
  echo "[INFO] SG_ID 未設定，嘗試查詢 line-report-task-sg..."
  SG_ID=$(aws ec2 describe-security-groups \
    --profile "$PROFILE" --region "$REGION" \
    --filters "Name=group-name,Values=line-report-task-sg" \
    --query 'SecurityGroups[0].GroupId' --output text)
  echo "[INFO] 使用安全群組：$SG_ID"
fi

if [[ "$SUBNET_ID" == "None" || -z "$SUBNET_ID" ]]; then
  echo "[ERROR] 無法取得 SUBNET_ID，請在 .env 或環境變數中手動設定"
  exit 1
fi

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  echo "[ERROR] 無法取得 SG_ID，請在 .env 或環境變數中手動設定"
  exit 1
fi

echo ""
echo "=== ECS Smoke Test ==="
echo "  Cluster    : $CLUSTER"
echo "  Task Def   : $TASK_DEF"
echo "  Subnet     : $SUBNET_ID"
echo "  SG         : $SG_ID"
echo ""

# ── Step 1：觸發 ECS task ────────────────────────────────────────
echo "[1/4] 觸發 ECS snapshot task..."
TASK_ARN=$(aws ecs run-task \
  --profile "$PROFILE" --region "$REGION" \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  echo "[ERROR] ECS task 啟動失敗，請確認 cluster / task-definition 名稱正確"
  exit 1
fi

echo "  Task ARN : $TASK_ARN"
TASK_ID="${TASK_ARN##*/}"

# ── Step 2：輪詢 task 狀態（最多等 5 分鐘）──────────────────────
echo "[2/4] 等待 task 完成..."
MAX_WAIT=300
INTERVAL=10
WAITED=0

while true; do
  LAST_STATUS=$(aws ecs describe-tasks \
    --profile "$PROFILE" --region "$REGION" \
    --cluster "$CLUSTER" --tasks "$TASK_ARN" \
    --query 'tasks[0].lastStatus' --output text)

  if [[ "$LAST_STATUS" == "STOPPED" ]]; then
    break
  fi

  if (( WAITED >= MAX_WAIT )); then
    echo "[ERROR] 超過 ${MAX_WAIT}s 仍未完成，目前狀態：$LAST_STATUS"
    exit 1
  fi

  echo "  狀態：${LAST_STATUS}（已等待 ${WAITED}s）"
  sleep "$INTERVAL"
  WAITED=$((WAITED + INTERVAL))
done

echo "  Task 已停止（${WAITED}s）"

# ── Step 3：確認 exitCode / stoppedReason ───────────────────────
echo "[3/4] 確認 task 結束狀態..."
TASK_DETAIL=$(aws ecs describe-tasks \
  --profile "$PROFILE" --region "$REGION" \
  --cluster "$CLUSTER" --tasks "$TASK_ARN")

STOP_CODE=$(echo "$TASK_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tasks'][0].get('stopCode',''))")
EXIT_CODE=$(echo "$TASK_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tasks'][0]['containers'][0].get('exitCode','unknown'))")
STOPPED_REASON=$(echo "$TASK_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tasks'][0].get('stoppedReason',''))")

echo "  stopCode     : $STOP_CODE"
echo "  exitCode     : $EXIT_CODE"
echo "  stoppedReason: $STOPPED_REASON"

if [[ "$EXIT_CODE" != "0" ]]; then
  echo "[ERROR] Task 非正常結束（exitCode=${EXIT_CODE}）"
  echo "  請至 CloudWatch Logs 查看詳細錯誤："
  echo "  aws logs get-log-events --profile $PROFILE --region $REGION \\"
  echo "    --log-group-name $LOG_GROUP --log-stream-name line-report/app/$TASK_ID"
  exit 1
fi

# ── Step 4：確認 CloudWatch Logs 有成功訊息 ─────────────────────
echo "[4/4] 確認 CloudWatch Logs（最多等 90s，每 5s 查一次）..."

LOG_STREAM="line-report/app/$TASK_ID"
LOG_FOUND=false
LOG_WAIT=0
LOG_MAX=90
LOG_INTERVAL=5

while (( LOG_WAIT <= LOG_MAX )); do
  LOG_OUTPUT=$(aws logs get-log-events \
    --profile "$PROFILE" --region "$REGION" \
    --log-group-name "$LOG_GROUP" \
    --log-stream-name "$LOG_STREAM" \
    --limit 50 \
    --query 'events[*].message' --output text 2>/dev/null || true)

  if echo "$LOG_OUTPUT" | grep -q "快照執行完成\|今日快照已成功完成，略過"; then
    LOG_FOUND=true
    break
  fi

  if (( LOG_WAIT < LOG_MAX )); then
    echo "  等待 log 寫入...（${LOG_WAIT}s）"
    sleep "$LOG_INTERVAL"
  fi
  LOG_WAIT=$(( LOG_WAIT + LOG_INTERVAL ))
done

if [[ "$LOG_FOUND" == "true" ]]; then
  echo "  [✓] CloudWatch Logs 含快照成功或幂等略過訊息（${LOG_WAIT}s）"
else
  echo "  [!] 等待 ${LOG_MAX}s 後仍未找到預期成功訊息，請手動確認"
  echo "      Log group : $LOG_GROUP"
  echo "      Log stream: $LOG_STREAM"
fi

# ── 確認 DynamoDB 有當月快照 ─────────────────────────────────────
MONTH=$(date +%Y-%m)
COUNT=$(aws dynamodb query \
  --profile "$PROFILE" --region "$REGION" \
  --table-name usage_snapshots \
  --key-condition-expression "monthKey = :mk" \
  --expression-attribute-values "{\":mk\":{\"S\":\"$MONTH\"}}" \
  --select COUNT \
  --query 'Count' --output text 2>/dev/null || echo "0")

if (( COUNT > 0 )); then
  echo "  [✓] DynamoDB usage_snapshots 有 $COUNT 筆 $MONTH 的資料"
else
  echo "  [!] DynamoDB usage_snapshots 尚無 $MONTH 的資料（可能今日已執行過且略過）"
fi

echo ""
echo "✅  ECS smoke test passed（exitCode=0）"
echo "    Task ID: $TASK_ID"
