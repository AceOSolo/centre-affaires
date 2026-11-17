CREATE TABLE `mail_category_defaults` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`category` enum('impots','social','banque','assurances','fournisseurs','clients','juridique','administration','publicite','autre') NOT NULL,
	`name` varchar(40),
	`hidden` boolean NOT NULL DEFAULT false,
	`position` smallint,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_category_defaults_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_category_defaults_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_category_defaults_category_key` UNIQUE(`tenant_id`,`category`),
	CONSTRAINT `mail_category_defaults_name_valid` CHECK(`mail_category_defaults`.`name` is null or (trim(`mail_category_defaults`.`name`) <> '' and char_length(`mail_category_defaults`.`name`) <= 40)),
	CONSTRAINT `mail_category_defaults_position_valid` CHECK(`mail_category_defaults`.`position` is null or `mail_category_defaults`.`position` >= 0)
);
--> statement-breakpoint
CREATE TABLE `mail_forward_addresses` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`label` varchar(60),
	`recipient` varchar(120) NOT NULL,
	`line1` varchar(120) NOT NULL,
	`line2` varchar(120),
	`postal_code` varchar(16) NOT NULL,
	`city` varchar(80) NOT NULL,
	`country` char(2) NOT NULL,
	`is_default` boolean NOT NULL DEFAULT false,
	`default_live` tinyint GENERATED ALWAYS AS (if(is_default, 1, null)) VIRTUAL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_forward_addresses_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_forward_addresses_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_forward_addresses_default_key` UNIQUE(`tenant_id`,`client_id`,`default_live`),
	CONSTRAINT `mail_forward_addresses_complete` CHECK(trim(`mail_forward_addresses`.`recipient`) <> '' and trim(`mail_forward_addresses`.`line1`) <> ''
        and trim(`mail_forward_addresses`.`postal_code`) <> '' and trim(`mail_forward_addresses`.`city`) <> ''),
	CONSTRAINT `mail_forward_addresses_label_valid` CHECK(`mail_forward_addresses`.`label` is null or trim(`mail_forward_addresses`.`label`) <> '')
);
--> statement-breakpoint
CREATE TABLE `mail_member_category_prefs` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`client_member_id` char(36) NOT NULL,
	`category` enum('impots','social','banque','assurances','fournisseurs','clients','juridique','administration','publicite','autre') NOT NULL,
	`name` varchar(40),
	`hidden` boolean,
	`position` smallint,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_member_category_prefs_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_member_category_prefs_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_member_category_prefs_member_key` UNIQUE(`tenant_id`,`client_member_id`,`category`),
	CONSTRAINT `mail_member_category_prefs_name_valid` CHECK(`mail_member_category_prefs`.`name` is null or (trim(`mail_member_category_prefs`.`name`) <> '' and char_length(`mail_member_category_prefs`.`name`) <= 40)),
	CONSTRAINT `mail_member_category_prefs_position_valid` CHECK(`mail_member_category_prefs`.`position` is null or `mail_member_category_prefs`.`position` >= 0)
);
--> statement-breakpoint
ALTER TABLE `mail_item_member_states` ADD `ignored_at` datetime(3);--> statement-breakpoint
ALTER TABLE `mail_member_categories` ADD `position` smallint;--> statement-breakpoint
ALTER TABLE `mail_member_categories` ADD `hidden` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mail_category_defaults` ADD CONSTRAINT `mail_category_defaults_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_forward_addresses` ADD CONSTRAINT `mail_forward_addresses_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_forward_addresses` ADD CONSTRAINT `mail_forward_addresses_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_member_category_prefs` ADD CONSTRAINT `mail_member_category_prefs_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_member_category_prefs` ADD CONSTRAINT `mail_member_category_prefs_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;