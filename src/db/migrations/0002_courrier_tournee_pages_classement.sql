CREATE TABLE `mail_batches` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`opened_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`opened_by` char(36) NOT NULL,
	`closed_at` datetime(3),
	`closed_by` char(36),
	`open_live` tinyint GENERATED ALWAYS AS (if(closed_at is null, 1, null)) VIRTUAL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_batches_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_batches_open_key` UNIQUE(`tenant_id`,`open_live`),
	CONSTRAINT `mail_batches_closing_complete` CHECK((`mail_batches`.`closed_at` is null) = (`mail_batches`.`closed_by` is null)),
	CONSTRAINT `mail_batches_closed_after_opened` CHECK(`mail_batches`.`closed_at` is null or `mail_batches`.`closed_at` >= `mail_batches`.`opened_at`)
);
--> statement-breakpoint
CREATE TABLE `mail_item_member_states` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`mail_item_id` char(36) NOT NULL,
	`client_member_id` char(36) NOT NULL,
	`read_at` datetime(3),
	`handled_at` datetime(3),
	`category` enum('impots','social','banque','assurances','fournisseurs','clients','juridique','administration','publicite','autre'),
	`tags` json NOT NULL DEFAULT (JSON_ARRAY()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_item_member_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_item_member_states_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_item_member_states_member_key` UNIQUE(`tenant_id`,`mail_item_id`,`client_member_id`),
	CONSTRAINT `mail_item_member_states_tags_valid` CHECK(json_type(`mail_item_member_states`.`tags`) = 'ARRAY' and json_length(`mail_item_member_states`.`tags`) <= 10)
);
--> statement-breakpoint
ALTER TABLE `invoice_lines` DROP CONSTRAINT `invoice_lines_one_mail_source`;--> statement-breakpoint
ALTER TABLE `notification_deliveries` MODIFY COLUMN `event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested','mail_batch_received','mail_none') NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_deliveries` MODIFY COLUMN `related_type` enum('mail_item','mail_request','booking','invoice','contract','inspection','client_member','offer','mail_batch');--> statement-breakpoint
ALTER TABLE `notification_preferences` MODIFY COLUMN `category` enum('mail','bookings','invoices','contracts','inspections','mail_none') NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_templates` MODIFY COLUMN `event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested','mail_batch_received','mail_none') NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `mail_opening_included_pages` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `mail_scan_id` char(36);--> statement-breakpoint
ALTER TABLE `mail_items` ADD `batch_id` char(36);--> statement-breakpoint
ALTER TABLE `mail_scans` ADD `page_count` smallint;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_mail_scan_key` UNIQUE(`tenant_id`,`mail_scan_id`,`held_live`);--> statement-breakpoint
ALTER TABLE `mail_batches` ADD CONSTRAINT `mail_batches_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_batches` ADD CONSTRAINT `mail_batches_opened_by_staff_members_id_fk` FOREIGN KEY (`opened_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_batches` ADD CONSTRAINT `mail_batches_closed_by_staff_members_id_fk` FOREIGN KEY (`closed_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_item_member_states` ADD CONSTRAINT `mail_item_member_states_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_item_member_states` ADD CONSTRAINT `mail_item_member_states_mail_item_fk` FOREIGN KEY (`tenant_id`,`mail_item_id`,`client_id`) REFERENCES `mail_items`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_item_member_states` ADD CONSTRAINT `mail_item_member_states_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mail_batches_closed_idx` ON `mail_batches` (`tenant_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `mail_item_member_states_member_idx` ON `mail_item_member_states` (`tenant_id`,`client_member_id`,`category`);--> statement-breakpoint
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_mail_included_pages_valid` CHECK (`tenants`.`mail_opening_included_pages` between 0 and 1000);--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_one_mail_source` CHECK ((`invoice_lines`.`mail_item_id` is not null) + (`invoice_lines`.`mail_request_id` is not null) + (`invoice_lines`.`mail_scan_id` is not null) <= 1);--> statement-breakpoint
ALTER TABLE `mail_scans` ADD CONSTRAINT `mail_scans_page_count_valid` CHECK (`mail_scans`.`page_count` is null or (`mail_scans`.`side` = 'content' and `mail_scans`.`page_count` between 1 and 1000));--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_mail_scan_fk` FOREIGN KEY (`tenant_id`,`mail_scan_id`) REFERENCES `mail_scans`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_items` ADD CONSTRAINT `mail_items_batch_fk` FOREIGN KEY (`tenant_id`,`batch_id`) REFERENCES `mail_batches`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mail_items_batch_idx` ON `mail_items` (`tenant_id`,`batch_id`,`client_id`);