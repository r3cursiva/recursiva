import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { addMember, asToken, asUser, fetchAs, importFixture, issueWithRefs, startServer, type Fixture } from "./test/helpers.ts";
import { takeWrite } from "./sync/limits.ts";
import { writeView } from "./sync/views.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
/** The agent's token and the owner's browser. */
let agent: typeof fetch;
let agentHeaders: Record<string, string>;
let owner: typeof fetch;
before(async () => {
  [server, ws] = await Promise.all([startServer(), importFixture()]);
  agentHeaders = await asToken(ws.workspaceId, ws.agentId);
  agent = fetchAs({ ...agentHeaders, "content-type": "application/json" });
  owner = fetchAs({ ...(await asUser(ws.ownerId)), "content-type": "application/json" });
});
after(() => server.close());

const api = (path: string) => `${server.url}/api/v1/workspaces/${ws.slug}${path}`;
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
interface View {
  key: string;
  title: string;
  state: string;
  priority: string;
  labels: string[];
  assignees: string[];
  parent: string | null;
  updatedAt: string;
  description?: string;
}

test("an issue's dates are read back as written, in the list too", async () => {
  const created = await json<{ key: string }>(agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: "Dated", startDate: "2027-03-01", dueDate: "2027-03-09" }) }));
  const dates = (i: { startDate?: string | null; dueDate?: string | null }) => [i.startDate, i.dueDate];
  assert.deepEqual(dates(await json(agent(api(`/issues/${created.key}`)))), ["2027-03-01", "2027-03-09"]);
  const listed = await json<{ issues: { key: string; startDate: string; dueDate: string }[] }>(agent(api("/issues?project=CORE&limit=1")));
  assert.deepEqual([listed.issues[0]!.key, ...dates(listed.issues[0]!)], [created.key, "2027-03-01", "2027-03-09"]);
  await agent(api(`/issues/${created.key}`), { method: "PATCH", body: JSON.stringify({ dueDate: null }) });
  assert.deepEqual(dates(await json(agent(api(`/issues/${created.key}`)))), ["2027-03-01", null]);
  await agent(api(`/issues/${created.key}`), { method: "DELETE" });
});

test("list: the browser's query language, newest first, a limit; mistakes come back with suggestions", async () => {
  const all = await json<{ total: number; issues: View[] }>(agent(api("/issues?project=CORE&limit=5")));
  assert.equal(all.issues.length, 5);
  assert.ok(all.total > 5);
  assert.ok(all.issues.every((i) => i.key.startsWith("CORE-")));
  const times = all.issues.map((i) => Date.parse(i.updatedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");

  const q = encodeURIComponent('state:"In Progress" label:bug');
  const some = await json<{ issues: View[] }>(agent(api(`/issues?project=CORE&q=${q}`)));
  assert.ok(some.issues.length > 0);
  assert.ok(some.issues.every((i) => i.state === "In Progress" && i.labels.includes("bug")));

  // The short forms, as the browser's filter and the bot read them (RSVA-368).
  const short = await json<{ issues: View[] }>(agent(api(`/issues?project=CORE&q=${encodeURIComponent('#core +bug state:"In Progress"')}`)));
  assert.deepEqual(short.issues.map((i) => i.key), some.issues.map((i) => i.key));

  const bad = await agent(api(`/issues?project=CORE&q=${encodeURIComponent("state:Progres")}`));
  assert.equal(bad.status, 400);
  const err = await json<{ error: string; errors: { suggestions: string[] }[] }>(bad);
  assert.equal(err.error, "invalid_query");
  assert.ok(err.errors[0]!.suggestions.some((s) => s.includes("Progress")), JSON.stringify(err));
  assert.equal((await agent(api("/issues?project=NOPE"))).status, 400);
  // The whole workspace without a project.
  const ws_ = await json<{ total: number }>(agent(api("/issues?limit=1")));
  assert.ok(ws_.total > all.total);
});

test("list: parent:, is: and has: read the workspace, as in the browser (PLNR-51, PLNR-173, RSVA-174)", async () => {
  const create = (title: string, more: Record<string, unknown> = {}) => json<{ key: string }>(agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title, ...more }) }));
  const keys = async (q: string) => (await json<{ issues: View[] }>(agent(api(`/issues?project=CORE&limit=500&q=${encodeURIComponent(q)}`)))).issues.map((i) => i.key).sort();
  const epic = await create("Epic of the relation filters");
  const child = await create("Under the epic", { parent: epic.key });
  const blocker = await create("Holds the next one up");
  const waiting = await create("Waits on the blocker");
  const rel = await agent(api(`/issues/${waiting.key}/relations`), { method: "POST", body: JSON.stringify({ type: "blockedBy", issue: blocker.key }) });
  assert.ok(rel.ok, await rel.clone().text());

  assert.deepEqual(await keys(`parent:${epic.key.toLowerCase()}`), [child.key]);
  assert.ok(!(await keys("parent:none")).includes(child.key));
  assert.ok((await keys("parent:any")).includes(child.key));
  assert.ok((await keys("is:blocked")).includes(waiting.key));
  assert.ok((await keys("is:blocking")).includes(blocker.key));
  assert.ok(!(await keys("-is:blocked")).includes(waiting.key));

  const closed = await agent(api(`/issues/${blocker.key}`), { method: "PATCH", body: JSON.stringify({ state: "Done" }) });
  assert.ok(closed.ok, await closed.clone().text());
  assert.ok(!(await keys("is:blocked")).includes(waiting.key), "a closed blocker holds nobody up");
  assert.ok(!(await keys("is:blocking")).includes(blocker.key));

  // has:link from the attachments the index loads with the issues; is:duplicate from the issue's own field (RSVA-174).
  const linked = await agent(api(`/issues/${child.key}/links`), { method: "POST", body: JSON.stringify({ url: "https://example.com/spec" }) });
  assert.equal(linked.status, 201, await linked.clone().text());
  assert.ok((await keys("has:link")).includes(child.key));
  assert.ok(!(await keys("has:link")).includes(epic.key));
  assert.ok(!(await keys("-has:link")).includes(child.key));
  const dup = await agent(api(`/issues/${waiting.key}/relations`), { method: "POST", body: JSON.stringify({ type: "duplicateOf", issue: epic.key }) });
  assert.ok(dup.ok, await dup.clone().text());
  assert.ok((await keys("is:duplicate")).includes(waiting.key));
  assert.ok(!(await keys("is:duplicate")).includes(epic.key));
  assert.ok(!(await keys("-is:duplicate")).includes(waiting.key));

  const bad = await agent(api(`/issues?q=${encodeURIComponent("parent:CORE-99999")}`));
  assert.equal(bad.status, 400);
  assert.match((await json<{ message: string }>(bad)).message, /No issue named "CORE-99999"/);
});

test("list by a saved view (PLNR-74): its query and order, narrowed by q; private views of others are not found", async () => {
  const set = { icon: "bug", display: { orderBy: "priority" }, layout: "list", tab: false, position: 0 } as const;
  await writeView(ws.workspaceId, ws.ownerId, "owner", { op: "save", id: randomUUID(), set: { ...set, name: "Core bugs", query: "project:CORE label:bug -state:Done", shared: true } });
  await writeView(ws.workspaceId, ws.ownerId, "owner", { op: "save", id: randomUUID(), set: { ...set, name: "Mine only", query: "", shared: false } });
  const got = await json<{ total: number; issues: View[] }>(agent(api(`/issues?view=${encodeURIComponent("core bugs")}&limit=500`)));
  assert.ok(got.total > 0);
  assert.ok(got.issues.every((i) => i.key.startsWith("CORE-") && i.labels.includes("bug") && i.state !== "Done"));
  const narrowed = await json<{ issues: View[] }>(agent(api(`/issues?view=Core%20bugs&q=${encodeURIComponent('state:"In Progress"')}`)));
  assert.ok(narrowed.issues.every((i) => i.state === "In Progress"));
  const missing = await agent(api("/issues?view=Mine%20only"));
  assert.equal(missing.status, 400);
  assert.match((await json<{ message: string }>(missing)).message, /"Core bugs"/);
});

test("order: in q orders the list as ?order= does, and ?order= wins (PLNR-401)", async () => {
  const keys = async (params: string) => (await json<{ issues: View[] }>(agent(api(`/issues?project=CORE&limit=500&${params}`)))).issues.map((i) => i.key);
  const byPriority = await keys("order=priority");
  assert.notDeepEqual(byPriority, await keys("order=createdAt"), "the fixture tells the two orders apart");
  assert.deepEqual(await keys(`q=${encodeURIComponent("order:priority")}`), byPriority);
  assert.deepEqual(await keys(`q=${encodeURIComponent("sort:created")}&order=priority`), byPriority);
  const bad = await agent(api(`/issues?project=CORE&q=${encodeURIComponent("order:colour")}`));
  assert.equal(bad.status, 400);
});

test("create and change by name: state, labels, people by email or me, parent by key, Markdown description", async () => {
  const { issue: parent, project } = await issueWithRefs(ws.workspaceId, "CORE");
  const r = await agent(api("/issues"), {
    method: "POST",
    body: JSON.stringify({
      project: "core",
      title: "Agent-made issue",
      state: "in progress",
      priority: "high",
      labels: ["Bug", "chore"],
      assignees: ["me"],
      parent: `${project.key}-${parent.number}`,
      description: "## Plan\n\n- [ ] one",
    }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const { key } = await json<{ key: string }>(r);
  assert.match(key, /^CORE-\d+$/);
  const got = await json<View>(agent(api(`/issues/${key}`)));
  assert.equal(got.state, "In Progress");
  assert.equal(got.priority, "high");
  assert.deepEqual(got.labels.sort(), ["bug", "chore"]);
  assert.deepEqual(got.assignees, [`bot@${ws.slug}.test`]);
  assert.equal(got.parent, `${project.key}-${parent.number}`);
  assert.equal(got.description, "## Plan\n\n- [ ] one\n");

  const patched = await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ labels: [], assignees: [], parent: null, priority: 0 }) });
  assert.equal(patched.status, 200);
  const after = await json<View>(agent(api(`/issues/${key}`)));
  assert.deepEqual([after.labels, after.assignees, after.parent, after.priority], [[], [], null, "none"]);

  // Unknown names are refused with what exists.
  const badLabel = await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ labels: ["nope"] }) });
  assert.equal(badLabel.status, 400);
  assert.match((await json<{ message: string }>(badLabel)).message, /no label "nope"; labels: .*"bug"/);
  const badState = await agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: "x", state: "Nope" }) });
  assert.match((await json<{ message: string }>(badState)).message, /no state "Nope".*"Backlog"/);
  // Without a state, the project's default.
  const plain = await json<{ key: string }>(agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: "Default state" }) }));
  assert.equal((await json<View>(agent(api(`/issues/${plain.key}`)))).state, "Backlog");
});

test("mentions in Markdown name members by email, me or id; stored by id, an unknown one refused", async () => {
  const { issue, project } = await issueWithRefs(ws.workspaceId, "CORE");
  const key = `${project.key}-${issue.number}`;
  const ownerEmail = `owner@${ws.slug}.test`;
  const posted = await agent(api(`/issues/${key}/comments`), { method: "POST", body: JSON.stringify({ body: `cc [@Boss](mention:${ownerEmail.toUpperCase()}) and [](mention:me)` }) });
  assert.equal(posted.status, 201, await posted.clone().text());
  const { comments } = await json<{ comments: { id: string; body: string }[] }>(agent(api(`/issues/${key}/comments`)));
  const { id } = await json<{ id: string }>(posted);
  assert.equal(comments.find((c) => c.id === id)!.body, `cc [@Boss](mention:${ws.ownerId}) and [@Agent](mention:${ws.agentId})`);

  const patched = await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ description: `for [](mention:${ownerEmail})` }) });
  assert.equal(patched.status, 200, await patched.clone().text());
  const got = await json<View>(agent(api(`/issues/${key}`)));
  assert.match(got.description!, new RegExp(`^for \\[@[^\\]]+\\]\\(mention:${ws.ownerId}\\)\\n$`));

  // Other ways to write the link would be stored unresolved: refused, as is a mention-looking link in code.
  for (const body of ["[@A](<mention:me>)", '[@A](mention:me "t")', "[@A](mention:me) and `[x](mention:me)`"]) {
    const r = await agent(api(`/issues/${key}/comments`), { method: "POST", body: JSON.stringify({ body }) });
    assert.equal(r.status, 400, body);
    assert.match((await json<{ message: string }>(r)).message, /write a mention as/);
  }
  // At most 50 different people per comment.
  const many = Array.from({ length: 51 }, (_, i) => `[@p](mention:p${i}@x.test)`).join(" ");
  const tooMany = await agent(api(`/issues/${key}/comments`), { method: "POST", body: JSON.stringify({ body: many }) });
  assert.equal(tooMany.status, 400);
  for (const r of [
    agent(api(`/issues/${key}/comments`), { method: "POST", body: JSON.stringify({ body: "[@x](mention:nobody@x.test)" }) }),
    agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ description: "[@x](mention:nobody@x.test)" }) }),
  ]) {
    const res = await r;
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /no member "nobody@x.test"; members: /);
  }
});

test("agents cannot move issues to Todo or Approved, people can; a read token cannot create", async () => {
  const { issue, project } = await issueWithRefs(ws.workspaceId, "CORE");
  const key = `${project.key}-${issue.number}`;
  for (const state of ["Todo", "Approved"]) {
    const r = await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ state }) });
    assert.equal(r.status, 403);
    const body = await json<{ error: string; message: string }>(r);
    assert.equal(body.error, "forbidden");
    assert.match(body.message, new RegExp(`agents cannot move issues to "${state}"`));
  }
  const create = await agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: "Straight to Todo", state: "Todo" }) });
  assert.equal(create.status, 403);
  assert.equal((await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ state: "In Review" }) })).status, 200);
  assert.equal((await owner(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ state: "Approved" }) })).status, 200);

  const read = fetchAs({ ...(await asToken(ws.workspaceId, ws.agentId, "read")), "content-type": "application/json" });
  assert.equal((await read(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: "x" }) })).status, 403);
  assert.equal((await read(api("/issues?project=CORE&limit=1"))).status, 200);
});

test("delete into the trash and restore; a deleted issue is out of lists and takes no edits until restored", async () => {
  const created = await json<{ key: string }>(agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: "to the trash" }) }));
  const key = created.key;
  const del = await agent(api(`/issues/${key}`), { method: "DELETE" });
  assert.equal(del.status, 200, await del.clone().text());
  const gone = await json<View & { deletedAt: string | null }>(agent(api(`/issues/${key}`)));
  assert.ok(gone.deletedAt, "a deleted issue is still read by key, with its time");
  const list = await json<{ issues: View[] }>(agent(api(`/issues?project=CORE&q=${encodeURIComponent('"to the trash"')}`)));
  assert.ok(!list.issues.some((i) => i.key === key));
  const edit = await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ title: "x" }) });
  assert.equal(edit.status, 400);
  assert.equal((await json<{ error: string }>(edit)).error, "deleted");
  assert.equal((await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ deleted: false, title: "back" }) })).status, 200);
  const back = await json<View & { deletedAt: string | null }>(agent(api(`/issues/${key}`)));
  assert.equal(back.deletedAt, null);
  assert.equal(back.title, "back");
  // Archive needs a closed state; true and false only.
  assert.equal((await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ archived: true }) })).status, 400);
  assert.equal((await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ archived: "yes" }) })).status, 400);
  assert.equal((await agent(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ state: "Done", archived: true }) })).status, 200);
  assert.ok((await json<{ archivedAt: string | null }>(agent(api(`/issues/${key}`)))).archivedAt);
  // Someone else's issue: the agent is a member, not its creator.
  const { issue } = await issueWithRefs(ws.workspaceId, "CORE");
  const theirs = await agent(api(`/issues/CORE-${issue.number}`), { method: "DELETE" });
  assert.equal(theirs.status, 403);
  assert.equal((await json<{ error: string }>(theirs)).error, "forbidden");
});

test("past the write budget a write answers 429 rate_limited with retry-after, and nothing is written (PLNR-411)", async (t) => {
  // The budget refills all the time: stop the clock it reads, so the drained budget stays drained.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // A member of their own: the budget is per person, and the agent's is used by the other tests.
  const m = await addMember(ws.workspaceId, "member");
  const as = fetchAs({ ...(await asToken(ws.workspaceId, m.id)), "content-type": "application/json" });
  const { issue, project } = await issueWithRefs(ws.workspaceId, "CORE");
  const key = `${project.key}-${issue.number}`;
  // Their sockets would have used it up the same way: the budget is shared (sync/limits.ts).
  while (takeWrite(m.id, 1, 0));
  const r = await as(api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ title: "over the budget" }) });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) >= 1, "it says how long to wait");
  assert.deepEqual(await r.json(), { error: "rate_limited", message: "too many changes" });
  assert.notEqual((await json<View>(as(api(`/issues/${key}`)))).title, "over the budget");
});

test("relations and links by key: both ends in the issue, a pair keeps one relation, links by address", async () => {
  const make = async (title: string) => (await json<{ key: string }>(agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title }) }))).key;
  const [a, b, c] = [await make("rel a"), await make("rel b"), await make("rel c")];
  const post = (key: string, body: object) => agent(api(`/issues/${key}/relations`), { method: "POST", body: JSON.stringify(body) });
  assert.equal((await post(a, { type: "blocks", issue: b })).status, 200);
  assert.equal((await post(a, { type: "related", issue: c })).status, 200);
  const view = async (key: string) => json<{ relations: Record<string, unknown>; links: { id: string; kind: string; url: string; title: string; createdBy: string }[] }>(agent(api(`/issues/${key}`)));
  assert.deepEqual((await view(a)).relations, { blockedBy: [], blocks: [b], related: [c], duplicateOf: null, duplicates: [] });
  assert.deepEqual((await view(b)).relations.blockedBy, [a]);
  assert.deepEqual((await view(c)).relations.related, [a]);
  // Another kind for the same pair replaces the first.
  await post(b, { type: "duplicateOf", issue: a });
  assert.deepEqual((await view(b)).relations, { blockedBy: [], blocks: [], related: [], duplicateOf: a, duplicates: [] });
  assert.equal((await agent(api(`/issues/${c}/relations/${a}`), { method: "DELETE" })).status, 200);
  assert.deepEqual((await view(a)).relations.related, []);
  assert.equal((await post(a, { type: "parent", issue: b })).status, 400);
  assert.equal((await post(a, { type: "blocks", issue: "CORE-999999" })).status, 400);
  assert.equal((await post(a, { type: "blocks", issue: a })).status, 400);

  const link = await agent(api(`/issues/${a}/links`), { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/app/pull/7", title: "Fix" }) });
  assert.equal(link.status, 201);
  const { id } = await json<{ id: string }>(link);
  const [l] = (await view(a)).links;
  assert.deepEqual([l!.id, l!.kind, l!.title], [id, "github_pr", "Fix"]);
  assert.match(l!.createdBy, /^bot@/);
  assert.equal((await agent(api(`/issues/${a}/links`), { method: "POST", body: JSON.stringify({ url: "javascript:alert(1)" }) })).status, 400);
  // A link is removed through its own issue only.
  assert.equal((await agent(api(`/issues/${b}/links/${id}`), { method: "DELETE" })).status, 404);
  assert.equal((await agent(api(`/issues/${a}/links/${id}`), { method: "DELETE" })).status, 200);
  assert.deepEqual((await view(a)).links, []);
  // An id that is 36 hex digits and dashes but no UUID is no link, comment or token: a 404, not the database's 500 (RSVA-428).
  const notUuid = "-".repeat(36);
  assert.equal((await agent(api(`/issues/${a}/links/${notUuid}`), { method: "DELETE" })).status, 404);
  assert.equal((await agent(api(`/issues/${a}/comments/${notUuid}`), { method: "DELETE" })).status, 404);
  assert.equal((await owner(api(`/tokens/${notUuid}`), { method: "DELETE" })).status, 404);
});

test("answers over 1 KB come compressed as asked (brotli, gzip), smaller ones and identity as they are (PLNR-234)", async () => {
  const get = (path: string, accept: string) => agent(api(path), { headers: { "accept-encoding": accept } });
  const plain = await json<{ total: number }>(get("/issues?project=CORE&limit=50", "identity"));
  for (const enc of ["br", "gzip"]) {
    const r = await get("/issues?project=CORE&limit=50", enc === "br" ? "br, gzip" : "gzip, deflate");
    assert.equal(r.headers.get("content-encoding"), enc);
    assert.equal(r.headers.get("vary"), "accept-encoding");
    assert.deepEqual(await r.json(), plain, `${enc}: the same answer`);
  }
  const noBrotli = await get("/issues?project=CORE&limit=50", "br;q=0, gzip");
  assert.equal(noBrotli.headers.get("content-encoding"), "gzip");
  assert.equal((await get("/issues?project=CORE&limit=50", "br;q=0")).headers.get("content-encoding"), null);
  const identity = await get("/issues?project=CORE&limit=50", "identity");
  assert.equal(identity.headers.get("content-encoding"), null);
  const small = await get("/issues?project=NOPE", "br");
  assert.equal(small.status, 400);
  assert.equal(small.headers.get("content-encoding"), null, "an error a few dozen bytes long is not worth it");
  // Bytes on the wire: fetch decodes, node:http does not.
  const raw = await new Promise<number>((resolve, reject) => {
    httpGet(api("/issues?project=CORE&limit=50"), { headers: { ...agentHeaders, "accept-encoding": "br" } }, (res) => {
      let n = 0;
      res.on("data", (c: Buffer) => (n += c.length));
      res.on("end", () => resolve(n));
    }).on("error", reject);
  });
  assert.ok(raw < JSON.stringify(plain).length / 3, `${raw} B compressed against ${JSON.stringify(plain).length} B`);
});

test("PATCH many issues (RSVA-303): one change by name in each one's project, lists added to and taken from, rights first", async () => {
  const create = async (labels: string[]) => (await json<{ key: string }>(agent(api("/issues"), { method: "POST", body: JSON.stringify({ project: "CORE", title: `Bulk ${randomUUID()}`, labels, force: true }) }))).key;
  const a = await create(["bug"]);
  const b = await create(["chore"]);
  const many = (body: Record<string, unknown>) => agent(api("/issues"), { method: "PATCH", body: JSON.stringify(body) });

  const r = await many({ keys: [a, b.toLowerCase()], state: "In Progress", priority: "high", addLabels: ["Bug"], removeLabels: ["chore"], addAssignees: ["me"] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await json<{ changed: number }>(r)).changed, 2);
  for (const k of [a, b]) {
    const got = await json<View>(agent(api(`/issues/${k}`)));
    assert.deepEqual([got.state, got.priority, got.labels, got.assignees], ["In Progress", "high", ["bug"], [`bot@${ws.slug}.test`]], k);
  }
  // Nothing left to change: no write.
  assert.equal((await json<{ changed: number }>(many({ keys: [a, b], addLabels: ["bug"] }))).changed, 0);
  await many({ keys: [a, b], removeAssignees: ["me"] });
  assert.deepEqual((await json<View>(agent(api(`/issues/${a}`)))).assignees, []);

  // Refusals: no keys, nothing to change, a list replaced and changed at once, a move, an unknown name, an unknown key.
  for (const body of [{ state: "Done" }, { keys: [a] }, { keys: [a], labels: [], addLabels: ["bug"] }, { keys: [a], project: "CORE" }, { keys: [a], addLabels: ["nope"] }, { keys: [a, "CORE-999999"], priority: 1 }])
    assert.equal((await many(body)).status, 400, JSON.stringify(body));
  // An agent may not set Approved on any of them: none changes.
  assert.equal((await many({ keys: [a, b], state: "Approved" })).status, 403);
  assert.equal((await json<View>(agent(api(`/issues/${b}`)))).state, "In Progress");

  // A deleted issue takes no change until restored, which the same call may do.
  await agent(api(`/issues/${b}`), { method: "DELETE" });
  assert.equal((await many({ keys: [a, b], priority: 2 })).status, 400);
  assert.equal((await many({ keys: [a, b], deleted: true })).status, 400);
  assert.equal((await many({ keys: [b], deleted: false })).status, 200);
  assert.equal((await many({ keys: [a, b], deleted: true })).status, 200);
});
