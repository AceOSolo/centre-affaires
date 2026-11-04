CREATE TABLE `crm_connections` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`connector` enum('dolibarr') NOT NULL DEFAULT 'dolibarr',
	`base_url` varchar(500),
	`inbound_token_hash` char(64),
	`inbound_token_set_at` datetime(3),
	`inbound_token_set_by` char(36),
	`outbound_key_sealed` text,
	`outbound_key_set_at` datetime(3),
	`enabled_flows` json NOT NULL DEFAULT (JSON_ARRAY('quotes', 'products')),
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `crm_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `crm_connections_tenant_key` UNIQUE(`tenant_id`),
	CONSTRAINT `crm_connections_inbound_token_key` UNIQUE(`inbound_token_hash`),
	CONSTRAINT `crm_connections_token_hash_format` CHECK(`crm_connections`.`inbound_token_hash` is null or REGEXP_LIKE(`crm_connections`.`inbound_token_hash`, '^[0-9a-f]{64}$', 'c')),
	CONSTRAINT `crm_connections_token_traced` CHECK((`crm_connections`.`inbound_token_hash` is null) = (`crm_connections`.`inbound_token_set_at` is null)),
	CONSTRAINT `crm_connections_key_traced` CHECK((`crm_connections`.`outbound_key_sealed` is null) = (`crm_connections`.`outbound_key_set_at` is null)),
	CONSTRAINT `crm_connections_base_url_https` CHECK(`crm_connections`.`base_url` is null or `crm_connections`.`base_url` like 'https://%'),
	CONSTRAINT `crm_connections_enabled_flows_array` CHECK(JSON_TYPE(`crm_connections`.`enabled_flows`) = 'ARRAY')
);
--> statement-breakpoint
CREATE TABLE `crm_exchanges` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`connector` enum('dolibarr') NOT NULL,
	`direction` enum('inbound','outbound') NOT NULL,
	`flow` enum('quotes','products','third_parties','contracts','consumptions'),
	`operation` varchar(120) NOT NULL,
	`status_code` smallint,
	`ok` boolean NOT NULL,
	`message` varchar(500),
	`credential` enum('screen','server'),
	`duration_ms` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `crm_exchanges_id` PRIMARY KEY(`id`),
	CONSTRAINT `crm_exchanges_status_code_valid` CHECK(`crm_exchanges`.`status_code` is null or `crm_exchanges`.`status_code` between 100 and 599),
	CONSTRAINT `crm_exchanges_duration_valid` CHECK(`crm_exchanges`.`duration_ms` >= 0),
	CONSTRAINT `crm_exchanges_inbound_complete` CHECK((`crm_exchanges`.`direction` = 'inbound' and `crm_exchanges`.`credential` is not null and `crm_exchanges`.`flow` is not null and `crm_exchanges`.`status_code` is not null) or (`crm_exchanges`.`direction` = 'outbound' and `crm_exchanges`.`credential` is null))
);
--> statement-breakpoint
ALTER TABLE `crm_connections` ADD CONSTRAINT `crm_connections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `crm_connections` ADD CONSTRAINT `crm_connections_inbound_token_set_by_staff_members_id_fk` FOREIGN KEY (`inbound_token_set_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `crm_connections` ADD CONSTRAINT `crm_connections_updated_by_staff_members_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `crm_exchanges` ADD CONSTRAINT `crm_exchanges_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `crm_exchanges_tenant_created_idx` ON `crm_exchanges` (`tenant_id`,`created_at`);