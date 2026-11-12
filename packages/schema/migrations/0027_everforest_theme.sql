-- PLNR-242: Everforest takes Tokyo Night's place. An account that chose a Tokyo Night theme gets Everforest on that
-- side and keeps the rest of its choice; left alone, the theme would read as none (readSettings) and reset to defaults.
UPDATE "account_settings" SET "theme" = "theme" || '{"light": "everforest-light"}'::jsonb WHERE "theme"->>'light' = 'tokyo-night-light';--> statement-breakpoint
UPDATE "account_settings" SET "theme" = "theme" || '{"dark": "everforest-dark"}'::jsonb WHERE "theme"->>'dark' = 'tokyo-night';
