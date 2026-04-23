-- Migration: Add LLM mode columns to bots table
-- Adds per-bot encrypted Anthropic API key and LLM configuration fields
-- required for strategyMode = 'llm'

-- Extend strategy_mode enum to include 'llm'
ALTER TABLE bots DROP CONSTRAINT IF EXISTS bots_strategy_mode_check;
ALTER TABLE bots
  ADD CONSTRAINT bots_strategy_mode_check
  CHECK (strategy_mode IN ('rule-based', 'aura-ai', 'both', 'llm'));

-- Encrypted Anthropic API key (AES-256-GCM, same scheme as encrypted_private_key)
ALTER TABLE bots ADD COLUMN IF NOT EXISTS encrypted_llm_api_key TEXT;

-- LLM model override (e.g. 'claude-haiku-4-5-20251001'). NULL = use default.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS llm_model TEXT;

-- Hard daily USD spend cap for LLM API calls. NULL = unlimited.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS llm_max_usd_per_day DOUBLE PRECISION;

-- Max pools to include in a single LLM prompt. NULL = 10.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS llm_max_pools_per_call INTEGER;
