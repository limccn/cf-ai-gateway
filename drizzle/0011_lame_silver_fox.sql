PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invite_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`created_by` integer,
	`used_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_invite_codes`("id", "code", "created_by", "used_at", "expires_at", "created_at") SELECT "id", "code", "created_by", "used_at", "expires_at", "created_at" FROM `invite_codes`;--> statement-breakpoint
DROP TABLE `invite_codes`;--> statement-breakpoint
ALTER TABLE `__new_invite_codes` RENAME TO `invite_codes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `invite_codes_code_unique` ON `invite_codes` (`code`);--> statement-breakpoint
CREATE INDEX `invite_codes_created_by_idx` ON `invite_codes` (`created_by`);--> statement-breakpoint
CREATE INDEX `invite_codes_code_idx` ON `invite_codes` (`code`);