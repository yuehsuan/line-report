#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-snapshot-metric-filters.sh
#
# 驗證 snapshot-missing 告警的修正：兩個 metric filter 皆存在且正確。
# 修正前：只有「快照執行完成」會觸發 SnapshotSuccessCount，
#         idempotent 略過時不觸發，導致誤報。
# 修正後：新增「今日快照已成功完成，略過（idempotent）」的 filter，
#         兩種情況都會產生 metric，避免誤報。
#
# 使用方式：
#   1. 先部署：npm run deploy -- LineReportMonitoringStack
#   2. 執行：bash scripts/e2e-tests/test-snapshot-metric-filters.sh
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROFILE="${AWS_PROFILE:-srec}"
REGION="${AWS_REGION:-ap-northeast-1}"
LOG_GROUP="/ecs/line-report"
METRIC_NAMESPACE="LineReport"
METRIC_NAME="SnapshotSuccessCount"

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

ok()   { echo -e "${GREEN}[PASS]${RESET} $*"; }
fail() { echo -e "${RED}[FAIL]${RESET} $*"; }

echo -e "${BOLD}=== Snapshot Metric Filters 驗證 ===${RESET}"
echo ""

# ── Step 1：查詢 log group 的 metric filters ─────────────────────────────
ALL_FILTERS=$(aws logs describe-metric-filters \
  --profile "$PROFILE" \
  --region "$REGION" \
  --log-group-name "$LOG_GROUP" \
  --output json 2>/dev/null || echo '{"metricFilters":[]}')
FILTERS=$(echo "$ALL_FILTERS" | jq '[.metricFilters[] | select(.metricTransformations[0].metricName=="SnapshotSuccessCount")]')

FILTER_COUNT=$(echo "$FILTERS" | jq 'length')
if [[ "$FILTER_COUNT" -lt 2 ]]; then
  fail "SnapshotSuccessCount 應有 2 個 metric filters（快照完成 + idempotent 略過），目前只有 ${FILTER_COUNT} 個"
  echo ""
  echo "請先執行：npm run deploy -- LineReportMonitoringStack"
  exit 1
fi
ok "找到 ${FILTER_COUNT} 個 SnapshotSuccessCount metric filters"

# ── Step 2：確認兩個 filter pattern 都存在 ──────────────────────────────
PATTERNS=$(echo "$FILTERS" | jq -r '.[].filterPattern')
HAS_COMPLETE=false
HAS_IDEMPOTENT=false

while IFS= read -r pattern; do
  if [[ "$pattern" == *'快照執行完成'* ]] && [[ "$pattern" != *'idempotent'* ]]; then
    HAS_COMPLETE=true
  fi
  if [[ "$pattern" == *'今日快照已成功完成，略過（idempotent）'* ]]; then
    HAS_IDEMPOTENT=true
  fi
done <<< "$PATTERNS"

if [[ "$HAS_COMPLETE" != "true" ]]; then
  fail "缺少 filter：\$\.msg = '快照執行完成'"
  exit 1
fi
ok "filter 1：快照執行完成"

if [[ "$HAS_IDEMPOTENT" != "true" ]]; then
  fail "缺少 filter：\$\.msg = '今日快照已成功完成，略過（idempotent）'"
  exit 1
fi
ok "filter 2：今日快照已成功完成，略過（idempotent）"

# ── Step 3：確認 alarm 存在且指向正確 metric ───────────────────────────
ALARM_STATE=$(aws cloudwatch describe-alarms \
  --profile "$PROFILE" \
  --region "$REGION" \
  --alarm-names "line-report-snapshot-missing" \
  --query 'MetricAlarms[0].MetricName' \
  --output text 2>/dev/null || echo "None")

if [[ "$ALARM_STATE" != "$METRIC_NAME" ]]; then
  fail "Alarm line-report-snapshot-missing 未正確設定或不存在"
  exit 1
fi
ok "Alarm line-report-snapshot-missing 使用 SnapshotSuccessCount"

echo ""
echo -e "${GREEN}${BOLD}━━━ 驗證通過 ━━━${RESET}"
echo "  idempotent 略過時也會產生 SnapshotSuccessCount，不再誤觸 snapshot-missing 告警"
echo ""
echo "  [選用] 若要端對端驗證，可執行："
echo "    1. bash scripts/e2e-tests/smoke-test-ecs.sh    # 第一次：真正快照"
echo "    2. bash scripts/e2e-tests/smoke-test-ecs.sh    # 第二次：idempotent 略過"
echo "    3. 等待 5–15 分鐘後，CloudWatch 應有 2 筆 SnapshotSuccessCount"
