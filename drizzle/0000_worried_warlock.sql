CREATE TABLE IF NOT EXISTS `bots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`name` text DEFAULT 'My Bot' NOT NULL,
	`mode` text DEFAULT 'simulation' NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`strategy_mode` text DEFAULT 'rule-based' NOT NULL,
	`entry_score_threshold` real DEFAULT 150 NOT NULL,
	`min_volume_24h` real DEFAULT 1000 NOT NULL,
	`min_liquidity` real DEFAULT 100 NOT NULL,
	`max_liquidity` real DEFAULT 1000000 NOT NULL,
	`position_size_sol` real DEFAULT 1 NOT NULL,
	`max_concurrent_positions` integer DEFAULT 5 NOT NULL,
	`default_bin_range` integer DEFAULT 10 NOT NULL,
	`profit_target_percent` real DEFAULT 8 NOT NULL,
	`stop_loss_percent` real DEFAULT 12 NOT NULL,
	`max_hold_time_minutes` integer DEFAULT 240 NOT NULL,
	`max_daily_loss_sol` real DEFAULT 2 NOT NULL,
	`cooldown_minutes` integer DEFAULT 79 NOT NULL,
	`cron_interval_seconds` integer DEFAULT 30 NOT NULL,
	`simulation_balance_sol` real DEFAULT 10 NOT NULL,
	`total_trades` integer DEFAULT 0 NOT NULL,
	`winning_trades` integer DEFAULT 0 NOT NULL,
	`total_pnl_lamports` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_activity_at` text,
	`emergency_stop_state` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `bots_bot_id_unique` ON `bots` (`bot_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`pool_address` text NOT NULL,
	`pool_name` text NOT NULL,
	`token_x_mint` text NOT NULL,
	`token_y_mint` text NOT NULL,
	`bin_step` integer NOT NULL,
	`entry_active_bin_id` integer,
	`entry_price_per_token` text,
	`entry_timestamp` integer NOT NULL,
	`entry_amount_x_lamports` integer DEFAULT 0 NOT NULL,
	`entry_amount_y_lamports` integer DEFAULT 0 NOT NULL,
	`entry_tx_signature` text,
	`entry_score` real,
	`ml_probability` real,
	`entry_features` text,
	`profit_target_percent` real NOT NULL,
	`stop_loss_percent` real NOT NULL,
	`max_hold_time_minutes` integer NOT NULL,
	`current_price_per_token` text,
	`unrealized_pnl_lamports` integer,
	`exit_price_per_token` text,
	`exit_timestamp` integer,
	`exit_tx_signature` text,
	`exit_reason` text,
	`realized_pnl_lamports` integer,
	`fees_earned_x_lamports` integer,
	`fees_earned_y_lamports` integer,
	`tx_cost_lamports` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`bot_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `positions_position_id_unique` ON `positions` (`position_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `strategy_presets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`name` text NOT NULL,
	`description` text,
	`is_system` integer DEFAULT false NOT NULL,
	`entry_score_threshold` real NOT NULL,
	`min_volume_24h` real NOT NULL,
	`min_liquidity` real NOT NULL,
	`max_liquidity` real NOT NULL,
	`position_size_sol` real NOT NULL,
	`max_concurrent_positions` integer NOT NULL,
	`profit_target_percent` real NOT NULL,
	`stop_loss_percent` real NOT NULL,
	`max_hold_time_minutes` integer NOT NULL,
	`cooldown_minutes` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trade_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`position_id` text,
	`event` text NOT NULL,
	`details` text,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`bot_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_address` text NOT NULL,
	`sentinel_wallet_address` text,
	`display_name` text,
	`auth_nonce` text,
	`auth_nonce_expires_at` integer,
	`refresh_token_hash` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_wallet_address_unique` ON `users` (`wallet_address`);