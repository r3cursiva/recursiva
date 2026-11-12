-- Fractional indexes compare byte by byte, as in the browser. The database's default collation (en_US.utf8) orders
-- "Zz" after "a0", so "the top of the column" in SQL disagreed with the client. drizzle has no collation in its column
-- builders, hence a custom migration; see the comment on issue.sortOrder in src/db.ts.
ALTER TABLE "issue" ALTER COLUMN "sort_order" TYPE text COLLATE "C";
