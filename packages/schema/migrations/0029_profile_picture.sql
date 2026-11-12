CREATE TABLE "user_picture" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sha256" char(64) NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "picture" char(64);--> statement-breakpoint
ALTER TABLE "user_picture" ADD CONSTRAINT "user_picture_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_picture_sha256_index" ON "user_picture" USING btree ("sha256");