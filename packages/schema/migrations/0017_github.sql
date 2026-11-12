CREATE TABLE "github_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"repo_id" bigint,
	"repo_name" text,
	"workspace_id" uuid,
	"status" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation" (
	"id" bigint PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"account_type" text NOT NULL,
	"installed_by" text,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"pull_id" uuid,
	"closing" boolean NOT NULL,
	"sha" text,
	"message" text,
	"author" text,
	"author_bot" boolean,
	"at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_pull" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"head" text NOT NULL,
	"head_sha" text NOT NULL,
	"base" text NOT NULL,
	"author" text NOT NULL,
	"author_bot" boolean DEFAULT false NOT NULL,
	"reviews" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"commit_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"comment_id" bigint,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_repo" (
	"id" bigint PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"installation_id" bigint,
	"workspace_id" uuid,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"project_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "github_delivery" ADD CONSTRAINT "github_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_link" ADD CONSTRAINT "github_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_link" ADD CONSTRAINT "github_link_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_link" ADD CONSTRAINT "github_link_repo_id_github_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."github_repo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_link" ADD CONSTRAINT "github_link_pull_id_github_pull_id_fk" FOREIGN KEY ("pull_id") REFERENCES "public"."github_pull"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pull" ADD CONSTRAINT "github_pull_repo_id_github_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."github_repo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo" ADD CONSTRAINT "github_repo_installation_id_github_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo" ADD CONSTRAINT "github_repo_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_delivery_workspace_id_created_at_index" ON "github_delivery" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "github_delivery_created_at_index" ON "github_delivery" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "github_link_issue_id_index" ON "github_link" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "github_link_pull_id_index" ON "github_link" USING btree ("pull_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_link_issue_id_pull_id_index" ON "github_link" USING btree ("issue_id","pull_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_link_issue_id_repo_id_sha_index" ON "github_link" USING btree ("issue_id","repo_id","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "github_pull_repo_id_number_index" ON "github_pull" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "github_pull_repo_id_head_sha_index" ON "github_pull" USING btree ("repo_id","head_sha");--> statement-breakpoint
CREATE INDEX "github_repo_workspace_id_index" ON "github_repo" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_repo_full_name_index" ON "github_repo" USING btree ("full_name");