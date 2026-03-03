#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# sync-ssm.sh
#
# 將 .env 中的業務設定同步到 AWS SSM Parameter Store。
# ECS Fargate 容器從 SSM 讀取設定，因此 .env 修改後必須執行此腳本才會生效。
#
# 使用方式：
#   bash scripts/sync-ssm.sh           # 同步全部參數
#   bash scripts/sync-ssm.sh targets   # 只同步 LINE_TARGETS
#   bash scripts/sync-ssm.sh token     # 只同步 LINE_CHANNEL_ACCESS_TOKEN
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV_FILE=".env"
PROFILE="srec"

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RESET="\033[0m"

ok()   { echo -e "${GREEN}[OK]${RESET}   $*"; }
skip() { echo -e "${YELLOW}[SKIP]${RESET} $*"; }

# 從 .env 讀取指定變數的值（忽略註解行；變數不存在時回傳空字串而非錯誤）
env_val() {
  grep "^${1}=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' || true
}

# 把變數值寫入 SSM（值為空則跳過）
put_ssm() {
  local name="$1" path="$2" type="$3" val="$4"
  if [[ -z "$val" ]]; then
    skip "${name}（.env 無此值，跳過）"
    return
  fi
  aws ssm put-parameter \
    --profile "$PROFILE" \
    --name "$path" \
    --type "$type" \
    --value "$val" \
    --overwrite \
    --no-cli-pager > /dev/null
  # 顯示時遮蔽 token（只印前 6 字）
  local display="$val"
  if [[ "$name" == "LINE_CHANNEL_ACCESS_TOKEN" ]]; then
    display="${val:0:6}…（已遮蔽）"
  fi
  ok "${name} → ${display}"
}

FILTER="${1:-all}"

echo -e "${BOLD}同步 .env → SSM Parameter Store（profile: ${PROFILE}）${RESET}"
echo ""

if [[ "$FILTER" == "all" || "$FILTER" == "token" ]]; then
  TOKEN=$(env_val LINE_CHANNEL_ACCESS_TOKEN)
  put_ssm "LINE_CHANNEL_ACCESS_TOKEN" "/line-report/LINE_CHANNEL_ACCESS_TOKEN" "SecureString" "$TOKEN"
fi

if [[ "$FILTER" == "all" || "$FILTER" == "targets" ]]; then
  TARGETS=$(env_val LINE_TARGETS)
  put_ssm "LINE_TARGETS" "/line-report/LINE_TARGETS" "String" "$TARGETS"
fi

if [[ "$FILTER" == "all" ]]; then
  put_ssm "FREE_QUOTA"       "/line-report/FREE_QUOTA"       "String" "$(env_val FREE_QUOTA)"
  put_ssm "PRICING_MODEL"    "/line-report/PRICING_MODEL"    "String" "$(env_val PRICING_MODEL)"
  put_ssm "PLAN_FEE"         "/line-report/PLAN_FEE"         "String" "$(env_val PLAN_FEE)"
  put_ssm "SINGLE_UNIT_PRICE" "/line-report/SINGLE_UNIT_PRICE" "String" "$(env_val SINGLE_UNIT_PRICE)"
  put_ssm "CURRENCY"         "/line-report/CURRENCY"         "String" "$(env_val CURRENCY)"

  TIERS=$(env_val TIERS_JSON)
  if [[ -n "$TIERS" ]]; then
    put_ssm "TIERS_JSON" "/line-report/TIERS_JSON" "String" "$TIERS"
  fi
fi

echo ""
echo -e "${BOLD}同步完成。下次 ECS task 啟動時即會使用新值。${RESET}"
