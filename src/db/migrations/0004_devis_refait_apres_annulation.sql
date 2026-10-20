ALTER TABLE `proposals` ADD `live` tinyint GENERATED ALWAYS AS (if(status <> 'cancelled', 1, null)) VIRTUAL;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_tenant_booking_live_key` UNIQUE(`tenant_id`,`booking_id`,`live`);--> statement-breakpoint
ALTER TABLE `proposals` DROP INDEX `proposals_tenant_booking_key`;