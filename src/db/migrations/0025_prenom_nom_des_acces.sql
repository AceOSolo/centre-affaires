ALTER TABLE `client_members` ADD `first_name` varchar(100);--> statement-breakpoint
ALTER TABLE `client_members` ADD `last_name` varchar(100);--> statement-breakpoint
ALTER TABLE `client_members` ADD CONSTRAINT `client_members_anonymized_no_names` CHECK (`client_members`.`anonymized_at` is null or (`client_members`.`first_name` is null and `client_members`.`last_name` is null));