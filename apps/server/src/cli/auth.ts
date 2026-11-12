// Sessions and tokens from the server's own shell, for whoever runs the server: the first agent token on a new deployment
// (later ones come from Settings › API tokens) and the perf checks, which open the app as the workspace owner.
//
//   node apps/server/src/cli/auth.ts token --ws atlas [--user bot@example.com] [--scope write] [--name claude]
//   node apps/server/src/cli/auth.ts session --ws atlas [--user a@example.com]
//
// Without --user, a token goes to the workspace's agent member and a session to its owner. Prints the secret alone, so
// a script can take it: `TOKEN=$(node … token --ws atlas)`. A session secret is a cookie value: rsva_sid on http,
// __Host-rsva_sid on https.
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { createSession } from "../auth/sessions.ts";
import { createToken } from "../auth/tokens.ts";
import { db, migrateDb, schema, sql } from "../db.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { ws: { type: "string" }, user: { type: "string" }, scope: { type: "string", default: "write" }, name: { type: "string", default: "cli" } },
});
const [command] = positionals;
if ((command !== "token" && command !== "session") || !values.ws) {
  console.error("usage: auth.ts token|session --ws <slug> [--user <email>] [--scope read|write] [--name <name>]");
  process.exit(2);
}
// A custom token is made in Settings › API tokens, where its grants are chosen.
if (values.scope !== "read" && values.scope !== "write") throw new Error('--scope is "read" or "write"');

await migrateDb();
const { workspace, member, user } = schema;
const members = await db
  .select({ id: user.id, email: user.email, kind: user.kind, role: member.role, workspaceId: workspace.id })
  .from(member)
  .innerJoin(workspace, eq(workspace.id, member.workspaceId))
  .innerJoin(user, eq(user.id, member.userId))
  .where(and(eq(workspace.slug, values.ws)));
const who = values.user
  ? members.find((m) => m.email.toLowerCase() === values.user!.toLowerCase())
  : command === "token"
    ? (members.find((m) => m.kind === "agent") ?? members.find((m) => m.role === "owner"))
    : members.find((m) => m.role === "owner" && m.kind === "human");
if (!who) throw new Error(`no such member in workspace ${values.ws}`);

if (command === "token") {
  const t = await createToken({ workspaceId: who.workspaceId, userId: who.id, name: values.name, scope: values.scope, createdById: null });
  console.error(`token ${t.id} for ${who.email} (${who.role}, ${values.scope}) in ${values.ws}`);
  console.log(t.secret);
} else {
  if (who.kind !== "human") throw new Error("agents have tokens, not sessions");
  // A browser's session (method "code"), for the cookie of the README's local sign-in and the perf checks: "cli" is a
  // terminal's, which makes no new key and ends after a week unused (routes.ts, freshBrowser; sessions.ts).
  const s = await createSession(who.id, "code", "cli");
  console.error(`session for ${who.email} until ${s.expiresAt.toISOString()}`);
  console.log(s.token);
}
await sql.end();
