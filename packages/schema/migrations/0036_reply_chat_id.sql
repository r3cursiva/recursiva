DROP INDEX "notify_outbox_user_id_message_id_index";--> statement-breakpoint
ALTER TABLE "notify_outbox" ADD COLUMN "chat_id" bigint;--> statement-breakpoint
CREATE INDEX "notify_outbox_chat_id_message_id_index" ON "notify_outbox" USING btree ("chat_id","message_id") WHERE "notify_outbox"."message_id" is not null;--> statement-breakpoint
-- Messages sent before this column: a person has one chat at a time, and linking a chat sets linked_at, so a message sent
-- after the chat now linked was linked went to that chat. One sent before it went to a chat no longer theirs: it stays
-- null, and a reply to it posts nothing. Group rows are not replied to and stay null.
UPDATE "notify_outbox" AS o SET "chat_id" = c."chat_id" FROM "telegram_chat" AS c WHERE o."channel" = 'telegram' AND o."message_id" IS NOT NULL AND c."user_id" = o."user_id" AND c."linked_at" <= o."done_at";
