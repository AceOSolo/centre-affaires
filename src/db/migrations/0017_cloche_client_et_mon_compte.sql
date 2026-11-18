CREATE TABLE `client_bell_settings` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`hidden_events` json NOT NULL DEFAULT (JSON_ARRAY()),
	`window_days` int NOT NULL DEFAULT 30,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `client_bell_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_bell_settings_tenant_key` UNIQUE(`tenant_id`),
	CONSTRAINT `client_bell_settings_window_days` CHECK(`client_bell_settings`.`window_days` between 1 and 90),
	CONSTRAINT `client_bell_settings_hidden_array` CHECK(json_type(`client_bell_settings`.`hidden_events`) = 'ARRAY')
);
--> statement-breakpoint
CREATE TABLE `client_notification_reads` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`client_member_id` char(36) NOT NULL,
	`delivery_id` char(36) NOT NULL,
	`read_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `client_notification_reads_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_notification_reads_member_key` UNIQUE(`tenant_id`,`client_member_id`,`delivery_id`)
);
--> statement-breakpoint
ALTER TABLE `client_members` ADD `phone` varchar(40);--> statement-breakpoint
ALTER TABLE `client_bell_settings` ADD CONSTRAINT `client_bell_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_bell_settings` ADD CONSTRAINT `client_bell_settings_updated_by_staff_members_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_notification_reads` ADD CONSTRAINT `client_notification_reads_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_notification_reads` ADD CONSTRAINT `client_notification_reads_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_notification_reads` ADD CONSTRAINT `client_notification_reads_delivery_fk` FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `client_notification_reads_client_idx` ON `client_notification_reads` (`tenant_id`,`client_id`);--> statement-breakpoint
ALTER TABLE `client_members` ADD CONSTRAINT `client_members_anonymized_no_phone` CHECK (`client_members`.`anonymized_at` is null or `client_members`.`phone` is null);