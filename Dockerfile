# ── 建置階段（安裝生產依賴）──────────────────────────────
# node:22-alpine 含較新 OpenSSL 3.5.x，減少 ECR Inspector 掃出的 Node 內建 OpenSSL CVE
FROM node:22-alpine AS deps
WORKDIR /app
# 升級 OS openssl 並更新 npm bundled 套件（修復 CVE 群組 A/B）
RUN apk upgrade --no-cache openssl && npm install -g npm@latest
COPY package*.json ./
RUN npm ci --omit=dev

# ── 執行階段 ─────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# 移除 npm（生產環境不需 package manager，且其 bundled minimatch/tar 會觸發 ECR 掃描）
RUN rm -rf /usr/local/lib/node_modules/npm
# 移除 Node headers（不需編譯 native addon，可減少 ECR 掃出 openssl 相關 CVE）
RUN rm -rf /usr/local/include/node

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
