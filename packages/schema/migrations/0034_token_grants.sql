ALTER TABLE "api_token" ADD COLUMN "grants" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "granted_by_id" uuid;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_granted_by_id_user_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;