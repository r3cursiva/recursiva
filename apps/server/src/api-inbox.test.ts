import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { asToken, fetchAs, importFixture, jsonTokens, startServer, type Fixture } from "./test/helpers.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
/** The agent writes; the owner reads their inbox with a token of their own, as a person at the CLI does. */
let agent: typeof fetch;
let owner: typeof fetch;
let ownerRead: typeof fetch;
before(async () => {
  [server, ws] = await Promise.all([startServer(), importFixture()]);
  const json = { "content-type": "application/json" };
  ({ agent, owner } = await jsonTokens(ws));
  ownerRead = fetchAs({ ...(await asToken(ws.workspaceId, ws.ownerId, "read")), ...json });
});
after(() => server.close());

const api = (path: string) => `${server.url}/api/v1/workspaces/${ws.slug}${path}`;
const body = async <T>(r: Promise<Response>) => (await (await r).json()) as T;
interface Line {
  key: string;
  title: string;
  state: string;
  kind: string;
  kinds: string[];
  by: string | null;
  unread: boolean;
  snoozedUntil: string | null;
}
const inbox = () => body<{ unread: number; lines: Line[] }>(owner(api("/inbox")));
const mark = (b: unknown, as = owner) => as(api("/inbox"), { method: "POST", body: JSON.stringify(b) });

test("the inbox for a token: the browser's lines by key, read, unread and archive; refusals name what is wrong", async () => {
  const me = await body<{ issues: { assignees: string[] }[] }>(owner(api("/issues?q=assignee:me&limit=1")));
  const email = me.issues[0]?.assignees[0];
  assert.ok(email, "the fixture's owner has issues");
  const { key } = await body<{ key: string }>(agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: "For the owner's inbox", assignees: [email] }) }));

  const before = await inbox();
  const line = before.lines.find((l) => l.key === key);
  assert.ok(line, JSON.stringify(before.lines.slice(0, 3)));
  assert.deepEqual([line.title, line.kind, line.unread, line.snoozedUntil], ["For the owner's inbox", "assigned", true, null]);
  assert.match(line.by ?? "", /@/);
  assert.equal(before.lines[0]!.key, key, "newest first");

  assert.deepEqual(await body(mark({ read: [key.toLowerCase()] })), { ok: true, marked: 1 });
  const read = await inbox();
  assert.equal(read.lines.find((l) => l.key === key)!.unread, false);
  assert.equal(read.unread, before.unread - 1);
  await mark({ unread: [key] });
  assert.equal((await inbox()).lines.find((l) => l.key === key)!.unread, true);
  await mark({ archive: [key] });
  assert.equal((await inbox()).lines.find((l) => l.key === key), undefined, "archived: out until something new");

  await agent(api(`/issues/${key}/comments`), { method: "POST", body: JSON.stringify({ body: "Back in your inbox" }) });
  const back = (await inbox()).lines.find((l) => l.key === key);
  assert.ok(back?.unread, "a newer notification brings it back");

  assert.deepEqual(await body(mark({ read: "all" })), { ok: true, marked: (await inbox()).lines.length });
  assert.equal((await inbox()).unread, 0);

  for (const [b, status] of [[{}, 400], [{ read: [key], archive: [key] }, 400], [{ read: [] }, 400], [{ read: "some" }, 400], [{ read: ["CORE-999999"] }, 400]] as const) {
    const r = await mark(b);
    assert.equal(r.status, status, JSON.stringify(b));
  }
  assert.match((await body<{ message: string }>(mark({ read: ["CORE-999999"] }))).message, /nothing in your inbox for CORE-999999/);
  assert.equal((await mark({ read: "all" }, ownerRead)).status, 403, "a read-only token reads the inbox but marks nothing");
  assert.equal((await ownerRead(api("/inbox"))).status, 200);
});
