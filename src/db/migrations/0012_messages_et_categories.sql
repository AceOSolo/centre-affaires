CREATE TABLE `mail_member_categories` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`client_member_id` char(36) NOT NULL,
	`name` varchar(40) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_member_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_member_categories_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_member_categories_owner_key` UNIQUE(`tenant_id`,`client_id`,`client_member_id`,`id`),
	CONSTRAINT `mail_member_categories_name_key` UNIQUE(`tenant_id`,`client_member_id`,`name`),
	CONSTRAINT `mail_member_categories_name_valid` CHECK(trim(`mail_member_categories`.`name`) <> '' and char_length(`mail_member_categories`.`name`) <= 40)
);
--> statement-breakpoint
CREATE TABLE `client_broadcast_recipients` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`broadcast_id` char(36) NOT NULL,
	`client_id` char(36) NOT NULL,
	`status` enum('pending','sent','failed','not_configured','skipped') NOT NULL DEFAULT 'pending',
	`address_count` int NOT NULL DEFAULT 0,
	`failed_count` int NOT NULL DEFAULT 0,
	`error` varchar(500),
	`claim_token` char(36),
	`claimed_at` datetime(3),
	`processed_at` datetime(3),
	CONSTRAINT `client_broadcast_recipients_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_broadcast_recipients_client_key` UNIQUE(`tenant_id`,`broadcast_id`,`client_id`),
	CONSTRAINT `client_broadcast_recipients_processed` CHECK((`client_broadcast_recipients`.`status` = 'pending') = (`client_broadcast_recipients`.`processed_at` is null)),
	CONSTRAINT `client_broadcast_recipients_counts` CHECK(`client_broadcast_recipients`.`address_count` >= 0 and `client_broadcast_recipients`.`failed_count` >= 0 and `client_broadcast_recipients`.`failed_count` <= `client_broadcast_recipients`.`address_count`)
);
--> statement-breakpoint
CREATE TABLE `client_broadcasts` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`subject` varchar(150) NOT NULL,
	`body` text NOT NULL,
	`target` enum('domiciliation','bureaux','selection') NOT NULL,
	`created_by` char(36) NOT NULL,
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `client_broadcasts_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_broadcasts_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `client_broadcasts_text_valid` CHECK(trim(`client_broadcasts`.`subject`) <> '' and char_length(`client_broadcasts`.`subject`) <= 150 and trim(`client_broadcasts`.`body`) <> '' and char_length(`client_broadcasts`.`body`) <= 5000)
);
--> statement-breakpoint
ALTER TABLE `notification_deliveries` MODIFY COLUMN `event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested','mail_batch_received','mail_none','domiciliation_request_submitted','client_broadcast') NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_deliveries` MODIFY COLUMN `related_type` enum('mail_item','mail_request','booking','invoice','contract','inspection','client_member','offer','mail_batch','proposal','client_broadcast');--> statement-breakpoint
ALTER TABLE `notification_preferences` MODIFY COLUMN `category` enum('mail','bookings','invoices','contracts','inspections','mail_none','centre_info') NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_templates` MODIFY COLUMN `event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested','mail_batch_received','mail_none','domiciliation_request_submitted','client_broadcast') NOT NULL;--> statement-breakpoint
ALTER TABLE `mail_item_member_states` ADD `custom_category_id` char(36);--> statement-breakpoint
ALTER TABLE `mail_member_categories` ADD CONSTRAINT `mail_member_categories_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_member_categories` ADD CONSTRAINT `mail_member_categories_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_broadcast_recipients` ADD CONSTRAINT `client_broadcast_recipients_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_broadcast_recipients` ADD CONSTRAINT `client_broadcast_recipients_broadcast_fk` FOREIGN KEY (`tenant_id`,`broadcast_id`) REFERENCES `client_broadcasts`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_broadcast_recipients` ADD CONSTRAINT `client_broadcast_recipients_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_broadcasts` ADD CONSTRAINT `client_broadcasts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_broadcasts` ADD CONSTRAINT `client_broadcasts_created_by_staff_members_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `client_broadcast_recipients_status_idx` ON `client_broadcast_recipients` (`tenant_id`,`broadcast_id`,`status`);--> statement-breakpoint
CREATE INDEX `client_broadcasts_recent_idx` ON `client_broadcasts` (`tenant_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `mail_item_member_states` ADD CONSTRAINT `mail_item_member_states_one_category` CHECK (`mail_item_member_states`.`category` is null or `mail_item_member_states`.`custom_category_id` is null);--> statement-breakpoint
ALTER TABLE `mail_item_member_states` ADD CONSTRAINT `mail_item_member_states_custom_category_fk` FOREIGN KEY (`tenant_id`,`client_id`,`client_member_id`,`custom_category_id`) REFERENCES `mail_member_categories`(`tenant_id`,`client_id`,`client_member_id`,`id`) ON DELETE restrict ON UPDATE no action;