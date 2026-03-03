#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-scheduler.sh
#
# 端到端驗證 EventBridge Scheduler → ECS Fargate → DynamoDB 整條路是否正常。
#
# 執行流程：
#   1. 確認 Scheduler 已有正確的 taskOverride（需先 deploy SchedulerStack）
#   2. 把快照排程改為「3 分鐘後」觸發
#   3. 等待 ECS task 完成（最多 5 分鐘）
#   4. 檢查 CloudWatch Logs 是否有成功訊息
#   5. 檢查 DynamoDB 是否出現新快照
#   6. 自動還原原始排程 cron（23:55）
#
# 使用方式：
#   bash scripts/test-scheduler.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROFILE="srec"
REGION="ap-northeast-1"
SCHEDULE_NAME="line-report-daily-snapshot"
ORIGINAL_CRON="cron(55 23 * * ? *)"
CLUSTER="line-report"
LOG_GROUP="/ecs/line-report"
DDB_TABLE="usage_snapshots"
MONTH_KEY=$(date -u +"%Y-%m")

ORIGINAL_TARGET_JSON=""  # 確保 cleanup trap 不會因 unbound variable 失敗

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

log()  { echo -e "${BOLD}[TEST]${RESET} $*"; }
ok()   { echo -e "${GREEN}[PASS]${RESET} $*"; }
fail() { echo -e "${RED}[FAIL]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }

# ── 清理函式（Ctrl+C 或錯誤時也會還原排程）────────────────────────────────
cleanup() {
  echo ""
  if [[ -z "$ORIGINAL_TARGET_JSON" ]]; then
    return  # Step 0 前就失敗，排程未變動，不需還原
  fi
  log "還原排程為原始設定：${ORIGINAL_CRON}"
  aws scheduler update-schedule \
    --profile "$PROFILE" \
    --name "$SCHEDULE_NAME" \
    --schedule-expression "$ORIGINAL_CRON" \
    --schedule-expression-timezone "Asia/Taipei" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --target "$ORIGINAL_TARGET_JSON" \
    --no-cli-pager > /dev/null 2>&1 && ok "排程已還原" || warn "排程還原失敗，請手動執行 npm run deploy -- LineReportSchedulerStack"
}
trap cleanup EXIT

# ── Step 0：確認 SchedulerStack 已部署（task definition 必須指向 line-report-snapshot）
log "Step 0：確認 Scheduler 已使用正確的 task definition..."
TASK_DEF_ARN=$(aws scheduler get-schedule \
  --profile "$PROFILE" \
  --name "$SCHEDULE_NAME" \
  --query 'Target.EcsParameters.TaskDefinitionArn' \
  --output text 2>/dev/null || echo "None")

if [[ "$TASK_DEF_ARN" != *"line-report-snapshot"* ]]; then
  fail "Scheduler task definition 不正確（目前：${TASK_DEF_ARN}），請先執行：npm run deploy -- LineReportEcsStack LineReportSchedulerStack"
  exit 1
fi
ok "task definition 正確：${TASK_DEF_ARN}"

# ── 取得完整 Target JSON（用於還原）──────────────────────────────────────
ORIGINAL_TARGET_JSON=$(aws scheduler get-schedule \
  --profile "$PROFILE" \
  --name "$SCHEDULE_NAME" \
  --query 'Target' \
  --output json)

# ── Step 1：計算 3 分鐘後的 cron（UTC 時間）──────────────────────────────
log "Step 1：計算測試用排程時間（3 分鐘後）..."
TRIGGER_EPOCH=$(( $(date -u +%s) + 180 ))
TRIGGER_HOUR=$(date -u -r "$TRIGGER_EPOCH" +"%H" 2>/dev/null || date -u -d "@$TRIGGER_EPOCH" +"%H")
TRIGGER_MIN=$(date -u -r  "$TRIGGER_EPOCH" +"%M" 2>/dev/null || date -u -d "@$TRIGGER_EPOCH" +"%M")
# EventBridge cron：UTC 時間，timezone 另設為 UTC（測試時暫時用 UTC）
TEST_CRON="cron(${TRIGGER_MIN} ${TRIGGER_HOUR} * * ? *)"
log "測試 cron（UTC）：${TEST_CRON}，約 $(date -u -r "$TRIGGER_EPOCH" +"%H:%M" 2>/dev/null || date -u -d "@$TRIGGER_EPOCH" +"%H:%M") UTC"

# ── Step 2：更新排程為測試時間，同時確保 timezone 改為 UTC ──────────────
log "Step 2：更新排程為測試時間..."
aws scheduler update-schedule \
  --profile "$PROFILE" \
  --name "$SCHEDULE_NAME" \
  --schedule-expression "$TEST_CRON" \
  --schedule-expression-timezone "UTC" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target "$ORIGINAL_TARGET_JSON" \
  --no-cli-pager > /dev/null
ok "排程已更新，等待觸發..."

# ── Step 3：等待排程觸發並偵測新 log stream（最多 5 分鐘）──────────────
# 注意：task 執行極快（約數秒），用 list-tasks 只能抓到 RUNNING 中的 task 可能來不及。
# 改為監聽 CloudWatch Logs 是否出現觸發時間點之後的新 log stream。
log "Step 3：等待 Scheduler 觸發並出現新 log stream（最多 5 分鐘）..."
TRIGGER_AFTER_MS=$(( $(date -u +%s) * 1000 ))  # 記錄等待開始的時間（ms）
WAIT_START=$(date -u +%s)
TASK_ID=""

while true; do
  ELAPSED=$(( $(date -u +%s) - WAIT_START ))
  if (( ELAPSED > 300 )); then
    fail "超時 5 分鐘，未偵測到新 ECS task"
    exit 1
  fi

  # 找出觸發後才出現的最新 log stream
  LATEST_STREAM=$(aws logs describe-log-streams \
    --profile "$PROFILE" \
    --log-group-name "$LOG_GROUP" \
    --order-by LastEventTime \
    --descending \
    --max-items 1 \
    --query "logStreams[?creationTime >= \`${TRIGGER_AFTER_MS}\`].logStreamName" \
    --output text 2>/dev/null || echo "None")

  if [[ "$LATEST_STREAM" != "None" && "$LATEST_STREAM" != "" ]]; then
    TASK_ID="${LATEST_STREAM##*/app/}"
    ok "偵測到新 ECS task：${TASK_ID}"
    break
  fi

  printf "  等待中... (%ds)\r" "$ELAPSED"
  sleep 15
done

# ── Step 4：等待 log stream 出現完成訊息（最多 2 分鐘）──────────────────
log "Step 4：等待 task log 出現完成訊息..."
sleep 5  # 給 CloudWatch 時間接收 log

# ── Step 5：查 CloudWatch Logs ────────────────────────────────────────────
log "Step 5：檢查 CloudWatch Logs..."
LOG_STREAM="line-report/app/${TASK_ID}"

LOGS=$(aws logs get-log-events \
  --profile "$PROFILE" \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "$LOG_STREAM" \
  --query 'events[*].message' \
  --output text 2>/dev/null || echo "")

if echo "$LOGS" | grep -q '"msg":"快照執行完成"'; then
  ok "CloudWatch Logs 確認：快照執行完成"
elif echo "$LOGS" | grep -q '"level":"error"'; then
  ERROR_MSG=$(echo "$LOGS" | grep '"level":"error"' | head -1)
  fail "CloudWatch Logs 有 error：${ERROR_MSG}"
  exit 1
else
  warn "CloudWatch Logs 未找到完成訊息，請手動確認："
  echo "$LOGS" | head -20
fi

# ── Step 6：確認 DynamoDB 有新快照 ───────────────────────────────────────
log "Step 6：確認 DynamoDB 有新快照..."
COUNT=$(aws dynamodb query \
  --profile "$PROFILE" \
  --table-name "$DDB_TABLE" \
  --key-condition-expression "monthKey = :mk" \
  --expression-attribute-values "{\":mk\":{\"S\":\"${MONTH_KEY}\"}}" \
  --query 'Count' \
  --output text)

if (( COUNT > 0 )); then
  USAGE=$(aws dynamodb query \
    --profile "$PROFILE" \
    --table-name "$DDB_TABLE" \
    --key-condition-expression "monthKey = :mk" \
    --expression-attribute-values "{\":mk\":{\"S\":\"${MONTH_KEY}\"}}" \
    --no-scan-index-forward \
    --max-items 1 \
    --query 'Items[0].totalUsage.N' \
    --output text)
  ok "DynamoDB 有快照資料：月份=${MONTH_KEY}，totalUsage=${USAGE}"
else
  fail "DynamoDB 無資料，快照可能未寫入"
  exit 1
fi

echo ""
echo -e "${GREEN}${BOLD}━━━ 所有測試通過 ━━━${RESET}"
echo -e "  Scheduler 觸發     ✅"
echo -e "  ECS task 完成      ✅"
echo -e "  CloudWatch Logs    ✅"
echo -e "  DynamoDB 寫入      ✅"
echo ""
log "排程將在 cleanup 時自動還原為 ${ORIGINAL_CRON}（Asia/Taipei）"
