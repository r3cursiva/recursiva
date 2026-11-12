-- A repository is bound to projects by id, not by key (PLNR-454): a key held as text came loose on a rename, and could be
-- taken over by another project. Each key becomes the project of the repository's workspace that has it now, else the one
-- that had it before a rename, as references resolve keys (projectsByKey). A key no project answers to becomes the nil
-- uuid: it reaches nothing, as before, and the repository does not open up to every project. An unbound repository's keys
-- go: `github.ts bind` sets them anew.
ALTER TABLE "github_repo" ADD COLUMN "project_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE "github_repo" r SET "project_ids" = (
	SELECT array_agg(coalesce(
		(SELECT p."id" FROM "project" p WHERE p."workspace_id" = r."workspace_id" AND p."key" = k),
		(SELECT p."id" FROM "project" p WHERE p."workspace_id" = r."workspace_id" AND k = any(p."former_keys") ORDER BY p."id" LIMIT 1),
		'00000000-0000-0000-0000-000000000000'::uuid
	) ORDER BY n)
	FROM unnest(r."project_keys") WITH ORDINALITY AS u(k, n)
) WHERE r."workspace_id" IS NOT NULL AND r."project_keys" <> '{}';--> statement-breakpoint
ALTER TABLE "github_repo" DROP COLUMN "project_keys";
