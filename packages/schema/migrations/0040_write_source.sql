-- Where a change or a comment was made when not in the app or the API: "telegram", "email" (PLNR-369). Nullable, so an
-- older image keeps writing without it and a rollback needs nothing.
ALTER TABLE "comment" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "sync_action" ADD COLUMN "via" text;