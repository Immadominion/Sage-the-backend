-- Migration: Per-trade fee billing system
-- Adds fee_ledger table + bots.total_fees_paid_lamports counter
-- Fees are charged on every position open (entry-only for now).
-- See aura-backend/src/engine/fee-calculator.ts for the fee schedule.

-- Running total of fees charged to each bot (append-only)
ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS total_fees_paid_lamports BIGINT NOT NULL DEFAULT 0;

-- Append-only audit log of every fee charged
CREATE TABLE IF NOT EXISTS fee_ledger (
  id SERIAL PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  position_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('simulation', 'live')),
  strategy_mode TEXT NOT NULL CHECK (strategy_mode IN ('rule-based', 'aura-ai', 'both', 'llm')),
  fee_type TEXT NOT NULL DEFAULT 'entry' CHECK (fee_type IN ('entry', 'exit')),
  position_size_lamports BIGINT NOT NULL,
  fee_bps INTEGER NOT NULL,
  fee_lamports BIGINT NOT NULL,
  collector_wallet TEXT NOT NULL,
  tx_signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fee_ledger_bot_id_idx ON fee_ledger(bot_id);
CREATE INDEX IF NOT EXISTS fee_ledger_user_id_idx ON fee_ledger(user_id);
CREATE INDEX IF NOT EXISTS fee_ledger_position_id_idx ON fee_ledger(position_id);
CREATE INDEX IF NOT EXISTS fee_ledger_created_at_idx ON fee_ledger(created_at);
