CREATE TABLE `staff_notification_reads` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`notification_id` char(36) NOT NULL,
	`staff_member_id` char(36) NOT NULL,
	`read_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `staff_notification_reads_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_notification_reads_member_key` UNIQUE(`tenant_id`,`staff_member_id`,`notification_id`)
);
--> statement-breakpoint
CREATE TABLE `staff_notifications` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`kind` enum('booking_request','quote_request','domiciliation_request','offer_request','mail_request','inspection_signed') NOT NULL,
	`client_id` char(36),
	`related_id` char(36) NOT NULL,
	`summary` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `staff_notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_notifications_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `staff_notifications_event_key` UNIQUE(`tenant_id`,`kind`,`related_id`),
	CONSTRAINT `staff_notifications_summary_not_blank` CHECK(trim(`staff_notifications`.`summary`) <> '')
);
--> statement-breakpoint
ALTER TABLE `staff_notification_reads` ADD CONSTRAINT `staff_notification_reads_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_notification_reads` ADD CONSTRAINT `staff_notification_reads_staff_member_id_staff_members_id_fk` FOREIGN KEY (`staff_member_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_notification_reads` ADD CONSTRAINT `staff_notification_reads_notification_fk` FOREIGN KEY (`tenant_id`,`notification_id`) REFERENCES `staff_notifications`(`tenant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_notifications` ADD CONSTRAINT `staff_notifications_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_notifications` ADD CONSTRAINT `staff_notifications_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `staff_notifications_recent_idx` ON `staff_notifications` (`tenant_id`,`created_at`);