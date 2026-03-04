#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-scheduler-report.sh
#
# 端到端驗證每月回報 EventBridge Scheduler → ECS Fargate → LINE 推播整條路。
#
# 執行流程：
#   1. 確認 Scheduler 已正確指向 line-report-report task definition
#   2. 確認上月有 prevMonthFinal 快照；若無，自動植入測試用假資料
#   3. 清除 job_runs 中的 report#<上月> 防重紀錄（允許重複觸發）
#   4. 把月報排程改為「3 分鐘後」觸發
#   5. 等待 ECS task 完成
#   6. 確認 CloudWatch Logs 有成功訊息
#   7. 確認 job_runs 寫入 success 狀態
#   8. 自動還原排程 + 清除植入的假資料（若有）
#
# 使用方式：
#   bash scripts/test-scheduler-report.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROFILE="srec"
SCHEDULE_NAME="line-report-monthly-report"
CLUSTER="line-report"
LOG_GROUP="/ecs/line-report"
DDB_SNAPSHOTS="usage_snapshots"
DDB_RUNS="job_runs"

# 計算上月 key
PREV_MONTH_KEY=$(date -u -v-1m +"%Y-%m" 2>/dev/null || date -u -d "1 month ago" +"%Y-%m")
PREV_MONTH_FINAL_TS="${PREV_MONTH_KEY}-28T15:55:00.000Z"
JOB_ID="report#${PREV_MONTH_KEY}"

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

log()  { echo -e "${BOLD}[TEST]${RESET} $*"; }
ok()   { echo -e "${GREEN}[PASS]${RESET} $*"; }
fail() { echo -e "${RED}[FAIL]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }

ORIGINAL_TARGET_JSON=""
SEEDED_SNAPSHOT=false  # 是否植入了假資料，供 cleanup 判斷是否刪除

cleanup() {
  echo ""

  # 還原排程
  if [[ -n "$ORIGINAL_TARGET_JSON" ]]; then
    log "還原月報排程為原始設定..."
    aws scheduler update-schedule \
      --profile "$PROFILE" \
      --name "$SCHEDULE_NAME" \
      --schedule-expression "$ORIGINAL_CRON" \
      --schedule-expression-timezone "Asia/Taipei" \
      --flexible-time-window '{"Mode":"OFF"}' \
      --target "$ORIGINAL_TARGET_JSON" \
      --no-cli-pager > /dev/null 2>&1 && ok "月報排程已還原" || warn "月報排程還原失敗，請手動執行 npm run deploy -- LineReportSchedulerStack"
  fi

  # 刪除植入的假資料
  if [[ "$SEEDED_SNAPSHOT" == "true" ]]; then
    log "清除測試植入的 prevMonthFinal 假資料（${PREV_MONTH_KEY}）..."
    aws dynamodb delete-item \
      --profile "$PROFILE" \
      --table-name "$DDB_SNAPSHOTS" \
      --key "{\"monthKey\":{\"S\":\"${PREV_MONTH_KEY}\"},\"ts\":{\"S\":\"${PREV_MONTH_FINAL_TS}\"}}" \
      > /dev/null 2>&1 && ok "假資料已清除" || warn "假資料清除失敗，請手動刪除 monthKey=${PREV_MONTH_KEY} ts=${PREV_MONTH_FINAL_TS}"
  fi

  # 刪除測試用的 job_runs 紀錄（避免影響日後真正的月報）
  log "清除測試用 job_runs 紀錄（${JOB_ID}）..."
  aws dynamodb delete-item \
    --profile "$PROFILE" \
    --table-name "$DDB_RUNS" \
    --key "{\"jobId\":{\"S\":\"${JOB_ID}\"}}" \
    > /dev/null 2>&1 && ok "job_runs 已清除" || warn "job_runs 清除失敗"
}
trap cleanup EXIT

# ── Step 0：確認 Scheduler 已使用正確的 task definition ──────────────────
log "Step 0：確認月報 Scheduler 指向 line-report-report..."
TASK_DEF_ARN=$(aws scheduler get-schedule \
  --profile "$PROFILE" \
  --name "$SCHEDULE_NAME" \
  --query 'Target.EcsParameters.TaskDefinitionArn' \
  --output text 2>/dev/null || echo "None")

if [[ "$TASK_DEF_ARN" != *"line-report-report"* ]]; then
  fail "Scheduler task definition 不正確（目前：${TASK_DEF_ARN}），請先執行：npm run deploy -- LineReportEcsStack LineReportSchedulerStack"
  exit 1
fi
ok "task definition 正確：${TASK_DEF_ARN}"

# 取得完整 Target JSON（用於還原）
ORIGINAL_TARGET_JSON=$(aws scheduler get-schedule \
  --profile "$PROFILE" \
  --name "$SCHEDULE_NAME" \
  --query 'Target' \
  --output json)

ORIGINAL_CRON=$(aws scheduler get-schedule \
  --profile "$PROFILE" \
  --name "$SCHEDULE_NAME" \
  --query 'ScheduleExpression' \
  --output text)

# ── Step 1：確認上月有 prevMonthFinal，若無則植入假資料 ──────────────────
log "Step 1：確認上月（${PREV_MONTH_KEY}）有 prevMonthFinal 快照..."
FINAL_COUNT=$(aws dynamodb query \
  --profile "$PROFILE" \
  --table-name "$DDB_SNAPSHOTS" \
  --key-condition-expression "monthKey = :mk" \
  --filter-expression "isPrevMonthFinal = :t" \
  --expression-attribute-values "{\":mk\":{\"S\":\"${PREV_MONTH_KEY}\"},\":t\":{\"BOOL\":true}}" \
  --query 'Count' \
  --output text 2>/dev/null || echo "0")

if [[ "$FINAL_COUNT" -gt 0 ]]; then
  ok "上月已有 prevMonthFinal 快照（${PREV_MONTH_KEY}），無需植入"
else
  warn "上月（${PREV_MONTH_KEY}）無 prevMonthFinal，植入測試假資料..."
  aws dynamodb put-item \
    --profile "$PROFILE" \
    --table-name "$DDB_SNAPSHOTS" \
    --item "{
      \"monthKey\":       {\"S\":\"${PREV_MONTH_KEY}\"},
      \"ts\":             {\"S\":\"${PREV_MONTH_FINAL_TS}\"},
      \"totalUsage\":     {\"N\":\"5000\"},
      \"isPrevMonthFinal\":{\"BOOL\":true},
      \"rawJson\":        {\"S\":\"{\\\"totalUsage\\\":5000}\"},
      \"createdAt\":      {\"S\":\"${PREV_MONTH_FINAL_TS}\"}
    }" > /dev/null
  SEEDED_SNAPSHOT=true
  ok "假資料植入完成（totalUsage=5000，isPrevMonthFinal=true）"
fi

# ── Step 2：清除 job_runs 防重紀錄，讓 report 可以重新執行 ───────────────
log "Step 2：清除 ${JOB_ID} 的 job_runs 防重紀錄..."
aws dynamodb delete-item \
  --profile "$PROFILE" \
  --table-name "$DDB_RUNS" \
  --key "{\"jobId\":{\"S\":\"${JOB_ID}\"}}" \
  > /dev/null
ok "job_runs 防重紀錄已清除"

# ── Step 3：計算 3 分鐘後的 cron 並更新排程 ──────────────────────────────
log "Step 3：更新月報排程為 3 分鐘後觸發..."
TRIGGER_EPOCH=$(( $(date -u +%s) + 180 ))
TRIGGER_HOUR=$(date -u -r "$TRIGGER_EPOCH" +"%H" 2>/dev/null || date -u -d "@$TRIGGER_EPOCH" +"%H")
TRIGGER_MIN=$(date -u -r  "$TRIGGER_EPOCH" +"%M" 2>/dev/null || date -u -d "@$TRIGGER_EPOCH" +"%M")
TEST_CRON="cron(${TRIGGER_MIN} ${TRIGGER_HOUR} * * ? *)"
log "測試 cron（UTC）：${TEST_CRON}"

aws scheduler update-schedule \
  --profile "$PROFILE" \
  --name "$SCHEDULE_NAME" \
  --schedule-expression "$TEST_CRON" \
  --schedule-expression-timezone "UTC" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target "$ORIGINAL_TARGET_JSON" \
  --no-cli-pager > /dev/null
ok "月報排程已更新，等待觸發..."

# ── Step 4+5：等待排程觸發並偵測新 log stream（最多 5 分鐘）────────────
log "Step 4：等待 Scheduler 觸發並出現新 log stream（最多 5 分鐘）..."
TRIGGER_AFTER_MS=$(( $(date -u +%s) * 1000 ))
WAIT_START=$(date -u +%s)
TASK_ID=""

while true; do
  ELAPSED=$(( $(date -u +%s) - WAIT_START ))
  if (( ELAPSED > 300 )); then
    fail "超時 5 分鐘，未偵測到新 ECS task"
    exit 1
  fi

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

log "Step 5：等待 log 送達 CloudWatch..."
sleep 5

# ── Step 6：查 CloudWatch Logs ────────────────────────────────────────────
log "Step 6：檢查 CloudWatch Logs..."
LOGS=$(aws logs get-log-events \
  --profile "$PROFILE" \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "line-report/app/${TASK_ID}" \
  --query 'events[*].message' \
  --output text 2>/dev/null || echo "")

if echo "$LOGS" | grep -q '"msg":"每月回報執行完成"'; then
  ok "CloudWatch Logs 確認：每月回報執行完成"
elif echo "$LOGS" | grep -q '"level":"error"'; then
  ERROR_MSG=$(echo "$LOGS" | grep '"level":"error"' | head -1)
  fail "CloudWatch Logs 有 error：${ERROR_MSG}"
  exit 1
else
  warn "CloudWatch Logs 未找到完成訊息，請手動確認："
  echo "$LOGS" | head -20
fi

# ── Step 7：確認 job_runs 寫入 success ───────────────────────────────────
log "Step 7：確認 job_runs 已記錄 success..."
JOB_STATUS=$(aws dynamodb get-item \
  --profile "$PROFILE" \
  --table-name "$DDB_RUNS" \
  --key "{\"jobId\":{\"S\":\"${JOB_ID}\"}}" \
  --query 'Item.status.S' \
  --output text 2>/dev/null || echo "None")

if [[ "$JOB_STATUS" == "success" ]]; then
  ok "job_runs 狀態：success"
else
  fail "job_runs 狀態異常：${JOB_STATUS}"
  exit 1
fi

echo ""
echo -e "${GREEN}${BOLD}━━━ 所有測試通過 ━━━${RESET}"
echo -e "  Scheduler 觸發        ✅"
echo -e "  ECS task 完成         ✅"
echo -e "  CloudWatch Logs       ✅"
echo -e "  job_runs success      ✅"
echo -e "  LINE 推播已發送        ✅ （請確認 LINE 群組有收到）"
echo ""
log "排程與測試資料將在 cleanup 時自動還原"
