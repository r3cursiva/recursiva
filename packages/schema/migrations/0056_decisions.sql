CREATE TABLE "decision" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"recommended" smallint NOT NULL,
	"evidence" jsonb NOT NULL,
	"close_as" text,
	"undo_state_id" uuid,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topic" text,
	"asked_by_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"answer_option" smallint,
	"answered_by_id" uuid,
	"answered_at" timestamp with time zone,
	"comment_id" uuid,
	"answer_comment_id" uuid,
	"rule_id" uuid,
	"replaced_rule" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"topic" text NOT NULL,
	"answer" text NOT NULL,
	"user_id" uuid NOT NULL,
	"decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_asked_by_id_user_id_fk" FOREIGN KEY ("asked_by_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_answered_by_id_user_id_fk" FOREIGN KEY ("answered_by_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule" ADD CONSTRAINT "decision_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule" ADD CONSTRAINT "decision_rule_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule" ADD CONSTRAINT "decision_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule" ADD CONSTRAINT "decision_rule_decision_id_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_issue_id_index" ON "decision" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "decision_workspace_id_index" ON "decision" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_open_index" ON "decision" USING btree ("issue_id","kind") WHERE "decision"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "decision_rule_project_id_kind_topic_index" ON "decision_rule" USING btree ("project_id","kind","topic");