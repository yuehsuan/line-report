# ── 建置階段（安裝生產依賴）──────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── 執行階段 ─────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# 設定時區（影響非 luxon 路徑的系統時間行為）
ENV TZ=Asia/Taipei

# 從建置階段複製 node_modules（不含 devDependencies）
COPY --from=deps /app/node_modules ./node_modules

# 複製應用程式原始碼
COPY package.json ./
COPY src ./src

# 以非 root 使用者執行（最小權限原則）
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# 預設 CMD；實際執行時由 ECS containerOverrides.command 覆寫
CMD ["node", "src/index.js"]
