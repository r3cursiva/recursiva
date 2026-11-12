-- The creature a person drew for an avatar without a picture (PLNR-366); null draws the one their name gives.
ALTER TABLE "user" ADD COLUMN "avatar" text;