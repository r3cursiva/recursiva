CREATE TABLE "telegram_chat" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"username" text,
	"name" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"error_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_code" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_code_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_chat" ADD CONSTRAINT "telegram_chat_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_code" ADD CONSTRAINT "telegram_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;