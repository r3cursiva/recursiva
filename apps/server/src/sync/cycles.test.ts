// Cycles in the write pipeline, the snapshot, the burn-up and the agent API (PLNR-63).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { addDays } from "@rsva/schema/days";
import { uuidv7, type CycleProgress, type Op } from "@rsva/protocol";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { asToken, asUser, fileFixture, rejects } from "../test/helpers.ts";
import { snapshot } from "./bootstrap.ts";
import { applyTx } from "./write.ts";

const { cycle, issue, syncAction } = schema;

const f = fileFixture();

const tx = (ops: Op[], actor = f.ws.ownerId) => applyTx(f.ws.workspaceId, actor, randomUUID(), ops);
const today = () => new Date().toISOString().slice(0, 10);
const createCycle = async (set: Record<string, unknown>, projectId = f.refs.project.id) => {
  const id = uuidv7();
  await tx([{ op: "create", m: "Cycle", id, set: { projectId, name: "Cycle", ...set } } as Op]);
  return (await db.select().from(cycle).where(eq(cycle.id, id)))[0]!;
};
const issuesOf = async (n: number, projectId = f.refs.project.id) => db.select().from(issue).where(eq(issue.projectId, projectId)).orderBy(issue.number).limit(n);
const setCycle = (issueId: string, cycleId: string | null): Op => ({ op: "update", m: "Issue", id: issueId, set: { cycleId } });

test("numbers count up per project; dates are both or none, in order, and clear of the project's other cycles", async () => {
  const a = await createCycle({ name: "Cycle A", startDate: "2027-01-05", endDate: "2027-01-18" });
  const b = await createCycle({ name: "Draft" });
  assert.equal(b.number, a.number + 1);
  assert.equal(b.startDate, null, "a draft has no dates");
  await rejects(createCycle({ startDate: "2027-02-01" }), "invalid", /both a start and an end date/);
  await rejects(createCycle({ startDate: "2027-02-10", endDate: "2027-02-01" }), "invalid", /ends on or after/);
  await rejects(createCycle({ startDate: "2027-01-18", endDate: "2027-01-31" }), "conflict", /overlap Cycle A \(2027-01-05 – 2027-01-18\)/);
  // Another project's cycles are no obstacle; the day after is free.
  await createCycle({ startDate: "2027-01-10", endDate: "2027-01-20" }, f.refs.other.id);
  await createCycle({ startDate: "2027-01-19", endDate: "2027-02-01" });
  // Moving a draft onto taken days is refused as well.
  await rejects(tx([{ op: "update", m: "Cycle", id: b.id, set: { startDate: "2027-01-01", endDate: "2027-01-06" } }]), "conflict");
});

test("the snapshot carries cycles and every issue's cycleId", async () => {
  const c = await createCycle({ name: "In snapshot" });
  const lines = [];
  for await (const l of snapshot(f.ws.slug, f.refs.project.key)) lines.push(l);
  const cycles = lines.find((l) => l.t === "b" && l.m === "Cycle");
  assert.ok(cycles && cycles.t === "b" && cycles.r.some((r) => r[cycles.c.indexOf("id")] === c.id));
  const issues = lines.find((l) => l.t === "b" && l.m === "Issue");
  assert.ok(issues && issues.t === "b" && issues.c.includes("cycleId"));
});

test("an issue goes into a cycle of its own project that is not completed; the move is in its history", async () => {
  const c = await createCycle({ name: "Plan", startDate: addDays(today(), 400), endDate: addDays(today(), 413) });
  const elsewhere = await createCycle({ name: "Elsewhere" }, f.refs.other.id);
  const [i] = await issuesOf(1);
  const r = await tx([setCycle(i!.id, c.id)]);
  assert.equal(r.actions[0]!.d!.cycleId, c.id);
  const [logged] = await db.select({ prev: syncAction.prev }).from(syncAction).where(and(eq(syncAction.workspaceId, f.ws.workspaceId), eq(syncAction.id, r.s)));
  assert.deepEqual(logged!.prev, { cycleId: null });
  await rejects(tx([setCycle(i!.id, elsewhere.id)]), "bad_ref", /not in the issue's project/);
  await rejects(tx([setCycle(i!.id, randomUUID())]), "bad_ref");
  await tx([setCycle(i!.id, null)]);
});

test("completing: not a draft or a cycle ahead; the summary freezes the numbers and the open issues move on after it", async () => {
  const draft = await createCycle({ name: "No dates" });
  await rejects(tx([{ op: "update", m: "Cycle", id: draft.id, set: { completedAt: new Date().toISOString() } }]), "invalid", /draft/);
  const ahead = await createCycle({ name: "Ahead", startDate: addDays(today(), 600), endDate: addDays(today(), 613) });
  await rejects(tx([{ op: "update", m: "Cycle", id: ahead.id, set: { completedAt: new Date().toISOString() } }]), "invalid", /not started/);

  const cur = await createCycle({ name: "Current", startDate: addDays(today(), -300), endDate: addDays(today(), -290) });
  const next = await createCycle({ name: "Next", startDate: addDays(today(), 700), endDate: addDays(today(), 713) });
  const [a, b, c] = await issuesOf(3);
  const done = f.refs.states.find((s) => s.group === "completed")!;
  const open = f.refs.states.find((s) => s.group === "started")!;
  await tx([setCycle(a!.id, cur.id), setCycle(b!.id, cur.id), setCycle(c!.id, cur.id)]);
  await tx([
    { op: "update", m: "Issue", id: a!.id, set: { stateId: done.id } },
    { op: "update", m: "Issue", id: b!.id, set: { stateId: open.id } },
    { op: "update", m: "Issue", id: c!.id, set: { stateId: open.id } },
  ]);
  // Complete, then move b on; c stays behind, unfinished.
  const r = await tx([{ op: "update", m: "Cycle", id: cur.id, set: { completedAt: "2000-01-01T00:00:00Z" } }, setCycle(b!.id, next.id)]);
  const [row] = await db.select().from(cycle).where(eq(cycle.id, cur.id));
  assert.ok(row!.completedAt && !row!.completedAt.startsWith("2000"), "the server sets the time");
  assert.deepEqual(row!.summary!.groups, { completed: 1, started: 2 });
  assert.deepEqual(new Set(row!.summary!.open), new Set([b!.id, c!.id]));
  assert.equal(row!.summary!.scope.length, 12, "the first moment and the ends of 11 days");
  assert.equal(r.actions[0]!.d!.completedAt, row!.completedAt);
  assert.deepEqual(r.actions[0]!.d!.summary, row!.summary);

  // A completed cycle keeps its dates, takes no new issues, is not deleted; issues may still leave it.
  await rejects(tx([{ op: "update", m: "Cycle", id: cur.id, set: { endDate: addDays(today(), -280) } }]), "invalid", /keeps its dates/);
  await rejects(tx([setCycle(b!.id, cur.id)]), "invalid", /completed/);
  await rejects(tx([{ op: "delete", m: "Cycle", id: cur.id }]), "invalid");
  await tx([{ op: "update", m: "Issue", id: c!.id, set: { priority: 2 } }]); // staying in it is no move into it
  await tx([{ op: "update", m: "Cycle", id: cur.id, set: { name: "Renamed after" } }]);
  await tx([setCycle(c!.id, null), setCycle(a!.id, null)]);
});

test("deleting a cycle that issues are in is refused; empty, it goes", async () => {
  const c = await createCycle({ name: "To delete" });
  const [i] = await issuesOf(1);
  await tx([setCycle(i!.id, c.id)]);
  await rejects(tx([{ op: "delete", m: "Cycle", id: c.id }]), "bad_ref", /move them out first/);
  const r = await tx([setCycle(i!.id, null), { op: "delete", m: "Cycle", id: c.id }]);
  assert.deepEqual(r.actions.at(-1), { ...r.actions.at(-1)!, m: "Cycle", a: "D", d: { projectId: f.refs.project.id } });
});

test("burn-up: the first moment and each day that is over, in the viewer's zone, read off the log; today is left to the client", async () => {
  const start = addDays(today(), -3);
  const c = await createCycle({ name: "Burning", startDate: start, endDate: addDays(today(), 10) });
  // Issues no earlier test touched: their log is in order of time, as a real one is.
  const [a, b] = (await issuesOf(6)).slice(4);
  const done = f.refs.states.find((s) => s.group === "completed")!;
  const ids = [a!.id, b!.id];
  // Not done yet, whatever the fixture made them: the step to done has to be in the log.
  const todo = f.refs.states.find((s) => s.group === "unstarted")!;
  await db.update(issue).set({ createdAt: dsql`now() - interval '30 days'`, stateId: todo.id }).where(inArray(issue.id, ids));
  const at = (day: string, time: string) => `${day}T${time}Z`;
  // b is planned the day before and done on day 3; a joins on day 2 in the evening, UTC: the next morning in Tokyo. An
  // action today counts for no past day.
  const moves: [Op, string][] = [
    [setCycle(b!.id, c.id), at(addDays(start, -1), "09:00:00")],
    [setCycle(a!.id, c.id), at(addDays(start, 1), "18:00:00")],
    [{ op: "update", m: "Issue", id: b!.id, set: { stateId: done.id } }, at(addDays(start, 2), "14:00:00")],
  ];
  for (const [op, when] of moves) {
    const r = await tx([op]);
    await db.update(syncAction).set({ createdAt: when }).where(and(eq(syncAction.workspaceId, f.ws.workspaceId), eq(syncAction.id, r.s)));
  }
  await tx([setCycle(a!.id, null)]); // today: a leaves; the days before still had it

  const owner = await asUser(f.ws.ownerId);
  const read = async (query = "") => {
    const res = await fetch(`${f.server.url}/sync/cycle-progress/${c.id}${query}`, { headers: owner });
    assert.equal(res.status, 200);
    return (await res.json()) as CycleProgress;
  };
  const p = await read();
  assert.equal(p.start, start);
  // The start, then the ends of days 1–3 in UTC.
  assert.deepEqual(p.scope, [1, 1, 2, 2]);
  assert.deepEqual(p.started, [0, 0, 0, 1]);
  assert.deepEqual(p.done, [0, 0, 0, 1]);
  // Tokyo's day 2 ends at 15:00 UTC, before a joined. Its today may be a day ahead of UTC, a fifth point.
  const tokyo = await read("?tz=asia/tokyo");
  assert.deepEqual(tokyo.scope.slice(0, 4), [1, 1, 1, 2]);
  assert.deepEqual(tokyo.done.slice(0, 4), [0, 0, 0, 1]);

  assert.equal((await fetch(`${f.server.url}/sync/cycle-progress/${c.id}?tz=Mars/Olympus`, { headers: owner })).status, 400);
  assert.equal((await fetch(`${f.server.url}/sync/cycle-progress/${randomUUID()}`, { headers: owner })).status, 404);
  assert.equal((await fetch(`${f.server.url}/sync/cycle-progress/${c.id}`)).status, 401);
  await tx([setCycle(b!.id, null)]);
});

test("agents plan by name: `cycle` on an issue (C-number or name), cycle:active in lists, and the cycles of a project", async () => {
  // The other project: the burn-up's cycle holds these days in the first one.
  const c = await createCycle({ name: "Agents' cycle", startDate: addDays(today(), -1), endDate: addDays(today(), 12) }, f.refs.other.id);
  const [i] = await issuesOf(1, f.refs.other.id);
  const agent = await asToken(f.ws.workspaceId, f.ws.agentId);
  const key = `${f.refs.other.key}-${i!.number}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${f.server.url}/api/v1/workspaces/${f.ws.slug}${path}`, { ...init, headers: { ...agent, "content-type": "application/json", ...(init.headers as Record<string, string>) } });

  assert.equal((await api(`/issues/${key}`, { method: "PATCH", body: JSON.stringify({ cycle: `C${c.number}` }) })).status, 200);
  assert.equal(((await (await api(`/issues/${key}`)).json()) as { cycle: string }).cycle, "Agents' cycle");
  const bad = await api(`/issues/${key}`, { method: "PATCH", body: JSON.stringify({ cycle: "C9999" }) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { message: string }).message, /no cycle "C9999"/);

  const listed = (await (await api(`/issues?project=${f.refs.other.key}&q=cycle:active`)).json()) as { issues: { key: string }[] };
  assert.deepEqual(listed.issues.map((x) => x.key), [key]);
  const cycles = (await (await api(`/cycles?project=${f.refs.other.key}`)).json()) as { name: string; status: string; issues: number }[];
  assert.deepEqual(cycles.find((x) => x.name === "Agents' cycle"), { ...cycles.find((x) => x.name === "Agents' cycle")!, status: "active", issues: 1 });
  assert.equal((await api(`/issues/${key}`, { method: "PATCH", body: JSON.stringify({ cycle: null }) })).status, 200);
});

test("agents manage cycles by name: create, edit, complete with a carry-over, delete; the pipeline's refusals come through", async () => {
  const key = f.refs.other.key;
  const headers = (scope: "read" | "write") => asToken(f.ws.workspaceId, f.ws.agentId, scope).then((h) => ({ ...h, "content-type": "application/json" }));
  const write = await headers("write");
  const call = async (method: string, path: string, body?: unknown, h = write) => {
    const r = await fetch(`${f.server.url}/api/v1/workspaces/${f.ws.slug}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { message: string; short: string } };
  };
  const inProject = (path: string) => `/cycles/${path}?project=${key}`;
  const window = { startDate: addDays(today(), 40), endDate: addDays(today(), 46) };
  // The test above leaves a cycle in progress here: it would be the next one.
  assert.equal((await call("DELETE", inProject(encodeURIComponent("Agents' cycle")))).status, 200);

  const nope = await call("POST", "/cycles", { project: key, name: "Read only", ...window }, await headers("read"));
  assert.equal(nope.status, 403);
  assert.equal((await call("POST", "/cycles", { project: "NOPE", name: "x" })).status, 400);

  const first = await call("POST", "/cycles", { project: key, name: "Agents' sprint", lead: "me", ...window });
  assert.equal(first.status, 201, first.body.message);
  assert.equal(first.body.name, "Agents' sprint");
  const overlap = await call("POST", "/cycles", { project: key, name: "Clash", ...window });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error, "conflict");
  assert.match(overlap.body.message, /overlap Agents' sprint/);
  assert.equal((await call("POST", "/cycles", { project: key, name: "Half", startDate: addDays(today(), 60) })).body.error, "invalid", "a cycle has both dates or none");

  const c = first.body.short;
  assert.equal((await call("PATCH", inProject(c), { name: "Renamed", description: "The goal" })).status, 200);
  assert.equal((await call("PATCH", inProject("Renamed"), {})).body.message, "nothing to change: name, description, startDate, endDate, lead");
  const shown = await call("GET", inProject("renamed"));
  assert.deepEqual([shown.body.short, shown.body.description, shown.body.status, shown.body.lead], [c, "The goal", "upcoming", (await db.select().from(schema.user).where(eq(schema.user.id, f.ws.agentId)))[0]!.email]);
  assert.match((await call("GET", inProject("C9999"))).body.message, /no cycle "C9999"/);

  // Two upcoming cycles, three issues in the first: one kept, one carried, one finished.
  const next = await call("POST", "/cycles", { project: key, name: "After", startDate: addDays(today(), 50), endDate: addDays(today(), 56) });
  const started = await createCycle({ name: "Now", startDate: addDays(today(), -30), endDate: addDays(today(), -25) }, f.refs.other.id);
  const [a, b, d] = await issuesOf(3, f.refs.other.id);
  await tx([a!, b!, d!].map((i) => setCycle(i.id, started.id)));
  for (const [i, state] of [[a, "In Progress"], [b, "In Progress"], [d, "Done"]] as const) assert.equal((await call("PATCH", `/issues/${key}-${i!.number}`, { state })).status, 200);
  const now = `C${started.number}`;
  assert.match((await call("POST", `${inProject(now).replace("?", "/complete?")}`, {})).body.message, /moveTo/, "where the open issues go is required");
  assert.match((await call("POST", `${inProject(now).replace("?", "/complete?")}`, { moveTo: now })).body.message, /its own open issues/);
  assert.match((await call("POST", `${inProject(now).replace("?", "/complete?")}`, { moveTo: null, keep: [`${key}-${d!.number}`] })).body.message, /is not an open issue/);
  const over = await createCycle({ name: "Over", startDate: addDays(today(), -20), endDate: addDays(today(), -15) }, f.refs.other.id);
  assert.match((await call("POST", `${inProject(now).replace("?", "/complete?")}`, { moveTo: `C${over.number}` })).body.message, /Over is over/, "only a cycle ahead, as the dialog offers");
  await tx([{ op: "delete", m: "Cycle", id: over.id }]);
  const done = await call("POST", `${inProject(now).replace("?", "/complete?")}`, { moveTo: "next", keep: [`${key}-${b!.number}`.toLowerCase()] });
  assert.equal(done.status, 200, done.body.message);
  assert.deepEqual([done.body.moved, done.body.kept], [1, 1]);
  const row = async (id: string) => (await db.select().from(issue).where(eq(issue.id, id)))[0]!.cycleId;
  const firstRow = (await db.select().from(cycle).where(and(eq(cycle.projectId, f.refs.other.id), eq(cycle.name, "Renamed"))))[0]!;
  assert.equal(await row(a!.id), firstRow.id, "next: the first cycle ahead with dates");
  const frozen = (await db.select().from(cycle).where(eq(cycle.id, started.id)))[0]!.summary!;
  assert.ok(frozen.open.includes(a!.id), "the summary is frozen before the issues move on");
  assert.equal(await row(b!.id), started.id, "kept in the completed cycle");
  assert.equal(await row(d!.id), started.id, "done work stays as the record");
  const closed = await call("GET", inProject(now));
  assert.deepEqual([closed.body.status, closed.body.done, closed.body.open], ["completed", 1, 1]);
  assert.match((await call("POST", `${inProject(now).replace("?", "/complete?")}`, { moveTo: null })).body.message, /already completed/);
  assert.match((await call("DELETE", inProject(now))).body.message, /record of its work/);

  const empty = await createCycle({ name: "Empty", startDate: addDays(today(), -14), endDate: addDays(today(), -10) }, f.refs.other.id);
  assert.equal((await call("DELETE", inProject(c))).body.moved, 1, "its issue leaves first, as in the browser");
  assert.equal((await call("DELETE", inProject(next.body.short))).status, 200);
  assert.equal((await call("POST", `${inProject(`C${empty.number}`).replace("?", "/complete?")}`, { moveTo: "next" })).status, 200, "nothing to move needs no next cycle");
  assert.equal(await row(a!.id), null);
  assert.equal((await call("GET", inProject(c))).status, 400);
});

test("agents complete and delete cycles of more than 500 issues: the ops go in several transactions; keep takes a former key (RSVA-240)", async () => {
  const p = f.refs.project;
  const agent = { ...(await asToken(f.ws.workspaceId, f.ws.agentId)), "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${f.server.url}/api/v1/workspaces/${f.ws.slug}${path}`, { method, headers: agent, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { message: string } };
  };
  const open = f.refs.states.find((s) => s.group === "unstarted" || s.group === "backlog")!;
  // Straight into the table: 600 issues through the pipeline would only slow the test down.
  const fill = async (cycleId: string, n: number, over: Partial<typeof issue.$inferInsert> = {}) => {
    const [{ top }] = (await db.select({ top: dsql<number>`max(${issue.number})::int` }).from(issue).where(eq(issue.projectId, p.id))) as [{ top: number }];
    const rows = Array.from({ length: n }, (_, i) => ({ workspaceId: f.ws.workspaceId, projectId: p.id, number: top + 1 + i, title: `Big ${i}`, stateId: open.id, sortOrder: "a0", cycleId, ...over }));
    return db.insert(issue).values(rows).returning({ id: issue.id, number: issue.number });
  };
  const inCycle = async (id: string) => (await db.select({ id: issue.id }).from(issue).where(eq(issue.cycleId, id))).length;

  const big = await createCycle({ name: "Big", startDate: addDays(today(), -500), endDate: addDays(today(), -490) });
  const made = await fill(big.id, 600);
  // One kept under a former project key, one under the key it had before a move.
  const [byOldProject, byMove] = [made[0]!, made[1]!];
  const was = `GONE${big.number}-1`;
  await db.update(issue).set({ formerKeys: [was] }).where(eq(issue.id, byMove.id));
  await db.update(schema.project).set({ formerKeys: [...p.formerKeys, "OLDKEY"] }).where(eq(schema.project.id, p.id));
  try {
    const done = await call("POST", `/cycles/C${big.number}/complete?project=${p.key}`, { moveTo: null, keep: [`oldkey-${byOldProject.number}`, was] });
    assert.equal(done.status, 200, done.body.message);
    assert.deepEqual([done.body.moved, done.body.kept], [598, 2]);
  } finally {
    await db.update(schema.project).set({ formerKeys: p.formerKeys }).where(eq(schema.project.id, p.id));
  }
  assert.equal(await inCycle(big.id), 2, "the kept ones stay in the completed cycle");
  const frozen = (await db.select().from(cycle).where(eq(cycle.id, big.id)))[0]!;
  assert.ok(frozen.completedAt);
  assert.equal(frozen.summary!.open.length, 600, "the summary is frozen before the issues move on");
  // A completed cycle is refused before any issue leaves it.
  assert.match((await call("DELETE", `/cycles/C${big.number}?project=${p.key}`)).body.message, /record of its work/);
  assert.equal(await inCycle(big.id), 2);

  // Archived and deleted issues leave too.
  const gone = await createCycle({ name: "Big draft" });
  await fill(gone.id, 590);
  await fill(gone.id, 5, { archivedAt: new Date().toISOString() });
  await fill(gone.id, 5, { deletedAt: new Date().toISOString() });
  const deleted = await call("DELETE", `/cycles/C${gone.number}?project=${p.key}`);
  assert.equal(deleted.status, 200, deleted.body.message);
  assert.equal(deleted.body.moved, 600);
  assert.equal(await inCycle(gone.id), 0);
  assert.equal((await db.select().from(cycle).where(eq(cycle.id, gone.id))).length, 0);
});
