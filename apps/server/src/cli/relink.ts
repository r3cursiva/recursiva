// Manual links to the old repository, pointed at its archive (relink.ts, RSVA-591). A dry run unless --as names who writes.
//
//   node apps/server/dist/relink-cli.js --before 2026-11-12T09:00:00Z
//   node apps/server/dist/relink-cli.js --before 2026-11-12T09:00:00Z --as owner@example.com
//
// --before is required: the moment the old repository was renamed. One line per link: the workspace, the issue, the row
// and the address → the new one.
import { parseArgs } from "node:util";
import { migrateDb, sql } from "../db.ts";
import { relink } from "../relink.ts";

const { values } = parseArgs({ options: { before: { type: "string" }, as: { type: "string" } } });
const before = values.before ? new Date(values.before) : null;
if (!before || Number.isNaN(before.getTime()) || !/[zZ]|[+-]\d\d:?\d\d$/.test(values.before!)) {
  console.error("usage: relink.ts --before <ISO time with a zone, 2026-11-12T09:00:00Z> [--as <email>]");
  process.exit(2);
}

await migrateDb();
try {
  const found = await relink({ before, ...(values.as ? { as: values.as } : {}) });
  for (const f of found) console.log([values.as ? "rewritten" : "rewrite", f.ws, f.key, f.id.slice(0, 8), `${f.url} → ${f.to}`].join("\t"));
  console.log(`${values.as ? "written" : "dry run"}: ${found.length} links in ${new Set(found.map((f) => f.ws)).size} workspaces ${values.as ? "rewritten" : "to rewrite"}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
}
await sql.end();
