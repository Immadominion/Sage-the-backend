-- 0015 — link a deployed brain to its bot.
-- Set when a brain's fingerprint is compiled into a bot via POST /brain/:id/deploy.
ALTER TABLE "brains" ADD COLUMN IF NOT EXISTS "bot_id" text;
