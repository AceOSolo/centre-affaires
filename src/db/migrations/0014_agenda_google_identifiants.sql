CREATE TABLE `google_oauth_clients` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` varchar(255) NOT NULL,
	`client_secret_sealed` text NOT NULL,
	`updated_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `google_oauth_clients_id` PRIMARY KEY(`id`),
	CONSTRAINT `google_oauth_clients_tenant_key` UNIQUE(`tenant_id`)
);
--> statement-breakpoint
ALTER TABLE `google_oauth_clients` ADD CONSTRAINT `google_oauth_clients_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `google_oauth_clients` ADD CONSTRAINT `google_oauth_clients_updated_by_staff_members_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;