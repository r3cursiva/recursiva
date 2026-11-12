ALTER TABLE "inbox_mark" ADD COLUMN "subscribed" boolean;--> statement-breakpoint
ALTER TABLE "inbox_mark" ADD COLUMN "subscribed_id" bigint DEFAULT 0 NOT NULL;