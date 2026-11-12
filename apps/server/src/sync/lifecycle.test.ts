// Archive, delete (into the trash) and restore an issue, and the parent tree: the write pipeline's rules (PLNR-33).
// Delete permanently and the sweep of issues 30 days in the trash (RSVA-457).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { Op } from "@rsva/protocol";
import { APP_BOT } from "@rsva/schema/models";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { addMember, importFixture, issueWithRefs, lastSyncId, rejects, type Fixture } from "../test/helpers.ts";
import { sweepTrash } from "./purge.ts";
import { applyServerChange, applyTx } from "./write.ts";

const { issue, comment, reaction, attachment, document, syncAction, user } = schema;

let ws: Fixture;
let refs: Awaited<ReturnType<typeof issueWithRefs>>;
before(async () => {
  ws = await importFixture();
  refs = await issueWithRefs(ws.workspaceId);
});

type Set = Extract<Op, { op: "update"; m: "Issue" }>["set"];
const as = (actor: string, ops: Op[]) => applyTx(ws.workspaceId, actor, randomUUID(), ops);
const update = (id: string, set: Set, actor = ws.ownerId) => as(actor, [{ op: "update", m: "Issue", id, set }]);
const row = async (id: string) => (await db.select().from(issue).where(eq(issue.id, id)))[0]!;
const state = (group: string) => refs.states.find((s) => s.group === group)!.id;
const now = () => new Date().toISOString();

/** A fresh issue in the fixture's project, created by `actor`. */
async function newIssue(actor = ws.ownerId, set: Partial<Set> = {}): Promise<string> {
  const id = randomUUID();
  await as(actor, [{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: "lifecycle", stateId: state("backlog"), ...set } }]);
  return id;
}

test("only completed or cancelled issues are archived; the server sets the time; restore clears it", async () => {
  const id = await newIssue();
  await rejects(update(id, { archivedAt: now() }), "invalid");
  // Closing and archiving in one change passes: the rule reads the state the change leaves.
  const r = await update(id, { stateId: state("completed"), archivedAt: "2000-01-01T00:00:00Z" });
  const d = r.actions[0]!.d!;
  assert.ok(d.archivedAt && String(d.archivedAt) > "2020", "the server's time, not the client's");
  assert.equal((await row(id)).archivedAt, d.archivedAt);
  // Archiving an archived issue is not a change.
  assert.deepEqual((await update(id, { archivedAt: now() })).actions, []);
  const back = await update(id, { archivedAt: null });
  assert.equal(back.actions[0]!.d!.archivedAt, null);
  assert.equal((await row(id)).archivedAt, null);
});

test("the creator or an admin deletes and restores; a deleted issue takes no comments", async () => {
  const mine = await newIssue(ws.agentId);
  const owners = await newIssue(ws.ownerId);
  // The agent is a member: it may delete its own issue, not someone else's.
  await rejects(update(owners, { deletedAt: now() }, ws.agentId), "forbidden");
  const r = await update(mine, { deletedAt: now() }, ws.agentId);
  assert.ok(r.actions[0]!.d!.deletedAt);
  assert.deepEqual(r.actions[0]!.d && Object.keys(r.actions[0]!.d).sort(), ["deletedAt", "updatedAt"]);
  await rejects(as(ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: mine, body: "hi" } }]), "bad_ref");
  await rejects(as(ws.ownerId, [{ op: "create", m: "Reaction", id: randomUUID(), set: { issueId: mine, emoji: "👍" } }]), "bad_ref");
  await rejects(update(owners, { parentId: mine }), "bad_ref");
  // The owner is an admin: they restore an issue someone else deleted.
  await update(mine, { deletedAt: null });
  assert.equal((await row(mine)).deletedAt, null);
  await as(ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: mine, body: "back" } }]);
});

test("delete and restore are history: the log keeps what the field held before", async () => {
  const id = await newIssue();
  const r = await update(id, { deletedAt: now() });
  const { syncAction } = schema;
  const [a] = await db.select().from(syncAction).where(and(eq(syncAction.workspaceId, ws.workspaceId), eq(syncAction.id, r.s)));
  assert.deepEqual(a!.prev, { deletedAt: null });
});

test("a parent cannot be one of the issue's own sub-issues, at any depth", async () => {
  const a = await newIssue();
  const b = await newIssue(ws.ownerId, { parentId: a });
  const c = await newIssue(ws.ownerId, { parentId: b });
  await rejects(update(a, { parentId: a }), "bad_ref");
  await rejects(update(a, { parentId: b }), "bad_ref");
  await rejects(update(a, { parentId: c }), "bad_ref");
  // Moving a sub-tree under a sibling is fine.
  const d = await newIssue();
  await update(b, { parentId: d });
  assert.equal((await row(b)).parentId, d);
  await update(a, { parentId: c });
  assert.equal((await row(a)).parentId, c);
});

// ── Delete permanently (RSVA-457) ────────────────────────────────────────────────────────────────────────────

const purge = (id: string, actor = ws.ownerId) => as(actor, [{ op: "delete", m: "Issue", id }]);
/** The issue's row, or undefined once it is deleted for good. */
const found = async (id: string) => (await db.select().from(issue).where(eq(issue.id, id)))[0];

async function trashedIssue(actor = ws.ownerId): Promise<string> {
  const id = await newIssue(actor);
  await update(id, { deletedAt: now() }, actor);
  return id;
}

test("Delete permanently: only from the trash, by its creator or an admin, never by an agent", async () => {
  const live = await newIssue();
  await rejects(purge(live), "invalid", /in the trash/);
  assert.ok(await found(live), "a live issue stays");

  // The agent made and trashed it, so it may delete it: not for good.
  const agents = await trashedIssue(ws.agentId);
  await rejects(purge(agents, ws.agentId), "forbidden", /by a person/);

  const member = await addMember(ws.workspaceId, "member");
  const owners = await trashedIssue();
  await rejects(purge(owners, member.id), "forbidden", /creator or an admin/);

  const own = await trashedIssue(member.id);
  await purge(own, member.id);
  assert.equal(await found(own), undefined, "its creator deleted it");
  // The owner is an admin: the agent's issue too.
  await purge(agents);
  assert.equal(await found(agents), undefined);
});

test("what is the issue's own goes with it; the others let go of it, each a change of theirs; the log gets one D", async () => {
  const gone = await newIssue();
  const child = await newIssue(ws.ownerId, { parentId: gone });
  const blocked = await newIssue(ws.ownerId, { blockedByIds: [gone] });
  const related = await newIssue(ws.ownerId, { relatedIds: [gone] });
  const dup = await newIssue(ws.ownerId, { duplicateOfId: gone });
  const commentId = randomUUID();
  await as(ws.ownerId, [
    { op: "create", m: "Comment", id: commentId, set: { issueId: gone, body: "a comment" } },
    { op: "create", m: "Reaction", id: randomUUID(), set: { issueId: gone, commentId, emoji: "👍" } },
    { op: "create", m: "Attachment", id: randomUUID(), set: { issueId: gone, url: "https://example.com/a", title: "a link" } },
    { op: "update", m: "Document", id: gone, set: { doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "text" }] }] } } },
  ]);
  await update(gone, { deletedAt: now() });

  const from = await lastSyncId(ws.workspaceId);
  const r = await purge(gone);
  assert.equal(await found(gone), undefined);
  for (const t of [comment, reaction, attachment] as const) assert.deepEqual(await db.select().from(t).where(eq(t.issueId, gone)), [], "nothing of it is left");
  assert.deepEqual(await db.select().from(document).where(eq(document.id, gone)), []);

  assert.equal((await found(child))!.parentId, null, "the sub-issue is top-level now");
  assert.deepEqual((await found(blocked))!.blockedByIds, []);
  assert.deepEqual((await found(related))!.relatedIds, []);
  assert.equal((await found(dup))!.duplicateOfId, null);

  const log = await db
    .select({ m: syncAction.model, mid: syncAction.modelId, a: syncAction.action, prev: syncAction.prev, by: syncAction.actorId })
    .from(syncAction)
    .where(and(eq(syncAction.workspaceId, ws.workspaceId), gt(syncAction.id, from)))
    .orderBy(asc(syncAction.id));
  assert.deepEqual(
    log.map((a) => `${a.a} ${a.mid}`).sort(),
    [`D ${gone}`, `U ${blocked}`, `U ${child}`, `U ${dup}`, `U ${related}`].sort(),
  );
  assert.equal(log.at(-1)!.a, "D", "the issue goes last, after the others let go of it");
  assert.deepEqual(log.find((a) => a.mid === child)!.prev, { parentId: gone }, "the sub-issue's history says what it had");
  assert.ok(log.every((a) => a.by === ws.ownerId));
  assert.equal(r.actions.length, 5);
  // The log's earlier rows of the issue stay: their numbers are what clients count by.
  assert.ok((await db.select().from(syncAction).where(eq(syncAction.modelId, gone))).some((a) => a.action === "I"));
});

test("the log forgets the issue's words: title, comments, links, GitHub links and description, in every earlier action (RSVA-609)", async () => {
  const secret = (what: string) => `secret-${what}-${randomUUID()}`;
  const words = { pull: secret("pull"), branch: secret("branch"), commit: secret("commit"), other: secret("other"), title: secret("title"), renamed: secret("renamed"), comment: secret("comment"), edited: secret("edited"), link: secret("link"), linkUrl: `https://example.com/${secret("url")}`, linkTitle: secret("link-title"), removed: secret("removed"), doc: secret("doc"), doc2: secret("doc2") };
  const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const before = await lastSyncId(ws.workspaceId);
  const gone = await newIssue(ws.ownerId, { title: words.title });
  const [commentId, linkId, removedId] = [randomUUID(), randomUUID(), randomUUID()];
  await update(gone, { title: words.renamed });
  await as(ws.ownerId, [
    { op: "create", m: "Comment", id: commentId, set: { issueId: gone, body: words.comment } },
    { op: "create", m: "Attachment", id: linkId, set: { issueId: gone, url: "https://example.com/plain", title: words.link } },
    { op: "create", m: "Attachment", id: removedId, set: { issueId: gone, url: "https://example.com/gone", title: words.removed } },
    { op: "update", m: "Document", id: gone, set: { doc: doc(words.doc) } },
  ]);
  await as(ws.ownerId, [
    { op: "update", m: "Comment", id: commentId, set: { body: words.edited } },
    { op: "update", m: "Attachment", id: linkId, set: { url: words.linkUrl, title: words.linkTitle } },
    { op: "delete", m: "Attachment", id: removedId },
    { op: "update", m: "Document", id: gone, set: { doc: doc(words.doc2) } },
  ]);
  // GitHub's: a pull request and a commit linked by the webhook (github/events.ts), the commit's link gone since.
  const [pullId, commitId] = [randomUUID(), randomUUID()];
  await applyServerChange(ws.workspaceId, ws.ownerId, async () => [
    { m: "GithubLink", mid: pullId, a: "I", d: { id: pullId, issueId: gone, kind: "pull", repo: "acme/app", number: 7, title: words.pull, head: words.branch } },
    { m: "GithubLink", mid: commitId, a: "I", d: { id: commitId, issueId: gone, kind: "commit", repo: "acme/app", sha: "0123abc", title: words.commit } },
    { m: "Issue", mid: gone, a: "U", d: { gh: { verb: "opened", repo: "acme/app", number: 7, sha: null, title: words.pull, state: "open", by: "robin", closing: true, at: now() } } },
    { m: "GithubLink", mid: commitId, a: "D", d: { issueId: gone } },
  ]);
  // A comment of the issue whose id is another issue's: ids are unique per table only. That issue keeps its words.
  const other = await newIssue(ws.ownerId, { title: words.other });
  await as(ws.ownerId, [{ op: "create", m: "Comment", id: other, set: { issueId: gone, body: "same id" } }]);
  await update(gone, { deletedAt: now() });
  const kept = await db.select({ id: syncAction.id }).from(syncAction).where(and(eq(syncAction.workspaceId, ws.workspaceId), gt(syncAction.id, before))).orderBy(asc(syncAction.id));
  await purge(gone);

  // What any reader of the log gets: a catch-up from before the issue, and the before-values the history reads.
  const log = await db.select({ id: syncAction.id, d: syncAction.data, p: syncAction.prev }).from(syncAction).where(and(eq(syncAction.workspaceId, ws.workspaceId), gt(syncAction.id, before))).orderBy(asc(syncAction.id));
  const text = JSON.stringify(log);
  assert.deepEqual(Object.keys(words).filter((what) => text.includes(words[what as keyof typeof words])), ["other"], "words the log still holds");
  // The rows and their numbers stay: a client counts by them.
  assert.deepEqual(log.map((a) => a.id).slice(0, kept.length), kept.map((a) => a.id));
});

test("the sweep: an issue in the trash for over 30 days goes, signed by the app's bot; a younger one and a restored one stay", async () => {
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const old = await trashedIssue();
  const young = await trashedIssue();
  const restored = await newIssue();
  await db.update(issue).set({ deletedAt: days(31) }).where(eq(issue.id, old));
  await db.update(issue).set({ deletedAt: days(29) }).where(eq(issue.id, young));

  const failed: string[] = [];
  assert.ok((await sweepTrash((_, id) => failed.push(id))) >= 1);
  assert.deepEqual(failed, []);
  assert.equal(await found(old), undefined);
  assert.ok(await found(young), "29 days in the trash: not yet");
  assert.ok(await found(restored));

  const [d] = await db
    .select({ by: user.email })
    .from(syncAction)
    .innerJoin(user, eq(user.id, syncAction.actorId))
    .where(and(eq(syncAction.modelId, old), eq(syncAction.action, "D")))
    .orderBy(desc(syncAction.id));
  assert.equal(d!.by, APP_BOT.email);
  // A second sweep finds nothing of this workspace to do.
  const before = await lastSyncId(ws.workspaceId);
  await sweepTrash(() => {});
  assert.equal(await lastSyncId(ws.workspaceId), before);
});
