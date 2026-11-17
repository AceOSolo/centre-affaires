CREATE TABLE `questionnaires` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`form` enum('salle','bureau','vehicule','materiel','domiciliation') NOT NULL,
	`label` varchar(120) NOT NULL,
	`description` varchar(300) NOT NULL,
	`questions` json NOT NULL,
	`service_codes` json NOT NULL DEFAULT (json_array()),
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `questionnaires_id` PRIMARY KEY(`id`),
	CONSTRAINT `questionnaires_tenant_form_key` UNIQUE(`tenant_id`,`form`),
	CONSTRAINT `questionnaires_label_not_blank` CHECK(trim(`questionnaires`.`label`) <> ''),
	CONSTRAINT `questionnaires_questions_array` CHECK(json_type(`questionnaires`.`questions`) = 'ARRAY'),
	CONSTRAINT `questionnaires_service_codes_array` CHECK(json_type(`questionnaires`.`service_codes`) = 'ARRAY')
);
--> statement-breakpoint
ALTER TABLE `proposals` ADD `described_answers` json;--> statement-breakpoint
ALTER TABLE `questionnaires` ADD CONSTRAINT `questionnaires_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `questionnaires` ADD CONSTRAINT `questionnaires_updated_by_staff_members_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;