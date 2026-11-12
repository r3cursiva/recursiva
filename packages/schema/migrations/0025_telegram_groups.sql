CREATE TABLE "telegram_group" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"title" text NOT NULL,
	"members" integer,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_ids" uuid[] DEFAULT '{}' NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"error_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_group_code" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_group_code_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
DROP INDEX "notify_outbox_user_id_workspace_id_action_id_channel_index";--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD COLUMN "fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_group" ADD CONSTRAINT "telegram_group_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_group" ADD CONSTRAINT "telegram_group_linked_by_user_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_group_code" ADD CONSTRAINT "telegram_group_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_group_code" ADD CONSTRAINT "telegram_group_code_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_group_workspace_id_chat_id_index" ON "telegram_group" USING btree ("workspace_id","chat_id");--> statement-breakpoint
CREATE INDEX "telegram_group_chat_id_index" ON "telegram_group" USING btree ("chat_id");--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_group_id_telegram_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."telegram_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_userId_workspaceId_actionId_channel_groupId_unique" UNIQUE NULLS NOT DISTINCT("user_id","workspace_id","action_id","channel","group_id");