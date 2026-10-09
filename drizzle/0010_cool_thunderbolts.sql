ALTER TABLE `users` ADD `signup_bonus_granted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verify_bonus_granted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `welcome_seen_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_tx_bonus_once_idx` ON `balance_tx` (`user_id`,`type`) WHERE "balance_tx"."type" IN ('signup_bonus', 'email_verify_bonus');