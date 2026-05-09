FROM node:22-bookworm-slim AS node-base

ARG NPM_REGISTRY=https://registry.npmmirror.com

# 统一 npm registry 和重试策略，减少构建时 npm 网络抖动导致失败。
RUN npm config set registry "$NPM_REGISTRY" \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000

FROM node-base AS frontend-builder

# 构建前端静态资源，最终只把 dist 放进运行镜像。
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node-base AS backend-builder

ENV DATABASE_URL="mysql://root:password@localhost:3306/e2e_platform"

# 构建后端，并整理一个最小运行目录，避免最终镜像带入源码和开发依赖。
WORKDIR /app/backend
COPY backend/package*.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
COPY backend/ ./
RUN npm run prisma:generate \
    && npm run build \
    && npm prune --omit=dev \
    && mkdir -p /app/runtime/tests \
    && cp package*.json /app/runtime/ \
    && cp -R node_modules dist prisma .claude /app/runtime/ \
    && cp -R tests/utils /app/runtime/tests/utils \
    && cp playwright.config.ts prisma.config.ts CLAUDE.md /app/runtime/

FROM node-base AS runner

ENV NODE_ENV=production
ENV PORT=9099

# 运行镜像只保留后端运行产物、前端静态资源、Claude Code 和 Chromium。
WORKDIR /app/backend

COPY --from=backend-builder /app/runtime ./
COPY --from=frontend-builder /app/frontend/dist ./public
COPY docker-entrypoint.sh /usr/local/bin/e2e-platform-entrypoint

# 后端生产依赖已在 backend-builder 阶段裁剪好，这里只补全全局 CLI 和 Chromium。
RUN npm install -g @anthropic-ai/claude-code @playwright/cli \
    && npx --no-install playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && chmod +x /usr/local/bin/e2e-platform-entrypoint \
    && mkdir -p tests/generated test-results

EXPOSE 9099

ENTRYPOINT ["e2e-platform-entrypoint"]
