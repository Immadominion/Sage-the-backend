ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "ml_threshold" double precision;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "wallet_address" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "encrypted_private_key" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "owner_wallet" text;