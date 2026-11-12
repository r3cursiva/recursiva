// Moving issues between projects (PLNR-448): one update that keeps the issue's id and everything hung on it, a new number
// in the target, the old key still finding it, and what belongs to a project mapped. Then the ways it can meet other
// changes: the same issue moved twice at once, new issues in the target meanwhile, an edit sent against the project the
// issue has left, a replayed transaction, a key handed over while issues move, agents and the process rules.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { newProjectOps, uuidv7, type Op } from "@rsva/protocol";
import type { Issue } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { asToken, fetchAs, fileFixture, lastSyncId, rejects } from "../test/helpers.ts";
import { snapshot } from "./bootstrap.ts";
import { readProjectHistory } from "./project-history.ts";
import { readHistory } from "./history.ts";
import { applyTx } from "./write.ts";

const { project, workflowState, label, issue, comment, attachment, document, syncAction } = schema;

const f = fileFixture();
const tx = (ops: Op[], actor = f.ws.ownerId, id: string = randomUUID()) => applyTx(f.ws.workspaceId, actor, id, ops);
/** As the owner signed in: the guarded states (Todo) of the test projects are theirs to rename and delete. */
const admin = (ops: Op[]) => applyTx(f.ws.workspaceId, f.ws.ownerId, randomUUID(), ops, true);

/** A key no other test of this file uses. */
let keys = 0;
const nextKey = (p: string) => `${p}${Date.now().toString(36).toUpperCase().slice(-4)}${keys++}`.slice(0, 12);

/** A new project with Plane's workflow and these labels; its rows. */
async function newProject(prefix: string, labelNames: string[] = []) {
  const id = uuidv7();
  const key = nextKey(prefix);
  await tx([...newProjectOps(id, { name: `Project ${key}`, key }, uuidv7), ...labelNames.map((name, i): Op => ({ op: "create", m: "Label", id: uuidv7(), set: { projectId: id, name, color: "#123456", position: i } }))]);
  const states = await db.select().from(workflowState).where(eq(workflowState.projectId, id)).orderBy(workflowState.position);
  const labels = await db.select().from(label).where(eq(label.projectId, id)).orderBy(label.position);
  const state = (name: string) => states.find((s) => s.name === name)!;
  const lbl = (name: string) => labels.find((l) => l.name === name)!;
  return { id, key, states, labels, state, label: lbl };
}
type P = Awaited<ReturnType<typeof newProject>>;

async function newIssue(p: P, set: Record<string, unknown> = {}): Promise<Issue> {
  const id = uuidv7();
  await tx([{ op: "create", m: "Issue", id, projectId: p.id, set: { title: `issue ${id.slice(-6)}`, stateId: p.state("Backlog").id, ...set } } as Op]);
  return row(id);
}
const row = async (id: string) => (await db.select().from(issue).where(eq(issue.id, id)))[0]! as Issue;
const projectRow = async (id: string) => (await db.select().from(project).where(eq(project.id, id)))[0]!;
const move = (id: string, projectId: string, set: Record<string, unknown> = {}, actor?: string) => tx([{ op: "update", m: "Issue", id, set: { projectId, ...set } } as Op], actor);

/** A workspace label (no project): imports make them; the app does not yet. */
async function workspaceLabel(name: string) {
  const [l] = await db.insert(label).values({ id: uuidv7(), workspaceId: f.ws.workspaceId, projectId: null, name, color: "#654321", position: 0 }).returning();
  return l!;
}

const api = async () => fetchAs({ ...(await asToken(f.ws.workspaceId, f.ws.ownerId)), "content-type": "application/json" });
const url = (path: string) => `${f.server.url}/api/v1/workspaces/${f.ws.slug}${path}`;

test("a move keeps the issue: same id, comments, links, description, relations and parent; new number, old key kept", async () => {
  const src = await newProject("SRC", ["bug", "only-here"]);
  const dst = await newProject("DST", ["Bug"]);
  const shared = await workspaceLabel(`shared-${randomUUID().slice(0, 6)}`);
  const parent = await newIssue(src);
  const blocker = await newIssue(src);
  const c = uuidv7();
  await tx([{ op: "create", m: "Cycle", id: c, set: { projectId: src.id, name: "Now" } } as Op]);
  const i = await newIssue(src, {
    stateId: src.state("In Progress").id,
    labelIds: [src.label("bug").id, shared.id, src.label("only-here").id],
    parentId: parent.id,
    blockedByIds: [blocker.id],
    cycleId: c,
    priority: 2,
  });
  const other = await newIssue(src, { relatedIds: [i.id] });
  await tx([
    { op: "create", m: "Comment", id: uuidv7(), set: { issueId: i.id, body: "keep me" } },
    { op: "create", m: "Attachment", id: uuidv7(), set: { issueId: i.id, url: "https://example.com/x", title: "x" } },
    { op: "update", m: "Document", id: i.id, set: { doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] } } },
  ]);
  const before = await row(i.id);

  const r = await move(i.id, dst.id);
  assert.equal(r.actions.length, 1, "one action: other clients apply one delta");
  const a = r.actions[0]!;
  assert.equal(a.m, "Issue");
  assert.equal(a.a, "U");
  assert.equal(a.mid, i.id);
  assert.equal(a.d!.projectId, dst.id);
  assert.equal(a.d!.number, 1, "the target's first number");
  assert.deepEqual(a.d!.formerKeys, [`${src.key}-${before.number}`]);
  assert.equal(a.d!.stateId, dst.state("In Progress").id, "the state of the same name");
  assert.deepEqual(a.d!.labelIds, [dst.label("Bug").id, shared.id], "a project label by name (any case), a workspace label stays, one without a match goes");
  assert.equal(a.d!.cycleId, null, "the cycle is cleared");

  const after = await row(i.id);
  assert.equal(after.projectId, dst.id);
  assert.equal(after.parentId, parent.id, "a parent in the old project stays");
  assert.deepEqual(after.blockedByIds, [blocker.id]);
  assert.equal(after.priority, 2);
  assert.equal(after.createdById, before.createdById);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual((await row(other.id)).relatedIds, [i.id], "the other end of a relation still points at it");
  assert.equal((await db.select().from(comment).where(eq(comment.issueId, i.id))).length, 1);
  assert.equal((await db.select().from(attachment).where(eq(attachment.issueId, i.id))).length, 1);
  assert.equal((await db.select().from(document).where(eq(document.id, i.id)))[0]!.id, i.id);
  assert.equal((await projectRow(dst.id)).issueCounter, 1);
  assert.equal((await projectRow(src.id)).issueCounter, 4, "the old project's numbers are not given back");

  // The log keeps what it was: the history says the move and the key it left.
  const [logged] = await db.select().from(syncAction).where(and(eq(syncAction.workspaceId, f.ws.workspaceId), eq(syncAction.id, a.id)));
  assert.equal((logged!.prev as Record<string, unknown>).projectId, src.id);
  assert.equal((logged!.prev as Record<string, unknown>).cycleId, c);
  const h = await readHistory(f.ws.ownerId, i.id);
  assert.ok(h && h !== "rate_limited");
  const entry = h.history.find((e) => e.id === a.id)!;
  assert.equal(entry.was, `${src.key}-${before.number}`);
  assert.equal(entry.d.projectId, dst.id);
  assert.equal(entry.p.projectId, src.id);
  assert.equal(h.comments.length, 1, "comments come with the moved issue");
});

test("the old key finds the moved issue in the API and as a relation's other end; a key a project answers to wins", async () => {
  const src = await newProject("OK");
  const dst = await newProject("NK");
  const i = await newIssue(src);
  const j = await newIssue(src);
  const old = `${src.key}-${i.number}`;
  await move(i.id, dst.id);
  const fetch = await api();

  const got = await fetch(url(`/issues/${old.toLowerCase()}`));
  assert.equal(got.status, 200);
  const body = (await got.json()) as { key: string };
  assert.equal(body.key, `${dst.key}-1`);

  // Relate through the old key: it resolves to the moved issue.
  const rel = await fetch(url(`/issues/${src.key}-${j.number}/relations`), { method: "POST", body: JSON.stringify({ type: "blocks", issue: old }) });
  assert.equal(rel.status, 200);
  assert.deepEqual((await row(i.id)).blockedByIds, [j.id]);

  // Moved again and back: every key it had finds it; back home it gets a new number, the old one is not reused.
  const third = await newProject("TK");
  await move(i.id, third.id);
  await move(i.id, src.id);
  const back = await row(i.id);
  assert.equal(back.number, 3);
  assert.deepEqual(back.formerKeys, [old, `${dst.key}-1`, `${third.key}-1`]);
  for (const k of [old, `${dst.key}-1`, `${third.key}-1`, `${src.key}-3`]) {
    const r = await fetch(url(`/issues/${k}`));
    assert.equal(r.status, 200, k);
    assert.equal(((await r.json()) as { key: string }).key, `${src.key}-3`, k);
  }
  // An issue that is the project's own under that number wins over an old key of another.
  const own = await newIssue(dst); // DST-2
  const r = await fetch(url(`/issues/${dst.key}-2`));
  assert.equal(((await r.json()) as { title: string }).title, own.title);
});

test("state mapping: same name, else the same group (its default first), else the default; labels without a match go", async () => {
  const src = await newProject("SM", ["a", "b"]);
  const dst = await newProject("DM", ["B"]);
  // The target has no "In Progress" but two started states, and its default in Backlog.
  const review = uuidv7();
  await tx([
    { op: "update", m: "WorkflowState", id: dst.state("In Progress").id, set: { name: "Doing", position: 3500 } },
    { op: "create", m: "WorkflowState", id: review, set: { projectId: dst.id, name: "Review", group: "started", position: 3200 } },
  ]);
  const i = await newIssue(src, { stateId: src.state("In Progress").id, labelIds: [src.label("a").id, src.label("b").id] });
  const r = await move(i.id, dst.id);
  assert.equal(r.actions[0]!.d!.stateId, review, "the first started state by position");
  assert.deepEqual(r.actions[0]!.d!.labelIds, [dst.label("B").id]);

  // A state of a group the target lacks: the target's default.
  await tx([
    { op: "update", m: "WorkflowState", id: src.state("Cancelled").id, set: { name: "Dropped" } },
  ]);
  const lone = await newProject("LN");
  // Lone has only Backlog (default) and Done.
  for (const n of ["Todo", "In Progress", "Cancelled"]) await admin([{ op: "delete", m: "WorkflowState", id: lone.state(n).id }]);
  const k = await newIssue(src, { stateId: src.state("Cancelled").id });
  const moved = await move(k.id, lone.id);
  assert.equal(moved.actions[0]!.d!.stateId, lone.state("Backlog").id);
  assert.ok((await row(k.id)).completedAt === null, "out of a closed state: no longer completed");
});

test("given fields win when they are the target's; a cycle of the old project is cleared; another project's label is refused", async () => {
  const src = await newProject("GS", ["x"]);
  const dst = await newProject("GD", ["x", "y"]);
  const third = await newProject("GT", ["z"]);
  const c = uuidv7();
  await tx([{ op: "create", m: "Cycle", id: c, set: { projectId: dst.id, name: "Target cycle" } } as Op]);
  const i = await newIssue(src, { labelIds: [src.label("x").id] });
  const r = await move(i.id, dst.id, { stateId: dst.state("Done").id, labelIds: [dst.label("y").id], cycleId: c });
  assert.equal(r.actions[0]!.d!.stateId, dst.state("Done").id);
  assert.deepEqual(r.actions[0]!.d!.labelIds, [dst.label("y").id]);
  assert.equal(r.actions[0]!.d!.cycleId, c);
  assert.ok((await row(i.id)).completedAt, "into a completed state: completed");

  const srcCycle = uuidv7();
  await tx([{ op: "create", m: "Cycle", id: srcCycle, set: { projectId: src.id, name: "Old" } } as Op]);
  const j = await newIssue(src);
  const moved = await move(j.id, dst.id, { cycleId: srcCycle });
  assert.equal((await row(j.id)).cycleId, null);
  assert.equal(moved.actions[0]!.d!.cycleId, undefined, "it had none: no change to say");

  const k = await newIssue(src);
  await rejects(move(k.id, dst.id, { labelIds: [third.label("z").id] }), "bad_ref");
  assert.equal((await row(k.id)).projectId, src.id, "a refused move leaves the issue where it was");
});

test("closed to closed keeps completedAt as it is, null included: a move or a state change does not close it again (RSVA-453)", async () => {
  const src = await newProject("CS");
  const dst = await newProject("CD");
  // Imported closed without a time: the time of the move is not when it was closed.
  const k = await newIssue(src, { stateId: src.state("Cancelled").id });
  await db.update(issue).set({ completedAt: null }).where(eq(issue.id, k.id));
  const r = await move(k.id, dst.id);
  assert.equal(r.actions[0]!.d!.stateId, dst.state("Cancelled").id);
  assert.equal((await row(k.id)).completedAt, null, "moved: still no completion time");
  assert.ok(!("completedAt" in r.actions[0]!.d!), "no completedAt in the delta");
  await tx([{ op: "update", m: "Issue", id: k.id, set: { stateId: dst.state("Done").id } }]);
  assert.equal((await row(k.id)).completedAt, null, "Cancelled → Done: still none");

  // A time it had stays, across a move and into the other closed group.
  const d = await newIssue(src, { stateId: src.state("Done").id });
  const at = (await row(d.id)).completedAt;
  assert.ok(at);
  await move(d.id, dst.id, { stateId: dst.state("Cancelled").id });
  assert.equal((await row(d.id)).completedAt, at);

  // Open → closed sets it; closed → open clears it.
  await tx([{ op: "update", m: "Issue", id: k.id, set: { stateId: dst.state("Backlog").id } }]);
  assert.equal((await row(k.id)).completedAt, null);
  await tx([{ op: "update", m: "Issue", id: k.id, set: { stateId: dst.state("Done").id } }]);
  assert.ok((await row(k.id)).completedAt, "reopened, then closed: closed now");
});

test("refused: a deleted issue (restoring it in the same change moves it), an archived or unknown project; same project is no change", async () => {
  const src = await newProject("RS");
  const dst = await newProject("RD");
  const i = await newIssue(src);
  await tx([{ op: "update", m: "Issue", id: i.id, set: { deletedAt: new Date().toISOString() } }]);
  await rejects(move(i.id, dst.id), "bad_ref", /deleted/);
  await move(i.id, dst.id, { deletedAt: null });
  const r = await row(i.id);
  assert.equal(r.projectId, dst.id);
  assert.equal(r.deletedAt, null);

  const j = await newIssue(src);
  await rejects(move(j.id, randomUUID()), "bad_ref");
  await tx([{ op: "update", m: "Project", id: dst.id, set: { archivedAt: new Date().toISOString() } }]);
  await rejects(move(j.id, dst.id), "invalid", /archived/);
  await tx([{ op: "update", m: "Project", id: dst.id, set: { archivedAt: null } }]);
  assert.equal((await projectRow(dst.id)).issueCounter, 1, "refused moves take no number");

  const s = await lastSyncId(f.ws.workspaceId);
  assert.deepEqual((await move(j.id, src.id)).actions, []);
  assert.equal(await lastSyncId(f.ws.workspaceId), s);

  // An archived issue moves and stays archived.
  const k = await newIssue(src, { stateId: src.state("Done").id });
  await tx([{ op: "update", m: "Issue", id: k.id, set: { archivedAt: new Date().toISOString() } }]);
  await move(k.id, dst.id);
  assert.ok((await row(k.id)).archivedAt);
});

test("many at once: one transaction, numbers in order; one refusal and none of them moves", async () => {
  const src = await newProject("MS");
  const dst = await newProject("MD");
  const issues = [];
  for (let n = 0; n < 5; n++) issues.push(await newIssue(src));
  const ops: Op[] = issues.map((i) => ({ op: "update", m: "Issue", id: i.id, set: { projectId: dst.id } }));
  const r = await tx(ops);
  assert.deepEqual(r.actions.map((a) => a.d!.number), [1, 2, 3, 4, 5]);

  const more = [await newIssue(src), await newIssue(src)];
  await tx([{ op: "update", m: "Issue", id: more[1]!.id, set: { deletedAt: new Date().toISOString() } }]);
  await rejects(tx(more.map((i) => ({ op: "update", m: "Issue", id: i.id, set: { projectId: dst.id } }))), "bad_ref");
  assert.equal((await row(more[0]!.id)).projectId, src.id);
  assert.equal((await projectRow(dst.id)).issueCounter, 5);
});

test("at the same moment: one issue moved to two projects, issues created in the target, many moves: unique numbers, nothing lost", async () => {
  const src = await newProject("CS");
  const a = await newProject("CA");
  const b = await newProject("CB");
  const i = await newIssue(src);
  const results = await Promise.allSettled([move(i.id, a.id), move(i.id, b.id)]);
  assert.ok(results.every((x) => x.status === "fulfilled"), "both apply, one after the other under the row's lock");
  const r = await row(i.id);
  assert.ok([a.id, b.id].includes(r.projectId));
  assert.equal(r.formerKeys.length, 2, "it went through both");
  assert.equal(r.formerKeys[0], `${src.key}-${i.number}`);

  // Twenty issues moved into one project one by one while ten new ones are made there: every number once.
  const many = [];
  for (let n = 0; n < 20; n++) many.push(await newIssue(src));
  await Promise.all([...many.map((x) => move(x.id, a.id)), ...Array.from({ length: 10 }, () => newIssue(a))]);
  const rows = await db.select({ number: issue.number }).from(issue).where(eq(issue.projectId, a.id));
  const numbers = rows.map((x) => x.number).sort((x, y) => x - y);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal((await projectRow(a.id)).issueCounter, Math.max(...numbers));
  assert.equal(numbers.length, 30 + (r.projectId === a.id ? 1 : 0));

  // Two bulk moves of overlapping issues in opposite orders: no deadlock left to the caller, each issue moved once per transaction.
  const set = [];
  for (let n = 0; n < 6; n++) set.push(await newIssue(src));
  const ops = (to: string, order: Issue[]): Op[] => order.map((x) => ({ op: "update", m: "Issue", id: x.id, set: { projectId: to } }));
  await Promise.all([tx(ops(a.id, set)), tx(ops(b.id, [...set].reverse()))]);
  for (const x of set) {
    const now = await row(x.id);
    assert.ok([a.id, b.id].includes(now.projectId));
    assert.ok(now.formerKeys.length >= 1 && now.formerKeys.length <= 2);
  }
});

test("a replayed move is not applied twice: the same answer, one number taken", async () => {
  const src = await newProject("PS");
  const dst = await newProject("PD");
  const j = await newIssue(src);
  const id = randomUUID();
  const op: Op[] = [{ op: "update", m: "Issue", id: j.id, set: { projectId: dst.id } }];
  const [one, two] = await Promise.all([tx(op, f.ws.ownerId, id), tx(op, f.ws.ownerId, id)]);
  assert.equal(one.s, two.s);
  const third = await tx(op, f.ws.ownerId, id);
  assert.equal(third.s, one.s);
  assert.equal((await projectRow(dst.id)).issueCounter, 1);
  const r = await row(j.id);
  assert.equal(r.number, 1);
  assert.deepEqual(r.formerKeys, [`${src.key}-${j.number}`]);
});

test("an edit sent against the project the issue just left is carried over; one against an unrelated project is still refused", async () => {
  const src = await newProject("ES", ["frontend", "solo"]);
  const dst = await newProject("ED", ["Frontend"]);
  const elsewhere = await newProject("EX", ["frontend"]);
  const c = uuidv7();
  await tx([{ op: "create", m: "Cycle", id: c, set: { projectId: src.id, name: "Old cycle" } } as Op]);
  const i = await newIssue(src, { labelIds: [src.label("solo").id] });
  await move(i.id, dst.id);
  // A tab that has not seen the move yet: Done of the old project, its labels, its cycle, with the list it saw.
  const stale = await tx([
    { op: "update", m: "Issue", id: i.id, set: { stateId: src.state("Done").id, labelIds: [src.label("solo").id, src.label("frontend").id], cycleId: c }, base: { labelIds: [src.label("solo").id] } },
  ]);
  const r = await row(i.id);
  assert.equal(r.stateId, dst.state("Done").id);
  assert.deepEqual(r.labelIds, [dst.label("Frontend").id]);
  assert.equal(r.cycleId, null);
  assert.equal(stale.actions[0]!.d!.cycleId, undefined);

  // A project it never was in: the usual refusal.
  await rejects(tx([{ op: "update", m: "Issue", id: i.id, set: { stateId: elsewhere.state("Done").id } }]), "bad_ref");
  await rejects(tx([{ op: "update", m: "Issue", id: i.id, set: { labelIds: [elsewhere.label("frontend").id] } }]), "bad_ref");
  // An issue never moved keeps the strict check for its own project.
  const never = await newIssue(src);
  await rejects(tx([{ op: "update", m: "Issue", id: never.id, set: { stateId: dst.state("Done").id } }]), "bad_ref");
});

test("a label someone added while the move was on its way is mapped too", async () => {
  const src = await newProject("LS", ["one", "two"]);
  const dst = await newProject("LD", ["two"]);
  const i = await newIssue(src, { labelIds: [src.label("one").id] });
  // Someone adds "two" in the old project...
  await tx([{ op: "update", m: "Issue", id: i.id, set: { labelIds: [src.label("one").id, src.label("two").id] }, base: { labelIds: [src.label("one").id] } }]);
  // ...and the mover's browser, which saw only "one", sends the mapped list ("one" has no match: none) with what it saw.
  await tx([{ op: "update", m: "Issue", id: i.id, set: { projectId: dst.id, labelIds: [] }, base: { labelIds: [src.label("one").id] } }]);
  assert.deepEqual((await row(i.id)).labelIds, [dst.label("two").id]);
});

test("agents move issues too; a move does not take one into a state only people set unless it was in such a state", async () => {
  const src = await newProject("AS");
  const dst = await newProject("AD");
  const todo = await newIssue(src, { stateId: src.state("Todo").id });
  const r = await move(todo.id, dst.id, {}, f.ws.agentId);
  assert.equal(r.actions[0]!.d!.stateId, dst.state("Todo").id, "Todo stays Todo: a person's decision, kept");

  // The target's unstarted group starts with a guarded state: a Backlog-group issue is fine, an unguarded "Ready" is not.
  const strict = await newProject("AT");
  await admin([{ op: "update", m: "WorkflowState", id: src.state("Todo").id, set: { name: "Ready", onlyPeople: false } }]);
  const ready = await newIssue(src, { stateId: src.state("Todo").id });
  await rejects(move(ready.id, strict.id, {}, f.ws.agentId), "forbidden");
  assert.equal((await row(ready.id)).projectId, src.id);
  // A person may.
  await move(ready.id, strict.id);
  assert.equal((await row(ready.id)).stateId, strict.state("Todo").id);
  // Nor may an agent name the guarded state itself.
  const other = await newIssue(src);
  await rejects(move(other.id, dst.id, { stateId: dst.state("Todo").id }, f.ws.agentId), "forbidden");
});

test("an emptied project gives its key up; until then the key stays; the new owner wins over moved issues' old keys", async () => {
  const old = await newProject("OL");
  const sites = await newProject("SI");
  const taker = await newProject("TA");
  const a = await newIssue(old);
  const b = await newIssue(old);
  const fetch = await api();

  // The project still has issues: its key, current or former, is not to be had.
  await rejects(tx([{ op: "update", m: "Project", id: taker.id, set: { key: old.key } }]), "conflict", /exists/);
  await move(a.id, sites.id);
  await tx([{ op: "update", m: "Project", id: old.id, set: { key: nextKey("ZZ") } }]);
  await rejects(tx([{ op: "update", m: "Project", id: taker.id, set: { key: old.key } }]), "conflict", /1 issues/);
  // Emptied, but still holding the key as its own: it changes its key first.
  await move(b.id, sites.id);
  const renamed = await projectRow(old.id);
  assert.deepEqual(renamed.formerKeys, [old.key]);
  assert.equal((await fetch(url(`/issues/${old.key}-1`))).status, 200, "before the hand-over the old key leads to the moved issue");
  // Moved after the rename, b kept the project's key of then; its key under the project's key before still finds it.
  assert.deepEqual((await row(b.id)).formerKeys, [`${renamed.key}-2`]);
  const viaOld = await fetch(url(`/issues/${old.key}-2`));
  assert.equal(((await viaOld.json()) as { key: string }).key, `${sites.key}-2`);

  const r = await tx([{ op: "update", m: "Project", id: taker.id, set: { key: old.key } }]);
  const handed = r.actions.find((x) => x.m === "Project" && x.mid === old.id)!;
  assert.deepEqual(handed.d, { formerKeys: [] });
  assert.deepEqual((await projectRow(old.id)).formerKeys, []);
  const cleared = r.actions.filter((x) => x.m === "Issue");
  assert.deepEqual(cleared.map((x) => [x.mid, x.d]), [[a.id, { formerKeys: [] }]], "only the keys under the key handed over");
  assert.deepEqual((await row(a.id)).formerKeys, []);
  assert.deepEqual((await row(b.id)).formerKeys, [`${renamed.key}-2`], "its key under the project's present key stays");
  assert.equal((await fetch(url(`/issues/${renamed.key}-2`))).status, 200);

  // OL-1 is the taker's issue 1 from now on; it has none yet.
  assert.equal((await fetch(url(`/issues/${old.key}-1`))).status, 404);
  const own = await newIssue(taker);
  const got = await fetch(url(`/issues/${old.key}-${own.number}`));
  assert.equal(((await got.json()) as { title: string }).title, own.title);
  // The history still says where the issue came from, as text.
  const h = await readHistory(f.ws.ownerId, a.id);
  assert.ok(h && h !== "rate_limited" && h.history.some((e) => e.was === `${old.key}-1`));
  // The taker's own old key stays its alias.
  assert.deepEqual((await projectRow(taker.id)).formerKeys, [taker.key]);
});

test("the current key of an emptied project is refused with what to do; a new project takes a key given up; taking back one's own key keeps moved issues' keys", async () => {
  const p = await newProject("CK");
  const dst = await newProject("CD");
  const i = await newIssue(p);
  await move(i.id, dst.id);
  await rejects(tx([...newProjectOps(uuidv7(), { name: "New", key: p.key }, uuidv7)]), "conflict", /no issues: change its key first/);
  // The project renames and takes its own key back: the moved issue keeps its old key.
  const tmp = nextKey("TM");
  await tx([{ op: "update", m: "Project", id: p.id, set: { key: tmp } }]);
  await tx([{ op: "update", m: "Project", id: p.id, set: { key: p.key } }]);
  assert.deepEqual((await row(i.id)).formerKeys, [`${p.key}-1`]);
  // Renamed again, a new project takes the key it gave up.
  await tx([{ op: "update", m: "Project", id: p.id, set: { key: nextKey("TN") } }]);
  const fresh = uuidv7();
  const r = await tx(newProjectOps(fresh, { name: "Fresh", key: p.key }, uuidv7));
  assert.ok(r.actions.some((x) => x.m === "Project" && x.a === "I" && x.mid === fresh));
  assert.ok(!(await projectRow(p.id)).formerKeys.includes(p.key));
  assert.deepEqual((await row(i.id)).formerKeys, []);
});

test("a key handed over while the last issue moves out: either order ends consistent", async () => {
  for (let round = 0; round < 3; round++) {
    const p = await newProject("HO");
    const dst = await newProject("HD");
    const taker = await newProject("HT");
    const i = await newIssue(p);
    const j = await newIssue(p);
    const renamed = nextKey("HR");
    // One issue goes before the rename (its key under the old one), the last one races the hand-over.
    await move(i.id, dst.id);
    await tx([{ op: "update", m: "Project", id: p.id, set: { key: renamed } }]);
    const [moved, took] = await Promise.allSettled([move(j.id, dst.id), tx([{ op: "update", m: "Project", id: taker.id, set: { key: p.key } }])]);
    assert.equal(moved.status, "fulfilled");
    assert.deepEqual((await row(j.id)).formerKeys, [`${renamed}-2`]);
    if (took.status === "fulfilled") {
      // The move went first: the key went over and the issue moved under it lost that key with it.
      assert.deepEqual((await row(i.id)).formerKeys, []);
      assert.equal((await projectRow(taker.id)).key, p.key);
      assert.ok(!(await projectRow(p.id)).formerKeys.includes(p.key));
    } else {
      // The hand-over went first and was refused: the last issue was still there.
      assert.match(String((took.reason as Error).message), /issues/);
      assert.deepEqual((await row(i.id)).formerKeys, [`${p.key}-1`]);
      assert.ok((await projectRow(p.id)).formerKeys.includes(p.key));
    }
  }
});

test("the Timeline of both projects shows the move; the target's shows the issue's story before it", async () => {
  const src = await newProject("TS");
  const dst = await newProject("TD");
  const i = await newIssue(src);
  await tx([{ op: "update", m: "Issue", id: i.id, set: { priority: 1 } }]);
  const r = await move(i.id, dst.id);
  const id = r.actions[0]!.id;
  for (const level of ["steps", "everything"] as const) {
    const s = await readProjectHistory(f.ws.ownerId, src.id, level);
    const d = await readProjectHistory(f.ws.ownerId, dst.id, level);
    assert.ok(s && s !== "rate_limited" && d && d !== "rate_limited");
    const out = s.history.find((e) => e.id === id);
    assert.ok(out, `${level}: the old project shows the move`);
    assert.equal(out.was, `${src.key}-1`);
    assert.ok(d.history.some((e) => e.id === id), `${level}: the new project shows it`);
  }
  const all = await readProjectHistory(f.ws.ownerId, dst.id, "everything");
  assert.ok(all && all !== "rate_limited" && all.history.some((e) => e.i === i.id && "priority" in e.d), "the story before the move goes with it");
  const outcomes = await readProjectHistory(f.ws.ownerId, src.id, "outcomes");
  assert.ok(outcomes && outcomes !== "rate_limited" && !outcomes.history.some((e) => e.id === id), "outcomes show no moves");
});

test("API: PATCH with project names the target's state and labels; POST …/issues/move moves many, sub-issues on request", async () => {
  const src = await newProject("AP", ["l"]);
  const dst = await newProject("AQ", ["l", "m"]);
  const fetch = await api();
  const i = await newIssue(src);
  const res = await fetch(url(`/issues/${src.key}-${i.number}`), { method: "PATCH", body: JSON.stringify({ project: dst.key.toLowerCase(), state: "Done", labels: ["m"] }) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const out = JSON.parse(text) as { key: string; was: string };
  assert.equal(out.key, `${dst.key}-1`);
  assert.equal(out.was, `${src.key}-${i.number}`);
  const r = await row(i.id);
  assert.equal(r.stateId, dst.state("Done").id);
  assert.deepEqual(r.labelIds, [dst.label("m").id]);
  assert.equal((await fetch(url(`/issues/${out.key}`), { method: "PATCH", body: JSON.stringify({ project: "NOPE" }) })).status, 400);

  // A parent with a sub-issue and a grandchild; one sub-issue in the trash stays.
  const parent = await newIssue(src);
  const child = await newIssue(src, { parentId: parent.id });
  const grand = await newIssue(src, { parentId: child.id });
  const trashed = await newIssue(src, { parentId: parent.id });
  await tx([{ op: "update", m: "Issue", id: trashed.id, set: { deletedAt: new Date().toISOString() } }]);
  const alone = await newIssue(src);
  const without = await fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: [`${src.key}-${alone.number}`], project: dst.key }) });
  assert.equal(without.status, 200);
  assert.deepEqual(((await without.json()) as { moved: unknown[] }).moved, [{ key: `${dst.key}-2`, was: `${src.key}-${alone.number}` }]);

  const bulk = await fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: [`${src.key}-${parent.number}`, `${src.key}-${parent.number}`], project: dst.key, subIssues: true }) });
  const bulkText = await bulk.text();
  assert.equal(bulk.status, 200, bulkText);
  const moved = (JSON.parse(bulkText) as { moved: { key: string }[] }).moved;
  assert.equal(moved.length, 3);
  for (const x of [parent, child, grand]) assert.equal((await row(x.id)).projectId, dst.id);
  assert.equal((await row(trashed.id)).projectId, src.id);
  assert.equal((await row(child.id)).parentId, parent.id);

  // Without sub-issues, a sub-issue left behind keeps its parent across projects.
  const p2 = await newIssue(src);
  const c2 = await newIssue(src, { parentId: p2.id });
  await fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: [`${src.key}-${p2.number}`], project: dst.key }) });
  assert.equal((await row(c2.id)).projectId, src.id);
  assert.equal((await row(c2.id)).parentId, p2.id);

  // Already there: nothing to do. A deleted issue named: refused. Not a list: refused.
  const again = await fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: [`${dst.key}-1`], project: dst.key }) });
  assert.deepEqual(await again.json(), { ok: true, moved: [] });
  assert.equal((await fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: [`${src.key}-${trashed.number}`], project: dst.key }) })).status, 400);
  assert.equal((await fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: "x", project: dst.key }) })).status, 400);
  assert.equal((await fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: ["NOPE-1"], project: dst.key }) })).status, 400);
});

test("API: POST …/issues/move refuses more keys than it takes before looking any up; duplicates and old keys resolve in one go", async () => {
  const src = await newProject("AL");
  const dst = await newProject("AM");
  const fetch = await api();
  const post = (issues: string[]) => fetch(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues, project: dst.key }) });
  const a = await newIssue(src);
  const key = `${src.key}-${a.number}`;
  const many = await post(Array(501).fill(key));
  assert.equal(many.status, 400);
  assert.match(((await many.json()) as { message: string }).message, /at most 500 issues move at once/);
  // The cap comes before the lookup: a key that names nothing does not change the answer.
  assert.match(((await (await post([...Array(500).fill(key), "NOPE-1"])).json()) as { message: string }).message, /at most 500/);
  // 500 copies of one key are one issue.
  const dup = await post(Array(500).fill(key));
  assert.equal(dup.status, 200);
  assert.deepEqual(((await dup.json()) as { moved: unknown[] }).moved, [{ key: `${dst.key}-1`, was: key }]);
  // Its old key and its new one name it together, and a key that names nothing is still refused.
  assert.deepEqual(((await (await post([key, `${dst.key}-1`])).json()) as { moved: unknown[] }).moved, []);
  assert.equal((await post([key, `${src.key}-99999`])).status, 400);
});

test("a read token cannot move; an agent's write token can", async () => {
  const src = await newProject("WS");
  const dst = await newProject("WD");
  const i = await newIssue(src);
  const read = fetchAs({ ...(await asToken(f.ws.workspaceId, f.ws.agentId, "read")), "content-type": "application/json" });
  const r = await read(url(`/issues/${src.key}-${i.number}`), { method: "PATCH", body: JSON.stringify({ project: dst.key }) });
  assert.equal(r.status, 403);
  const write = fetchAs({ ...(await asToken(f.ws.workspaceId, f.ws.agentId)), "content-type": "application/json" });
  const w = await write(url("/issues/move"), { method: "POST", body: JSON.stringify({ issues: [`${src.key}-${i.number}`], project: dst.key }) });
  assert.equal(w.status, 200);
  assert.equal((await row(i.id)).projectId, dst.id);
});

test("the snapshot carries formerKeys", async () => {
  const src = await newProject("SN");
  const dst = await newProject("SD");
  const i = await newIssue(src);
  await move(i.id, dst.id);
  const lines = [];
  for await (const l of snapshot(f.ws.slug, undefined)) lines.push(l);
  const b = lines.find((l) => l.t === "b" && l.m === "Issue" && l.r.some((r) => r[l.c.indexOf("id")] === i.id));
  assert.ok(b && b.t === "b");
  const r = b.r.find((x) => x[b.c.indexOf("id")] === i.id)!;
  assert.deepEqual(r[b.c.indexOf("formerKeys")], [`${src.key}-1`]);
});
