CREATE TABLE `client_document_kinds` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`code` varchar(40) NOT NULL,
	`label` varchar(120) NOT NULL,
	`help` varchar(300),
	`applies_to` enum('all','creation','registered') NOT NULL DEFAULT 'all',
	`position` smallint NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `client_document_kinds_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_document_kinds_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `client_document_kinds_code_key` UNIQUE(`tenant_id`,`code`),
	CONSTRAINT `client_document_kinds_code_format` CHECK(REGEXP_LIKE(`client_document_kinds`.`code`, '^[a-z0-9-]{1,40}$', 'c')),
	CONSTRAINT `client_document_kinds_label_valid` CHECK(trim(`client_document_kinds`.`label`) <> '')
);
--> statement-breakpoint
CREATE TABLE `client_document_views` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`document_id` char(36) NOT NULL,
	`viewed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`viewer` varchar(16) NOT NULL,
	`staff_member_id` char(36),
	`client_member_id` char(36),
	`auth_user_id` varchar(255) NOT NULL,
	CONSTRAINT `client_document_views_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_document_views_viewer_consistent` CHECK((`client_document_views`.`viewer` = 'staff' and `client_document_views`.`staff_member_id` is not null and `client_document_views`.`client_member_id` is null)
        or (`client_document_views`.`viewer` = 'client' and `client_document_views`.`client_member_id` is not null and `client_document_views`.`staff_member_id` is null))
);
--> statement-breakpoint
CREATE TABLE `client_documents` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`kind_code` varchar(40) NOT NULL,
	`kind_label` varchar(120) NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`encryption_key_version` smallint NOT NULL,
	`content_type` varchar(100) NOT NULL,
	`byte_size` int NOT NULL,
	`status` enum('received','accepted','refused') NOT NULL DEFAULT 'received',
	`refusal_reason` varchar(500),
	`uploaded_by_member_id` char(36) NOT NULL,
	`reviewed_at` datetime(3),
	`reviewed_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `client_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_documents_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `client_documents_storage_key_key` UNIQUE(`storage_key`),
	CONSTRAINT `client_documents_content_type_allowed` CHECK(`client_documents`.`content_type` in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT `client_documents_byte_size_valid` CHECK(`client_documents`.`byte_size` between 1 and 10485760),
	CONSTRAINT `client_documents_encryption_key_version_positive` CHECK(`client_documents`.`encryption_key_version` > 0),
	CONSTRAINT `client_documents_refusal_reason` CHECK((`client_documents`.`status` = 'refused' and `client_documents`.`refusal_reason` is not null and trim(`client_documents`.`refusal_reason`) <> '')
        or (`client_documents`.`status` <> 'refused' and `client_documents`.`refusal_reason` is null)),
	CONSTRAINT `client_documents_review_traced` CHECK((`client_documents`.`status` = 'received' and `client_documents`.`reviewed_at` is null and `client_documents`.`reviewed_by` is null)
        or (`client_documents`.`status` <> 'received' and `client_documents`.`reviewed_at` is not null and `client_documents`.`reviewed_by` is not null))
);
--> statement-breakpoint
ALTER TABLE `notification_deliveries` MODIFY COLUMN `event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested','mail_batch_received','mail_none','domiciliation_request_submitted','client_broadcast','staff_invited','request_received','client_document_received','client_document_refused') NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_deliveries` MODIFY COLUMN `related_type` enum('mail_item','mail_request','booking','invoice','contract','inspection','client_member','offer','mail_batch','proposal','client_broadcast','staff_member','client_document');--> statement-breakpoint
ALTER TABLE `notification_templates` MODIFY COLUMN `event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested','mail_batch_received','mail_none','domiciliation_request_submitted','client_broadcast','staff_invited','request_received','client_document_received','client_document_refused') NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `client_document_retention_months` int DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `refused_client_document_retention_months` int DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `client_document_access_log_retention_months` int DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE `client_document_kinds` ADD CONSTRAINT `client_document_kinds_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_document_kinds` ADD CONSTRAINT `client_document_kinds_updated_by_staff_members_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_document_views` ADD CONSTRAINT `client_document_views_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_document_views` ADD CONSTRAINT `client_document_views_staff_member_id_staff_members_id_fk` FOREIGN KEY (`staff_member_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_document_views` ADD CONSTRAINT `client_document_views_document_fk` FOREIGN KEY (`tenant_id`,`document_id`) REFERENCES `client_documents`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_document_views` ADD CONSTRAINT `client_document_views_client_member_fk` FOREIGN KEY (`tenant_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_documents` ADD CONSTRAINT `client_documents_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_documents` ADD CONSTRAINT `client_documents_reviewed_by_staff_members_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_documents` ADD CONSTRAINT `client_documents_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_documents` ADD CONSTRAINT `client_documents_uploaded_by_fk` FOREIGN KEY (`tenant_id`,`client_id`,`uploaded_by_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `client_document_views_document_idx` ON `client_document_views` (`tenant_id`,`document_id`,`viewed_at`);--> statement-breakpoint
CREATE INDEX `client_documents_client_idx` ON `client_documents` (`tenant_id`,`client_id`,`kind_code`,`created_at`);--> statement-breakpoint
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_client_document_retention_valid` CHECK (`tenants`.`client_document_retention_months` between 1 and 120 and `tenants`.`refused_client_document_retention_months` between 1 and 120 and `tenants`.`client_document_access_log_retention_months` between 1 and 120);