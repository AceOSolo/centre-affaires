CREATE TABLE `tenants` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`name` text NOT NULL,
	`slug` varchar(100) NOT NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'Europe/Paris',
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`booking_lead_hours` int NOT NULL DEFAULT 0,
	`booking_horizon_days` int NOT NULL DEFAULT 90,
	`tagline` text,
	`legal_name` text,
	`address_line1` text,
	`address_line2` text,
	`postal_code` text,
	`city` text,
	`country` char(2) NOT NULL DEFAULT 'FR',
	`phone` text,
	`email` text,
	`website_url` text,
	`logo_path` text,
	`logo_light_path` text,
	`hero_image_path` text,
	`social_links` json NOT NULL DEFAULT (JSON_ARRAY()),
	`mail_scan_retention_months` int NOT NULL DEFAULT 12,
	`mail_access_log_retention_months` int NOT NULL DEFAULT 12,
	`public_request_retention_months` int NOT NULL DEFAULT 12,
	`prospect_retention_months` int NOT NULL DEFAULT 36,
	`client_retention_months` int NOT NULL DEFAULT 60,
	`removed_member_retention_months` int NOT NULL DEFAULT 12,
	`notification_log_retention_months` int NOT NULL DEFAULT 12,
	`inspection_photo_retention_months` int NOT NULL DEFAULT 36,
	`inspection_access_log_retention_months` int NOT NULL DEFAULT 12,
	`legal_form` text,
	`share_capital_cents` bigint,
	`siren` text,
	`siret` text,
	`vat_number` text,
	`rcs_city` text,
	`bank_iban` text,
	`bank_bic` text,
	`sepa_creditor_id` text,
	`default_payment_method` enum('transfer','direct_debit','other') NOT NULL DEFAULT 'transfer',
	`prorata_rule` enum('calendar_days','thirty_day_month','none') NOT NULL DEFAULT 'calendar_days',
	`started_unit_tolerance_minutes` int NOT NULL DEFAULT 0,
	`half_day_minutes` int NOT NULL DEFAULT 240,
	`default_vat_rate_bp` int NOT NULL DEFAULT 2000,
	`invoice_payment_terms_days` int NOT NULL DEFAULT 30,
	`recurring_billing_timing` enum('in_advance','in_arrears') NOT NULL DEFAULT 'in_advance',
	`vat_on_debits` boolean NOT NULL DEFAULT false,
	`late_payment_penalty_text` varchar(1000) NOT NULL DEFAULT 'Pénalités de retard : taux d’intérêt appliqué par la Banque centrale européenne à son opération de refinancement la plus récente, majoré de 10 points de pourcentage (art. L. 441-10 du Code de commerce).',
	`recovery_indemnity_cents` int NOT NULL DEFAULT 4000,
	`early_payment_discount_text` varchar(500) NOT NULL DEFAULT 'Pas d’escompte pour paiement anticipé.',
	`invoice_footer_text` text,
	`accounting_sales_journal` varchar(8) NOT NULL DEFAULT 'VE',
	`accounting_bank_journal` varchar(8) NOT NULL DEFAULT 'BQ',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenants_slug_unique` UNIQUE(`slug`),
	CONSTRAINT `tenants_booking_delays_valid` CHECK(`tenants`.`booking_lead_hours` >= 0 and `tenants`.`booking_horizon_days` between 1 and 365 and `tenants`.`booking_lead_hours` < `tenants`.`booking_horizon_days` * 24),
	CONSTRAINT `tenants_mail_retention_valid` CHECK(`tenants`.`mail_scan_retention_months` between 1 and 120 and `tenants`.`mail_access_log_retention_months` between 1 and 120),
	CONSTRAINT `tenants_public_request_retention_valid` CHECK(`tenants`.`public_request_retention_months` between 1 and 120),
	CONSTRAINT `tenants_anonymization_retention_valid` CHECK(`tenants`.`prospect_retention_months` between 1 and 120 and `tenants`.`client_retention_months` between 1 and 120 and `tenants`.`removed_member_retention_months` between 1 and 120),
	CONSTRAINT `tenants_notification_retention_valid` CHECK(`tenants`.`notification_log_retention_months` between 1 and 120),
	CONSTRAINT `tenants_inspection_retention_valid` CHECK(`tenants`.`inspection_photo_retention_months` between 1 and 120 and `tenants`.`inspection_access_log_retention_months` between 1 and 120),
	CONSTRAINT `tenants_siren_format` CHECK(`tenants`.`siren` is null or REGEXP_LIKE(`tenants`.`siren`, '^[0-9]{9}$', 'c')),
	CONSTRAINT `tenants_siret_format` CHECK(`tenants`.`siret` is null or (REGEXP_LIKE(`tenants`.`siret`, '^[0-9]{14}$', 'c') and (`tenants`.`siren` is null or left(`tenants`.`siret`, 9) = `tenants`.`siren`))),
	CONSTRAINT `tenants_vat_number_format` CHECK(`tenants`.`vat_number` is null or REGEXP_LIKE(`tenants`.`vat_number`, '^[A-Z]{2}[0-9A-Z]{2,13}$', 'c')),
	CONSTRAINT `tenants_share_capital_positive` CHECK(`tenants`.`share_capital_cents` is null or `tenants`.`share_capital_cents` >= 0),
	CONSTRAINT `tenants_bank_iban_format` CHECK(`tenants`.`bank_iban` is null or REGEXP_LIKE(`tenants`.`bank_iban`, '^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$', 'c')),
	CONSTRAINT `tenants_bank_bic_format` CHECK(`tenants`.`bank_bic` is null or REGEXP_LIKE(`tenants`.`bank_bic`, '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$', 'c')),
	CONSTRAINT `tenants_sepa_creditor_id_format` CHECK(`tenants`.`sepa_creditor_id` is null or REGEXP_LIKE(`tenants`.`sepa_creditor_id`, '^[A-Z]{2}[0-9]{2}[0-9A-Z]{1,31}$', 'c')),
	CONSTRAINT `tenants_pricing_rules_valid` CHECK(`tenants`.`started_unit_tolerance_minutes` between 0 and 59 and `tenants`.`half_day_minutes` between 60 and 720 and `tenants`.`default_vat_rate_bp` between 0 and 10000),
	CONSTRAINT `tenants_invoicing_rules_valid` CHECK(`tenants`.`invoice_payment_terms_days` between 0 and 60 and `tenants`.`recovery_indemnity_cents` >= 0 and trim(`tenants`.`late_payment_penalty_text`) <> '' and trim(`tenants`.`early_payment_discount_text`) <> ''),
	CONSTRAINT `tenants_accounting_journals_valid` CHECK(REGEXP_LIKE(`tenants`.`accounting_sales_journal`, '^[0-9A-Z]{1,8}$', 'c') and REGEXP_LIKE(`tenants`.`accounting_bank_journal`, '^[0-9A-Z]{1,8}$', 'c'))
);
--> statement-breakpoint
CREATE TABLE `staff_members` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`auth_user_id` varchar(255),
	`email` varchar(255) NOT NULL,
	`full_name` varchar(255),
	`role` enum('admin','staff') NOT NULL DEFAULT 'staff',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`anonymized_at` datetime(3),
	`anonymized_by` char(36),
	`anonymization_basis` enum('retention','erasure_request','relationship_ended'),
	`erasure_requested_on` date,
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `staff_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_members_tenant_email_key` UNIQUE(`tenant_id`,`email`,`live`),
	CONSTRAINT `staff_members_auth_user_key` UNIQUE(`auth_user_id`,`live`),
	CONSTRAINT `staff_members_anonymized_removed` CHECK(`staff_members`.`anonymized_at` is null or (`staff_members`.`deleted_at` is not null and `staff_members`.`auth_user_id` is null)),
	CONSTRAINT `staff_members_anonymization_traced` CHECK((`staff_members`.`anonymized_at` is not null or (`staff_members`.`anonymized_by` is null and `staff_members`.`anonymization_basis` is null and `staff_members`.`erasure_requested_on` is null))
    and (`staff_members`.`erasure_requested_on` is null) = (`staff_members`.`anonymization_basis` is null or `staff_members`.`anonymization_basis` <> 'erasure_request')
    and (`staff_members`.`anonymization_basis` is null or (`staff_members`.`anonymized_by` is null) = (`staff_members`.`anonymization_basis` = 'retention')))
);
--> statement-breakpoint
CREATE TABLE `document_sequences` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`document_type` enum('contract','invoice','credit_note') NOT NULL,
	`year` int NOT NULL,
	`last_value` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `document_sequences_id` PRIMARY KEY(`id`),
	CONSTRAINT `document_sequences_series_key` UNIQUE(`tenant_id`,`document_type`,`year`),
	CONSTRAINT `document_sequences_last_value_positive` CHECK(`document_sequences`.`last_value` >= 0),
	CONSTRAINT `document_sequences_year_valid` CHECK(`document_sequences`.`year` between 2000 and 9999)
);
--> statement-breakpoint
CREATE TABLE `closures` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_id` char(36),
	`starts_on` date NOT NULL,
	`ends_on` date NOT NULL,
	`reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `closures_id` PRIMARY KEY(`id`),
	CONSTRAINT `closures_period_ordered` CHECK(`closures`.`ends_on` >= `closures`.`starts_on`)
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_id` char(36) NOT NULL,
	`slug` varchar(191) NOT NULL,
	`headline` varchar(255) NOT NULL,
	`description` text,
	`highlights` json NOT NULL DEFAULT (JSON_ARRAY()),
	`photos` json NOT NULL DEFAULT (JSON_ARRAY()),
	`published_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `listings_id` PRIMARY KEY(`id`),
	CONSTRAINT `listings_tenant_resource_key` UNIQUE(`tenant_id`,`resource_id`),
	CONSTRAINT `listings_tenant_slug_key` UNIQUE(`tenant_id`,`slug`,`live`)
);
--> statement-breakpoint
CREATE TABLE `opening_hours` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_id` char(36),
	`weekday` smallint NOT NULL,
	`opens_at` time NOT NULL,
	`closes_at` time NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`resource_key` char(36) GENERATED ALWAYS AS (coalesce(resource_id, '00000000-0000-0000-0000-000000000000')) VIRTUAL,
	CONSTRAINT `opening_hours_id` PRIMARY KEY(`id`),
	CONSTRAINT `opening_hours_slot_key` UNIQUE(`tenant_id`,`resource_key`,`weekday`,`opens_at`),
	CONSTRAINT `opening_hours_weekday_valid` CHECK(`opening_hours`.`weekday` between 1 and 7),
	CONSTRAINT `opening_hours_range_not_empty` CHECK(`opening_hours`.`closes_at` > `opening_hours`.`opens_at`)
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres') NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`capacity` int,
	`status` enum('active','maintenance','retired') NOT NULL DEFAULT 'active',
	`client_booking_mode` enum('instant','approval','closed') NOT NULL DEFAULT 'approval',
	`photo_path` varchar(512),
	`attributes` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	`locker_numero_key` varchar(100) GENERATED ALWAYS AS (if(resource_type = 'casier' and deleted_at is null, lower(nullif(json_unquote(json_extract(attributes, '$.numero')), 'null')), null)) VIRTUAL,
	CONSTRAINT `resources_id` PRIMARY KEY(`id`),
	CONSTRAINT `resources_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `resources_tenant_code_key` UNIQUE(`tenant_id`,`code`,`live`),
	CONSTRAINT `resources_tenant_locker_numero_key` UNIQUE(`tenant_id`,`locker_numero_key`)
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_id` char(36) NOT NULL,
	`series_id` char(36),
	`kind` varchar(20) NOT NULL DEFAULT 'booking',
	`channel` enum('staff','client','public') NOT NULL,
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3) NOT NULL,
	`status` enum('pending','confirmed','cancelled') NOT NULL DEFAULT 'confirmed',
	`title` text NOT NULL,
	`notes` text,
	`requester_name` text,
	`requester_email` text,
	`requester_phone` text,
	`requester_anonymized_at` datetime(3),
	`client_id` char(36),
	`contract_id` char(36),
	`contract_amendment_id` char(36),
	`quote_unit` enum('hour','half_day','day','week','month','unit'),
	`quote_quantity` int,
	`quote_unit_price_cents` int,
	`quote_discount_bp` int,
	`quote_discount_amount_cents` int,
	`quote_amount_cents` int GENERATED ALWAYS AS ((sign(((quote_quantity * quote_unit_price_cents - coalesce(quote_discount_amount_cents, 0)) * (10000 - coalesce(quote_discount_bp, 0)) * coalesce(NULL, 1))) * ((2 * abs(((quote_quantity * quote_unit_price_cents - coalesce(quote_discount_amount_cents, 0)) * (10000 - coalesce(quote_discount_bp, 0)) * coalesce(NULL, 1))) + (10000 * coalesce(NULL, 1))) div (2 * (10000 * coalesce(NULL, 1)))))) STORED,
	`quote_vat_rate_bp` int,
	`quote_currency` char(3),
	`quote_rate_plan_item_id` char(36),
	`quoted_at` datetime(3),
	`booked_by_member_id` char(36),
	`confirmed_at` datetime(3),
	`confirmed_by_staff_id` char(36),
	`cancelled_at` datetime(3),
	`cancellation_reason` text,
	`cancelled_by_member_id` char(36),
	`cancelled_by_staff_id` char(36),
	`contract_occupation_segment` char(36) GENERATED ALWAYS AS (if(kind = 'contract', coalesce(contract_amendment_id, '00000000-0000-0000-0000-000000000000'), null)) VIRTUAL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `bookings_id` PRIMARY KEY(`id`),
	CONSTRAINT `bookings_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `bookings_tenant_id_client_key` UNIQUE(`tenant_id`,`id`,`client_id`),
	CONSTRAINT `bookings_contract_occupation_key` UNIQUE(`tenant_id`,`contract_id`,`contract_occupation_segment`),
	CONSTRAINT `bookings_booked_by_member_consistent` CHECK(`bookings`.`booked_by_member_id` is null or (`bookings`.`channel` = 'client' and `bookings`.`kind` = 'booking' and `bookings`.`client_id` is not null)),
	CONSTRAINT `bookings_confirmed_by_consistent` CHECK(`bookings`.`confirmed_by_staff_id` is null or `bookings`.`confirmed_at` is not null),
	CONSTRAINT `bookings_cancelled_by_consistent` CHECK((`bookings`.`cancelled_by_member_id` is not null) + (`bookings`.`cancelled_by_staff_id` is not null) = 0 or (`bookings`.`status` = 'cancelled' and (`bookings`.`cancelled_by_member_id` is not null) + (`bookings`.`cancelled_by_staff_id` is not null) = 1 and (`bookings`.`cancelled_by_member_id` is null or `bookings`.`client_id` is not null))),
	CONSTRAINT `bookings_range_not_empty` CHECK(`bookings`.`ends_at` > `bookings`.`starts_at`),
	CONSTRAINT `bookings_kind_valid` CHECK(`bookings`.`kind` in ('booking', 'unavailability', 'contract')),
	CONSTRAINT `bookings_contract_kind_consistent` CHECK(`bookings`.`kind` <> 'contract' or `bookings`.`contract_id` is not null),
	CONSTRAINT `bookings_contract_amendment_kind_consistent` CHECK(`bookings`.`contract_amendment_id` is null or `bookings`.`kind` = 'contract'),
	CONSTRAINT `bookings_quote_complete` CHECK((`bookings`.`quote_unit` is null) + (`bookings`.`quote_quantity` is null) + (`bookings`.`quote_unit_price_cents` is null) + (`bookings`.`quote_vat_rate_bp` is null) + (`bookings`.`quote_currency` is null) + (`bookings`.`quoted_at` is null) in (0, 6)),
	CONSTRAINT `bookings_quote_kind_consistent` CHECK(`bookings`.`kind` = 'booking' or `bookings`.`quoted_at` is null),
	CONSTRAINT `bookings_quote_values_valid` CHECK(`bookings`.`quoted_at` is null or (`bookings`.`quote_quantity` > 0 and `bookings`.`quote_unit_price_cents` >= 0 and `bookings`.`quote_vat_rate_bp` between 0 and 10000 and `bookings`.`quote_amount_cents` >= 0 and (`bookings`.`quote_discount_bp` is not null) + (`bookings`.`quote_discount_amount_cents` is not null) <= 1 and (`bookings`.`quote_discount_bp` is null or `bookings`.`quote_discount_bp` between 0 and 10000) and (`bookings`.`quote_discount_amount_cents` is null or `bookings`.`quote_discount_amount_cents` >= 0))),
	CONSTRAINT `bookings_quote_extras_need_quote` CHECK(`bookings`.`quoted_at` is not null or (`bookings`.`quote_discount_bp` is not null) + (`bookings`.`quote_discount_amount_cents` is not null) + (`bookings`.`quote_rate_plan_item_id` is not null) = 0),
	CONSTRAINT `bookings_cancelled_at_consistent` CHECK((`bookings`.`status` = 'cancelled') = (`bookings`.`cancelled_at` is not null))
);
--> statement-breakpoint
CREATE TABLE `google_calendar_connections` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`google_email` varchar(255) NOT NULL,
	`refresh_token_sealed` text NOT NULL,
	`connected_by` char(36) NOT NULL,
	`last_synced_at` datetime(3),
	`last_error_at` datetime(3),
	`last_error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `google_calendar_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `google_calendar_connections_tenant_key` UNIQUE(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `resource_google_calendars` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_id` char(36) NOT NULL,
	`connection_id` char(36) NOT NULL,
	`calendar_id` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `resource_google_calendars_id` PRIMARY KEY(`id`),
	CONSTRAINT `resource_google_calendars_resource_key` UNIQUE(`tenant_id`,`resource_id`)
);
--> statement-breakpoint
CREATE TABLE `client_contacts` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`full_name` text NOT NULL,
	`job_title` text,
	`email` text,
	`phone` text,
	`is_primary` boolean NOT NULL DEFAULT false,
	`is_billing` boolean NOT NULL DEFAULT false,
	`notes` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`anonymized_at` datetime(3),
	`primary_live` tinyint GENERATED ALWAYS AS (if(is_primary and deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `client_contacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_contacts_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `client_contacts_primary_key` UNIQUE(`tenant_id`,`client_id`,`primary_live`),
	CONSTRAINT `client_contacts_name_not_blank` CHECK(trim(`client_contacts`.`full_name`) <> ''),
	CONSTRAINT `client_contacts_anonymized_archived` CHECK(`client_contacts`.`anonymized_at` is null or `client_contacts`.`deleted_at` is not null)
);
--> statement-breakpoint
CREATE TABLE `client_members` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`auth_user_id` varchar(255),
	`email` varchar(255) NOT NULL,
	`full_name` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`anonymized_at` datetime(3),
	`anonymized_by` char(36),
	`anonymization_basis` enum('retention','erasure_request','relationship_ended'),
	`erasure_requested_on` date,
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `client_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_members_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `client_members_tenant_client_id_key` UNIQUE(`tenant_id`,`client_id`,`id`),
	CONSTRAINT `client_members_client_email_key` UNIQUE(`tenant_id`,`client_id`,`email`,`live`),
	CONSTRAINT `client_members_client_auth_user_key` UNIQUE(`client_id`,`auth_user_id`,`live`),
	CONSTRAINT `client_members_anonymized_removed` CHECK(`client_members`.`anonymized_at` is null or (`client_members`.`deleted_at` is not null and `client_members`.`auth_user_id` is null)),
	CONSTRAINT `client_members_anonymization_traced` CHECK((`client_members`.`anonymized_at` is not null or (`client_members`.`anonymized_by` is null and `client_members`.`anonymization_basis` is null and `client_members`.`erasure_requested_on` is null))
    and (`client_members`.`erasure_requested_on` is null) = (`client_members`.`anonymization_basis` is null or `client_members`.`anonymization_basis` <> 'erasure_request')
    and (`client_members`.`anonymization_basis` is null or (`client_members`.`anonymized_by` is null) = (`client_members`.`anonymization_basis` = 'retention')))
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`name` varchar(255) NOT NULL,
	`legal_form` text,
	`siret` varchar(14),
	`vat_number` text,
	`email` text,
	`phone` text,
	`address_line1` text,
	`address_line2` text,
	`postal_code` text,
	`city` text,
	`country` char(2) NOT NULL DEFAULT 'FR',
	`status` enum('prospect','active','inactive') NOT NULL DEFAULT 'prospect',
	`notes` text,
	`accounting_code` varchar(17),
	`last_contact_on` date,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`anonymized_at` datetime(3),
	`anonymized_by` char(36),
	`anonymization_basis` enum('retention','erasure_request','relationship_ended'),
	`erasure_requested_on` date,
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `clients_id` PRIMARY KEY(`id`),
	CONSTRAINT `clients_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `clients_tenant_accounting_code_key` UNIQUE(`tenant_id`,`accounting_code`,`live`),
	CONSTRAINT `clients_tenant_siret_key` UNIQUE(`tenant_id`,`siret`,`live`),
	CONSTRAINT `clients_anonymized_archived` CHECK(`clients`.`anonymized_at` is null or `clients`.`deleted_at` is not null),
	CONSTRAINT `clients_anonymization_traced` CHECK((`clients`.`anonymized_at` is not null or (`clients`.`anonymized_by` is null and `clients`.`anonymization_basis` is null and `clients`.`erasure_requested_on` is null))
    and (`clients`.`erasure_requested_on` is null) = (`clients`.`anonymization_basis` is null or `clients`.`anonymization_basis` <> 'erasure_request')
    and (`clients`.`anonymization_basis` is null or (`clients`.`anonymized_by` is null) = (`clients`.`anonymization_basis` = 'retention'))),
	CONSTRAINT `clients_accounting_code_format` CHECK(`clients`.`accounting_code` is null or REGEXP_LIKE(`clients`.`accounting_code`, '^[0-9A-Z]{1,17}$', 'c'))
);
--> statement-breakpoint
CREATE TABLE `offer_items` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`offer_id` char(36) NOT NULL,
	`resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres'),
	`resource_id` char(36),
	`service_id` char(36),
	`quantity` int NOT NULL DEFAULT 1,
	`unit` enum('hour','half_day','day','week','month','unit') NOT NULL DEFAULT 'month',
	`price_cents` int,
	`discount_bp` int,
	`discount_amount_cents` int,
	`vat_rate_bp` int,
	`position` smallint NOT NULL DEFAULT 0,
	`label` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `offer_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `offer_items_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `offer_items_label_not_blank` CHECK(`offer_items`.`label` is null or trim(`offer_items`.`label`) <> ''),
	CONSTRAINT `offer_items_one_target` CHECK((`offer_items`.`resource_type` is not null) + (`offer_items`.`resource_id` is not null) + (`offer_items`.`service_id` is not null) = 1),
	CONSTRAINT `offer_items_one_pricing` CHECK((`offer_items`.`price_cents` is not null) + (`offer_items`.`discount_bp` is not null) + (`offer_items`.`discount_amount_cents` is not null) <= 1),
	CONSTRAINT `offer_items_quantity_positive` CHECK(`offer_items`.`quantity` > 0),
	CONSTRAINT `offer_items_amounts_valid` CHECK((`offer_items`.`price_cents` is null or `offer_items`.`price_cents` >= 0) and (`offer_items`.`discount_bp` is null or `offer_items`.`discount_bp` between 0 and 10000) and (`offer_items`.`discount_amount_cents` is null or `offer_items`.`discount_amount_cents` >= 0) and (`offer_items`.`vat_rate_bp` is null or `offer_items`.`vat_rate_bp` between 0 and 10000))
);
--> statement-breakpoint
CREATE TABLE `offers` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`name` text NOT NULL,
	`description` text,
	`billing_period` enum('monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
	`commitment_months` int,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`client_visible` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `offers_id` PRIMARY KEY(`id`),
	CONSTRAINT `offers_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `offers_name_not_blank` CHECK(trim(`offers`.`name`) <> ''),
	CONSTRAINT `offers_commitment_valid` CHECK(`offers`.`commitment_months` is null or `offers`.`commitment_months` between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE `rate_plan_items` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`rate_plan_id` char(36) NOT NULL,
	`resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres') NOT NULL,
	`resource_id` char(36),
	`unit` enum('hour','half_day','day','week','month','unit') NOT NULL,
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	`type_live` tinyint GENERATED ALWAYS AS (if(resource_id is null and deleted_at is null, 1, null)) VIRTUAL,
	`amount_cents` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `rate_plan_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `rate_plan_items_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `rate_plan_items_type_key` UNIQUE(`rate_plan_id`,`resource_type`,`unit`,`type_live`),
	CONSTRAINT `rate_plan_items_resource_key` UNIQUE(`rate_plan_id`,`resource_id`,`unit`,`live`),
	CONSTRAINT `rate_plan_items_amount_positive` CHECK(`rate_plan_items`.`amount_cents` >= 0)
);
--> statement-breakpoint
CREATE TABLE `rate_plans` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`name` text NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`is_default` boolean NOT NULL DEFAULT false,
	`valid_from` date,
	`valid_to` date,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `rate_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `rate_plans_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `rate_plans_validity_ordered` CHECK(`rate_plans`.`valid_to` is null or `rate_plans`.`valid_from` is null or `rate_plans`.`valid_to` >= `rate_plans`.`valid_from`)
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`code` varchar(100),
	`name` text NOT NULL,
	`description` text,
	`nature` enum('package','act') NOT NULL,
	`unit` enum('hour','half_day','day','week','month','unit') NOT NULL,
	`unit_price_cents` int NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`vat_rate_bp` int NOT NULL DEFAULT 2000,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `services_id` PRIMARY KEY(`id`),
	CONSTRAINT `services_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `services_tenant_code_key` UNIQUE(`tenant_id`,`code`,`live`),
	CONSTRAINT `services_code_format` CHECK(`services`.`code` is null or REGEXP_LIKE(`services`.`code`, '^[a-z0-9]+([._-][a-z0-9]+)*$', 'c')),
	CONSTRAINT `services_name_not_blank` CHECK(trim(`services`.`name`) <> ''),
	CONSTRAINT `services_unit_price_positive` CHECK(`services`.`unit_price_cents` >= 0),
	CONSTRAINT `services_vat_rate_valid` CHECK(`services`.`vat_rate_bp` between 0 and 10000),
	CONSTRAINT `services_act_per_unit` CHECK(`services`.`nature` <> 'act' or `services`.`unit` = 'unit')
);
--> statement-breakpoint
CREATE TABLE `accounting_accounts` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`purpose` enum('customers','bank','revenue','vat_collected') NOT NULL,
	`line_kind` enum('rent','booking','package','act','discount','other'),
	`vat_rate_bp` int,
	`account_number` varchar(20) NOT NULL,
	`label` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`line_kind_key` varchar(16) GENERATED ALWAYS AS (ifnull(line_kind, '')) VIRTUAL,
	`vat_rate_key` int GENERATED ALWAYS AS (ifnull(vat_rate_bp, -1)) VIRTUAL,
	CONSTRAINT `accounting_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `accounting_accounts_key` UNIQUE(`tenant_id`,`purpose`,`line_kind_key`,`vat_rate_key`),
	CONSTRAINT `accounting_accounts_target_consistent` CHECK((case `accounting_accounts`.`purpose`
        when 'revenue' then `accounting_accounts`.`line_kind` is not null and `accounting_accounts`.`vat_rate_bp` is null
        when 'vat_collected' then `accounting_accounts`.`vat_rate_bp` is not null and `accounting_accounts`.`line_kind` is null
        else `accounting_accounts`.`line_kind` is null and `accounting_accounts`.`vat_rate_bp` is null
      end) = 1),
	CONSTRAINT `accounting_accounts_vat_rate_valid` CHECK(`accounting_accounts`.`vat_rate_bp` is null or `accounting_accounts`.`vat_rate_bp` between 1 and 10000),
	CONSTRAINT `accounting_accounts_number_format` CHECK(REGEXP_LIKE(`accounting_accounts`.`account_number`, '^[0-9A-Z]{3,20}$', 'c')),
	CONSTRAINT `accounting_accounts_label_not_blank` CHECK(trim(`accounting_accounts`.`label`) <> '')
);
--> statement-breakpoint
CREATE TABLE `accounting_exports` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`format` varchar(16) NOT NULL DEFAULT 'fec',
	`period_start` date NOT NULL,
	`period_end` date NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`file_sha256` char(64) NOT NULL,
	`entry_count` int NOT NULL,
	`generated_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `accounting_exports_id` PRIMARY KEY(`id`),
	CONSTRAINT `accounting_exports_format_known` CHECK(`accounting_exports`.`format` in ('fec')),
	CONSTRAINT `accounting_exports_period_ordered` CHECK(`accounting_exports`.`period_end` >= `accounting_exports`.`period_start`),
	CONSTRAINT `accounting_exports_sha256_format` CHECK(REGEXP_LIKE(`accounting_exports`.`file_sha256`, '^[0-9a-f]{64}$', 'c')),
	CONSTRAINT `accounting_exports_entry_count_positive` CHECK(`accounting_exports`.`entry_count` >= 0),
	CONSTRAINT `accounting_exports_file_name_not_blank` CHECK(trim(`accounting_exports`.`file_name`) <> '')
);
--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`invoice_id` char(36) NOT NULL,
	`position` smallint NOT NULL DEFAULT 0,
	`kind` enum('rent','booking','package','act','discount','other') NOT NULL,
	`description` text NOT NULL,
	`period_start` date,
	`period_end` date,
	`quantity` int NOT NULL DEFAULT 1,
	`unit` enum('hour','half_day','day','week','month','unit'),
	`unit_price_cents` int NOT NULL,
	`discount_bp` int,
	`discount_amount_cents` int,
	`prorata_numerator` int,
	`prorata_denominator` int,
	`net_amount_cents` int GENERATED ALWAYS AS ((sign(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(prorata_numerator, 1))) * ((2 * abs(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(prorata_numerator, 1))) + (10000 * coalesce(prorata_denominator, 1))) div (2 * (10000 * coalesce(prorata_denominator, 1)))))) STORED,
	`vat_rate_bp` int NOT NULL,
	`vat_category` enum('S','Z','E','AE','K','G','O') NOT NULL DEFAULT 'S',
	`vat_exemption_reason` text,
	`vat_amount_cents` int NOT NULL DEFAULT 0,
	`total_amount_cents` int NOT NULL DEFAULT 0,
	`contract_id` char(36),
	`contract_line_id` char(36),
	`booking_id` char(36),
	`subscribed_service_id` char(36),
	`mail_item_id` char(36),
	`mail_request_id` char(36),
	`service_id` char(36),
	`resource_id` char(36),
	`credited_line_id` char(36),
	`released_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`held_live` tinyint GENERATED ALWAYS AS (if(deleted_at is null and released_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `invoice_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_lines_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `invoice_lines_booking_key` UNIQUE(`tenant_id`,`booking_id`,`held_live`),
	CONSTRAINT `invoice_lines_mail_item_key` UNIQUE(`tenant_id`,`mail_item_id`,`held_live`),
	CONSTRAINT `invoice_lines_mail_request_key` UNIQUE(`tenant_id`,`mail_request_id`,`kind`,`held_live`),
	CONSTRAINT `invoice_lines_one_mail_source` CHECK((`invoice_lines`.`mail_item_id` is not null) + (`invoice_lines`.`mail_request_id` is not null) <= 1),
	CONSTRAINT `invoice_lines_description_not_blank` CHECK(trim(`invoice_lines`.`description`) <> ''),
	CONSTRAINT `invoice_lines_quantity_positive` CHECK(`invoice_lines`.`quantity` > 0),
	CONSTRAINT `invoice_lines_period_consistent` CHECK((`invoice_lines`.`period_start` is null) = (`invoice_lines`.`period_end` is null) and (`invoice_lines`.`period_end` is null or `invoice_lines`.`period_end` >= `invoice_lines`.`period_start`)),
	CONSTRAINT `invoice_lines_prorata_valid` CHECK((`invoice_lines`.`prorata_numerator` is null) = (`invoice_lines`.`prorata_denominator` is null) and (`invoice_lines`.`prorata_numerator` is null or (`invoice_lines`.`prorata_numerator` > 0 and `invoice_lines`.`prorata_denominator` >= `invoice_lines`.`prorata_numerator`))),
	CONSTRAINT `invoice_lines_discount_valid` CHECK(((`invoice_lines`.`discount_bp` is not null) + (`invoice_lines`.`discount_amount_cents` is not null)) <= 1 and (`invoice_lines`.`discount_bp` is null or `invoice_lines`.`discount_bp` between 0 and 10000) and (`invoice_lines`.`discount_amount_cents` is null or `invoice_lines`.`discount_amount_cents` >= 0)),
	CONSTRAINT `invoice_lines_unit_price_sign` CHECK((case when `invoice_lines`.`kind` = 'discount' then `invoice_lines`.`unit_price_cents` <= 0 else `invoice_lines`.`unit_price_cents` >= 0 end) = 1),
	CONSTRAINT `invoice_lines_vat_rate_valid` CHECK(`invoice_lines`.`vat_rate_bp` between 0 and 10000),
	CONSTRAINT `invoice_lines_vat_category_consistent` CHECK((case when `invoice_lines`.`vat_category` = 'S' then `invoice_lines`.`vat_rate_bp` > 0 else `invoice_lines`.`vat_rate_bp` = 0 end) = 1),
	CONSTRAINT `invoice_lines_total_consistent` CHECK(`invoice_lines`.`total_amount_cents` = `invoice_lines`.`net_amount_cents` + `invoice_lines`.`vat_amount_cents`),
	CONSTRAINT `invoice_lines_contract_line_needs_contract` CHECK(`invoice_lines`.`contract_line_id` is null or `invoice_lines`.`contract_id` is not null)
);
--> statement-breakpoint
CREATE TABLE `invoice_reminders` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`invoice_id` char(36) NOT NULL,
	`level` smallint NOT NULL,
	`channel` varchar(16) NOT NULL,
	`recipients` json NOT NULL DEFAULT (JSON_ARRAY()),
	`amount_due_cents` int NOT NULL,
	`currency` char(3) NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`sent_by` char(36) NOT NULL,
	`sent_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `invoice_reminders_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_reminders_level_valid` CHECK(`invoice_reminders`.`level` between 1 and 3),
	CONSTRAINT `invoice_reminders_channel_known` CHECK(`invoice_reminders`.`channel` in ('email', 'post')),
	CONSTRAINT `invoice_reminders_recipients_consistent` CHECK((`invoice_reminders`.`channel` = 'email') = (JSON_LENGTH(`invoice_reminders`.`recipients`) > 0)),
	CONSTRAINT `invoice_reminders_amount_positive` CHECK(`invoice_reminders`.`amount_due_cents` > 0)
);
--> statement-breakpoint
CREATE TABLE `invoice_runs` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`period_start` date NOT NULL,
	`period_end` date NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	`created_by` char(36),
	`result` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`running_live` tinyint GENERATED ALWAYS AS (if(status = 'running', 1, null)) VIRTUAL,
	CONSTRAINT `invoice_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_runs_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `invoice_runs_one_running_key` UNIQUE(`tenant_id`,`running_live`),
	CONSTRAINT `invoice_runs_period_ordered` CHECK(`invoice_runs`.`period_end` >= `invoice_runs`.`period_start`),
	CONSTRAINT `invoice_runs_finished_consistent` CHECK((`invoice_runs`.`status` = 'running') = (`invoice_runs`.`finished_at` is null))
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`kind` enum('invoice','credit_note') NOT NULL DEFAULT 'invoice',
	`number` varchar(32),
	`status` enum('draft','issued','partially_paid','paid','cancelled') NOT NULL DEFAULT 'draft',
	`client_id` char(36) NOT NULL,
	`credited_invoice_id` char(36),
	`invoice_run_id` char(36),
	`period_start` date NOT NULL,
	`period_end` date NOT NULL,
	`issue_date` date,
	`issued_at` datetime(3),
	`issued_by` char(36),
	`payment_terms_days` int,
	`due_date` date,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`total_excl_tax_cents` int NOT NULL DEFAULT 0,
	`total_tax_cents` int NOT NULL DEFAULT 0,
	`total_incl_tax_cents` int NOT NULL DEFAULT 0,
	`paid_cents` int NOT NULL DEFAULT 0,
	`credited_cents` int NOT NULL DEFAULT 0,
	`expected_payment_method` enum('transfer','direct_debit','other') NOT NULL DEFAULT 'transfer',
	`sepa_mandate_id` char(36),
	`mandate_reference` varchar(35),
	`buyer_reference` text,
	`notes` text,
	`seller_snapshot` json,
	`buyer_snapshot` json,
	`legal_mentions` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`run_period_live` tinyint GENERATED ALWAYS AS (if(kind = 'invoice' and invoice_run_id is not null and deleted_at is null and status <> 'cancelled', 1, null)) VIRTUAL,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `invoices_tenant_id_client_key` UNIQUE(`tenant_id`,`id`,`client_id`),
	CONSTRAINT `invoices_tenant_number_key` UNIQUE(`tenant_id`,`number`),
	CONSTRAINT `invoices_run_period_key` UNIQUE(`tenant_id`,`client_id`,`period_start`,`period_end`,`run_period_live`),
	CONSTRAINT `invoices_number_on_issue` CHECK((`invoices`.`status` = 'draft') = (`invoices`.`number` is null)),
	CONSTRAINT `invoices_issued_complete` CHECK(`invoices`.`status` = 'draft' or ((`invoices`.`issue_date` is null) + (`invoices`.`issued_at` is null) + (`invoices`.`payment_terms_days` is null) + (`invoices`.`due_date` is null) + (`invoices`.`seller_snapshot` is null) + (`invoices`.`buyer_snapshot` is null) + (`invoices`.`legal_mentions` is null)) = 0),
	CONSTRAINT `invoices_draft_unsettled` CHECK(`invoices`.`status` <> 'draft' or (`invoices`.`paid_cents` = 0 and `invoices`.`credited_cents` = 0)),
	CONSTRAINT `invoices_draft_not_issued` CHECK(`invoices`.`status` <> 'draft' or ((`invoices`.`issue_date` is not null) + (`invoices`.`issued_at` is not null) + (`invoices`.`due_date` is not null) + (`invoices`.`seller_snapshot` is not null) + (`invoices`.`buyer_snapshot` is not null) + (`invoices`.`legal_mentions` is not null) + (`invoices`.`mandate_reference` is not null)) = 0),
	CONSTRAINT `invoices_totals_consistent` CHECK(`invoices`.`total_incl_tax_cents` = `invoices`.`total_excl_tax_cents` + `invoices`.`total_tax_cents`),
	CONSTRAINT `invoices_credit_note_link` CHECK((`invoices`.`kind` = 'credit_note') = (`invoices`.`credited_invoice_id` is not null) and not (`invoices`.`credited_invoice_id` <=> `invoices`.`id`)),
	CONSTRAINT `invoices_credit_note_status` CHECK(`invoices`.`kind` = 'invoice' or (`invoices`.`status` in ('draft', 'issued') and `invoices`.`paid_cents` = 0 and `invoices`.`credited_cents` = 0)),
	CONSTRAINT `invoices_period_ordered` CHECK(`invoices`.`period_end` >= `invoices`.`period_start`),
	CONSTRAINT `invoices_payment_terms_valid` CHECK(`invoices`.`payment_terms_days` is null or `invoices`.`payment_terms_days` between 0 and 60),
	CONSTRAINT `invoices_mandate_for_direct_debit` CHECK(`invoices`.`sepa_mandate_id` is null or `invoices`.`expected_payment_method` = 'direct_debit'),
	CONSTRAINT `invoices_credited_positive` CHECK(`invoices`.`credited_cents` >= 0),
	CONSTRAINT `invoices_status_derived` CHECK(`invoices`.`status` = 'draft' or `invoices`.`status` = (case
        when `invoices`.`kind` = 'credit_note' then 'issued'
        when `invoices`.`total_incl_tax_cents` > 0 and `invoices`.`credited_cents` >= `invoices`.`total_incl_tax_cents` then 'cancelled'
        when `invoices`.`total_incl_tax_cents` - `invoices`.`credited_cents` - `invoices`.`paid_cents` <= 0 then 'paid'
        when `invoices`.`paid_cents` > 0 then 'partially_paid'
        else 'issued'
      end))
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`invoice_id` char(36) NOT NULL,
	`amount_cents` int NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`paid_on` date NOT NULL,
	`method` enum('transfer','direct_debit','other') NOT NULL,
	`reference` text,
	`sepa_mandate_id` char(36),
	`notes` text,
	`recorded_by` char(36) NOT NULL,
	`cancelled_at` datetime(3),
	`cancelled_by` char(36),
	`cancellation_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_amount_not_zero` CHECK(`payments`.`amount_cents` <> 0),
	CONSTRAINT `payments_cancelled_consistent` CHECK((`payments`.`cancelled_at` is null) = (`payments`.`cancelled_by` is null)),
	CONSTRAINT `payments_mandate_for_direct_debit` CHECK(`payments`.`sepa_mandate_id` is null or `payments`.`method` = 'direct_debit')
);
--> statement-breakpoint
CREATE TABLE `sepa_mandates` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`reference` varchar(35) NOT NULL,
	`debtor_name` text NOT NULL,
	`iban_ciphertext` varbinary(512) NOT NULL,
	`iban_key_version` smallint NOT NULL,
	`iban_last4` char(4) NOT NULL,
	`bic` varchar(11),
	`signed_on` date NOT NULL,
	`sequence_type` enum('recurrent','one_off') NOT NULL DEFAULT 'recurrent',
	`status` enum('active','revoked','expired') NOT NULL DEFAULT 'active',
	`revoked_on` date,
	`last_collected_on` date,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`active_live` tinyint GENERATED ALWAYS AS (if(status = 'active' and deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `sepa_mandates_id` PRIMARY KEY(`id`),
	CONSTRAINT `sepa_mandates_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `sepa_mandates_tenant_id_client_key` UNIQUE(`tenant_id`,`id`,`client_id`),
	CONSTRAINT `sepa_mandates_tenant_reference_key` UNIQUE(`tenant_id`,`reference`),
	CONSTRAINT `sepa_mandates_one_active_key` UNIQUE(`tenant_id`,`client_id`,`active_live`),
	CONSTRAINT `sepa_mandates_reference_format` CHECK(REGEXP_LIKE(`sepa_mandates`.`reference`, '^[A-Za-z0-9+?/:().,'' -]{1,35}$', 'c') and trim(`sepa_mandates`.`reference`) <> ''),
	CONSTRAINT `sepa_mandates_debtor_not_blank` CHECK(trim(`sepa_mandates`.`debtor_name`) <> ''),
	CONSTRAINT `sepa_mandates_iban_sealed` CHECK(substring(`sepa_mandates`.`iban_ciphertext`, 1, 4) = x'43414431' and octet_length(`sepa_mandates`.`iban_ciphertext`) >= 49),
	CONSTRAINT `sepa_mandates_key_version_positive` CHECK(`sepa_mandates`.`iban_key_version` > 0),
	CONSTRAINT `sepa_mandates_last4_format` CHECK(REGEXP_LIKE(`sepa_mandates`.`iban_last4`, '^[0-9A-Z]{4}$', 'c')),
	CONSTRAINT `sepa_mandates_bic_format` CHECK(`sepa_mandates`.`bic` is null or REGEXP_LIKE(`sepa_mandates`.`bic`, '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$', 'c')),
	CONSTRAINT `sepa_mandates_revoked_consistent` CHECK((`sepa_mandates`.`status` = 'revoked') = (`sepa_mandates`.`revoked_on` is not null))
);
--> statement-breakpoint
CREATE TABLE `subscribed_services` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`contract_id` char(36),
	`service_id` char(36) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`unit` enum('hour','half_day','day','week','month','unit') NOT NULL,
	`unit_price_cents` int NOT NULL,
	`discount_bp` int,
	`discount_amount_cents` int,
	`net_amount_cents` int GENERATED ALWAYS AS ((sign(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(NULL, 1))) * ((2 * abs(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(NULL, 1))) + (10000 * coalesce(NULL, 1))) div (2 * (10000 * coalesce(NULL, 1)))))) STORED,
	`vat_rate_bp` int NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`included_quantity` int,
	`starts_on` date NOT NULL,
	`ends_on` date,
	`notes` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `subscribed_services_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscribed_services_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `subscribed_services_quantity_positive` CHECK(`subscribed_services`.`quantity` > 0),
	CONSTRAINT `subscribed_services_unit_price_positive` CHECK(`subscribed_services`.`unit_price_cents` >= 0),
	CONSTRAINT `subscribed_services_discount_valid` CHECK(((`subscribed_services`.`discount_bp` is not null) + (`subscribed_services`.`discount_amount_cents` is not null)) <= 1 and (`subscribed_services`.`discount_bp` is null or `subscribed_services`.`discount_bp` between 0 and 10000) and (`subscribed_services`.`discount_amount_cents` is null or `subscribed_services`.`discount_amount_cents` >= 0)),
	CONSTRAINT `subscribed_services_net_positive` CHECK(`subscribed_services`.`net_amount_cents` >= 0),
	CONSTRAINT `subscribed_services_vat_rate_valid` CHECK(`subscribed_services`.`vat_rate_bp` between 0 and 10000),
	CONSTRAINT `subscribed_services_included_positive` CHECK(`subscribed_services`.`included_quantity` is null or `subscribed_services`.`included_quantity` >= 0),
	CONSTRAINT `subscribed_services_period_ordered` CHECK(`subscribed_services`.`ends_on` is null or `subscribed_services`.`ends_on` >= `subscribed_services`.`starts_on`)
);
--> statement-breakpoint
CREATE TABLE `contract_amendments` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`contract_id` char(36) NOT NULL,
	`number` int NOT NULL DEFAULT 0,
	`effective_on` date NOT NULL,
	`status` enum('draft','signed') NOT NULL DEFAULT 'draft',
	`signed_at` datetime(3),
	`reason` text,
	`changes_resource` boolean NOT NULL DEFAULT false,
	`resource_id` char(36),
	`amount_cents` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `contract_amendments_id` PRIMARY KEY(`id`),
	CONSTRAINT `contract_amendments_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `contract_amendments_tenant_contract_id_key` UNIQUE(`tenant_id`,`contract_id`,`id`),
	CONSTRAINT `contract_amendments_number_key` UNIQUE(`contract_id`,`number`),
	CONSTRAINT `contract_amendments_number_positive` CHECK(`contract_amendments`.`number` > 0),
	CONSTRAINT `contract_amendments_signed_consistent` CHECK((`contract_amendments`.`status` = 'signed') = (`contract_amendments`.`signed_at` is not null)),
	CONSTRAINT `contract_amendments_resource_consistent` CHECK(`contract_amendments`.`changes_resource` or `contract_amendments`.`resource_id` is null),
	CONSTRAINT `contract_amendments_amount_positive` CHECK(`contract_amendments`.`amount_cents` is null or `contract_amendments`.`amount_cents` >= 0)
);
--> statement-breakpoint
CREATE TABLE `contract_documents` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`contract_id` char(36) NOT NULL,
	`amendment_id` char(36),
	`version` int NOT NULL DEFAULT 0,
	`snapshot` json NOT NULL,
	`sha256` varchar(64) NOT NULL DEFAULT '',
	`generated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `contract_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `contract_documents_version_key` UNIQUE(`tenant_id`,`contract_id`,`version`),
	CONSTRAINT `contract_documents_version_positive` CHECK(`contract_documents`.`version` > 0),
	CONSTRAINT `contract_documents_sha256_format` CHECK(REGEXP_LIKE(`contract_documents`.`sha256`, '^[0-9a-f]{64}$', 'c'))
);
--> statement-breakpoint
CREATE TABLE `contract_lines` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`contract_id` char(36) NOT NULL,
	`amendment_id` char(36),
	`resource_id` char(36),
	`resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres'),
	`service_id` char(36),
	`offer_id` char(36),
	`offer_item_id` char(36),
	`description` text NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`unit` enum('hour','half_day','day','week','month','unit') NOT NULL DEFAULT 'month',
	`unit_price_cents` int NOT NULL,
	`discount_bp` int,
	`discount_amount_cents` int,
	`vat_rate_bp` int NOT NULL DEFAULT 2000,
	`net_amount_cents` int GENERATED ALWAYS AS ((sign(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(NULL, 1))) * ((2 * abs(((quantity * unit_price_cents - coalesce(discount_amount_cents, 0)) * (10000 - coalesce(discount_bp, 0)) * coalesce(NULL, 1))) + (10000 * coalesce(NULL, 1))) div (2 * (10000 * coalesce(NULL, 1)))))) STORED,
	`is_recurring` boolean NOT NULL DEFAULT true,
	`position` smallint NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `contract_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `contract_lines_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `contract_lines_tenant_contract_id_key` UNIQUE(`tenant_id`,`contract_id`,`id`),
	CONSTRAINT `contract_lines_one_target` CHECK((`contract_lines`.`resource_id` is not null) + (`contract_lines`.`resource_type` is not null) + (`contract_lines`.`service_id` is not null) + (`contract_lines`.`offer_id` is not null) <= 1),
	CONSTRAINT `contract_lines_description_not_blank` CHECK(trim(`contract_lines`.`description`) <> ''),
	CONSTRAINT `contract_lines_quantity_positive` CHECK(`contract_lines`.`quantity` > 0),
	CONSTRAINT `contract_lines_unit_price_positive` CHECK(`contract_lines`.`unit_price_cents` >= 0),
	CONSTRAINT `contract_lines_discount_valid` CHECK((`contract_lines`.`discount_bp` is not null) + (`contract_lines`.`discount_amount_cents` is not null) <= 1 and (`contract_lines`.`discount_bp` is null or `contract_lines`.`discount_bp` between 0 and 10000) and (`contract_lines`.`discount_amount_cents` is null or `contract_lines`.`discount_amount_cents` >= 0)),
	CONSTRAINT `contract_lines_vat_rate_valid` CHECK(`contract_lines`.`vat_rate_bp` between 0 and 10000),
	CONSTRAINT `contract_lines_net_positive` CHECK(`contract_lines`.`net_amount_cents` >= 0)
);
--> statement-breakpoint
CREATE TABLE `contract_renewals` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`contract_id` char(36) NOT NULL,
	`previous_ends_on` date NOT NULL,
	`new_ends_on` date NOT NULL,
	`renewed_on` date NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `contract_renewals_id` PRIMARY KEY(`id`),
	CONSTRAINT `contract_renewals_extends` CHECK(`contract_renewals`.`new_ends_on` > `contract_renewals`.`previous_ends_on`)
);
--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`reference` varchar(64) NOT NULL DEFAULT '@auto',
	`contract_type` enum('domiciliation','bureau','coworking','autre') NOT NULL,
	`status` enum('draft','active','terminated') NOT NULL DEFAULT 'draft',
	`starts_on` date NOT NULL,
	`ends_on` date,
	`billing_period` enum('monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
	`amount_cents` int NOT NULL,
	`currency` char(3) NOT NULL DEFAULT 'EUR',
	`vat_rate_bp` int NOT NULL DEFAULT 2000,
	`offer_id` char(36),
	`commitment_months` int,
	`commitment_ends_on` date GENERATED ALWAYS AS (if(commitment_months is null, null, date_sub(date_add(starts_on, interval commitment_months month), interval 1 day))) STORED,
	`tacit_renewal` boolean NOT NULL DEFAULT false,
	`renewal_months` int,
	`rate_plan_id` char(36),
	`resource_id` char(36),
	`notice_days` int NOT NULL DEFAULT 90,
	`terminated_on` date,
	`termination_reason` text,
	`notes` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `contracts_id` PRIMARY KEY(`id`),
	CONSTRAINT `contracts_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `contracts_tenant_id_client_key` UNIQUE(`tenant_id`,`id`,`client_id`),
	CONSTRAINT `contracts_tenant_reference_key` UNIQUE(`tenant_id`,`reference`,`live`),
	CONSTRAINT `contracts_reference_not_blank` CHECK(trim(`contracts`.`reference`) <> ''),
	CONSTRAINT `contracts_amount_positive` CHECK(`contracts`.`amount_cents` >= 0),
	CONSTRAINT `contracts_notice_positive` CHECK(`contracts`.`notice_days` >= 0),
	CONSTRAINT `contracts_vat_rate_valid` CHECK(`contracts`.`vat_rate_bp` between 0 and 10000),
	CONSTRAINT `contracts_commitment_valid` CHECK(`contracts`.`commitment_months` is null or `contracts`.`commitment_months` between 1 and 120),
	CONSTRAINT `contracts_renewal_consistent` CHECK(`contracts`.`tacit_renewal` = (`contracts`.`renewal_months` is not null) and (`contracts`.`renewal_months` is null or `contracts`.`renewal_months` between 1 and 120)),
	CONSTRAINT `contracts_period_ordered` CHECK(`contracts`.`ends_on` is null or `contracts`.`ends_on` >= `contracts`.`starts_on`),
	CONSTRAINT `contracts_terminated_on_consistent` CHECK((`contracts`.`status` = 'terminated') = (`contracts`.`terminated_on` is not null))
);
--> statement-breakpoint
CREATE TABLE `offer_requests` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`offer_id` char(36) NOT NULL,
	`requested_by_member_id` char(36) NOT NULL,
	`requested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`status` enum('requested','contracted','dismissed') NOT NULL DEFAULT 'requested',
	`contract_id` char(36),
	`closed_at` datetime(3),
	`closed_by_staff_id` char(36),
	`dismissal_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`open_live` tinyint GENERATED ALWAYS AS (if(status = 'requested', 1, null)) VIRTUAL,
	CONSTRAINT `offer_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `offer_requests_open_key` UNIQUE(`tenant_id`,`client_id`,`offer_id`,`open_live`),
	CONSTRAINT `offer_requests_status_consistent` CHECK((`offer_requests`.`status` = 'requested' and `offer_requests`.`contract_id` is null and `offer_requests`.`closed_at` is null and `offer_requests`.`closed_by_staff_id` is null and `offer_requests`.`dismissal_reason` is null)
        or (`offer_requests`.`status` = 'contracted' and `offer_requests`.`contract_id` is not null and `offer_requests`.`closed_at` is not null and `offer_requests`.`dismissal_reason` is null)
        or (`offer_requests`.`status` = 'dismissed' and `offer_requests`.`contract_id` is null and `offer_requests`.`closed_at` is not null)),
	CONSTRAINT `offer_requests_dismissal_reason_length` CHECK(`offer_requests`.`dismissal_reason` is null or char_length(`offer_requests`.`dismissal_reason`) <= 500)
);
--> statement-breakpoint
CREATE TABLE `mail_items` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`kind` enum('lettre','recommande','colis','autre') NOT NULL DEFAULT 'lettre',
	`sender` text,
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`note` text,
	`status` enum('received','opening_requested','opened') NOT NULL DEFAULT 'received',
	`registered_by` char(36),
	`opening_requested_at` datetime(3),
	`opening_requested_by` char(36),
	`opened_at` datetime(3),
	`opened_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`sender_anonymized_at` datetime(3),
	CONSTRAINT `mail_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_items_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_items_tenant_id_client_key` UNIQUE(`tenant_id`,`id`,`client_id`),
	CONSTRAINT `mail_items_sender_anonymized` CHECK(`mail_items`.`sender_anonymized_at` is null or (`mail_items`.`sender` is null and `mail_items`.`note` is null)),
	CONSTRAINT `mail_items_status_consistent` CHECK((`mail_items`.`status` = 'received' and `mail_items`.`opening_requested_at` is null and `mail_items`.`opened_at` is null)
        or (`mail_items`.`status` = 'opening_requested' and `mail_items`.`opening_requested_at` is not null and `mail_items`.`opened_at` is null)
        or (`mail_items`.`status` = 'opened' and `mail_items`.`opened_at` is not null)),
	CONSTRAINT `mail_items_request_complete` CHECK((`mail_items`.`opening_requested_at` is null) = (`mail_items`.`opening_requested_by` is null)),
	CONSTRAINT `mail_items_opening_complete` CHECK((`mail_items`.`opened_at` is null) = (`mail_items`.`opened_by` is null))
);
--> statement-breakpoint
CREATE TABLE `mail_requests` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`mail_item_id` char(36) NOT NULL,
	`client_id` char(36) NOT NULL,
	`kind` enum('open_and_scan','scan','forward') NOT NULL,
	`status` enum('requested','in_progress','done','refused','cancelled') NOT NULL DEFAULT 'requested',
	`pending_live` tinyint GENERATED ALWAYS AS (if(status in ('requested', 'in_progress'), 1, null)) VIRTUAL,
	`requested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`requested_by_member_id` char(36),
	`requested_by_staff_id` char(36),
	`client_note` text,
	`forward_recipient` text,
	`forward_address_line1` text,
	`forward_address_line2` text,
	`forward_postal_code` text,
	`forward_city` text,
	`forward_country` char(2),
	`forward_tracking_number` text,
	`postage_cents` int,
	`postage_currency` char(3),
	`started_at` datetime(3),
	`started_by_staff_id` char(36),
	`completed_at` datetime(3),
	`completed_by_staff_id` char(36),
	`refused_at` datetime(3),
	`refused_by_staff_id` char(36),
	`refusal_reason` text,
	`cancelled_at` datetime(3),
	`cancelled_by_member_id` char(36),
	`cancelled_by_staff_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mail_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_requests_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_requests_tenant_id_item_key` UNIQUE(`tenant_id`,`id`,`mail_item_id`),
	CONSTRAINT `mail_requests_pending_key` UNIQUE(`tenant_id`,`mail_item_id`,`kind`,`pending_live`),
	CONSTRAINT `mail_requests_one_author` CHECK((`mail_requests`.`requested_by_member_id` is not null) + (`mail_requests`.`requested_by_staff_id` is not null) = 1),
	CONSTRAINT `mail_requests_opening_by_client` CHECK(`mail_requests`.`kind` <> 'open_and_scan' or `mail_requests`.`requested_by_member_id` is not null),
	CONSTRAINT `mail_requests_forward_address` CHECK((`mail_requests`.`kind` = 'forward'
        and `mail_requests`.`forward_recipient` is not null and `mail_requests`.`forward_address_line1` is not null
             and `mail_requests`.`forward_postal_code` is not null and `mail_requests`.`forward_city` is not null
             and `mail_requests`.`forward_country` is not null
             and trim(`mail_requests`.`forward_recipient`) <> '' and trim(`mail_requests`.`forward_address_line1`) <> ''
             and trim(`mail_requests`.`forward_postal_code`) <> '' and trim(`mail_requests`.`forward_city`) <> '')
        or (`mail_requests`.`kind` <> 'forward'
             and `mail_requests`.`forward_recipient` is null and `mail_requests`.`forward_address_line1` is null
             and `mail_requests`.`forward_address_line2` is null and `mail_requests`.`forward_postal_code` is null
             and `mail_requests`.`forward_city` is null and `mail_requests`.`forward_country` is null
             and `mail_requests`.`forward_tracking_number` is null)),
	CONSTRAINT `mail_requests_postage_valid` CHECK((`mail_requests`.`postage_cents` is null) = (`mail_requests`.`postage_currency` is null) and (`mail_requests`.`postage_cents` is null or (`mail_requests`.`kind` = 'forward' and `mail_requests`.`status` = 'done' and `mail_requests`.`postage_cents` >= 0))),
	CONSTRAINT `mail_requests_status_consistent` CHECK((`mail_requests`.`started_at` is null) = (`mail_requests`.`started_by_staff_id` is null)
        and (`mail_requests`.`completed_at` is null) = (`mail_requests`.`completed_by_staff_id` is null)
        and (`mail_requests`.`status` = 'done') = (`mail_requests`.`completed_at` is not null)
        and (`mail_requests`.`status` = 'refused') = (`mail_requests`.`refused_at` is not null)
        and (`mail_requests`.`refused_at` is null) = (`mail_requests`.`refusal_reason` is null)
        and (`mail_requests`.`refusal_reason` is null or trim(`mail_requests`.`refusal_reason`) <> '')
        and (`mail_requests`.`refused_by_staff_id` is null or `mail_requests`.`refused_at` is not null)
        and (`mail_requests`.`status` = 'cancelled') = (`mail_requests`.`cancelled_at` is not null)
        and (case when `mail_requests`.`cancelled_at` is null
              then `mail_requests`.`cancelled_by_member_id` is null and `mail_requests`.`cancelled_by_staff_id` is null
              else (`mail_requests`.`cancelled_by_member_id` is not null) + (`mail_requests`.`cancelled_by_staff_id` is not null) = 1 end)
        and (`mail_requests`.`status` <> 'requested' or `mail_requests`.`started_at` is null)
        and (`mail_requests`.`status` <> 'in_progress' or `mail_requests`.`started_at` is not null)
        and (`mail_requests`.`status` <> 'cancelled' or `mail_requests`.`started_at` is null))
);
--> statement-breakpoint
CREATE TABLE `mail_scan_views` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`mail_scan_id` char(36) NOT NULL,
	`viewed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`viewer` varchar(16) NOT NULL,
	`staff_member_id` char(36),
	`client_member_id` char(36),
	`auth_user_id` varchar(255) NOT NULL,
	CONSTRAINT `mail_scan_views_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_scan_views_viewer_consistent` CHECK((`mail_scan_views`.`viewer` = 'staff' and `mail_scan_views`.`staff_member_id` is not null and `mail_scan_views`.`client_member_id` is null)
        or (`mail_scan_views`.`viewer` = 'client' and `mail_scan_views`.`client_member_id` is not null and `mail_scan_views`.`staff_member_id` is null))
);
--> statement-breakpoint
CREATE TABLE `mail_scans` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`mail_item_id` char(36) NOT NULL,
	`side` enum('envelope','content') NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`content_type` varchar(100) NOT NULL,
	`byte_size` int NOT NULL,
	`uploaded_by` char(36),
	`encryption_key_version` smallint,
	`mail_request_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`live_key` char(36) GENERATED ALWAYS AS (if(deleted_at is null, coalesce(mail_request_id, '00000000-0000-0000-0000-000000000000'), null)) VIRTUAL,
	CONSTRAINT `mail_scans_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_scans_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `mail_scans_storage_key_key` UNIQUE(`storage_key`),
	CONSTRAINT `mail_scans_item_side_key` UNIQUE(`mail_item_id`,`side`,`live_key`),
	CONSTRAINT `mail_scans_request_content_only` CHECK(`mail_scans`.`mail_request_id` is null or `mail_scans`.`side` = 'content'),
	CONSTRAINT `mail_scans_content_type_allowed` CHECK(`mail_scans`.`content_type` in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT `mail_scans_byte_size_positive` CHECK(`mail_scans`.`byte_size` > 0),
	CONSTRAINT `mail_scans_encryption_key_version_positive` CHECK(`mail_scans`.`encryption_key_version` is null or `mail_scans`.`encryption_key_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested') NOT NULL,
	`audience` enum('client','centre') NOT NULL,
	`client_id` char(36),
	`recipients` json NOT NULL DEFAULT (JSON_ARRAY()),
	`failed_recipients` json NOT NULL DEFAULT (JSON_ARRAY()),
	`subject` text NOT NULL,
	`status` enum('sent','failed','not_configured','skipped') NOT NULL,
	`error` text,
	`related_type` enum('mail_item','mail_request','booking','invoice','contract','inspection','client_member','offer'),
	`related_id` char(36),
	`sent_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notification_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `notification_deliveries_client_audience` CHECK(`notification_deliveries`.`audience` <> 'client' or `notification_deliveries`.`client_id` is not null),
	CONSTRAINT `notification_deliveries_subject_not_blank` CHECK(trim(`notification_deliveries`.`subject`) <> ''),
	CONSTRAINT `notification_deliveries_status_consistent` CHECK(JSON_CONTAINS(`notification_deliveries`.`recipients`, `notification_deliveries`.`failed_recipients`)
        and case `notification_deliveries`.`status`
          when 'sent' then JSON_LENGTH(`notification_deliveries`.`recipients`) > 0 and JSON_LENGTH(`notification_deliveries`.`failed_recipients`) = 0
          when 'failed' then `notification_deliveries`.`error` is not null and JSON_LENGTH(`notification_deliveries`.`failed_recipients`) > 0
          when 'not_configured' then JSON_LENGTH(`notification_deliveries`.`failed_recipients`) = 0
          when 'skipped' then `notification_deliveries`.`error` is not null and JSON_LENGTH(`notification_deliveries`.`failed_recipients`) = 0
          else false
        end),
	CONSTRAINT `notification_deliveries_related_complete` CHECK((`notification_deliveries`.`related_type` is null) = (`notification_deliveries`.`related_id` is null))
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`client_id` char(36) NOT NULL,
	`client_member_id` char(36) NOT NULL,
	`category` enum('mail','bookings','invoices','contracts','inspections') NOT NULL,
	`enabled` boolean NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notification_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `notification_preferences_member_category_key` UNIQUE(`tenant_id`,`client_member_id`,`category`)
);
--> statement-breakpoint
CREATE TABLE `notification_templates` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`event` enum('mail_received','mail_scanned','mail_request_submitted','mail_request_done','mail_request_refused','booking_request_submitted','booking_request_accepted','booking_request_refused','booking_confirmed','booking_cancelled','invoice_issued','invoice_reminder','contract_activated','inspection_to_sign','inspection_signed','member_invited','offer_requested') NOT NULL,
	`subject` varchar(255) NOT NULL,
	`body` text NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`updated_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notification_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `notification_templates_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `notification_templates_event_key` UNIQUE(`tenant_id`,`event`),
	CONSTRAINT `notification_templates_text_valid` CHECK(trim(`notification_templates`.`subject`) <> '' and char_length(`notification_templates`.`subject`) <= 200 and trim(`notification_templates`.`body`) <> '' and char_length(`notification_templates`.`body`) <= 10000)
);
--> statement-breakpoint
CREATE TABLE `inspection_photo_views` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`photo_id` char(36) NOT NULL,
	`viewed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`viewer` varchar(16) NOT NULL,
	`staff_member_id` char(36),
	`client_member_id` char(36),
	`auth_user_id` varchar(255) NOT NULL,
	CONSTRAINT `inspection_photo_views_id` PRIMARY KEY(`id`),
	CONSTRAINT `inspection_photo_views_viewer_consistent` CHECK((`inspection_photo_views`.`viewer` = 'staff' and `inspection_photo_views`.`staff_member_id` is not null and `inspection_photo_views`.`client_member_id` is null)
        or (`inspection_photo_views`.`viewer` = 'client' and `inspection_photo_views`.`client_member_id` is not null and `inspection_photo_views`.`staff_member_id` is null))
);
--> statement-breakpoint
CREATE TABLE `inspection_photos` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`inspection_id` char(36) NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`encryption_key_version` smallint NOT NULL,
	`content_type` varchar(100) NOT NULL,
	`byte_size` int NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`caption` text,
	`field_id` varchar(64),
	`position` smallint NOT NULL DEFAULT 0,
	`uploaded_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `inspection_photos_id` PRIMARY KEY(`id`),
	CONSTRAINT `inspection_photos_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `inspection_photos_storage_key_key` UNIQUE(`storage_key`),
	CONSTRAINT `inspection_photos_content_type_allowed` CHECK(`inspection_photos`.`content_type` in ('image/jpeg', 'image/webp', 'image/png')),
	CONSTRAINT `inspection_photos_byte_size_valid` CHECK(`inspection_photos`.`byte_size` between 1 and 10485760),
	CONSTRAINT `inspection_photos_dimensions_valid` CHECK(`inspection_photos`.`width` between 1 and 10000 and `inspection_photos`.`height` between 1 and 10000),
	CONSTRAINT `inspection_photos_encryption_key_version_positive` CHECK(`inspection_photos`.`encryption_key_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `inspection_template_versions` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`template_id` char(36) NOT NULL,
	`version` int NOT NULL,
	`name` text NOT NULL,
	`fields` json NOT NULL,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inspection_template_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `inspection_template_versions_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `inspection_template_versions_version_key` UNIQUE(`tenant_id`,`template_id`,`version`),
	CONSTRAINT `inspection_template_versions_version_positive` CHECK(`inspection_template_versions`.`version` >= 1),
	CONSTRAINT `inspection_template_versions_name_not_blank` CHECK(trim(`inspection_template_versions`.`name`) <> '')
);
--> statement-breakpoint
CREATE TABLE `inspection_templates` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres') NOT NULL,
	`name` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`live` tinyint GENERATED ALWAYS AS (if(deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `inspection_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `inspection_templates_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `inspection_templates_type_key` UNIQUE(`tenant_id`,`resource_type`,`live`),
	CONSTRAINT `inspection_templates_name_not_blank` CHECK(trim(`inspection_templates`.`name`) <> '')
);
--> statement-breakpoint
CREATE TABLE `inspections` (
	`id` char(36) NOT NULL DEFAULT (uuid()),
	`tenant_id` char(36) NOT NULL DEFAULT '01999f00-0000-7000-8000-000000000001',
	`kind` enum('entry','exit') NOT NULL,
	`status` enum('draft','closed') NOT NULL DEFAULT 'draft',
	`resource_id` char(36) NOT NULL,
	`client_id` char(36) NOT NULL,
	`booking_id` char(36),
	`contract_id` char(36),
	`entry_inspection_id` char(36),
	`template_version_id` char(36) NOT NULL,
	`performed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`values` json NOT NULL DEFAULT (JSON_OBJECT()),
	`observations` text,
	`created_by` char(36) NOT NULL,
	`closed_at` datetime(3),
	`closed_by` char(36),
	`signed_at` datetime(3),
	`signed_by_member_id` char(36),
	`client_remarks` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`exit_live` tinyint GENERATED ALWAYS AS (if(entry_inspection_id is not null and deleted_at is null, 1, null)) VIRTUAL,
	CONSTRAINT `inspections_id` PRIMARY KEY(`id`),
	CONSTRAINT `inspections_tenant_id_id_key` UNIQUE(`tenant_id`,`id`),
	CONSTRAINT `inspections_tenant_id_client_resource_key` UNIQUE(`tenant_id`,`id`,`client_id`,`resource_id`),
	CONSTRAINT `inspections_exit_per_entry_key` UNIQUE(`tenant_id`,`entry_inspection_id`,`exit_live`),
	CONSTRAINT `inspections_occupation_given` CHECK(`inspections`.`booking_id` is not null or `inspections`.`contract_id` is not null),
	CONSTRAINT `inspections_entry_for_exit` CHECK(`inspections`.`entry_inspection_id` is null or `inspections`.`kind` = 'exit'),
	CONSTRAINT `inspections_values_object` CHECK(json_type(`inspections`.`values`) = 'OBJECT'),
	CONSTRAINT `inspections_client_remarks_length` CHECK(`inspections`.`client_remarks` is null or char_length(`inspections`.`client_remarks`) <= 2000),
	CONSTRAINT `inspections_status_consistent` CHECK((`inspections`.`status` = 'closed') = (`inspections`.`closed_at` is not null)
        and (`inspections`.`closed_at` is null) = (`inspections`.`closed_by` is null)
        and (`inspections`.`signed_at` is null) = (`inspections`.`signed_by_member_id` is null)
        and (`inspections`.`signed_at` is null or `inspections`.`status` = 'closed')
        and (`inspections`.`client_remarks` is null or `inspections`.`signed_at` is not null)
        and (`inspections`.`deleted_at` is null or `inspections`.`status` = 'draft'))
);
--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` varchar(36) NOT NULL,
	`account_id` varchar(255) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` datetime(3),
	`refresh_token_expires_at` datetime(3),
	`scope` text,
	`password` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` varchar(36) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`token` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`ip_address` varchar(64),
	`user_agent` text,
	`user_id` varchar(36) NOT NULL,
	CONSTRAINT `auth_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_sessions_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` varchar(36) NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`value` text NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `staff_members` ADD CONSTRAINT `staff_members_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_members` ADD CONSTRAINT `staff_members_anonymized_by_staff_members_id_fk` FOREIGN KEY (`anonymized_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `document_sequences` ADD CONSTRAINT `document_sequences_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `closures` ADD CONSTRAINT `closures_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `closures` ADD CONSTRAINT `closures_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `listings` ADD CONSTRAINT `listings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `listings` ADD CONSTRAINT `listings_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `opening_hours` ADD CONSTRAINT `opening_hours_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `opening_hours` ADD CONSTRAINT `opening_hours_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `resources` ADD CONSTRAINT `resources_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_confirmed_by_staff_id_staff_members_id_fk` FOREIGN KEY (`confirmed_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_cancelled_by_staff_id_staff_members_id_fk` FOREIGN KEY (`cancelled_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`) REFERENCES `contracts`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_contract_amendment_fk` FOREIGN KEY (`tenant_id`,`contract_id`,`contract_amendment_id`) REFERENCES `contract_amendments`(`tenant_id`,`contract_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_quote_rate_plan_item_fk` FOREIGN KEY (`tenant_id`,`quote_rate_plan_item_id`) REFERENCES `rate_plan_items`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_booked_by_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`booked_by_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_cancelled_by_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`cancelled_by_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `google_calendar_connections` ADD CONSTRAINT `google_calendar_connections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `google_calendar_connections` ADD CONSTRAINT `google_calendar_connections_connected_by_staff_members_id_fk` FOREIGN KEY (`connected_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `resource_google_calendars` ADD CONSTRAINT `resource_google_calendars_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `resource_google_calendars` ADD CONSTRAINT `resource_google_calendars_connection_fk` FOREIGN KEY (`connection_id`) REFERENCES `google_calendar_connections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `resource_google_calendars` ADD CONSTRAINT `resource_google_calendars_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_contacts` ADD CONSTRAINT `client_contacts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_contacts` ADD CONSTRAINT `client_contacts_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_members` ADD CONSTRAINT `client_members_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_members` ADD CONSTRAINT `client_members_anonymized_by_staff_members_id_fk` FOREIGN KEY (`anonymized_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_members` ADD CONSTRAINT `client_members_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clients` ADD CONSTRAINT `clients_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clients` ADD CONSTRAINT `clients_anonymized_by_staff_members_id_fk` FOREIGN KEY (`anonymized_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_items` ADD CONSTRAINT `offer_items_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_items` ADD CONSTRAINT `offer_items_offer_fk` FOREIGN KEY (`tenant_id`,`offer_id`) REFERENCES `offers`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_items` ADD CONSTRAINT `offer_items_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_items` ADD CONSTRAINT `offer_items_service_fk` FOREIGN KEY (`tenant_id`,`service_id`) REFERENCES `services`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offers` ADD CONSTRAINT `offers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rate_plan_items` ADD CONSTRAINT `rate_plan_items_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rate_plan_items` ADD CONSTRAINT `rate_plan_items_plan_fk` FOREIGN KEY (`tenant_id`,`rate_plan_id`) REFERENCES `rate_plans`(`tenant_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rate_plan_items` ADD CONSTRAINT `rate_plan_items_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rate_plans` ADD CONSTRAINT `rate_plans_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `services` ADD CONSTRAINT `services_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accounting_accounts` ADD CONSTRAINT `accounting_accounts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accounting_exports` ADD CONSTRAINT `accounting_exports_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accounting_exports` ADD CONSTRAINT `accounting_exports_generated_by_staff_members_id_fk` FOREIGN KEY (`generated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_invoice_fk` FOREIGN KEY (`tenant_id`,`invoice_id`) REFERENCES `invoices`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`) REFERENCES `contracts`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_contract_line_fk` FOREIGN KEY (`tenant_id`,`contract_id`,`contract_line_id`) REFERENCES `contract_lines`(`tenant_id`,`contract_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_booking_fk` FOREIGN KEY (`tenant_id`,`booking_id`) REFERENCES `bookings`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_subscribed_service_fk` FOREIGN KEY (`tenant_id`,`subscribed_service_id`) REFERENCES `subscribed_services`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_mail_item_fk` FOREIGN KEY (`tenant_id`,`mail_item_id`) REFERENCES `mail_items`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_mail_request_fk` FOREIGN KEY (`tenant_id`,`mail_request_id`) REFERENCES `mail_requests`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_service_fk` FOREIGN KEY (`tenant_id`,`service_id`) REFERENCES `services`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_credited_line_fk` FOREIGN KEY (`tenant_id`,`credited_line_id`) REFERENCES `invoice_lines`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_reminders` ADD CONSTRAINT `invoice_reminders_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_reminders` ADD CONSTRAINT `invoice_reminders_sent_by_staff_members_id_fk` FOREIGN KEY (`sent_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_reminders` ADD CONSTRAINT `invoice_reminders_invoice_fk` FOREIGN KEY (`tenant_id`,`invoice_id`) REFERENCES `invoices`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_runs` ADD CONSTRAINT `invoice_runs_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_runs` ADD CONSTRAINT `invoice_runs_created_by_staff_members_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_issued_by_staff_members_id_fk` FOREIGN KEY (`issued_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_credited_invoice_fk` FOREIGN KEY (`tenant_id`,`credited_invoice_id`,`client_id`) REFERENCES `invoices`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_run_fk` FOREIGN KEY (`tenant_id`,`invoice_run_id`) REFERENCES `invoice_runs`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_sepa_mandate_fk` FOREIGN KEY (`tenant_id`,`sepa_mandate_id`,`client_id`) REFERENCES `sepa_mandates`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_recorded_by_staff_members_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_cancelled_by_staff_members_id_fk` FOREIGN KEY (`cancelled_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoice_fk` FOREIGN KEY (`tenant_id`,`invoice_id`) REFERENCES `invoices`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_sepa_mandate_fk` FOREIGN KEY (`tenant_id`,`sepa_mandate_id`) REFERENCES `sepa_mandates`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sepa_mandates` ADD CONSTRAINT `sepa_mandates_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sepa_mandates` ADD CONSTRAINT `sepa_mandates_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscribed_services` ADD CONSTRAINT `subscribed_services_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscribed_services` ADD CONSTRAINT `subscribed_services_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscribed_services` ADD CONSTRAINT `subscribed_services_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`,`client_id`) REFERENCES `contracts`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscribed_services` ADD CONSTRAINT `subscribed_services_service_fk` FOREIGN KEY (`tenant_id`,`service_id`) REFERENCES `services`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_amendments` ADD CONSTRAINT `contract_amendments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_amendments` ADD CONSTRAINT `contract_amendments_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`) REFERENCES `contracts`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_amendments` ADD CONSTRAINT `contract_amendments_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_generated_by_staff_members_id_fk` FOREIGN KEY (`generated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`) REFERENCES `contracts`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_amendment_fk` FOREIGN KEY (`tenant_id`,`contract_id`,`amendment_id`) REFERENCES `contract_amendments`(`tenant_id`,`contract_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_lines` ADD CONSTRAINT `contract_lines_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_lines` ADD CONSTRAINT `contract_lines_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`) REFERENCES `contracts`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_lines` ADD CONSTRAINT `contract_lines_amendment_fk` FOREIGN KEY (`tenant_id`,`contract_id`,`amendment_id`) REFERENCES `contract_amendments`(`tenant_id`,`contract_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_lines` ADD CONSTRAINT `contract_lines_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_lines` ADD CONSTRAINT `contract_lines_service_fk` FOREIGN KEY (`tenant_id`,`service_id`) REFERENCES `services`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_lines` ADD CONSTRAINT `contract_lines_offer_fk` FOREIGN KEY (`tenant_id`,`offer_id`) REFERENCES `offers`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_lines` ADD CONSTRAINT `contract_lines_offer_item_fk` FOREIGN KEY (`tenant_id`,`offer_item_id`) REFERENCES `offer_items`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_renewals` ADD CONSTRAINT `contract_renewals_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_renewals` ADD CONSTRAINT `contract_renewals_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`) REFERENCES `contracts`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_offer_fk` FOREIGN KEY (`tenant_id`,`offer_id`) REFERENCES `offers`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_rate_plan_fk` FOREIGN KEY (`tenant_id`,`rate_plan_id`) REFERENCES `rate_plans`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_requests` ADD CONSTRAINT `offer_requests_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_requests` ADD CONSTRAINT `offer_requests_closed_by_staff_id_staff_members_id_fk` FOREIGN KEY (`closed_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_requests` ADD CONSTRAINT `offer_requests_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_requests` ADD CONSTRAINT `offer_requests_offer_fk` FOREIGN KEY (`tenant_id`,`offer_id`) REFERENCES `offers`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_requests` ADD CONSTRAINT `offer_requests_requested_by_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`requested_by_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offer_requests` ADD CONSTRAINT `offer_requests_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`,`client_id`) REFERENCES `contracts`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_items` ADD CONSTRAINT `mail_items_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_items` ADD CONSTRAINT `mail_items_registered_by_staff_members_id_fk` FOREIGN KEY (`registered_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_items` ADD CONSTRAINT `mail_items_opened_by_staff_members_id_fk` FOREIGN KEY (`opened_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_items` ADD CONSTRAINT `mail_items_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_items` ADD CONSTRAINT `mail_items_requested_by_fk` FOREIGN KEY (`tenant_id`,`opening_requested_by`) REFERENCES `client_members`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_requested_by_staff_id_staff_members_id_fk` FOREIGN KEY (`requested_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_started_by_staff_id_staff_members_id_fk` FOREIGN KEY (`started_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_completed_by_staff_id_staff_members_id_fk` FOREIGN KEY (`completed_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_refused_by_staff_id_staff_members_id_fk` FOREIGN KEY (`refused_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_cancelled_by_staff_id_staff_members_id_fk` FOREIGN KEY (`cancelled_by_staff_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_mail_item_fk` FOREIGN KEY (`tenant_id`,`mail_item_id`,`client_id`) REFERENCES `mail_items`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_requested_by_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`requested_by_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_requests` ADD CONSTRAINT `mail_requests_cancelled_by_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`cancelled_by_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scan_views` ADD CONSTRAINT `mail_scan_views_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scan_views` ADD CONSTRAINT `mail_scan_views_staff_member_id_staff_members_id_fk` FOREIGN KEY (`staff_member_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scan_views` ADD CONSTRAINT `mail_scan_views_scan_fk` FOREIGN KEY (`tenant_id`,`mail_scan_id`) REFERENCES `mail_scans`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scan_views` ADD CONSTRAINT `mail_scan_views_client_member_fk` FOREIGN KEY (`tenant_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scans` ADD CONSTRAINT `mail_scans_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scans` ADD CONSTRAINT `mail_scans_uploaded_by_staff_members_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scans` ADD CONSTRAINT `mail_scans_mail_item_fk` FOREIGN KEY (`tenant_id`,`mail_item_id`) REFERENCES `mail_items`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_scans` ADD CONSTRAINT `mail_scans_mail_request_fk` FOREIGN KEY (`tenant_id`,`mail_request_id`,`mail_item_id`) REFERENCES `mail_requests`(`tenant_id`,`id`,`mail_item_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_templates` ADD CONSTRAINT `notification_templates_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_templates` ADD CONSTRAINT `notification_templates_updated_by_staff_members_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_photo_views` ADD CONSTRAINT `inspection_photo_views_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_photo_views` ADD CONSTRAINT `inspection_photo_views_staff_member_id_staff_members_id_fk` FOREIGN KEY (`staff_member_id`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_photo_views` ADD CONSTRAINT `inspection_photo_views_photo_fk` FOREIGN KEY (`tenant_id`,`photo_id`) REFERENCES `inspection_photos`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_photo_views` ADD CONSTRAINT `inspection_photo_views_client_member_fk` FOREIGN KEY (`tenant_id`,`client_member_id`) REFERENCES `client_members`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_photos` ADD CONSTRAINT `inspection_photos_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_photos` ADD CONSTRAINT `inspection_photos_uploaded_by_staff_members_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_photos` ADD CONSTRAINT `inspection_photos_inspection_fk` FOREIGN KEY (`tenant_id`,`inspection_id`) REFERENCES `inspections`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_template_versions` ADD CONSTRAINT `inspection_template_versions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_template_versions` ADD CONSTRAINT `inspection_template_versions_created_by_staff_members_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_template_versions` ADD CONSTRAINT `inspection_template_versions_template_fk` FOREIGN KEY (`tenant_id`,`template_id`) REFERENCES `inspection_templates`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_templates` ADD CONSTRAINT `inspection_templates_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_created_by_staff_members_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_closed_by_staff_members_id_fk` FOREIGN KEY (`closed_by`) REFERENCES `staff_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_resource_fk` FOREIGN KEY (`tenant_id`,`resource_id`) REFERENCES `resources`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_client_fk` FOREIGN KEY (`tenant_id`,`client_id`) REFERENCES `clients`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_booking_fk` FOREIGN KEY (`tenant_id`,`booking_id`,`client_id`) REFERENCES `bookings`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_contract_fk` FOREIGN KEY (`tenant_id`,`contract_id`,`client_id`) REFERENCES `contracts`(`tenant_id`,`id`,`client_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_entry_fk` FOREIGN KEY (`tenant_id`,`entry_inspection_id`,`client_id`,`resource_id`) REFERENCES `inspections`(`tenant_id`,`id`,`client_id`,`resource_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_template_version_fk` FOREIGN KEY (`tenant_id`,`template_version_id`) REFERENCES `inspection_template_versions`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_signed_by_member_fk` FOREIGN KEY (`tenant_id`,`client_id`,`signed_by_member_id`) REFERENCES `client_members`(`tenant_id`,`client_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_accounts` ADD CONSTRAINT `auth_accounts_user_id_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `staff_members_tenant_idx` ON `staff_members` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `closures_tenant_period_idx` ON `closures` (`tenant_id`,`starts_on`,`ends_on`);--> statement-breakpoint
CREATE INDEX `listings_tenant_published_idx` ON `listings` (`tenant_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `opening_hours_tenant_weekday_idx` ON `opening_hours` (`tenant_id`,`weekday`);--> statement-breakpoint
CREATE INDEX `resources_tenant_type_idx` ON `resources` (`tenant_id`,`resource_type`);--> statement-breakpoint
CREATE INDEX `bookings_client_starts_at_idx` ON `bookings` (`tenant_id`,`client_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_contract_idx` ON `bookings` (`tenant_id`,`contract_id`);--> statement-breakpoint
CREATE INDEX `bookings_series_idx` ON `bookings` (`tenant_id`,`series_id`);--> statement-breakpoint
CREATE INDEX `bookings_resource_starts_at_idx` ON `bookings` (`resource_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_tenant_starts_at_idx` ON `bookings` (`tenant_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_pending_idx` ON `bookings` (`tenant_id`,`status`,`starts_at`);--> statement-breakpoint
CREATE INDEX `client_contacts_client_idx` ON `client_contacts` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `client_members_tenant_email_idx` ON `client_members` (`tenant_id`,`email`);--> statement-breakpoint
CREATE INDEX `client_members_auth_user_idx` ON `client_members` (`auth_user_id`);--> statement-breakpoint
CREATE INDEX `clients_tenant_name_idx` ON `clients` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX `offer_items_offer_idx` ON `offer_items` (`tenant_id`,`offer_id`);--> statement-breakpoint
CREATE INDEX `services_tenant_nature_idx` ON `services` (`tenant_id`,`nature`);--> statement-breakpoint
CREATE INDEX `accounting_exports_tenant_period_idx` ON `accounting_exports` (`tenant_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice_idx` ON `invoice_lines` (`tenant_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `invoice_lines_resource_idx` ON `invoice_lines` (`tenant_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `invoice_lines_service_idx` ON `invoice_lines` (`tenant_id`,`service_id`);--> statement-breakpoint
CREATE INDEX `invoice_lines_credited_line_idx` ON `invoice_lines` (`tenant_id`,`credited_line_id`);--> statement-breakpoint
CREATE INDEX `invoice_reminders_invoice_idx` ON `invoice_reminders` (`tenant_id`,`invoice_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `invoice_runs_tenant_period_idx` ON `invoice_runs` (`tenant_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `invoices_client_idx` ON `invoices` (`tenant_id`,`client_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `invoices_tenant_issue_date_idx` ON `invoices` (`tenant_id`,`issue_date`);--> statement-breakpoint
CREATE INDEX `invoices_credited_invoice_idx` ON `invoices` (`tenant_id`,`credited_invoice_id`);--> statement-breakpoint
CREATE INDEX `invoices_run_idx` ON `invoices` (`tenant_id`,`invoice_run_id`);--> statement-breakpoint
CREATE INDEX `payments_invoice_idx` ON `payments` (`tenant_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `payments_tenant_paid_on_idx` ON `payments` (`tenant_id`,`paid_on`);--> statement-breakpoint
CREATE INDEX `sepa_mandates_client_idx` ON `sepa_mandates` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `subscribed_services_client_idx` ON `subscribed_services` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `subscribed_services_service_idx` ON `subscribed_services` (`tenant_id`,`service_id`);--> statement-breakpoint
CREATE INDEX `subscribed_services_contract_idx` ON `subscribed_services` (`tenant_id`,`contract_id`);--> statement-breakpoint
CREATE INDEX `contract_amendments_contract_idx` ON `contract_amendments` (`tenant_id`,`contract_id`,`effective_on`);--> statement-breakpoint
CREATE INDEX `contract_lines_contract_idx` ON `contract_lines` (`tenant_id`,`contract_id`);--> statement-breakpoint
CREATE INDEX `contract_renewals_contract_idx` ON `contract_renewals` (`tenant_id`,`contract_id`);--> statement-breakpoint
CREATE INDEX `contracts_tenant_client_idx` ON `contracts` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `contracts_tenant_status_idx` ON `contracts` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `offer_requests_client_idx` ON `offer_requests` (`tenant_id`,`client_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `mail_items_client_received_idx` ON `mail_items` (`tenant_id`,`client_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `mail_items_tenant_received_idx` ON `mail_items` (`tenant_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `mail_items_requested_idx` ON `mail_items` (`tenant_id`,`status`,`opening_requested_at`);--> statement-breakpoint
CREATE INDEX `mail_items_opened_idx` ON `mail_items` (`tenant_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `mail_requests_item_idx` ON `mail_requests` (`tenant_id`,`mail_item_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `mail_requests_client_idx` ON `mail_requests` (`tenant_id`,`client_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `mail_requests_queue_idx` ON `mail_requests` (`tenant_id`,`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `mail_requests_done_idx` ON `mail_requests` (`tenant_id`,`status`,`completed_at`);--> statement-breakpoint
CREATE INDEX `mail_scan_views_scan_idx` ON `mail_scan_views` (`tenant_id`,`mail_scan_id`,`viewed_at`);--> statement-breakpoint
CREATE INDEX `mail_scans_unencrypted_idx` ON `mail_scans` (`tenant_id`,`encryption_key_version`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_sent_idx` ON `notification_deliveries` (`tenant_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_client_idx` ON `notification_deliveries` (`tenant_id`,`client_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_related_idx` ON `notification_deliveries` (`tenant_id`,`related_type`,`related_id`);--> statement-breakpoint
CREATE INDEX `notification_preferences_client_idx` ON `notification_preferences` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `inspection_photo_views_photo_idx` ON `inspection_photo_views` (`tenant_id`,`photo_id`,`viewed_at`);--> statement-breakpoint
CREATE INDEX `inspection_photos_inspection_idx` ON `inspection_photos` (`tenant_id`,`inspection_id`,`position`);--> statement-breakpoint
CREATE INDEX `inspections_client_idx` ON `inspections` (`tenant_id`,`client_id`,`performed_at`);--> statement-breakpoint
CREATE INDEX `inspections_resource_idx` ON `inspections` (`tenant_id`,`resource_id`,`performed_at`);--> statement-breakpoint
CREATE INDEX `inspections_booking_idx` ON `inspections` (`tenant_id`,`booking_id`);--> statement-breakpoint
CREATE INDEX `inspections_contract_idx` ON `inspections` (`tenant_id`,`contract_id`);--> statement-breakpoint
CREATE INDEX `auth_accounts_user_idx` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_verifications_identifier_idx` ON `auth_verifications` (`identifier`);