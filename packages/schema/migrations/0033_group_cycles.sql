-- PLNR-253: the linker's date of the last cycles of the day a group chat was sent; one a day at most.
ALTER TABLE "telegram_group" ADD COLUMN "cycles_sent_on" date;