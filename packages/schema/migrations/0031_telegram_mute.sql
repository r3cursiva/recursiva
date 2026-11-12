-- PLNR-205: /mute 2h in a person's Telegram chat; until then only urgent issues go there.
ALTER TABLE "telegram_chat" ADD COLUMN "muted_until" timestamp with time zone;