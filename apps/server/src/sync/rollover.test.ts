// Cycle rollover (PLNR-64): the project switch, the sweep, what it leaves behind, and what it does not do.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { addDays } from "@rsva/schema/days";
import { uuidv7, type Op } from "@rsva/protocol";
import { APP_BOT, type CycleSummary } from "@rsva/schema/models";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { fileFixture } from "../test/helpers.ts";
import { snapshot } from "./bootstrap.ts";
import { sweepCycles } from "./rollover.ts";
import { applyTx } from "./write.ts";

const { cycle, issue, project, syncAction, user } = schema;

const f = fileFixture();

const tx = (ops: Op[]) => applyTx(f.ws.workspaceId, f.ws.ownerId, randomUUID(), ops);
const today = () => new Date().toISOString().slice(0, 10);
const sweep = () => sweepCycles((e) => assert.fail(e as Error));
const rollover = (projectId: string, on: boolean) => tx([{ op: "update", m: "Project", id: projectId, set: { cycleRollover: on } }]);

/** A cycle `from`..`to` days from today, in the project. */
async function newCycle(name: string, from: number, to: number, projectId = f.refs.project.id) {
  const id = uuidv7();
  await tx([{ op: "create", m: "Cycle", id, set: { projectId, name, startDate: addDays(today(), from), endDate: addDays(today(), to) } }]);
  return id;
}

/** New issues in the cycle, one per state group given. */
async function issuesIn(cycleId: string, groups: string[], projectId = f.refs.project.id) {
  const states = projectId === f.refs.project.id ? f.refs.states : f.refs.otherStates;
  const ids = groups.map(() => uuidv7());
  await tx(ids.map((id, i): Op => ({ op: "create", m: "Issue", id, projectId, set: { title: `${groups[i]} work`, stateId: states.find((s) => s.group === groups[i])!.id, cycleId } })));
  return ids;
}

const cycleOf = async (id: string) => (await db.select().from(cycle).where(eq(cycle.id, id)))[0]!;
const cyclesOf = async (ids: string[]) => new Map((await db.select({ id: issue.id, cycleId: issue.cycleId }).from(issue).where(inArray(issue.id, ids))).map((r) => [r.id, r.cycleId]));

test("the switch is a project setting, off by default, in the snapshot", async () => {
  const [p] = await db.select({ on: project.cycleRollover }).from(project).where(eq(project.id, f.refs.project.id));
  assert.equal(p!.on, false);
  const r = await rollover(f.refs.project.id, true);
  assert.deepEqual(r.actions[0]!.d, { cycleRollover: true });
  const lines = [];
  for await (const l of snapshot(f.ws.slug, f.refs.project.key)) lines.push(l);
  const projects = lines.find((l) => l.t === "b" && l.m === "Project");
  assert.ok(projects && projects.t === "b");
  const row = projects.r.find((x) => x[projects.c.indexOf("id")] === f.refs.project.id)!;
  assert.equal(row[projects.c.indexOf("cycleRollover")], true);
});

test("a cycle that is over completes; its open issues move to the next, signed by the app's bot; a second sweep changes nothing", async () => {
  // Over ten days ago: the server was off on the day, the first sweep catches up.
  const ended = await newCycle("Ended", -20, -10);
  const next = await newCycle("Next", 1, 10);
  const [done, started, todo, cancelled] = await issuesIn(ended, ["completed", "started", "unstarted", "cancelled"]);

  // Two sweeps at once (two processes during a release): one completes it, the other finds it completed.
  const counts = await Promise.all([sweep(), sweep()]);
  assert.equal(counts[0] + counts[1], 1);

  const c = await cycleOf(ended);
  assert.ok(c.completedAt);
  const summary = c.summary as CycleSummary;
  assert.deepEqual([...summary.open].sort(), [started!, todo!].sort(), "the completed cycle keeps what moved on");
  assert.deepEqual(summary.groups, { completed: 1, started: 1, unstarted: 1, cancelled: 1 });
  const now = await cyclesOf([done!, started!, todo!, cancelled!]);
  assert.equal(now.get(started!), next);
  assert.equal(now.get(todo!), next);
  assert.equal(now.get(done!), ended, "done and cancelled stay as its record");
  assert.equal(now.get(cancelled!), ended);

  // The moves are in the issues' history, by the bot, from the ended cycle to the next.
  const [bot] = await db.select().from(user).where(eq(user.email, APP_BOT.email));
  assert.equal(bot!.kind, "bot");
  const moves = await db.select().from(syncAction).where(and(eq(syncAction.workspaceId, f.ws.workspaceId), eq(syncAction.model, "Issue"), inArray(syncAction.modelId, [started!, todo!]), eq(syncAction.actorId, bot!.id)));
  assert.equal(moves.length, 2);
  for (const m of moves) {
    assert.equal((m.data as Record<string, unknown>).cycleId, next);
    assert.equal((m.prev as Record<string, unknown>).cycleId, ended);
  }
  // A new client learns the bot's name from the snapshot.
  const lines = [];
  for await (const l of snapshot(f.ws.slug, f.refs.project.key)) lines.push(l);
  const users = lines.find((l) => l.t === "b" && l.m === "User");
  assert.ok(users && users.t === "b" && users.r.some((r) => r[users.c.indexOf("id")] === bot!.id));

  const [{ last }] = (await db.select({ last: schema.workspace.lastSyncId }).from(schema.workspace).where(eq(schema.workspace.id, f.ws.workspaceId))) as [{ last: number }];
  assert.equal(await sweep(), 0);
  const [{ after }] = (await db.select({ after: schema.workspace.lastSyncId }).from(schema.workspace).where(eq(schema.workspace.id, f.ws.workspaceId))) as [{ after: number }];
  assert.equal(after, last);
});

test("after a long gap the issues skip cycles that are over; a cycle that has not ended is left alone", async () => {
  // The first cycle ahead with dates is the live one, before the previous test's "Next" (days 1–10).
  const older = await newCycle("Older", -60, -51);
  const old = await newCycle("Old", -50, -41);
  const live = await newCycle("Live", -2, 0);
  const [a] = await issuesIn(older, ["started"]);
  const [b] = await issuesIn(old, ["started"]);
  const [c] = await issuesIn(live, ["started"]);
  assert.equal(await sweep(), 2);
  const now = await cyclesOf([a!, b!, c!]);
  assert.equal(now.get(a!), live, "not into a cycle that is over");
  assert.equal(now.get(b!), live);
  assert.equal(now.get(c!), live);
  assert.equal((await cycleOf(live)).completedAt, null, "its last day is today");
});

test("with no next cycle open issues stay and the cycle stays ended; with nothing open it completes; switched off, nothing moves", async () => {
  const other = f.refs.other.id;
  const stuck = await newCycle("Stuck", -30, -21, other);
  const empty = await newCycle("Empty", -20, -11, other);
  const [open] = await issuesIn(stuck, ["started"], other);
  await issuesIn(empty, ["completed"], other);

  assert.equal(await sweep(), 0, "the switch is off in this project");
  assert.equal((await cycleOf(stuck)).completedAt, null);

  await rollover(other, true);
  assert.equal(await sweep(), 1);
  assert.equal((await cycleOf(stuck)).completedAt, null, "it waits for a next cycle");
  assert.ok((await cycleOf(empty)).completedAt, "nothing open: completed anyway");

  // A next cycle is planned: the next sweep takes the one that waited.
  const later = await newCycle("Later", 3, 12, other);
  assert.equal(await sweep(), 1);
  assert.ok((await cycleOf(stuck)).completedAt);
  assert.equal((await cyclesOf([open!])).get(open!), later);

  // An archived project's cycles are left as they are.
  const parked = await newCycle("Parked", -10, -5, other);
  await issuesIn(parked, ["started"], other);
  await tx([{ op: "update", m: "Project", id: other, set: { archivedAt: new Date().toISOString() } }]);
  assert.equal(await sweep(), 0);
  assert.equal((await cycleOf(parked)).completedAt, null);
});
