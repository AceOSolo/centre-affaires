ALTER TABLE `inspection_photos` DROP CONSTRAINT `inspection_photos_content_type_allowed`;--> statement-breakpoint
ALTER TABLE `inspection_photos` DROP CONSTRAINT `inspection_photos_dimensions_valid`;--> statement-breakpoint
ALTER TABLE `inspection_photos` MODIFY COLUMN `width` int;--> statement-breakpoint
ALTER TABLE `inspection_photos` MODIFY COLUMN `height` int;--> statement-breakpoint
ALTER TABLE `inspection_photos` ADD CONSTRAINT `inspection_photos_content_type_allowed` CHECK (`inspection_photos`.`content_type` in ('image/jpeg', 'image/webp', 'image/png', 'application/pdf'));--> statement-breakpoint
ALTER TABLE `inspection_photos` ADD CONSTRAINT `inspection_photos_dimensions_valid` CHECK ((`inspection_photos`.`content_type` = 'application/pdf' and `inspection_photos`.`width` is null and `inspection_photos`.`height` is null)
        or (`inspection_photos`.`content_type` <> 'application/pdf' and `inspection_photos`.`width` is not null and `inspection_photos`.`height` is not null
            and `inspection_photos`.`width` between 1 and 10000 and `inspection_photos`.`height` between 1 and 10000));