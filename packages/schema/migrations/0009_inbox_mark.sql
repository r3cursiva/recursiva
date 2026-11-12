CREATE TABLE "inbox_mark" (
	"user_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"read_id" bigint DEFAULT 0 NOT NULL,
	"archived_id" bigint DEFAULT 0 NOT NULL,
	"snoozed_id" bigint DEFAULT 0 NOT NULL,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_mark_user_id_issue_id_pk" PRIMARY KEY("user_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_mark" ADD CONSTRAINT "inbox_mark_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_mark" ADD CONSTRAINT "inbox_mark_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_mark" ADD CONSTRAINT "inbox_mark_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_mark_user_id_workspace_id_updated_at_index" ON "inbox_mark" USING btree ("user_id","workspace_id","updated_at");