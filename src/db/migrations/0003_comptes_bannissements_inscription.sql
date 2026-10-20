CREATE TABLE `account_bans` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`auth_user_id` varchar(36) NOT NULL,
	`reason` text NOT NULL,
	`banned_until` datetime(3),
	`banned_by` char(36) NOT NULL,
	`lifted_at` datetime(3),
	`lifted_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `account_bans_id` PRIMARY KEY(`id`),
	CONSTRAINT `account_bans_lift_traced` CHECK((`account_bans`.`lifted_at` is null) = (`account_bans`.`lifted_by` is null)),
	CONSTRAINT `account_bans_reason_present` CHECK(char_length(trim(`account_bans`.`reason`)) > 0)
);
--> statement-breakpoint
ALTER TABLE `clients` ADD `origin` enum('back_office','inscription') DEFAULT 'back_office' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `company_name` varchar(255);--> statement-breakpoint
ALTER TABLE `account_bans` ADD CONSTRAINT `account_bans_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `account_bans` ADD CONSTRAINT `account_bans_banned_by_staff_members_id_fk` FOREIGN KEY (`banned_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `account_bans` ADD CONSTRAINT `account_bans_lifted_by_staff_members_id_fk` FOREIGN KEY (`lifted_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `account_bans_tenant_user_idx` ON `account_bans` (`tenant_id`,`auth_user_id`);