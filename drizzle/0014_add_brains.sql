-- 0014 — add brains table (Wallet Intelligence analysis runs)
-- A "brain" is an analysis of a real wallet's on-chain trading: full history is
-- fetched, decoded, and reconstructed into real DLMM positions (real PnL) + swaps,
-- and the resulting behavioral fingerprint is stored here. One row per run.
CREATE TABLE IF NOT EXISTS "brains" (
	"id" serial PRIMARY KEY NOT NULL,
	"brain_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_address" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"window_days" integer DEFAULT 90 NOT NULL,
	"max_txs" integer DEFAULT 5000 NOT NULL,
	"txs_scanned" integer,
	"positions_total" integer,
	"positions_complete" integer,
	"swaps_found" integer,
	"pools_resolved" integer,
	"confidence" text,
	"fingerprint" jsonb,
	"pnl_summary" jsonb,
	"priced_positions" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brains_brain_id_idx" ON "brains" USING btree ("brain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brains_user_id_idx" ON "brains" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brains_wallet_address_idx" ON "brains" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brains_status_idx" ON "brains" USING btree ("status");--> statement-breakpoint
ALTER TABLE "brains" ADD CONSTRAINT "brains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
