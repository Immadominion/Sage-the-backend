# ═══════════════════════════════════════════════════════════════
# Sage Backend — Multi-stage production Docker build
#
# - Stage 1: Install deps + build TypeScript → dist/
# - Stage 2: Lean production image (no devDeps, no src/)
#
# PostgreSQL via node-postgres (pure JS, no native deps).
# Node 22 LTS (Jod) is used for maximum compatibility.
# ═══════════════════════════════════════════════════════════════

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first (Docker layer cache)
COPY package.json package-lock.json* ./

# Install ALL deps (including devDeps for tsc)
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────
FROM node:22-alpine AS production

# Non-root user for security
RUN addgroup -g 1001 -S sage && \
  adduser -S sage -u 1001 -G sage

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy Drizzle migration files (auto-migrate on startup)
COPY drizzle/ ./drizzle/

# Switch to non-root user
USER sage

# Railway injects PORT env var automatically
# DATABASE_URL is set via Railway's PostgreSQL addon
ENV NODE_ENV=production

EXPOSE 3001

# Health check — Railway also uses this
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/health || exit 1

CMD ["node", "dist/index.js"]
