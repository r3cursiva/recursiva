ALTER TABLE "project" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "former_keys" text[] DEFAULT '{}' NOT NULL;