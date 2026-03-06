# Sage Backend

REST API backend for the Sage LP Intelligence Platform — powering the Sage mobile app's autonomous Meteora DLMM trading bots.

## Architecture

```mermaid
graph TB
    subgraph Client
        APP["Sage Mobile App<br/>(Flutter)"]
    end

    subgraph Server["Hono HTTP Server (Node.js)"]
        MW["Middleware<br/>CORS · SecureHeaders · RateLimit · BodyLimit"]
        AUTH["Auth: SIWS → JWT<br/>(jose + tweetnacl)"]

        subgraph Routes
            R1["/auth"]
            R2["/bot"]
            R3["/position"]
            R4["/wallet"]
            R5["/strategy"]
            R6["/ml"]
            R7["/ai"]
            R8["/events (SSE)"]
            R9["/fleet"]
            R10["/health"]
        end

        subgraph Engine["BotOrchestrator (Singleton)"]
            TE["TradingEngine<br/>(per bot)"]
            SE["SimulationExecutor"]
            LE["LiveExecutor"]
            ES["EmergencyStop<br/>(per bot)"]
            CB["CircuitBreaker<br/>(per bot)"]
            MD["MarketDataProvider"]
            SC["SharedAPICache"]
            ML["MLPredictor<br/>(shared, optional)"]
        end

        subgraph Data["PostgreSQL (Drizzle ORM)"]
            T1["users"]
            T2["bots"]
            T3["positions"]
            T4["trade_log"]
            T5["strategy_presets"]
            T6["conversations"]
        end
    end

    subgraph External
        METEORA["Meteora DLMM API<br/>(real market data)"]
        SOLANA["Solana RPC<br/>(Helius)"]
        CLAUDE["Anthropic Claude<br/>(strategy chat)"]
        OPENAI["OpenAI<br/>(voice STT)"]
    end

    APP -->|"REST + SSE"| MW
    MW --> AUTH
    AUTH --> Routes

    R2 & R3 --> TE
    TE --> SE & LE
    TE --> ES & CB
    SE & LE --> MD
    MD --> SC

    R6 --> ML
    R7 --> CLAUDE & OPENAI

    Engine --> Data
    Routes --> Data

    MD --> METEORA
    LE --> SOLANA
    SC --> METEORA

    style Server fill:#1a1a2e,stroke:#16213e,color:#e0e0e0
    style Engine fill:#0f3460,stroke:#533483,color:#e0e0e0
    style Data fill:#1a1a2e,stroke:#e94560,color:#e0e0e0
    style Client fill:#533483,stroke:#e94560,color:#e0e0e0
    style External fill:#16213e,stroke:#0f3460,color:#e0e0e0
```

## Tech Stack

| Layer       | Technology                                      |
|-------------|------------------------------------------------|
| Framework   | [Hono](https://hono.dev/) v4 + @hono/node-server |
| Database    | PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/) |
| Auth        | SIWS (Sign-In With Solana) → JWT (jose + tweetnacl) |
| Validation  | Zod schemas on all inputs                       |
| Logging     | Pino (structured JSON)                          |
| Rate Limit  | hono-rate-limiter (per-route tiers)             |
| Real-time   | Server-Sent Events (SSE) via EventBus           |
| AI          | Anthropic Claude (strategy chat), OpenAI (STT)  |
| Blockchain  | @solana/web3.js, @meteora-ag/dlmm               |

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+ (local or cloud)
- A Solana RPC endpoint (Helius recommended)

### Setup

```bash
cd sage-backend

# Install dependencies
npm install

# Copy env template and fill in your values
cp .env.example .env    # or create .env manually (see below)

# Push schema to your database
npm run db:push

# Start development server (with hot reload)
npm run dev
```

### Required Environment Variables

```bash
# Minimum required — server won't start without these
JWT_SECRET="your-secret-at-least-32-characters-long"
DATABASE_URL="postgresql://user:pass@localhost:5432/sage_dev"
SOLANA_RPC_URL="https://your-helius-rpc-endpoint.com"

# Optional — for full functionality
ANTHROPIC_API_KEY="sk-ant-..."       # AI strategy chat
OPENAI_API_KEY="sk-..."             # Voice transcription
HELIUS_API_KEY="..."                # Enhanced RPC features
ML_SERVICE_URL="http://127.0.0.1:8100"  # ML prediction service
WALLET_PATH="./wallet.json"         # Live trading (⚠️ REAL MONEY)
```

See [src/config.ts](src/config.ts) for the full Zod-validated config schema with defaults.

## Scripts

| Script         | Description                                           |
|----------------|-------------------------------------------------------|
| `npm run dev`  | Start dev server with hot reload (tsx watch)           |
| `npm run build`| Compile TypeScript to `dist/`                          |
| `npm start`    | Run compiled production build                          |
| `npm run db:push`    | Push schema changes directly to DB (dev)         |
| `npm run db:generate`| Generate SQL migration files                     |
| `npm run db:migrate` | Apply pending migrations                         |
| `npm run db:studio`  | Open Drizzle Studio (visual DB browser)          |
| `npm run db:seed`    | Seed database with strategy presets              |

## API Reference

### Authentication

All routes except `/health` and `/auth/*` require a JWT bearer token.

```
Authorization: Bearer <access_token>
```

#### Auth Flow (SIWS)

```
1. GET  /auth/nonce?walletAddress=<pubkey>    → { nonce }
2. POST /auth/verify { walletAddress, signature, message }
   → { accessToken, refreshToken }
3. POST /auth/refresh { refreshToken }
   → { accessToken, refreshToken }
```

### Core Routes

| Method | Path                    | Description                              | Rate Limit     |
|--------|-------------------------|------------------------------------------|----------------|
| GET    | `/health`               | Server health + cache stats              | Global         |
| POST   | `/auth/nonce`           | Request SIWS nonce                       | 20/min         |
| POST   | `/auth/verify`          | Verify signature → JWT                   | 20/min         |
| POST   | `/auth/refresh`         | Refresh access token                     | 20/min         |
| GET    | `/wallet/portfolio`     | Wallet balances + token holdings         | 100/min        |
| POST   | `/bot/create`           | Create a new bot                         | 10/min         |
| GET    | `/bot/list`             | List user's bots                         | 100/min        |
| GET    | `/bot/:botId`           | Bot detail + stats + live positions      | 100/min        |
| PUT    | `/bot/:botId/config`    | Update config (stopped bots only)        | 10/min         |
| PUT    | `/bot/:botId/rename`    | Rename a bot                             | Global         |
| POST   | `/bot/:botId/start`     | Start trading engine                     | 10/min         |
| POST   | `/bot/:botId/stop`      | Stop gracefully                          | 10/min         |
| POST   | `/bot/:botId/emergency` | Emergency close all positions            | 10/min         |
| DELETE | `/bot/:botId`           | Soft-delete a stopped bot                | Global         |
| GET    | `/position/list`        | User's position history                  | 100/min        |
| GET    | `/position/:id`         | Position detail                          | 100/min        |
| POST   | `/position/:id/close`   | Close a specific position                | Global         |
| GET    | `/strategy/presets`     | List strategy presets                    | 100/min        |
| GET    | `/events/stream`        | SSE stream for real-time updates         | Global         |
| POST   | `/ml/predict`           | Get ML prediction for a pool             | 30/min         |
| GET    | `/ml/status`            | ML service health                        | 30/min         |
| POST   | `/ai/chat`              | AI strategy conversation                 | 30/min         |
| POST   | `/ai/transcribe`        | Voice-to-text (25MB max)                 | 30/min         |
| GET    | `/fleet/leaderboard`    | Public bot leaderboard                   | 100/min        |
| POST   | `/wallet/prepare-create`| Prepare Seal wallet creation TX      | 10/min         |
| POST   | `/wallet/prepare-register-agent` | Prepare per-bot agent registration TX | 10/min   |
| POST   | `/wallet/prepare-deposit`| Prepare deposit TX for Seal wallet  | 10/min         |
| GET    | `/wallet/state`         | On-chain Seal wallet state           | 100/min        |
| GET    | `/wallet/balance`       | Seal wallet SOL balance              | 100/min        |
| GET    | `/wallet/sponsor-status`| Check if sponsored mode available        | 100/min        |

### SSE Events (GET /events/stream)

Real-time updates pushed to the client:

| Event              | Payload                                                    |
|--------------------|------------------------------------------------------------|
| `position:opened`  | `{ positionId, pool, entryPrice, score }`                  |
| `position:closed`  | `{ positionId, pool, exitPrice, reason, pnlSol, result }`|
| `position:updated` | `{ positionId, currentPrice, unrealizedPnl }`              |
| `scan:completed`   | `{ eligible, entered }`                                    |
| `engine:started`   | `{}`                                                       |
| `engine:stopped`   | `{ stats }`                                                |
| `engine:error`     | `{ error, severity }`                                      |

## Database Schema

6 tables managed by Drizzle ORM. Migrations live in `drizzle/`.

| Table              | Purpose                                       |
|--------------------|-----------------------------------------------|
| `users`            | Wallet-authenticated users (SIWS)             |
| `bots`             | Per-user bot instances with config + stats     |
| `positions`        | LP position lifecycle (active → closed)        |
| `trade_log`        | Append-only event log (audit trail)            |
| `strategy_presets` | System + user strategy templates               |
| `conversations`    | AI chat history (setup, portfolio, general)     |

### Key Design Decisions

- **Soft-delete on bots** (`deletedAt`) — trade history is never destroyed
- **On-chain position key** on positions — for blockchain reconciliation
- **EmergencyStop state** persisted as JSON on bots table — survives restarts
- **Virtual balance** persisted on every trade — simulation balance is always accurate
- **Bigint for lamports** — no floating point for financial amounts
- **Per-bot Seal agent** — `agentPubkey`, `agentConfigAddress`, `sessionAddress` columns on `bots` table link each live bot to its on-chain Seal agent PDA

## Engine Architecture

The trading engine follows a **plug-and-play executor pattern**:

```typescript
interface ITradingExecutor {
  openPosition(poolAddress, strategy, amountX, amountY): Promise<OpenPositionResult>
  closePosition(positionId, reason): Promise<ClosePositionResult>
  getActivePositions(): TrackedPosition[]
  getBalance(): Promise<BN>
  getPerformanceSummary(): PerformanceSummary
}
```

- **SimulationExecutor** — Virtual balance, real market data from Meteora API
- **LiveExecutor** — Real DLMM transactions on Solana

Both are managed by the **BotOrchestrator** singleton which handles:

- Bot lifecycle (start/stop/recover)
- Position persistence to `positions` table
- Stats accumulation to `bots` table
- Emergency stop state persistence
- Virtual balance persistence (simulation mode)
- SSE event emission via EventBus

### Safety Systems

Every bot instance gets its own:

- **EmergencyStop** — Halts on daily loss limit, total loss limit, consecutive losses, tx failure spikes, or API error spikes
- **CircuitBreaker** — Prevents over-exposure (max positions, max per pool, max SOL per position)

## Deployment

Currently deployed on **Railway** with:

- PostgreSQL managed database
- Auto-deploy from `main` branch
- Environment variables configured in Railway dashboard

```bash
# Production build
npm run build
npm start
```

## Project Structure

```
sage-backend/
├── drizzle/                  # Generated SQL migrations
├── src/
│   ├── config.ts             # Zod-validated environment config
│   ├── index.ts              # Hono app setup + server start
│   ├── db/
│   │   ├── index.ts          # Drizzle connection + migration runner
│   │   ├── schema.ts         # All table definitions
│   │   └── seed.ts           # Strategy preset seeding
│   ├── engine/
│   │   ├── orchestrator.ts   # Bot lifecycle manager (singleton)
│   │   ├── trading-engine.ts # Scan/entry/exit loop
│   │   ├── simulation-executor.ts  # Virtual balance executor
│   │   ├── live-executor.ts  # Real DLMM transaction executor
│   │   ├── market-data.ts    # Meteora API + on-chain data provider
│   │   ├── ml-predictor.ts   # ML service client
│   │   ├── ml-features.ts    # Feature engineering
│   │   ├── emergency-stop.ts # Financial safety kill switch
│   │   ├── circuit-breaker.ts# Position limit enforcement
│   │   ├── wallet-manager.ts # Solana keypair management
│   │   ├── shared-cache.ts   # Cross-bot API response cache
│   │   ├── event-bus.ts      # SSE event emitter
│   │   ├── transaction-sender.ts # Solana TX builder/sender
│   │   └── types.ts          # Shared TypeScript types
│   ├── middleware/
│   │   ├── auth.ts           # JWT verification middleware
│   │   ├── error.ts          # Global error handler
│   │   ├── logger.ts         # Pino logger setup
│   │   └── rate-limit.ts     # Per-route rate limiting
│   ├── routes/
│   │   ├── auth.ts           # SIWS authentication
│   │   ├── bot.ts            # Bot CRUD + lifecycle
│   │   ├── position.ts       # Position queries + manual close
│   │   ├── wallet.ts         # Portfolio + balance
│   │   ├── strategy.ts       # Strategy presets
│   │   ├── ml.ts             # ML prediction proxy
│   │   ├── ai.ts             # Claude chat + voice transcription
│   │   ├── events.ts         # SSE streaming endpoint
│   │   ├── fleet.ts          # Public leaderboard
│   │   └── health.ts         # Health check
│   └── services/
│       ├── ai.ts             # Anthropic Claude integration
│       ├── auth.ts           # JWT token issuance + verification
│       ├── solana.ts         # Solana connection helpers
│       └── sponsor.ts        # Transaction sponsor (fee payer)
├── drizzle.config.ts         # Drizzle Kit configuration
├── package.json
└── tsconfig.json
```

## License

Apache-2.0
