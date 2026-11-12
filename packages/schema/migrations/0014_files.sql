CREATE TABLE "blob" (
	"workspace_id" uuid NOT NULL,
	"sha256" char(64) NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_workspace_id_sha256_pk" PRIMARY KEY("workspace_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "sha256" char(64);--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "size" bigint;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "mime" text;--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;