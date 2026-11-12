-- A project's cycles complete themselves once over and move their open issues to the next one (PLNR-64, ADR 0049); off
-- in every project, so nothing moves until someone turns it on.
ALTER TABLE "project" ADD COLUMN "cycle_rollover" boolean DEFAULT false NOT NULL;