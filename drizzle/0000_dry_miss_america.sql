CREATE TABLE "bots" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"name" text DEFAULT 'My Bot' NOT NULL,
	"mode" text DEFAULT 'simulation' NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"strategy_mode" text DEFAULT 'rule-based' NOT NULL,
	"entry_score_threshold" double precision DEFAULT 150 NOT NULL,
	"min_volume_24h" double precision DEFAULT 1000 NOT NULL,
	"min_liquidity" double precision DEFAULT 100 NOT NULL,
	"max_liquidity" double precision DEFAULT 1000000 NOT NULL,
	"position_size_sol" double precision DEFAULT 1 NOT NULL,
	"max_concurrent_positions" integer DEFAULT 5 NOT NULL,
	"default_bin_range" integer DEFAULT 10 NOT NULL,
	"profit_target_percent" double precision DEFAULT 8 NOT NULL,
	"stop_loss_percent" double precision DEFAULT 12 NOT NULL,
	"max_hold_time_minutes" integer DEFAULT 240 NOT NULL,
	"max_daily_loss_sol" double precision DEFAULT 2 NOT NULL,
	"cooldown_minutes" integer DEFAULT 79 NOT NULL,
	"cron_interval_seconds" integer DEFAULT 30 NOT NULL,
	"simulation_balance_sol" double precision DEFAULT 10 NOT NULL,
	"total_trades" integer DEFAULT 0 NOT NULL,
	"winning_trades" integer DEFAULT 0 NOT NULL,
	"total_pnl_lamports" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_activity_at" timestamp with time zone,
	"emergency_stop_state" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bots_bot_id_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pool_address" text NOT NULL,
	"pool_name" text NOT NULL,
	"token_x_mint" text NOT NULL,
	"token_y_mint" text NOT NULL,
	"bin_step" integer NOT NULL,
	"on_chain_position_key" text,
	"entry_active_bin_id" integer,
	"entry_price_per_token" text,
	"entry_timestamp" bigint NOT NULL,
	"entry_amount_x_lamports" bigint DEFAULT 0 NOT NULL,
	"entry_amount_y_lamports" bigint DEFAULT 0 NOT NULL,
	"entry_tx_signature" text,
	"entry_score" double precision,
	"ml_probability" double precision,
	"entry_features" text,
	"profit_target_percent" double precision NOT NULL,
	"stop_loss_percent" double precision NOT NULL,
	"max_hold_time_minutes" integer NOT NULL,
	"current_price_per_token" text,
	"unrealized_pnl_lamports" bigint,
	"exit_price_per_token" text,
	"exit_timestamp" bigint,
	"exit_tx_signature" text,
	"exit_reason" text,
	"realized_pnl_lamports" bigint,
	"fees_earned_x_lamports" bigint,
	"fees_earned_y_lamports" bigint,
	"tx_cost_lamports" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_position_id_unique" UNIQUE("position_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"entry_score_threshold" double precision NOT NULL,
	"min_volume_24h" double precision NOT NULL,
	"min_liquidity" double precision NOT NULL,
	"max_liquidity" double precision NOT NULL,
	"position_size_sol" double precision NOT NULL,
	"max_concurrent_positions" integer NOT NULL,
	"profit_target_percent" double precision NOT NULL,
	"stop_loss_percent" double precision NOT NULL,
	"max_hold_time_minutes" integer NOT NULL,
	"cooldown_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"position_id" text,
	"event" text NOT NULL,
	"details" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"seal_wallet_address" text,
	"display_name" text,
	"setup_completed" boolean DEFAULT false NOT NULL,
	"exec_mode" text,
	"auth_nonce" text,
	"auth_nonce_expires_at" integer,
	"refresh_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_bot_id_bots_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("bot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_presets" ADD CONSTRAINT "strategy_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_log" ADD CONSTRAINT "trade_log_bot_id_bots_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("bot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_log" ADD CONSTRAINT "trade_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_bot_id_idx" ON "bots" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bots_user_id_idx" ON "bots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bots_status_idx" ON "bots" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_position_id_idx" ON "positions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "positions_bot_id_idx" ON "positions" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "positions_user_id_idx" ON "positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "positions_status_idx" ON "positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "positions_pool_address_idx" ON "positions" USING btree ("pool_address");--> statement-breakpoint
CREATE INDEX "positions_on_chain_key_idx" ON "positions" USING btree ("on_chain_position_key");--> statement-breakpoint
CREATE INDEX "strategy_presets_user_id_idx" ON "strategy_presets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trade_log_bot_id_idx" ON "trade_log" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "trade_log_user_id_idx" ON "trade_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trade_log_timestamp_idx" ON "trade_log" USING btree ("timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "users_wallet_address_idx" ON "users" USING btree ("wallet_address");