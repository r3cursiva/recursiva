-- RSVA-577: a project's home is everyone's, one page per project, and the default home is the rest. Homes a person
-- kept for themselves ("Only me") are no longer read: they are deleted as views are, so clients hear they are gone.
UPDATE "saved_view" SET "deleted_at" = clock_timestamp(), "updated_at" = clock_timestamp()
WHERE "layout" = 'home' AND NOT "shared" AND "deleted_at" IS NULL;
