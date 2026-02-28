# ═══════════════════════════════════════════════════════════════
# Sage Backend — Multi-stage production Docker build
#
# - Stage 1: Install deps + build TypeScript → dist/
# - Stage 2: Lean production image (no devDeps, no src/)
#
# better-sqlite3 compiles native C++ — needs python3 + build tools.
# Node 22 LTS (Jod) is used for maximum compatibility.
# ═══════════════════════════════════════════════════════════════

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-alpine AS builder

# Native deps for better-sqlite3 compilation
RUN apk add --no-cache python3 make g++

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

# Native deps for better-sqlite3 runtime
RUN apk add --no-cache python3 make g++

# Non-root user for security
RUN addgroup -g 1001 -S sage && \
    adduser -S sage -u 1001 -G sage

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Native rebuild in production stage (linked against this Alpine's glibc)
RUN npm rebuild better-sqlite3

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy Drizzle migration files (auto-migrate on startup)
COPY drizzle/ ./drizzle/

# Create data directory for SQLite persistent volume
RUN mkdir -p /data && chown sage:sage /data

# Switch to non-root user
USER sage

# Railway injects PORT env var automatically
ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/sage.db

EXPOSE 3001

# Health check — Railway also uses this
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/health || exit 1

CMD ["node", "dist/index.js"]
