import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { COMMENT_EXCERPT, type HistoryLevel, type Op, type ProjectHistory } from "@rsva/protocol";
import { fromMarkdown } from "@rsva/editor/markdown";
import type { DocJSON, GithubEvent } from "@rsva/schema/models";
import { importFixture, issueWithRefs, serverWithIssue, type ServerWithIssue } from "../test/helpers.ts";
import { applyServerChange, applyTx } from "./write.ts";

let { server, ws, refs, owner } = {} as ServerWithIssue;
before(async () => ({ server, ws, refs, owner } = await serverWithIssue()));
after(() => server.close());

const as = (actor: string, ops: Op[]) => applyTx(ws.workspaceId, actor, randomUUID(), ops);
const say = (issueId: string, body: string): Op => ({ op: "create", m: "Comment", id: randomUUID(), set: { issueId, body } });
const url = (projectId: string, level: string, until?: string) =>
  `${server.url}/sync/project-history?project=${projectId}&level=${level}${until ? `&until=${encodeURIComponent(until)}` : ""}`;
const read = async (level: HistoryLevel, until?: string) => {
  const r = await owner(url(refs.other.id, level, until));
  assert.equal(r.status, 200);
  return (await r.json()) as ProjectHistory;
};
const fields = (h: ProjectHistory) => h.history.map((e) => [e.i, e.by, Object.keys(e.d).join(",")]);

test("GET /sync/project-history: the level decides which changes and whether comments come; entries name their issue", async () => {
  const { otherStates, otherLabels } = await issueWithRefs(ws.workspaceId);
  const id = randomUUID();
  // An agent may move an issue into work, not into Todo (packages/policy).
  const first = otherStates[0];
  const second = otherStates.find((s) => s.group === "started");
  await as(ws.ownerId, [{ op: "create", m: "Issue", id, projectId: refs.other.id, set: { title: "history", stateId: first!.id } }]);
  await as(ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [ws.agentId] } }]);
  await as(ws.agentId, [{ op: "update", m: "Issue", id, set: { stateId: second!.id, labelIds: [otherLabels[0]!.id] } }]);
  await as(ws.agentId, [{ op: "update", m: "Issue", id, set: { priority: 2 } }]);
  await as(ws.agentId, [say(id, "x".repeat(COMMENT_EXCERPT + 50))]);
  const last = await as(ws.agentId, [{ op: "update", m: "Document", id, set: { doc: fromMarkdown("The plan") as DocJSON } }]);

  const outcomes = await read("outcomes");
  assert.equal(outcomes.s, last.s);
  assert.deepEqual(fields(outcomes), [[id, ws.agentId, "stateId"]], "only the move, and only its state");
  assert.deepEqual(outcomes.history[0]!.p, { stateId: first!.id });
  assert.deepEqual(outcomes.comments, []);

  const steps = await read("steps");
  assert.deepEqual(fields(steps), [
    [id, ws.ownerId, "stateId"],
    [id, ws.ownerId, "assigneeIds"],
    [id, ws.agentId, "stateId"],
  ]);
  assert.deepEqual(
    steps.comments.map((c) => [c.i, c.by, c.x.length, c.r]),
    [[id, ws.agentId, COMMENT_EXCERPT, null]],
    "a comment comes as its first characters",
  );

  const everything = await read("everything");
  assert.deepEqual(fields(everything), [
    [id, ws.ownerId, "stateId"],
    [id, ws.ownerId, "assigneeIds"],
    [id, ws.agentId, "stateId,labelIds"],
    [id, ws.agentId, "priority"],
    [id, ws.agentId, "description"],
  ]);
});

test("GET /sync/project-history: what GitHub did comes at the level it belongs to, also when the state stayed", async () => {
  const id = randomUUID();
  await as(ws.ownerId, [{ op: "create", m: "Issue", id, projectId: refs.other.id, set: { title: "pull", stateId: refs.otherStates[0]!.id } }]);
  const event = (verb: GithubEvent["verb"]) => ({ verb, repo: "x/y", number: 4, sha: null, title: "t", state: "open" as const, by: "login", closing: false, at: new Date().toISOString() });
  for (const verb of ["pushed", "merged"] as const) {
    await applyServerChange(ws.workspaceId, ws.agentId, async () => [{ m: "Issue", mid: id, a: "U", d: { gh: event(verb) } }]);
  }
  const verbs = async (level: HistoryLevel) => (await read(level)).history.filter((e) => e.i === id && e.gh).map((e) => e.gh!.verb);
  assert.deepEqual(await verbs("outcomes"), ["merged"]);
  assert.deepEqual(await verbs("steps"), ["merged"]);
  assert.deepEqual(await verbs("everything"), ["pushed", "merged"]);
});

test("GET /sync/project-history: 400 for a level or until it does not know, 404 for a project the viewer cannot open", async () => {
  assert.equal((await owner(url(refs.other.id, "milestones"))).status, 400);
  assert.equal((await owner(url(refs.other.id, "steps", "yesterday"))).status, 400);
  assert.equal((await owner(url("nope", "steps"))).status, 404);
  assert.equal((await owner(url(randomUUID(), "steps"))).status, 404);
  const foreign = await importFixture("sample", undefined, 3);
  const elsewhere = await issueWithRefs(foreign.workspaceId);
  assert.equal((await owner(url(elsewhere.project.id, "steps"))).status, 404);
});

test("GET /sync/project-history comes in pages: newest first, `until` gives the one before, nothing lost or doubled", async () => {
  const id = randomUUID();
  await as(ws.ownerId, [{ op: "create", m: "Issue", id, projectId: refs.other.id, set: { title: "busy", stateId: refs.otherStates[0]!.id } }]);
  const made: string[] = [];
  // 300 comments of a kilobyte, ten to a transaction: over a page of 256 KB.
  for (let t = 0; t < 30; t++) {
    const ops = Array.from({ length: 10 }, (_, n) => say(id, `${t}:${n} ${"y".repeat(1000)}`));
    made.push(...ops.map((o) => o.id));
    await as(ws.agentId, ops);
  }
  const pages = [await read("steps")];
  while (pages.at(-1)!.older) {
    pages.push(await read("steps", pages.at(-1)!.older!));
    assert.ok(pages.length < 10);
  }
  assert.ok(pages.length >= 2, `${pages.length} pages`);
  const got = pages.flatMap((p) => p.comments.map((c) => c.id));
  assert.equal(new Set(got).size, got.length, "no comment twice");
  for (const c of made) assert.ok(got.includes(c), "every comment once");
  const oldest = (p: ProjectHistory) => Math.min(...p.comments.map((c) => Date.parse(c.at)));
  const newest = (p: ProjectHistory) => Math.max(...p.comments.map((c) => Date.parse(c.at)));
  for (let i = 1; i < pages.length; i++) assert.ok(newest(pages[i]!) <= oldest(pages[i - 1]!));
});

test("GET /sync/project-history: a creation says what the issue started with; the project's states and labels come at everything", async () => {
  const { otherStates, otherLabels } = await issueWithRefs(ws.workspaceId);
  const projectId = refs.other.id;
  const id = randomUUID();
  const [stateId, labelId] = [otherStates[0]!.id, otherLabels[0]!.id];
  await as(ws.agentId, [{ op: "create", m: "Issue", id, projectId, set: { title: "started with", stateId, labelIds: [labelId], assigneeIds: [ws.ownerId], priority: 2 } }]);
  const [state, tag, gone] = [randomUUID(), randomUUID(), randomUUID()];
  await as(ws.ownerId, [{ op: "create", m: "WorkflowState", id: state, set: { projectId, name: "Checked", group: "started", position: 50 } }]);
  await as(ws.ownerId, [{ op: "update", m: "WorkflowState", id: state, set: { name: "Approved here" } }]);
  await as(ws.ownerId, [{ op: "create", m: "Label", id: tag, set: { projectId, name: "area", color: "#12A594", position: 50 } }]);
  await as(ws.ownerId, [{ op: "update", m: "Label", id: tag, set: { color: "#0090FF" } }]);
  await as(ws.ownerId, [{ op: "create", m: "Label", id: gone, set: { projectId, name: "temporary", color: "#12A594", position: 51 } }]);
  await as(ws.ownerId, [{ op: "update", m: "Label", id: gone, set: { name: "short-lived" } }]);
  await as(ws.ownerId, [{ op: "delete", m: "Label", id: gone }]);
  await as(ws.ownerId, [{ op: "delete", m: "WorkflowState", id: state }]);

  const created = async (level: HistoryLevel) => (await read(level)).history.filter((e) => e.i === id).map((e) => [e.a, e.by, e.d]);
  assert.deepEqual(await created("outcomes"), [], "outcomes draw the creation from the issue alone");
  assert.deepEqual(await created("steps"), [["I", ws.agentId, { stateId, assigneeIds: [ws.ownerId] }]], "steps: the fields steps show");
  assert.deepEqual(await created("everything"), [["I", ws.agentId, { stateId, labelIds: [labelId], assigneeIds: [ws.ownerId], priority: 2 }]], "no empty fields, no title");

  assert.equal((await read("steps")).settings, undefined, "states and labels only at everything");
  const everything = await read("everything");
  assert.deepEqual(
    everything.settings!.filter((e) => new Set<string>([state, tag, gone]).has(e.mid)).map((e) => [e.m, e.a, e.mid, e.by, e.d, e.p]),
    [
      ["WorkflowState", "I", state, ws.ownerId, { name: "Checked", group: "started", isDefault: false }, {}],
      ["WorkflowState", "U", state, ws.ownerId, { name: "Approved here" }, { name: "Checked" }],
      ["Label", "I", tag, ws.ownerId, { name: "area", parentId: null }, {}],
      ["Label", "I", gone, ws.ownerId, { name: "temporary", parentId: null }, {}],
      ["Label", "U", gone, ws.ownerId, { name: "short-lived" }, { name: "temporary" }],
      ["Label", "D", gone, ws.ownerId, {}, { name: "short-lived" }],
      ["WorkflowState", "D", state, ws.ownerId, {}, { name: "Approved here" }],
    ],
    "a color change says nothing; deleted ones keep their lines",
  );
});
