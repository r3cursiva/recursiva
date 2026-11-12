// Which of a person's workspaces each list shows, by role (RSVA-428: one query, auth/access.ts workspacesOf, behind
// the switcher, the notification settings, the bot's writable workspaces and the mails' readable ones).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { WorkspaceListItem } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { workspacesOf } from "./access.ts";
import { addMember, asToken, asUser, fetchAs, importFixture, startServer, type Fixture } from "../test/helpers.ts";
import { writable } from "../telegram/fields.ts";

let server: Awaited<ReturnType<typeof startServer>>;
/** The person is owner, member, guest, and something no role is ("boss": bad data), of workspaces named A, B, C, D. */
const ws: Record<"owner" | "member" | "guest" | "boss", Fixture> = {} as never;
let me: string;
before(async () => {
  const [s, ...made] = await Promise.all([startServer(), importFixture(), importFixture(), importFixture(), importFixture()]);
  server = s;
  (["owner", "member", "guest", "boss"] as const).forEach((role, i) => (ws[role] = made[i]!));
  me = (await addMember(ws.member.workspaceId, "member")).id;
  for (const role of ["owner", "guest", "boss"] as const) await db.insert(schema.member).values({ workspaceId: ws[role].workspaceId, userId: me, role });
  for (const [role, name] of [["owner", "A"], ["member", "B"], ["guest", "C"], ["boss", "D"]] as const)
    await db.update(schema.workspace).set({ name: `${name} ${ws[role].slug}` }).where(eq(schema.workspace.id, ws[role].workspaceId));
});
after(() => server.close());

const slugs = (list: { slug: string }[]) => list.map((w) => w.slug).filter((s) => Object.values(ws).some((w) => w.slug === s));

test("the switcher lists what the person may open: owner and member, not guest or a row with no known role; a token its one workspace", async () => {
  const list = (await (await fetchAs(await asUser(me))(`${server.url}/sync/workspaces`)).json()) as WorkspaceListItem[];
  assert.deepEqual(slugs(list), [ws.owner.slug, ws.member.slug]);
  assert.deepEqual(list.map((w) => w.role), ["owner", "member"]);
  const token = (await (await fetchAs(await asToken(ws.member.workspaceId, me, "read"))(`${server.url}/sync/workspaces`)).json()) as WorkspaceListItem[];
  assert.deepEqual(slugs(token), [ws.member.slug]);
});

test("notification settings list every membership, a guest's too, by name; a row with no known role is none", async () => {
  const r = (await (await fetchAs(await asUser(me))(`${server.url}/auth/notifications`)).json()) as { workspaces: { slug: string; role: string }[] };
  assert.deepEqual(slugs(r.workspaces), [ws.owner.slug, ws.member.slug, ws.guest.slug]);
  assert.deepEqual(r.workspaces.map((w) => w.role), ["owner", "member", "guest"]);
});

test("the bot creates issues where the role writes issues: owner and member, the given one first", async () => {
  assert.deepEqual(slugs(await writable(me)), [ws.owner.slug, ws.member.slug]);
  assert.deepEqual(slugs(await writable(me, ws.member.workspaceId)), [ws.member.slug, ws.owner.slug]);
  assert.deepEqual((await writable(me)).map((w) => [w.workspaceId, w.role]), [[ws.owner.workspaceId, "owner"], [ws.member.workspaceId, "member"]]);
});

test("what the person may read (mails, the bot's /my, /inbox and cards): owner and member; with a capability, by the role alone", async () => {
  assert.deepEqual(slugs(await workspacesOf(me, "read")), [ws.owner.slug, ws.member.slug]);
  assert.deepEqual(slugs(await workspacesOf(me, "members.manage")), [ws.owner.slug]);
  // A workspace may open labels to members (member rights); the role alone, which is what this reads, does not reach them.
  assert.deepEqual(slugs(await workspacesOf(me, "labels.write")), [ws.owner.slug]);
});
