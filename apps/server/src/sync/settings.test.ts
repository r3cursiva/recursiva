import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Op } from "@rsva/protocol";
import { DEFAULT_WORKFLOW, NAME_MAX, cleanName } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { asToken, asUser, importFixture, issueWithRefs, rejects, startServer, type Fixture } from "../test/helpers.ts";
import { snapshot } from "./bootstrap.ts";
import { applyTx } from "./write.ts";

const { project, workflowState, label, issue } = schema;

let ws: Fixture;
let refs: Awaited<ReturnType<typeof issueWithRefs>>;
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  [ws, server] = await Promise.all([importFixture(), startServer()]);
  refs = await issueWithRefs(ws.workspaceId);
});
after(() => server.close());

const tx = (ops: Op[]) => applyTx(ws.workspaceId, ws.ownerId, randomUUID(), ops);
const projectRow = async (id = refs.project.id) => (await db.select().from(project).where(eq(project.id, id)))[0]!;
const statesOf = (projectId = refs.project.id) => db.select().from(workflowState).where(eq(workflowState.projectId, projectId)).orderBy(workflowState.position);

test("a renamed key keeps the old one as an alias: old issue links and the snapshot still find the project", async () => {
  const p = await projectRow();
  const old = p.key;
  const r = await tx([{ op: "update", m: "Project", id: p.id, set: { key: "RENAMED", name: "Renamed project" } }]);
  assert.deepEqual(r.actions[0]!.d, { key: "RENAMED", name: "Renamed project", formerKeys: [...p.formerKeys, old] });

  const res = await fetch(`${server.url}/api/v1/workspaces/${ws.slug}/issues/${old}-${refs.issue.number}`, { headers: await asToken(ws.workspaceId, ws.agentId, "read") });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { key: string }).key, `RENAMED-${refs.issue.number}`);

  const lines = [];
  for await (const l of snapshot(ws.slug, old)) lines.push(l);
  const ready = lines.findIndex((l) => l.t === "ready");
  const firstIssues = lines.slice(0, ready).find((l) => l.t === "b" && l.m === "Issue");
  assert.ok(firstIssues && firstIssues.t === "b" && firstIssues.r.length > 0, "the renamed project's issues come before ready");

  // No other project may take the old key or the new one; taking back the old key drops the alias.
  await rejects(tx([{ op: "update", m: "Project", id: refs.other.id, set: { key: old } }]), "conflict", /was a key of project RENAMED/);
  await rejects(tx([{ op: "update", m: "Project", id: refs.other.id, set: { key: "RENAMED" } }]), "conflict");
  await rejects(tx([{ op: "update", m: "Project", id: p.id, set: { key: "lower" } }]), "invalid");
  const back = await tx([{ op: "update", m: "Project", id: p.id, set: { key: old, name: p.name } }]);
  assert.deepEqual(back.actions[0]!.d!.formerKeys, [...p.formerKeys, "RENAMED"]);
});

test("color takes a tile tone or null; archive gets the server's time and restore clears it", async () => {
  await rejects(tx([{ op: "update", m: "Project", id: refs.other.id, set: { color: "purple" as never } }]), "invalid");
  await tx([{ op: "update", m: "Project", id: refs.other.id, set: { color: "teal" } }]);
  assert.equal((await projectRow(refs.other.id)).color, "teal");

  const r = await tx([{ op: "update", m: "Project", id: refs.other.id, set: { archivedAt: "2000-01-01T00:00:00Z" } }]);
  const at = (await projectRow(refs.other.id)).archivedAt;
  assert.ok(at && !at.startsWith("2000"));
  assert.equal(r.actions[0]!.d!.archivedAt, at);
  // Archiving an archived project changes nothing.
  assert.deepEqual((await tx([{ op: "update", m: "Project", id: refs.other.id, set: { archivedAt: new Date().toISOString() } }])).actions, []);
  await tx([{ op: "update", m: "Project", id: refs.other.id, set: { archivedAt: null, color: null } }]);
  const restored = await projectRow(refs.other.id);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.color, null);
});

test("names keep any visible character and lose what cannot be seen; empty and too long are refused", async () => {
  const cases: [string, string][] = [
    ["example.com?ю@#$!%^&", "example.com?ю@#$!%^&"], // punctuation and Cyrillic stay
    ["  Two\n lines\tand\u00A0tabs  ", "Two lines and tabs"],
    ["admin\u202Etxt.exe", "admintxt.exe"], // a bidi override would show "exe.txt"
    ["in\u2066vis\u2069ible\u200B\uFEFF", "invisible"],
    ["👨\u200D👩\u200D👧 team", "👨\u200D👩\u200D👧 team"], // ZWJ holds an emoji sequence together
    ["e\u0301", "\u00E9"], // NFC: the same letter typed two ways is one name
    [`x${"\u0301\u0302\u0303\u0304\u0305\u0306"}`, `x${"\u0301\u0302\u0303\u0304"}`], // no mark towers
    ["bad\uD800", "bad\uFFFD"],
  ];
  for (const [raw, clean] of cases) assert.equal(cleanName(raw), clean, JSON.stringify(raw));

  const p = await projectRow(refs.other.id);
  const r = await tx([{ op: "update", m: "Project", id: p.id, set: { name: " Spaced\u202E  out\n" } }]);
  assert.equal(r.actions[0]!.d!.name, "Spaced out");
  assert.equal((await projectRow(p.id)).name, "Spaced out");
  await rejects(tx([{ op: "update", m: "Project", id: p.id, set: { name: "\u200B\n " } }]), "invalid", /empty/);
  await rejects(tx([{ op: "update", m: "Project", id: p.id, set: { name: "x".repeat(NAME_MAX + 1) } }]), "invalid", /at most 80/);
  await tx([{ op: "update", m: "Project", id: p.id, set: { name: p.name } }]);
});

/** A new project's ops as the app sends them (packages/sync, createProject): the project, then its states. */
function newProject(key: string, states = DEFAULT_WORKFLOW.map((s, i) => ({ ...s, isDefault: i === 0 }))): { id: string; ops: Op[] } {
  const id = randomUUID();
  return {
    id,
    ops: [
      { op: "create", m: "Project", id, set: { name: `Project ${key}`, key } },
      ...states.map((s, i): Op => ({ op: "create", m: "WorkflowState", id: randomUUID(), set: { projectId: id, name: s.name, group: s.group, position: (i + 1) * 1000, ...(s.isDefault ? { isDefault: true } : {}) } })),
    ],
  };
}

test("a new project comes with its states in one transaction: logged, in the snapshot, its key checked like a rename", async () => {
  const p = newProject("NEWP");
  const r = await tx(p.ops);
  assert.deepEqual(
    r.actions.map((a) => `${a.m}:${a.a}`),
    ["Project:I", ...DEFAULT_WORKFLOW.map(() => "WorkflowState:I")],
  );
  assert.equal(r.actions[0]!.d!.key, "NEWP");
  assert.equal(r.actions[0]!.d!.color, null);
  assert.equal(r.actions[0]!.d!.issueCounter, 0);
  const states = await statesOf(p.id);
  assert.deepEqual(states.map((s) => [s.name, s.isDefault]), DEFAULT_WORKFLOW.map((s, i) => [s.name, i === 0]));

  const lines = [];
  for await (const l of snapshot(ws.slug, undefined)) lines.push(l);
  const projects = lines.flatMap((l) => (l.t === "b" && l.m === "Project" ? l.r : []));
  assert.ok(projects.some((row) => (row as unknown[]).includes("NEWP")), "the new project is in the next snapshot");

  // A key another project has, or had, or that is not a key; nothing is written.
  const renamed = await projectRow(refs.other.id);
  await tx([{ op: "update", m: "Project", id: renamed.id, set: { key: "WAS" } }]);
  await rejects(tx(newProject("NEWP").ops), "conflict", /project NEWP exists/);
  await rejects(tx(newProject(renamed.key).ops), "conflict", /was a key of project WAS/);
  await rejects(tx(newProject("new").ops), "invalid");
  await rejects(tx([{ ...p.ops[0]!, id: randomUUID(), set: { name: "x", key: "COLOR", color: "purple" as never } } as Op]), "invalid");
  await tx([{ op: "update", m: "Project", id: renamed.id, set: { key: renamed.key } }]);
});

test("a new project without states, or without exactly one default among them, is refused", async () => {
  const bare = newProject("BARE");
  await rejects(tx(bare.ops.slice(0, 1)), "invalid", /at least one state/);
  await rejects(tx(newProject("NODEF", DEFAULT_WORKFLOW.map((s) => ({ ...s, isDefault: false }))).ops), "invalid", /exactly one default/);
  await rejects(tx(newProject("TWODEF", DEFAULT_WORKFLOW.map((s) => ({ ...s, isDefault: true }))).ops), "invalid", /exactly one default/);
  assert.equal((await db.select().from(project).where(and(eq(project.workspaceId, ws.workspaceId), eq(project.key, "BARE")))).length, 0);
});

test("states: create and rename freely, but every project keeps exactly one default", async () => {
  const states = await statesOf();
  const def = states.find((s) => s.isDefault)!;
  const id = randomUUID();
  const created = await tx([{ op: "create", m: "WorkflowState", id, set: { projectId: refs.project.id, name: "Verify on staging", group: "started", position: states.at(-1)!.position + 1 } }]);
  assert.equal(created.actions[0]!.d!.isDefault, false);
  assert.equal(created.actions[0]!.d!.color, "#F59E0B");
  await rejects(tx([{ op: "create", m: "WorkflowState", id: randomUUID(), set: { projectId: refs.project.id, name: " ", group: "started", position: 0 } }]), "invalid");
  await rejects(tx([{ op: "create", m: "WorkflowState", id: randomUUID(), set: { projectId: refs.project.id, name: "x", group: "triage" as never, position: 0 } }]), "invalid");

  // A second default alone, or none, is refused; moving it in one transaction passes.
  await rejects(tx([{ op: "update", m: "WorkflowState", id, set: { isDefault: true } }]), "invalid", /exactly one default/);
  await rejects(tx([{ op: "update", m: "WorkflowState", id: def.id, set: { isDefault: false } }]), "invalid", /exactly one default/);
  await rejects(tx([{ op: "delete", m: "WorkflowState", id: def.id }]), "bad_ref");
  const moved = await tx([
    { op: "update", m: "WorkflowState", id: def.id, set: { isDefault: false } },
    { op: "update", m: "WorkflowState", id, set: { isDefault: true, name: "Verify" } },
  ]);
  assert.equal(moved.actions.length, 2);
  assert.deepEqual((await statesOf()).filter((s) => s.isDefault).map((s) => s.id), [id]);
  await tx([
    { op: "update", m: "WorkflowState", id, set: { isDefault: false } },
    { op: "update", m: "WorkflowState", id: def.id, set: { isDefault: true } },
  ]);
});

test("a state with issues is deleted only after they move; a group change carries their completedAt", async () => {
  const states = await statesOf();
  const id = randomUUID();
  await tx([{ op: "create", m: "WorkflowState", id, set: { projectId: refs.project.id, name: "Doomed", group: "started", position: -1 } }]);
  const target = states.find((s) => s.group === "backlog")!;
  const issueId = refs.issue.id;
  await tx([{ op: "update", m: "Issue", id: issueId, set: { stateId: id } }]);

  // Closing the group closes the issue too: one Issue action with the server's time.
  const closed = await tx([{ op: "update", m: "WorkflowState", id, set: { group: "completed" } }]);
  const [row] = await db.select().from(issue).where(eq(issue.id, issueId));
  assert.ok(row!.completedAt);
  assert.deepEqual(
    closed.actions.map((a) => [a.m, a.d]),
    [
      ["WorkflowState", { group: "completed" }],
      ["Issue", { completedAt: row!.completedAt }],
    ],
  );
  const reopened = await tx([{ op: "update", m: "WorkflowState", id, set: { group: "unstarted" } }]);
  assert.deepEqual(reopened.actions[1]!.d, { completedAt: null });

  await rejects(tx([{ op: "delete", m: "WorkflowState", id }]), "bad_ref", /still has 1 issues/);
  // The client's way: move the issue, then delete, in order.
  const r = await tx([
    { op: "update", m: "Issue", id: issueId, set: { stateId: target.id } },
    { op: "delete", m: "WorkflowState", id },
  ]);
  assert.deepEqual(r.actions.map((a) => `${a.m}:${a.a}`), ["Issue:U", "WorkflowState:D"]);
  assert.equal((await db.select().from(workflowState).where(eq(workflowState.id, id))).length, 0);
  // States of another workspace are out of reach.
  const other = await importFixture("sample", undefined, 3);
  const [foreign] = await db.select().from(workflowState).innerJoin(project, eq(project.id, workflowState.projectId)).where(eq(project.workspaceId, other.workspaceId)).limit(1);
  await rejects(tx([{ op: "update", m: "WorkflowState", id: foreign!.workflow_state.id, set: { name: "x" } }]), "not_found");
});

test("labels: unique names per project, no cycles, deleted only when no issue and no child uses them", async () => {
  const a = randomUUID();
  const b = randomUUID();
  await tx([
    { op: "create", m: "Label", id: a, set: { projectId: refs.project.id, name: "Area", color: "#2F6F6A", position: 100 } },
    { op: "create", m: "Label", id: b, set: { projectId: refs.project.id, name: "Billing", color: "#55548A", position: 101, parentId: a } },
  ]);
  await rejects(tx([{ op: "create", m: "Label", id: randomUUID(), set: { projectId: refs.project.id, name: "area", color: "#000000", position: 0 } }]), "conflict");
  await rejects(tx([{ op: "create", m: "Label", id: randomUUID(), set: { projectId: refs.project.id, name: "x", color: "red", position: 0 } }]), "invalid");
  await rejects(tx([{ op: "update", m: "Label", id: a, set: { parentId: b } }]), "bad_ref", /inside itself/);
  await rejects(tx([{ op: "update", m: "Label", id: b, set: { parentId: refs.otherLabels[0]!.id } }]), "bad_ref", /another project/);
  // The same name is fine in another project.
  await tx([{ op: "create", m: "Label", id: randomUUID(), set: { projectId: refs.other.id, name: "Area", color: "#000000", position: 0 } }]);

  await tx([{ op: "update", m: "Issue", id: refs.issue.id, set: { labelIds: [b] } }]);
  await rejects(tx([{ op: "delete", m: "Label", id: a }]), "bad_ref", /labels inside/);
  await rejects(tx([{ op: "delete", m: "Label", id: b }]), "bad_ref", /still on 1 issues/);
  const r = await tx([
    { op: "update", m: "Issue", id: refs.issue.id, set: { labelIds: [] } },
    { op: "delete", m: "Label", id: b },
    { op: "delete", m: "Label", id: a },
  ]);
  assert.deepEqual(r.actions.map((x) => `${x.m}:${x.a}`), ["Issue:U", "Label:D", "Label:D"]);
  assert.equal((await db.select().from(label).where(and(eq(label.workspaceId, ws.workspaceId), eq(label.name, "Area")))).length, 1);
});

test("the workspace's name and color: logged, in the next snapshot and the switcher's list; its slug is not a field", async () => {
  const r = await tx([{ op: "update", m: "Workspace", id: ws.workspaceId, set: { name: "Renamed workspace", color: "teal" } }]);
  assert.deepEqual(r.actions.map((a) => [a.m, a.mid, a.a, a.d]), [["Workspace", ws.workspaceId, "U", { name: "Renamed workspace", color: "teal" }]]);
  assert.equal((await tx([{ op: "update", m: "Workspace", id: ws.workspaceId, set: { color: "teal" } }])).actions.length, 0, "no change, no action");

  const { value: meta } = await snapshot(ws.slug, undefined).next();
  assert.deepEqual(meta?.t === "meta" && meta.ws, { id: ws.workspaceId, slug: ws.slug, name: "Renamed workspace", color: "teal", memberRights: ["labels.write"], triagers: [] });
  const list = (await (await fetch(`${server.url}/sync/workspaces`, { headers: await asUser(ws.ownerId) })).json()) as { slug: string; color: string }[];
  assert.equal(list.find((w) => w.slug === ws.slug)?.color, "teal");

  await rejects(tx([{ op: "update", m: "Workspace", id: refs.project.id, set: { name: "x" } }]), "not_found");
  await rejects(tx([{ op: "update", m: "Workspace", id: ws.workspaceId, set: { color: "red" } as never }]), "invalid");
  await rejects(tx([{ op: "update", m: "Workspace", id: ws.workspaceId, set: { slug: "other" } as never }]), "invalid");
  await rejects(tx([{ op: "update", m: "Workspace", id: ws.workspaceId, set: { name: "  " } }]), "invalid");
});
