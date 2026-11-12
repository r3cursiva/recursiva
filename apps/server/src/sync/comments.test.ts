import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { IssueHistory, Op } from "@rsva/protocol";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { importFixture, issueWithRefs, lastSyncId, rejects, serverWithIssue, type ServerWithIssue } from "../test/helpers.ts";
import { readLog } from "./log.ts";
import { applyTx } from "./write.ts";

const { comment, reaction, syncAction, issue } = schema;

// owner: the owner's browser, agent: the agent's API token.
let { server, ws, refs, owner, agent } = {} as ServerWithIssue;
before(async () => ({ server, ws, refs, owner, agent } = await serverWithIssue()));
after(() => server.close());

const as = (actor: string, ops: Op[]) => applyTx(ws.workspaceId, actor, randomUUID(), ops);
const tx = (ops: Op[]) => as(ws.ownerId, ops);
const say = (issueId: string, body: string, parentId?: string) => {
  const id = randomUUID();
  return { id, op: { op: "create", m: "Comment", id, set: { issueId, body, ...(parentId ? { parentId } : {}) } } as Op };
};
const row = async (id: string) => (await db.select().from(comment).where(eq(comment.id, id)))[0]!;
const history = async (issueId: string) => (await (await owner(`${server.url}/sync/history/${issueId}`)).json()) as IssueHistory;

test("comments and replies: one level deep, on the same issue, inside the workspace; actions carry issueId and author", async () => {
  const top = say(refs.issue.id, "First **comment**  \n");
  const r = await tx([top.op]);
  assert.equal(r.actions[0]!.m, "Comment");
  assert.equal(r.actions[0]!.by, ws.ownerId);
  assert.equal(r.actions[0]!.d!.issueId, refs.issue.id);
  assert.equal(r.actions[0]!.d!.body, "First **comment**", "trailing whitespace is dropped");
  assert.equal((await row(top.id)).authorId, ws.ownerId);

  const reply = say(refs.issue.id, "A reply", top.id);
  await as(ws.agentId, [reply.op]);
  assert.equal((await row(reply.id)).parentId, top.id);

  await rejects(tx([say(refs.issue.id, "deeper", reply.id).op]), "bad_ref");
  const [otherIssue] = await db.select().from(issue).where(eq(issue.projectId, refs.other.id)).limit(1);
  await rejects(tx([say(otherIssue!.id, "wrong thread", top.id).op]), "bad_ref");
  const foreign = await importFixture("sample", undefined, 3);
  const foreignIssue = (await issueWithRefs(foreign.workspaceId)).issue;
  await rejects(tx([say(foreignIssue.id, "elsewhere").op]), "bad_ref");
  await rejects(tx([say(refs.issue.id, "   ").op]), "invalid");
  await rejects(tx([top.op]), "conflict");
});

test("only the author edits and deletes; deletes leave an empty tombstone", async () => {
  const c = say(refs.issue.id, "draft");
  await tx([c.op]);
  await rejects(as(ws.agentId, [{ op: "update", m: "Comment", id: c.id, set: { body: "hijack" } }]), "forbidden");
  await rejects(as(ws.agentId, [{ op: "delete", m: "Comment", id: c.id }]), "forbidden");
  await rejects(tx([{ op: "update", m: "Comment", id: randomUUID(), set: { body: "x" } }]), "not_found");

  const edit = await tx([{ op: "update", m: "Comment", id: c.id, set: { body: "final" } }]);
  assert.deepEqual(Object.keys(edit.actions[0]!.d!).sort(), ["body", "editedAt", "issueId"]);
  const [logged] = await db.select().from(syncAction).where(and(eq(syncAction.workspaceId, ws.workspaceId), eq(syncAction.id, edit.s)));
  assert.equal(logged!.prev, null, "the old text is not kept in the log");
  assert.ok((await row(c.id)).editedAt);
  assert.deepEqual((await tx([{ op: "update", m: "Comment", id: c.id, set: { body: "final" } }])).actions, [], "same body: no action");

  const reply = say(refs.issue.id, "answer", c.id);
  await tx([reply.op]);
  const del = await tx([{ op: "delete", m: "Comment", id: c.id }]);
  assert.equal(del.actions[0]!.a, "U");
  assert.equal(del.actions[0]!.d!.body, "");
  const gone = await row(c.id);
  assert.equal(gone.body, "");
  assert.ok(gone.deletedAt);
  assert.equal((await row(reply.id)).parentId, c.id, "the reply keeps its thread");
  assert.deepEqual((await tx([{ op: "delete", m: "Comment", id: c.id }])).actions, [], "deleting twice is a no-op");
  await rejects(tx([{ op: "update", m: "Comment", id: c.id, set: { body: "back" } }]), "not_found");
  await rejects(tx([say(refs.issue.id, "late", c.id).op]), "bad_ref");
});

test("reactions: one per user, emoji and target; adding twice and removing twice are no-ops", async () => {
  const c = say(refs.issue.id, "react to me");
  await tx([c.op]);
  const thumbs = (id: string, commentId: string | null = c.id, emoji = "👍"): Op => ({ op: "create", m: "Reaction", id, set: { issueId: refs.issue.id, commentId, emoji } });
  const a = randomUUID();
  const added = await tx([thumbs(a)]);
  assert.equal(added.actions[0]!.d!.issueId, refs.issue.id);
  assert.deepEqual((await tx([thumbs(randomUUID())])).actions, [], "the same user, emoji and comment");
  await tx([thumbs(randomUUID(), null)]); // the issue itself is another target
  await as(ws.agentId, [thumbs(randomUUID())]); // another user
  await tx([thumbs(randomUUID(), c.id, "👍🏽")]); // a skin tone is another emoji
  await rejects(tx([thumbs(randomUUID(), c.id, "ok")]), "invalid");
  const [otherIssue] = await db.select().from(issue).where(eq(issue.projectId, refs.other.id)).limit(1);
  await rejects(tx([{ op: "create", m: "Reaction", id: randomUUID(), set: { issueId: otherIssue!.id, commentId: c.id, emoji: "🎉" } }]), "bad_ref");

  await rejects(as(ws.agentId, [{ op: "delete", m: "Reaction", id: a }]), "forbidden");
  const removed = await tx([{ op: "delete", m: "Reaction", id: a }]);
  assert.deepEqual(removed.actions.map((x) => [x.a, x.d]), [["D", { issueId: refs.issue.id }]]);
  assert.deepEqual((await tx([{ op: "delete", m: "Reaction", id: a }])).actions, []);
  const left = await db.select().from(reaction).where(eq(reaction.commentId, c.id));
  assert.equal(left.length, 2);
});

test("GET /sync/history: field changes with before → after and actor, comments and reactions, cut at s", async () => {
  const { issue: i, states, labels } = await issueWithRefs(ws.workspaceId, refs.other.key);
  const to = states.find((s) => s.id !== i.stateId)!;
  await tx([{ op: "update", m: "Issue", id: i.id, set: { stateId: to.id, labelIds: [labels[0]!.id] } }]);
  await as(ws.agentId, [{ op: "update", m: "Issue", id: i.id, set: { sortOrder: "a9" } }]); // a move: not history
  await as(ws.agentId, [{ op: "update", m: "Issue", id: i.id, set: { priority: i.priority === 1 ? 2 : 1 } }]);
  const c = say(i.id, "Looks good");
  const last = await tx([c.op, { op: "create", m: "Reaction", id: randomUUID(), set: { issueId: i.id, commentId: c.id, emoji: "🎉" } }]);

  const h = await history(i.id);
  assert.equal(h.s, last.s);
  assert.deepEqual(
    h.history.map((e) => [e.by, e.d, e.p]),
    [
      [ws.ownerId, { stateId: to.id, labelIds: [labels[0]!.id] }, { stateId: i.stateId, labelIds: i.labelIds }],
      [ws.agentId, { priority: i.priority === 1 ? 2 : 1 }, { priority: i.priority }],
    ],
  );
  assert.ok(h.history.every((e) => e.a === "U" && typeof e.at === "string"));
  assert.deepEqual(h.comments.map((x) => [x.id, x.body, x.authorId]), [[c.id, "Looks good", ws.ownerId]]);
  assert.deepEqual(h.reactions.map((x) => [x.commentId, x.emoji]), [[c.id, "🎉"]]);

  assert.equal((await owner(`${server.url}/sync/history/${randomUUID()}`)).status, 404);
  assert.equal((await owner(`${server.url}/sync/history/nope`)).status, 404);
});

test("agent API: comments in Markdown by issue key, replies by parentId, rejections as 400", async () => {
  const key = `${refs.project.key}-${refs.issue.number}`;
  const url = `${server.url}/api/v1/workspaces/${ws.slug}/issues/${key}/comments`;
  const post = (body: unknown) => agent(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const r = await post({ body: "Done in `abc123`.\n\n- checked" });
  assert.equal(r.status, 201);
  const { id } = (await r.json()) as { id: string };
  assert.equal((await row(id)).authorId, ws.agentId);
  assert.equal((await post({ body: "Thanks", parentId: id })).status, 201);
  const bad = await post({ body: "" });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "invalid");
  assert.equal((await post({ body: "x", parentId: randomUUID() })).status, 400);
  assert.equal((await agent(`${server.url}/api/v1/workspaces/${ws.slug}/issues/NOPE-1/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);

  const list = (await (await agent(url)).json()) as { comments: { id: string; parentId: string | null; author: string; body: string }[] };
  const mine = list.comments.filter((c) => c.id === id || c.parentId === id);
  assert.deepEqual(mine.map((c) => [c.body, c.author]), [["Done in `abc123`.\n\n- checked", `bot@${ws.slug}.test`], ["Thanks", `bot@${ws.slug}.test`]]);
});

test("an edit or a deletion leaves no earlier text in the log, and replaying the log still ends at the comment's text", async () => {
  const from = await lastSyncId(ws.workspaceId);
  const c = say(refs.issue.id, "secret v1");
  const other = say(refs.issue.id, "another comment stays");
  await tx([c.op, other.op]);
  await tx([{ op: "update", m: "Comment", id: c.id, set: { body: "secret v2" } }]);
  await tx([{ op: "update", m: "Comment", id: c.id, set: { body: "public v3" } }]);
  const log = await readLog(ws.workspaceId, from);
  const text = JSON.stringify(await db.select({ d: syncAction.data, p: syncAction.prev }).from(syncAction).where(eq(syncAction.modelId, c.id)));
  assert.doesNotMatch(text, /secret/, "neither data nor prev keeps an earlier version");
  assert.match(JSON.stringify(log), /another comment stays/, "other comments keep theirs");

  // A member who joined after all this replays the log: a row with every field, then the newest text.
  const replay = (actions: typeof log) => {
    const rows = new Map<string, Record<string, unknown>>();
    for (const a of actions.filter((x) => x.m === "Comment")) rows.set(a.mid, a.a === "I" ? { ...a.d } : { ...rows.get(a.mid), ...a.d });
    return rows.get(c.id)!;
  };
  const created = log.find((a) => a.mid === c.id && a.a === "I")!;
  assert.equal(created.d!.body, "", "the I action keeps the field, empty");
  assert.equal(replay(log).body, "public v3");
  assert.equal(replay(log).issueId, refs.issue.id);

  await tx([{ op: "delete", m: "Comment", id: c.id }]);
  const after = await readLog(ws.workspaceId, from);
  assert.doesNotMatch(JSON.stringify(after.filter((a) => a.mid === c.id)), /v3/, "a deletion clears the last version too");
  assert.equal(replay(after).body, "");
  assert.ok(replay(after).deletedAt);
});

test("GET /sync/history comes in pages of about a megabyte: newest first, `until` gives the one before, nothing lost or doubled", async () => {
  const id = randomUUID();
  await tx([{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: "long thread", stateId: refs.states[0]!.id } }]);
  const body = "z".repeat(60_000);
  const made: string[] = [];
  // 30 comments of 60 KB in transactions of three (one moment each), with a title change between them.
  for (let i = 0; i < 10; i++) {
    const three = [say(id, `${i}a ${body}`), say(id, `${i}b ${body}`), say(id, `${i}c ${body}`)];
    made.push(...three.map((c) => c.id));
    await tx(three.map((c) => c.op));
    await tx([{ op: "update", m: "Issue", id, set: { title: `long thread ${i}` } }]);
  }
  const pages: IssueHistory[] = [await history(id)];
  while (pages.at(-1)!.older) {
    const r = await owner(`${server.url}/sync/history/${id}?until=${encodeURIComponent(pages.at(-1)!.older!)}`);
    assert.equal(r.status, 200);
    pages.push((await r.json()) as IssueHistory);
    assert.ok(pages.length < 10);
  }
  assert.ok(pages.length >= 2, `${pages.length} pages`);
  for (const p of pages) assert.ok(JSON.stringify(p).length < 1.5 * 2 ** 20, "a page stays near the budget");
  const comments = pages.flatMap((p) => p.comments.map((c) => c.id));
  assert.deepEqual([...comments].sort(), [...made].sort(), "every comment once");
  const entries = pages.flatMap((p) => p.history.map((e) => e.id));
  assert.equal(new Set(entries).size, entries.length);
  assert.equal(entries.length, 10, "every title change once");
  assert.ok(pages[0]!.doc, "the description comes with the first page");
  assert.equal(pages[1]!.doc, null);
  // Pages go back in time: everything on a later page is older than everything on the one before.
  const oldest = (p: IssueHistory) => Math.min(...p.comments.map((c) => Date.parse(c.createdAt)));
  const newest = (p: IssueHistory) => Math.max(...p.comments.map((c) => Date.parse(c.createdAt)));
  for (let i = 1; i < pages.length; i++) assert.ok(newest(pages[i]!) <= oldest(pages[i - 1]!));
  assert.equal((await owner(`${server.url}/sync/history/${id}?until=yesterday`)).status, 400);
});

test("a page is one moment when that moment alone is over the budget (one big transaction), then goes on before it", async () => {
  const id = randomUUID();
  await tx([{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: "burst", stateId: refs.states[0]!.id } }]);
  const early = say(id, "before the burst");
  await tx([early.op]);
  const burst = Array.from({ length: 20 }, (_, i) => say(id, `${i} ${"q".repeat(60_000)}`));
  await tx(burst.map((c) => c.op));
  const first = await history(id);
  assert.equal(first.comments.length, 20, "the whole moment, not part of it");
  assert.ok(first.older);
  const second = (await (await owner(`${server.url}/sync/history/${id}?until=${encodeURIComponent(first.older!)}`)).json()) as IssueHistory;
  assert.deepEqual(second.comments.map((c) => c.id), [early.id]);
  assert.equal(second.older, null);
});
