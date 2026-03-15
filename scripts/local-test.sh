#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Sage Backend — Local Test Runner
#
# Usage:
#   ./scripts/local-test.sh          # Run unit tests only
#   ./scripts/local-test.sh --full   # Run with Docker PostgreSQL for integration tests
#
# Requirements:
#   - Node.js 18+
#   - Docker (for --full mode)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

FULL_MODE=false
if [[ "${1:-}" == "--full" ]]; then
  FULL_MODE=true
fi

# ── 1. Check prerequisites ──────────────────────────────────

info "Checking prerequisites..."
command -v node >/dev/null || fail "Node.js not found"
command -v npm >/dev/null || fail "npm not found"

if [[ "$FULL_MODE" == true ]]; then
  command -v docker >/dev/null || fail "Docker not found (required for --full mode)"
fi

# ── 2. Install dependencies ─────────────────────────────────

if [[ ! -d "node_modules" ]]; then
  info "Installing dependencies..."
  npm install
fi

# ── 3. Set test environment ─────────────────────────────────

export NODE_ENV=test
export JWT_SECRET="test-secret-at-least-32-characters-long"
export LOG_LEVEL=error

# ── 4. Start PostgreSQL (full mode only) ────────────────────

PG_CONTAINER=""
if [[ "$FULL_MODE" == true ]]; then
  info "Starting PostgreSQL via Docker..."
  PG_CONTAINER="sage-test-pg-$$"
  
  docker run -d \
    --name "$PG_CONTAINER" \
    -e POSTGRES_USER=sage_test \
    -e POSTGRES_PASSWORD=sage_test \
    -e POSTGRES_DB=sage_test \
    -p 5433:5432 \
    postgres:16-alpine >/dev/null

  export DATABASE_URL="postgresql://sage_test:sage_test@localhost:5433/sage_test"

  # Wait for PostgreSQL to be ready
  info "Waiting for PostgreSQL..."
  for i in {1..30}; do
    if docker exec "$PG_CONTAINER" pg_isready -U sage_test >/dev/null 2>&1; then
      break
    fi
    sleep 1
    if [[ $i -eq 30 ]]; then
      fail "PostgreSQL failed to start"
    fi
  done
  info "PostgreSQL ready on port 5433"

  # Run migrations
  info "Running database migrations..."
  npx drizzle-kit push --force 2>/dev/null || warn "Migration may have partial errors (OK for test DB)"
fi

# ── 5. Run tests ────────────────────────────────────────────

info "Running tests..."
npx vitest run --reporter=verbose
TEST_EXIT=$?

# ── 6. Cleanup ──────────────────────────────────────────────

if [[ -n "$PG_CONTAINER" ]]; then
  info "Stopping PostgreSQL container..."
  docker stop "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker rm "$PG_CONTAINER" >/dev/null 2>&1 || true
fi

if [[ $TEST_EXIT -eq 0 ]]; then
  info "All tests passed ✓"
else
  fail "Tests failed (exit code: $TEST_EXIT)"
fi

exit $TEST_EXIT
