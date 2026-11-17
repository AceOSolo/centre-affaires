ALTER TABLE `tenants` ADD `email_logo` json;--> statement-breakpoint
ALTER TABLE `tenants` ADD `email_signature` varchar(600);--> statement-breakpoint
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_email_signature_valid` CHECK (`tenants`.`email_signature` is null or trim(`tenants`.`email_signature`) <> '');--> statement-breakpoint
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_email_logo_valid` CHECK (`tenants`.`email_logo` is null or json_type(`tenants`.`email_logo`) = 'OBJECT');