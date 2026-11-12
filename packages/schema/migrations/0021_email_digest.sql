CREATE TABLE "notify_digest" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_on" date NOT NULL,
	CONSTRAINT "notify_digest_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "unsubscribe_key" text;--> statement-breakpoint
ALTER TABLE "notify_digest" ADD CONSTRAINT "notify_digest_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;