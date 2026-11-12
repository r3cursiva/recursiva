ALTER TABLE "label" ADD COLUMN "only_people" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_state" ADD COLUMN "only_people" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "member_rights" text[] DEFAULT '{labels.write}' NOT NULL;--> statement-breakpoint
-- The process rules on the row, not a list of names (ADR 0037): the names packages/policy guarded until now, read as its
-- skeleton() read them: compatibility forms folded, spaces, case and lookalike letters as Latin, and the marks and
-- format characters names carry dropped — combining marks (U+0300–036F, 0483–0489, 1AB0–1AFF, 1DC0–1DFF, 20D0–20FF,
-- FE20–FE2F), soft hyphen, U+061C, U+180E, zero-width and direction marks (U+200B–200F, 202A–202E, 2060–206F), U+FEFF
-- and tags (U+E0000–E007F). skeleton() drops every \p{M} and \p{Cf}; SQL has no such classes, so a mark outside these
-- ranges would leave a row the old check guarded unguarded ("TODO ", "Тodo", "T0do", "To‮do" are guarded).
UPDATE "workflow_state" SET "only_people" = true WHERE translate(regexp_replace(lower(normalize(normalize("name", NFKC), NFKD)), '[[:space:]' || chr(768) || '-' || chr(879) || chr(1155) || '-' || chr(1161) || chr(6832) || '-' || chr(6911) || chr(7616) || '-' || chr(7679) || chr(8400) || '-' || chr(8447) || chr(65056) || '-' || chr(65071) || chr(173) || chr(1564) || chr(6158) || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8303) || chr(65279) || chr(917504) || '-' || chr(917631) || ']', '', 'g'), 'аеортвαορτν0', 'aeoptbaoptvo') IN ('todo', 'approved');--> statement-breakpoint
UPDATE "label" SET "only_people" = true WHERE translate(regexp_replace(lower(normalize(normalize("name", NFKC), NFKD)), '[[:space:]' || chr(768) || '-' || chr(879) || chr(1155) || '-' || chr(1161) || chr(6832) || '-' || chr(6911) || chr(7616) || '-' || chr(7679) || chr(8400) || '-' || chr(8447) || chr(65056) || '-' || chr(65071) || chr(173) || chr(1564) || chr(6158) || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8303) || chr(65279) || chr(917504) || '-' || chr(917631) || ']', '', 'g'), 'аеортвαορτν0', 'aeoptbaoptvo') IN ('proposed', 'security', 'owner');--> statement-breakpoint
-- Labels have one level now, Write, as every resource; a token given Create keeps label access as Labels: write.
UPDATE "api_token" SET "grants" = ARRAY(SELECT DISTINCT unnest(array_replace("grants", 'labels.create', 'labels.write'))) WHERE 'labels.create' = ANY("grants");
--> statement-breakpoint
-- An agent's token holds nothing past member now (ADR 0037): the grants an admin lent it above member go from the row,
-- so they do not come back when an admin later opens states or projects to members.
UPDATE "api_token" SET "grants" = ARRAY(SELECT g FROM unnest("grants") g WHERE g NOT IN ('states.write', 'projects.write', 'workspace.write')) WHERE "scope" = 'custom' AND "user_id" IN (SELECT "id" FROM "user" WHERE "kind" = 'agent') AND "grants" && ARRAY['states.write', 'projects.write', 'workspace.write'];
--> statement-breakpoint
-- An agent's role is at most member (capRole, ADR 0037): one stored above it before capRole held lands on member, or
-- its Write token would still reach what only admins do.
UPDATE "member" SET "role" = 'member' WHERE "role" IN ('admin', 'owner') AND "user_id" IN (SELECT "id" FROM "user" WHERE "kind" = 'agent');
