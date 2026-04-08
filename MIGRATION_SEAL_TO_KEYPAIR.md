# Sage Backend — Seal → Encrypted Keypair Migration

## Why

Seal smart wallet program added significant complexity (100+ touch points, instruction rewriting, session expiry, pre-funding choreography) while the agent/session keypairs were stored **plaintext** in Postgres anyway — negating the on-chain security benefits. This migration replaces Seal with server-side encrypted keypairs: simpler, faster, and actually more secure.

## Architecture (After)

```
User signs in (MWA/SIWS) → JWT → creates bot
  → Backend: Keypair.generate() → AES-256-GCM encrypt → store ciphertext in DB
  → User deposits SOL to bot's plain Solana address (one MWA transfer)
  → Bot trades: decrypt keypair → sign DLMM TXs directly (no CPI wrapping)
  → Withdraw: backend signs transfer back to user's verified wallet
```

## Phases

### Phase 0 — Fund Recovery

- [x] Check all Seal wallet PDAs for remaining funds
- [x] Drain session signer balances
- [x] Close mainnet program → recover ~1.66 SOL to 4ZscU7J4emNUgy6BP98agYkzi1grBJbK3FJqnBSFjcvJ

### Phase 1 — New Execution Layer

- `src/engine/crypto-utils.ts` — AES-256-GCM encrypt/decrypt for keypairs
- `src/engine/bot-keypair-executor.ts` — ITradingExecutor using encrypted keypairs
- DB schema: add `walletAddress`, `encryptedPrivateKey`, `ownerWallet` to bots; drop Seal columns
- Config: add `MASTER_ENCRYPTION_KEY`, remove `SEAL_*`

### Phase 2 — Route Changes

- Bot creation generates keypair server-side (no on-chain TX)
- `POST /bot/:id/deposit` → returns bot address for user to send SOL
- `POST /bot/:id/withdraw` → backend signs transfer to owner wallet
- Orchestrator uses BotKeypairExecutor for live mode

### Phase 3 — Cleanup

- Delete: seal-executor.ts, seal-session.ts, Seal wallet routes, Seal PDA derivation
- Update health route, index.ts startup logs

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Key storage | AES-256-GCM encrypted in DB, master key in env (never in DB) |
| Key access | Decrypted only in-memory during active trading, zeroized on stop |
| Withdrawals | Whitelisted to owner's MWA-verified wallet only |
| Trading limits | EmergencyStop + CircuitBreaker (unchanged) |
| Auth | SIWS + JWT (unchanged) |
| Fund isolation | Each bot has its own Solana keypair / address |

## Cost Comparison

| Action | Before (Seal) | After |
|--------|--------------|-------|
| Create bot wallet | ~0.002 SOL + MWA sign | Free, instant |
| Register agent | ~0.004 SOL + MWA sign | N/A |
| Create session | ~0.001 SOL + MWA sign | N/A |
| Deposit | Complex Seal PDA funding | Standard SOL transfer |
| Trade execution | CPI via executeViaSession | Direct DLMM call |
| Withdraw | CloseWallet instruction | Backend-signed transfer |
