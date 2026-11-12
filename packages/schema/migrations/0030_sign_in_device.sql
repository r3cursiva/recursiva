-- PLNR-252: browsers people sign in from. Everyone who exists now gets the row SIGNED_IN_BEFORE (auth/devices.ts),
-- which no browser's token hashes to: they have signed in before or were invited, so a sign-in from a new browser mails them
-- even when all their sessions have ended.
CREATE TABLE "sign_in_device" (
	"user_id" uuid NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_device_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "sign_in_device" ADD CONSTRAINT "sign_in_device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "sign_in_device" ("user_id", "id") SELECT "id", 'signed-in-before' FROM "user" WHERE "kind" = 'human';
