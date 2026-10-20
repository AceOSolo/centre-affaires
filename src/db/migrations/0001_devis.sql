CREATE TABLE `proposal_lines` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`proposal_id` char(36) NOT NULL,
	`position` int NOT NULL,
	`source` enum('booking','service','manual') NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`unit` enum('hour','half_day','day','week','month','unit') NOT NULL,
	`quantity` int NOT NULL,
	`unit_price_cents` int NOT NULL,
	`discount_bp` int,
	`discount_amount_cents` int,
	`amount_cents` int GENERATED ALWAYS AS ((sign(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(NULL, 1))) * ((2 * abs(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(NULL, 1))) + (10000 * coalesce(NULL, 1))) div (2 * (10000 * coalesce(NULL, 1)))))) STORED,
	`vat_rate_bp` int NOT NULL,
	`resource_id` char(36),
	`service_id` char(36),
	`rate_plan_item_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `proposal_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `proposal_lines_label_not_blank` CHECK(trim(`proposal_lines`.`label`) <> ''),
	CONSTRAINT `proposal_lines_values_valid` CHECK(`proposal_lines`.`quantity` > 0 and `proposal_lines`.`unit_price_cents` >= 0 and `proposal_lines`.`vat_rate_bp` between 0 and 10000
        and (`proposal_lines`.`discount_bp` is not null) + (`proposal_lines`.`discount_amount_cents` is not null) <= 1
        and (`proposal_lines`.`discount_bp` is null or `proposal_lines`.`discount_bp` between 0 and 10000)
        and (`proposal_lines`.`discount_amount_cents` is null or `proposal_lines`.`discount_amount_cents` >= 0)
        and `proposal_lines`.`amount_cents` >= 0),
	CONSTRAINT `proposal_lines_service_source` CHECK((`proposal_lines`.`source` = 'service') = (`proposal_lines`.`service_id` is not null))
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`number` varchar(32) NOT NULL,
	`product` enum('espace','vehicule','domiciliation') NOT NULL,
	`status` enum('draft','ready','sent','accepted','refused','cancelled') NOT NULL DEFAULT 'draft',
	`channel` enum('staff','client','public') NOT NULL,
	`client_id` char(36),
	`requester_name` text,
	`requester_email` varchar(320),
	`requester_phone` varchar(40),
	`requester_company` text,
	`booking_id` char(36),
	`answers` json NOT NULL,
	`message` text,
	`staff_note` text,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`validated_at` datetime(3),
	`validated_by_staff_id` char(36),
	`dolibarr_id` varchar(64),
	`dolibarr_ref` varchar(64),
	`sent_at` datetime(3),
	`outcome_at` datetime(3),
	`cancelled_at` datetime(3),
	`cancellation_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `proposals_id` PRIMARY KEY(`id`),
	CONSTRAINT `proposals_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `proposals_tenant_number_key` UNIQUE(`tenant_id`,`number`),
	CONSTRAINT `proposals_tenant_booking_key` UNIQUE(`tenant_id`,`booking_id`),
	CONSTRAINT `proposals_booking_matches_product` CHECK((`proposals`.`product` = 'domiciliation') = (`proposals`.`booking_id` is null)),
	CONSTRAINT `proposals_has_recipient` CHECK(`proposals`.`client_id` is not null or (`proposals`.`requester_email` is not null and trim(`proposals`.`requester_email`) <> '')),
	CONSTRAINT `proposals_sent_has_reference` CHECK(`proposals`.`sent_at` is null or `proposals`.`dolibarr_id` is not null),
	CONSTRAINT `proposals_status_dates` CHECK((`proposals`.`status` in ('draft') or `proposals`.`validated_at` is not null or `proposals`.`status` = 'cancelled')
        and (`proposals`.`status` not in ('sent', 'accepted', 'refused') or `proposals`.`sent_at` is not null)
        and ((`proposals`.`status` in ('accepted', 'refused')) = (`proposals`.`outcome_at` is not null))
        and ((`proposals`.`status` = 'cancelled') = (`proposals`.`cancelled_at` is not null)))
);
--> statement-breakpoint
ALTER TABLE `document_sequences` MODIFY COLUMN `document_type` enum('contract','invoice','credit_note','proposal') NOT NULL;--> statement-breakpoint
ALTER TABLE `proposal_lines` ADD CONSTRAINT `proposal_lines_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposal_lines` ADD CONSTRAINT `proposal_lines_proposal_fk` FOREIGN KEY (`tenant_id`,`proposal_id`) REFERENCES `proposals`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposal_lines` ADD CONSTRAINT `proposal_lines_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposal_lines` ADD CONSTRAINT `proposal_lines_service_fk` FOREIGN KEY (`tenant_id`,`service_id`) REFERENCES `services`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposal_lines` ADD CONSTRAINT `proposal_lines_rate_plan_item_fk` FOREIGN KEY (`tenant_id`,`rate_plan_item_id`) REFERENCES `rate_plan_items`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_validated_by_staff_id_staff_members_id_fk` FOREIGN KEY (`validated_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_booking_fk` FOREIGN KEY (`tenant_id`,`booking_id`) REFERENCES `bookings`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `proposal_lines_proposal_idx` ON `proposal_lines` (`tenant_id`,`proposal_id`,`position`);--> statement-breakpoint
CREATE INDEX `proposals_tenant_status_idx` ON `proposals` (`tenant_id`,`status`,`updated_at`);