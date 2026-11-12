CREATE TABLE "saved_view" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"display" jsonb NOT NULL,
	"layout" text DEFAULT 'list' NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"tab" boolean DEFAULT false NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"external_source" text,
	"external_id" text
);
--> statement-breakpoint
CREATE TABLE "view_pin" (
	"user_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pinned" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "view_pin_user_id_view_id_pk" PRIMARY KEY("user_id","view_id")
);
--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_pin" ADD CONSTRAINT "view_pin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_pin" ADD CONSTRAINT "view_pin_view_id_saved_view_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."saved_view"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_pin" ADD CONSTRAINT "view_pin_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_view_workspace_id_updated_at_index" ON "saved_view" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_view_workspace_id_external_source_external_id_index" ON "saved_view" USING btree ("workspace_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "view_pin_user_id_workspace_id_updated_at_index" ON "view_pin" USING btree ("user_id","workspace_id","updated_at");