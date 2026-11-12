ALTER TABLE "project_order" ADD COLUMN "pins" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_order" ADD COLUMN "hidden" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- The views pinned before PLNR-292 open the new list, in the order they were pinned. view_pin stays for a rollback to a
-- server before it; nothing reads it now.
INSERT INTO "project_order" ("user_id", "workspace_id", "ids", "pins")
SELECT p."user_id", p."workspace_id", '{}', array_agg('view:' || p."view_id" ORDER BY p."updated_at")
FROM "view_pin" AS p JOIN "saved_view" AS v ON v."id" = p."view_id"
WHERE p."pinned" AND v."deleted_at" IS NULL
GROUP BY p."user_id", p."workspace_id"
ON CONFLICT ("user_id", "workspace_id") DO UPDATE SET "pins" = EXCLUDED."pins";
