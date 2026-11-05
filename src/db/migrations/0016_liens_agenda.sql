CREATE TABLE `calendar_feeds` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_id` char(36) NOT NULL,
	`created_by` char(36) NOT NULL,
	`last_fetched_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `calendar_feeds_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_feeds_resource_key` UNIQUE(`tenant_id`,`resource_id`)
);
--> statement-breakpoint
ALTER TABLE `calendar_feeds` ADD CONSTRAINT `calendar_feeds_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_feeds` ADD CONSTRAINT `calendar_feeds_created_by_staff_members_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_feeds` ADD CONSTRAINT `calendar_feeds_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;