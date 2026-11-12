// Links to the app's old addresses, rewritten to its address now (rehost.ts, PLNR-324). A dry run unless --as names who writes.
//
//   node apps/server/src/cli/rehost.ts --from plan.rsva.dev [--from old.example.com] [--to https://app.rsva.dev] [--ws arsen]
//   node apps/server/src/cli/rehost.ts --from plan.rsva.dev --as owner@example.com
//
// --to defaults to the server's public origin (RSVA_ALLOWED_ORIGINS). One line per link: rewrite or keep, the workspace,
// the issue, where the link is, the row and the address (→ the new one).
import { parseArgs } from "node:util";
import { PUBLIC_ORIGIN } from "../auth/mail.ts";
import { migrateDb, sql } from "../db.ts";
import { rehost } from "../rehost.ts";

const { values } = parseArgs({
  options: { from: { type: "string", multiple: true, default: [] }, to: { type: "string" }, ws: { type: "string" }, as: { type: "string" } },
});
const to = values.to ?? PUBLIC_ORIGIN;
if (!to) {
  console.error("usage: rehost.ts --from <old host>... [--to <https origin>] [--ws <slug>] [--as <email>]: no --to and no RSVA_ALLOWED_ORIGINS");
  process.exit(2);
}

await migrateDb();
try {
  const found = await rehost({ from: values.from, to, ...(values.ws ? { ws: values.ws } : {}), ...(values.as ? { as: values.as } : {}) });
  let moved = 0;
  let kept = 0;
  for (const f of found)
    for (const h of f.hits) {
      if (h.to) moved++;
      else kept++;
      console.log([h.to ? "rewrite" : "keep", f.ws, f.key, f.where, f.id.slice(0, 8), h.to ? `${h.url} → ${h.to}` : h.url].join("\t"));
    }
  const rows = found.filter((f) => f.hits.some((h) => h.to)).length;
  console.log(`${values.as ? "written" : "dry run"}: ${moved} links in ${rows} rows ${values.as ? "rewritten" : "to rewrite"}, ${kept} kept`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
}
await sql.end();
