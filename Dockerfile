# ── sela license server — Coolify / Docker ─────────────────────
# Multi-stage: native build for better-sqlite3, slim runtime.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev || npm install --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
WORKDIR /app

# Non-root user + writable data volume.
RUN addgroup -S sela && adduser -S sela -G sela \
    && mkdir -p /data && chown -R sela:sela /data

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER sela
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/v1/health || exit 1

CMD ["node", "src/server.js"]
