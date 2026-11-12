-- The GitHub bot's user is found by its email (GITHUB_BOT, events.ts): it moves to the new name, so the next GitHub event
-- does not make a second bot and the first one's actions stay its (PLNR-319).
UPDATE "user" SET "email" = 'github-bot@rsva.invalid' WHERE "email" = 'github-bot@planner.invalid' AND NOT EXISTS (SELECT 1 FROM "user" WHERE "email" = 'github-bot@rsva.invalid');
