CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"outcome" text,
	"note" text,
	"error" text,
	"error_fingerprint" text,
	"stop_sync_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_agent_id_user_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_live_index" ON "run" USING btree ("issue_id") WHERE "run"."outcome" is null;--> statement-breakpoint
CREATE INDEX "run_issue_id_stage_created_at_index" ON "run" USING btree ("issue_id","stage","created_at");--> statement-breakpoint
CREATE INDEX "run_workspace_live_index" ON "run" USING btree ("workspace_id") WHERE "run"."outcome" is null;