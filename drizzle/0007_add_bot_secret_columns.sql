ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "agent_secret_key" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "session_pubkey" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "session_secret_key" text;