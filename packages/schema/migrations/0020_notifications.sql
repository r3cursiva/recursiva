CREATE TABLE "notify_cursor" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"last_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"action_id" bigint NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event" text NOT NULL,
	"by_id" uuid,
	"comment_id" uuid,
	"state_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "notifications" jsonb;--> statement-breakpoint
ALTER TABLE "notify_cursor" ADD CONSTRAINT "notify_cursor_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notify_outbox_user_id_workspace_id_action_id_channel_index" ON "notify_outbox" USING btree ("user_id","workspace_id","action_id","channel");--> statement-breakpoint
CREATE INDEX "notify_outbox_due_at_index" ON "notify_outbox" USING btree ("due_at") WHERE "notify_outbox"."status" = 'pending';