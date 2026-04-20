CREATE TABLE IF NOT EXISTS "bot_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"scan_id" text NOT NULL,
	"pool_address" text NOT NULL,
	"pool_name" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"rule_score" double precision,
	"ml_probability" double precision,
	"score_breakdown" jsonb,
	"features" jsonb,
	"position_id" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_decisions_bot_id_idx" ON "bot_decisions" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_decisions_user_id_idx" ON "bot_decisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_decisions_scan_id_idx" ON "bot_decisions" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_decisions_position_id_idx" ON "bot_decisions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_decisions_timestamp_idx" ON "bot_decisions" USING btree ("timestamp");--> statement-breakpoint
ALTER TABLE "bot_decisions" ADD CONSTRAINT "bot_decisions_bot_id_bots_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("bot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_decisions" ADD CONSTRAINT "bot_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
