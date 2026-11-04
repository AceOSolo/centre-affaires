ALTER TABLE `resources` MODIFY COLUMN `resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres','materiel') NOT NULL;--> statement-breakpoint
ALTER TABLE `offer_items` MODIFY COLUMN `resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres','materiel');--> statement-breakpoint
ALTER TABLE `rate_plan_items` MODIFY COLUMN `resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres','materiel') NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` MODIFY COLUMN `product` enum('espace','vehicule','domiciliation','materiel') NOT NULL;--> statement-breakpoint
ALTER TABLE `contract_lines` MODIFY COLUMN `resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres','materiel');--> statement-breakpoint
ALTER TABLE `inspection_templates` MODIFY COLUMN `resource_type` enum('salle','bureau','casier','vehicule','boite_aux_lettres','materiel') NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `parent_booking_id` char(36);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_parent_consistent` CHECK (`bookings`.`parent_booking_id` is null or (`bookings`.`parent_booking_id` <> `bookings`.`id` and `bookings`.`kind` = 'booking'));--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_parent_fk` FOREIGN KEY (`tenant_id`,`parent_booking_id`) REFERENCES `bookings`(`tenant_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `bookings_parent_idx` ON `bookings` (`tenant_id`,`parent_booking_id`);