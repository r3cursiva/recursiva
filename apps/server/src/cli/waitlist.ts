// The cloud's waitlist from the server's own shell (RSVA-542, ADR 0054): who asked, and letting people in a batch at a
// time. Letting in mails each address how to get in, through the server's mailer and to its public origin.
//
//   node apps/server/src/cli/waitlist.ts list [--all]
//   node apps/server/src/cli/waitlist.ts admit you@example.com [more@example.com …]
//   node apps/server/src/cli/waitlist.ts admit --next 10
//
// On a deployment: dist/waitlist-cli.js in the server's container, with its environment.
import { parseArgs } from "node:util";
import { mailerFromEnv, PUBLIC_ORIGIN } from "../auth/mail.ts";
import { migrateDb, sql } from "../db.ts";
import { admit, listWaitlist } from "../waitlist.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { all: { type: "boolean", default: false }, next: { type: "string" } } });
const [command, ...emails] = positionals;
const usage = "usage: waitlist.ts list [--all] | admit <email>… | admit --next <n>";

/** Addresses or --next N, not both and not neither. */
function admitArgs(): boolean {
  if (values.next === undefined) return emails.length > 0;
  const n = Number(values.next);
  return emails.length === 0 && Number.isInteger(n) && n > 0;
}

await migrateDb();
if (command === "list") {
  const rows = await listWaitlist(values.all);
  const state = (r: (typeof rows)[number]) => (r.usedAt ? "workspace made" : r.admittedAt ? "let in" : "waiting");
  for (const r of rows) console.log([r.createdAt.slice(0, 10), values.all ? state(r) : null, r.email, r.note].filter((x) => x !== null).join("\t"));
  console.error(`${rows.length} ${values.all ? "on the list" : "waiting"}`);
} else if (command === "admit" && admitArgs()) {
  const next = values.next === undefined ? null : Number(values.next);
  if (!PUBLIC_ORIGIN) throw new Error("RSVA_ALLOWED_ORIGINS has no https origin: the mail would have no link to sign in at");
  const mailer = mailerFromEnv(process.env, (m) => console.error(m));
  const done = await admit(next === null ? { emails } : { next }, mailer, PUBLIC_ORIGIN);
  for (const e of done) console.log(e);
  console.error(`${done.length} let in`);
} else {
  console.error(usage);
  process.exitCode = 2;
}
await sql.end();
