-- A Telegram chat acts for its person only when they turn that on (RSVA-496): buttons, commands, replies as comments.
-- A chat linked from now on starts with notifications only; the chats linked before keep acting as they did.
ALTER TABLE "telegram_chat" ADD COLUMN "actions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "telegram_chat" SET "actions" = true;
