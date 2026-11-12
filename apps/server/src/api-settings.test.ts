// The agent API's settings (PLNR-239): projects, states, labels, the workspace, members, views, comment edits.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { LABEL_COLORS } from "@rsva/schema/settings";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { applyTx } from "./sync/write.ts";
import { importFixture, jsonTokens, startServer, type Fixture } from "./test/helpers.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
/** The agent's token (a member at most) and the owner's own token. */
let agent: typeof fetch;
let owner: typeof fetch;
before(async () => {
  [server, ws] = await Promise.all([startServer(), importFixture()]);
  ({ agent, owner } = await jsonTokens(ws));
});
after(() => server.close());

const api = (path: string) => `${server.url}/api/v1/workspaces/${ws.slug}${path}`;
const call = async <T = Record<string, unknown>>(as: typeof fetch, method: string, path: string, body?: unknown) => {
  const r = await as(api(path), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, data: (await r.json()) as T & { error?: string; message?: string } };
};
const ok = async <T = Record<string, unknown>>(as: typeof fetch, method: string, path: string, body?: unknown) => {
  const r = await call<T>(as, method, path, body);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
type State = { name: string; group: string; default: boolean; onlyPeople: boolean; issues: number };
type LabelRow = { name: string; color: string; parent: string | null; depth: number; issues: number };

test("an agent reads the workspace, members, projects, states, labels and views, and cannot change settings", async () => {
  const me = await ok<{ slug: string; me: { kind: string; role: string; scope: string } }>(agent, "GET", "/workspace");
  assert.equal(me.slug, ws.slug);
  assert.deepEqual([me.me.kind, me.me.role, me.me.scope], ["agent", "member", "write"]);
  const members = await ok<{ role: string; kind: string }[]>(agent, "GET", "/members");
  assert.equal(members[0]!.role, "owner", "by role, the owner first");
  assert.ok(members.some((m) => m.kind === "agent"));
  const projects = await ok<{ key: string }[]>(agent, "GET", "/projects");
  assert.ok(projects.some((p) => p.key === "CORE"));
  const core = await ok<{ key: string; states: State[]; labels: LabelRow[] }>(agent, "GET", "/projects/core");
  assert.equal(core.key, "CORE");
  assert.equal(core.states.filter((s) => s.default).length, 1);
  assert.ok(core.labels.length > 0 && core.labels.some((l) => l.issues > 0));
  assert.deepEqual(await ok(agent, "GET", "/states?project=CORE"), core.states);
  assert.ok(Array.isArray(await ok(agent, "GET", "/views")));

  // An agent's role is at most member: labels, open to members by default, it makes; what the workspace did not open
  // needs an admin, and the refusal names the model and the way to open it (ADR 0037).
  assert.deepEqual((await ok<{ memberRights: string[] }>(agent, "GET", "/workspace")).memberRights, ["labels.write"]);
  assert.equal((await call(agent, "POST", "/labels", { project: "CORE", name: "agent-made" })).status, 201);
  const refused = await call(agent, "POST", "/states", { project: "CORE", name: "Agent state", group: "started" });
  assert.equal(refused.status, 403);
  assert.match(refused.data.message!, /member cannot change WorkflowState; an admin can open States to members/);
  assert.equal((await call(agent, "PATCH", "/workspace", { name: "Taken" })).status, 403);
});

test("projects: created with the default workflow, a new key keeps the old one as an alias, archived and back, rollover on and off", async () => {
  const made = await ok<{ key: string }>(owner, "POST", "/projects", { key: "shop", name: "Shop", color: "teal" });
  assert.equal(made.key, "SHOP");
  const states = await ok<State[]>(owner, "GET", "/states?project=SHOP");
  assert.deepEqual(states.map((s) => s.name), ["Backlog", "Todo", "In Progress", "Done", "Cancelled"]);
  assert.deepEqual(states.filter((s) => s.onlyPeople).map((s) => s.name), ["Todo"], "a new project's Todo is the people's");
  assert.equal(states.find((s) => s.default)?.name, "Backlog");
  assert.equal((await call(owner, "POST", "/projects", { key: "SHOP", name: "Again" })).data.error, "conflict");
  const badColor = await call(owner, "PATCH", "/projects/SHOP", { color: "mauve" });
  assert.equal(badColor.data.error, "bad_ref");
  assert.match(badColor.data.message!, /teal/);
  assert.equal((await call(owner, "PATCH", "/projects/SHOP", {})).data.error, "invalid", "nothing to change");

  await ok(owner, "PATCH", "/projects/SHOP", { key: "store", name: "Store" });
  const renamed = await ok<{ key: string; name: string; formerKeys: string[]; color: string }>(owner, "GET", "/projects/SHOP");
  assert.deepEqual([renamed.key, renamed.name, renamed.formerKeys, renamed.color], ["STORE", "Store", ["SHOP"], "teal"]);
  // A query or a saved view written with the old key still finds the project (PLNR-455).
  const made1 = await ok<{ key: string }>(owner, "POST", "/issues", { project: "STORE", title: "Under the new key" });
  await db.insert(schema.savedView).values({ workspaceId: ws.workspaceId, ownerId: ws.ownerId, name: "Old shop", icon: "list", query: "project:SHOP state:Backlog", display: {} });
  const listed = await ok<{ issues: { key: string }[] }>(owner, "GET", `/issues?q=${encodeURIComponent("project:SHOP state:Backlog")}`);
  assert.deepEqual(listed.issues.map((i) => i.key), [made1.key]);
  assert.deepEqual((await ok<{ issues: { key: string }[] }>(owner, "GET", `/issues?view=${encodeURIComponent("Old shop")}`)).issues.map((i) => i.key), [made1.key]);
  await ok(owner, "PATCH", "/projects/STORE", { archived: true });
  assert.ok((await ok<{ archivedAt: string | null }>(owner, "GET", "/projects/STORE")).archivedAt);
  await ok(owner, "PATCH", "/projects/STORE", { archived: false });
  assert.equal((await ok<{ archivedAt: string | null }>(owner, "GET", "/projects/STORE")).archivedAt, null);

  // Cycle rollover (PLNR-64): off for a new project, a switch like `archived`.
  const rollover = async () => (await ok<{ rollover: boolean }>(owner, "GET", "/projects/STORE")).rollover;
  assert.equal(await rollover(), false);
  await ok(owner, "PATCH", "/projects/STORE", { rollover: true });
  assert.equal(await rollover(), true);
  assert.match((await call(owner, "PATCH", "/projects/STORE", { rollover: "on" })).data.message!, /rollover: true or false/);
  await ok(owner, "PATCH", "/projects/STORE", { rollover: false });
  assert.equal(await rollover(), false);
});

test("states: placed in their group, the default moves, deleting one moves its issues", async () => {
  await ok(owner, "POST", "/projects", { key: "FLOW", name: "Flow" });
  await ok(owner, "POST", "/states", { project: "FLOW", name: "In Review", group: "started", after: "In Progress" });
  await ok(owner, "POST", "/states", { project: "FLOW", name: "Triage", group: "backlog", before: "Backlog" });
  const names = async () => (await ok<State[]>(owner, "GET", "/states?project=FLOW")).map((s) => s.name);
  assert.deepEqual(await names(), ["Triage", "Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"]);
  const misplaced = await call(owner, "POST", "/states", { project: "FLOW", name: "Odd", group: "started", after: "Todo" });
  assert.match(misplaced.data.message!, /its group \(started\)/);

  await ok(owner, "PATCH", "/states/in%20review?project=FLOW", { name: "Review", group: "completed" });
  assert.deepEqual(await names(), ["Triage", "Backlog", "Todo", "In Progress", "Done", "Review", "Cancelled"], "last in its new group");
  await ok(owner, "PATCH", "/states/Review?project=FLOW", { default: true });
  const defaults = (await ok<State[]>(owner, "GET", "/states?project=FLOW")).filter((s) => s.default).map((s) => s.name);
  assert.deepEqual(defaults, ["Review"]);
  assert.equal((await call(owner, "PATCH", "/states/Review?project=FLOW", { default: false })).data.error, "bad_ref");

  const issue = await ok<{ key: string }>(owner, "POST", "/issues", { project: "FLOW", title: "Waits for review" });
  const empty = await call(owner, "DELETE", "/states/Review?project=FLOW");
  assert.match(empty.data.message!, /moveTo: the state its 1 issues go to/);
  assert.equal((await ok<{ moved: number }>(owner, "DELETE", "/states/Review?project=FLOW&moveTo=Todo")).moved, 1);
  assert.equal((await ok<{ state: string }>(owner, "GET", `/issues/${issue.key}`)).state, "Todo");
  const after = await ok<State[]>(owner, "GET", "/states?project=FLOW");
  assert.deepEqual([after.length, after.find((s) => s.default)?.name], [6, "Todo"], "the default went with the issues");
  assert.equal((await ok<{ moved: number }>(owner, "DELETE", "/states/Triage?project=FLOW")).moved, 0, "an empty state needs no moveTo");
});

test("labels: a tree, the app's next color, rename; deleting takes it off issues and its labels up a level", async () => {
  await ok(owner, "POST", "/projects", { key: "TAGS", name: "Tags" });
  // The next color after the labels the project can use, the workspace's among them, as the settings screen counts.
  const usable = (await ok<LabelRow[]>(owner, "GET", "/labels?project=TAGS")).length;
  const area = await ok<{ name: string; color: string }>(owner, "POST", "/labels", { project: "TAGS", name: " area\u200b" });
  assert.deepEqual([area.name, area.color], ["area", LABEL_COLORS[usable % LABEL_COLORS.length]!.value], "the name as stored, the app's next color");
  await ok(owner, "POST", "/labels", { project: "TAGS", name: "ui", parent: "area", color: "blue" });
  const tree = async () => (await ok<LabelRow[]>(owner, "GET", "/labels?project=TAGS")).filter((l) => ["area", "ui", "frontend"].includes(l.name));
  assert.deepEqual(
    (await tree()).map((l) => [l.name, l.color, l.parent, l.depth]),
    [
      ["area", area.color, null, 0],
      ["ui", "#0090FF", "area", 1],
    ],
  );
  assert.equal((await call(owner, "POST", "/labels", { project: "TAGS", name: "UI" })).data.error, "conflict", "names are unique, any case");
  assert.equal((await call(owner, "PATCH", "/labels/ui?project=TAGS", { color: "#12345" })).data.error, "bad_ref");

  await ok(owner, "PATCH", "/labels/ui?project=TAGS", { name: "frontend" });
  const issue = await ok<{ key: string }>(owner, "POST", "/issues", { project: "TAGS", title: "Labelled", labels: ["frontend", "area"] });
  assert.equal((await ok<{ removedFrom: number }>(owner, "DELETE", "/labels/area?project=TAGS")).removedFrom, 1);
  assert.deepEqual((await tree()).map((l) => [l.name, l.parent, l.depth, l.issues]), [["frontend", null, 0, 1]], "up a level");
  assert.deepEqual((await ok<{ labels: string[] }>(owner, "GET", `/issues/${issue.key}`)).labels, ["frontend"]);
});

test("the workspace's name and color by a person's token", async () => {
  const before = await ok<{ name: string; color: string | null }>(owner, "GET", "/workspace");
  await ok(owner, "PATCH", "/workspace", { name: "Renamed", color: "plum" });
  const now = await ok<{ name: string; color: string | null }>(owner, "GET", "/workspace");
  assert.deepEqual([now.name, now.color], ["Renamed", "plum"]);
  await ok(owner, "PATCH", "/workspace", { name: before.name, color: before.color });
});

test("comments: the author edits and deletes their own; another's comment is refused", async () => {
  const issue = await ok<{ key: string }>(agent, "POST", "/issues", { project: "CORE", title: "Talked about" });
  const { id } = await ok<{ id: string }>(agent, "POST", `/issues/${issue.key}/comments`, { body: "first words" });
  await ok(agent, "PATCH", `/issues/${issue.key}/comments/${id}`, { body: "better words, [](mention:me)" });
  type Comments = { comments: { id: string; body: string; editedAt: string | null }[] };
  const [edited] = (await ok<Comments>(agent, "GET", `/issues/${issue.key}/comments`)).comments;
  assert.match(edited!.body, /^better words, \[@.+\]\(mention:[0-9a-f-]{36}\)$/);
  assert.ok(edited!.editedAt);
  const others = await call(owner, "PATCH", `/issues/${issue.key}/comments/${id}`, { body: "not mine" });
  assert.deepEqual([others.status, others.data.error], [403, "forbidden"], "a refusal of the pipeline answers as its code says (PLNR-411)");
  assert.equal((await call(agent, "DELETE", `/issues/CORE-1/comments/${id}`)).status, 404, "a comment of another issue");
  await ok(agent, "DELETE", `/issues/${issue.key}/comments/${id}`);
  assert.deepEqual((await ok<Comments>(agent, "GET", `/issues/${issue.key}/comments`)).comments, []);
});

test("rights come before any write: the agent's delete of a label on more issues than one transaction holds changes nothing; a person's goes in several", async () => {
  // A workspace label, as imports make them, on every issue of the workspace and on 80 new ones: more than one transaction.
  const id = randomUUID();
  const { label, issue } = schema;
  await db.insert(label).values({ id, workspaceId: ws.workspaceId, projectId: null, name: "wide", color: "#8D8D86", position: 999 });
  await db.update(issue).set({ labelIds: sql`array_append(${issue.labelIds}, ${id}::uuid)` }).where(eq(issue.workspaceId, ws.workspaceId));
  for (let i = 0; i < 80; i++) await ok(owner, "POST", "/issues", { project: "CORE", title: `Wide ${i}`, labels: ["wide"] });
  const carrying = async () => (await ok<LabelRow[]>(owner, "GET", "/labels?project=CORE")).find((l) => l.name === "wide")?.issues;
  const n = (await carrying())!;
  assert.ok(n > 500, `${n} issues: more than one transaction`);

  // Labels closed to members for this test: the agent's delete is refused before any of its transactions.
  const rights = (r: string[]) => applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Workspace", id: ws.workspaceId, set: { memberRights: r } }]);
  await rights([]);
  const refused = await call(agent, "DELETE", "/labels/wide?project=CORE");
  await rights(["labels.write"]);
  assert.deepEqual([refused.status, refused.data.message], [403, "a member cannot change Label; an admin can open Labels to members in Settings › Members"]);
  assert.equal(await carrying(), n, "not one issue lost it");
  assert.equal((await ok<{ removedFrom: number }>(owner, "DELETE", "/labels/wide?project=CORE")).removedFrom, n);
  assert.equal(await carrying(), undefined, "gone, and off every issue");
});
