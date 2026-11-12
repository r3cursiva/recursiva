-- Issues move between projects of a workspace (PLNR-448): the keys an issue had before a move keep finding it, and a
-- project's Timeline finds the issues moved out of it through the move's before-values.
ALTER TABLE "issue" ADD COLUMN "former_keys" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "issue_moved_idx" ON "issue" USING btree ("workspace_id") WHERE "issue"."former_keys" <> '{}';--> statement-breakpoint
CREATE INDEX "sync_action_moved_out_idx" ON "sync_action" USING btree ("workspace_id",("prev" ->> 'projectId')) WHERE "sync_action"."model" = 'Issue' and "sync_action"."prev" ? 'projectId';