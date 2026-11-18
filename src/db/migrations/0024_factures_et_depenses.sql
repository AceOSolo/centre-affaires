CREATE TABLE `crm_invoices` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`connector` enum('dolibarr') NOT NULL,
	`external_id` varchar(64) NOT NULL,
	`client_id` char(36) NOT NULL,
	`number` varchar(64) NOT NULL,
	`kind` enum('invoice','credit_note') NOT NULL DEFAULT 'invoice',
	`status` enum('unpaid','paid','cancelled') NOT NULL,
	`issued_on` date NOT NULL,
	`due_on` date,
	`total_excl_tax_cents` int NOT NULL,
	`total_incl_tax_cents` int NOT NULL,
	`amount_due_cents` int,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`pdf_url` varchar(1000),
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`removed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `crm_invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `crm_invoices_external_key` UNIQUE(`tenant_id`,`connector`,`external_id`),
	CONSTRAINT `crm_invoices_external_id_not_blank` CHECK(trim(`crm_invoices`.`external_id`) <> ''),
	CONSTRAINT `crm_invoices_number_not_blank` CHECK(trim(`crm_invoices`.`number`) <> ''),
	CONSTRAINT `crm_invoices_amounts_valid` CHECK(`crm_invoices`.`total_excl_tax_cents` >= 0 and `crm_invoices`.`total_incl_tax_cents` >= 0 and (`crm_invoices`.`amount_due_cents` is null or `crm_invoices`.`amount_due_cents` between 0 and `crm_invoices`.`total_incl_tax_cents`)),
	CONSTRAINT `crm_invoices_paid_nothing_due` CHECK(`crm_invoices`.`status` <> 'paid' or `crm_invoices`.`amount_due_cents` is null or `crm_invoices`.`amount_due_cents` = 0),
	CONSTRAINT `crm_invoices_due_after_issue` CHECK(`crm_invoices`.`due_on` is null or `crm_invoices`.`due_on` >= `crm_invoices`.`issued_on`),
	CONSTRAINT `crm_invoices_currency_format` CHECK(REGEXP_LIKE(`crm_invoices`.`currency`, '^[A-Z]{3}$', 'c')),
	CONSTRAINT `crm_invoices_pdf_url_https` CHECK(`crm_invoices`.`pdf_url` is null or `crm_invoices`.`pdf_url` like 'https://%')
);
--> statement-breakpoint
CREATE TABLE `client_expense_settings` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`show_expenses` boolean NOT NULL DEFAULT true,
	`estimate_mail_acts` boolean NOT NULL DEFAULT true,
	`history_months` tinyint NOT NULL DEFAULT 12,
	`note` varchar(300),
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `client_expense_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_expense_settings_tenant_key` UNIQUE(`tenant_id`),
	CONSTRAINT `client_expense_settings_history_months_valid` CHECK(`client_expense_settings`.`history_months` between 1 and 24),
	CONSTRAINT `client_expense_settings_note_not_blank` CHECK(`client_expense_settings`.`note` is null or trim(`client_expense_settings`.`note`) <> '')
);
--> statement-breakpoint
ALTER TABLE `crm_exchanges` MODIFY COLUMN `flow` enum('quotes','products','third_parties','contracts','consumptions','invoices');--> statement-breakpoint
ALTER TABLE `crm_invoices` ADD CONSTRAINT `crm_invoices_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `crm_invoices` ADD CONSTRAINT `crm_invoices_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_expense_settings` ADD CONSTRAINT `client_expense_settings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_expense_settings` ADD CONSTRAINT `client_expense_settings_updated_by_staff_members_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `crm_invoices_client_idx` ON `crm_invoices` (`tenant_id`,`client_id`,`issued_on`);