-- PLNR-243: Night Owl takes Everforest's place (which took Tokyo Night's, 0027). An account that chose an Everforest
-- theme gets Night Owl on that side and keeps the rest of its choice; left alone, the theme would read as none
-- (readSettings) and reset to defaults.
UPDATE "account_settings" SET "theme" = "theme" || '{"light": "night-owl-light"}'::jsonb WHERE "theme"->>'light' = 'everforest-light';--> statement-breakpoint
UPDATE "account_settings" SET "theme" = "theme" || '{"dark": "night-owl"}'::jsonb WHERE "theme"->>'dark' = 'everforest-dark';
