CREATE TABLE `crm_links` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`connector` enum('dolibarr') NOT NULL,
	`entity` enum('client','contact','contract') NOT NULL,
	`local_id` char(36) NOT NULL,
	`external_id` varchar(64) NOT NULL,
	`external_ref` varchar(64),
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`removed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`live` tinyint GENERATED ALWAYS AS (if(removed_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `crm_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `crm_links_external_key` UNIQUE(`tenant_id`,`connector`,`entity`,`external_id`),
	CONSTRAINT `crm_links_local_key` UNIQUE(`tenant_id`,`connector`,`entity`,`local_id`,`live`),
	CONSTRAINT `crm_links_external_id_not_blank` CHECK(trim(`crm_links`.`external_id`) <> '')
);
--> statement-breakpoint
CREATE TABLE `crm_consumptions` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`nature` enum('booking','mail_opening','mail_pages','mail_scan','mail_forward') NOT NULL,
	`source_id` char(36) NOT NULL,
	`client_id` char(36) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`quantity` int NOT NULL,
	`unit` enum('hour','half_day','day','week','month','unit'),
	`product_ref` varchar(100),
	`description` varchar(500) NOT NULL,
	`unit_price_cents` int,
	`discount_bp` int,
	`discount_amount_cents` int,
	`vat_rate_bp` int,
	`amount_cents` int,
	`fees_cents` int,
	`currency` char(3),
	`details` json NOT NULL,
	`fingerprint` char(64) NOT NULL,
	`status` enum('ready','sent','cancelled') NOT NULL DEFAULT 'ready',
	`crm_id` varchar(64),
	`crm_ref` varchar(64),
	`sent_at` datetime(3),
	`cancelled_at` datetime(3),
	`cancellation_reason` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`live` tinyint GENERATED ALWAYS AS (if(status <> 'cancelled', 1, null)) VIRTUAL,
	CONSTRAINT `crm_consumptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `crm_consumptions_source_key` UNIQUE(`tenant_id`,`nature`,`source_id`,`live`),
	CONSTRAINT `crm_consumptions_quantity_positive` CHECK(`crm_consumptions`.`quantity` > 0),
	CONSTRAINT `crm_consumptions_amounts_valid` CHECK((`crm_consumptions`.`unit_price_cents` is null or `crm_consumptions`.`unit_price_cents` >= 0) and (`crm_consumptions`.`amount_cents` is null or `crm_consumptions`.`amount_cents` >= 0) and (`crm_consumptions`.`fees_cents` is null or `crm_consumptions`.`fees_cents` >= 0) and (`crm_consumptions`.`vat_rate_bp` is null or `crm_consumptions`.`vat_rate_bp` between 0 and 10000)),
	CONSTRAINT `crm_consumptions_status_consistent` CHECK((`crm_consumptions`.`status` = 'ready' and `crm_consumptions`.`crm_id` is null and `crm_consumptions`.`sent_at` is null and `crm_consumptions`.`cancelled_at` is null)
        or (`crm_consumptions`.`status` = 'sent' and `crm_consumptions`.`crm_id` is not null and `crm_consumptions`.`sent_at` is not null and `crm_consumptions`.`cancelled_at` is null)
        or (`crm_consumptions`.`status` = 'cancelled' and `crm_consumptions`.`cancelled_at` is not null and (`crm_consumptions`.`crm_id` is null) = (`crm_consumptions`.`sent_at` is null))),
	CONSTRAINT `crm_consumptions_fingerprint_format` CHECK(REGEXP_LIKE(`crm_consumptions`.`fingerprint`, '^[0-9a-f]{64}$', 'c'))
);
--> statement-breakpoint
ALTER TABLE `crm_connections` ADD `consumptions_from` date;--> statement-breakpoint
ALTER TABLE `crm_links` ADD CONSTRAINT `crm_links_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `crm_consumptions` ADD CONSTRAINT `crm_consumptions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `crm_consumptions` ADD CONSTRAINT `crm_consumptions_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `crm_links_local_idx` ON `crm_links` (`tenant_id`,`entity`,`local_id`);--> statement-breakpoint
CREATE INDEX `crm_consumptions_status_idx` ON `crm_consumptions` (`tenant_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `crm_consumptions_client_idx` ON `crm_consumptions` (`tenant_id`,`client_id`,`occurred_at`);