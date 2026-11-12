import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fromMarkdown } from "@rsva/editor/markdown";
import { generate } from "@rsva/fixtures";
import type { BundleHeader, BundleIssue, BundleLine, BundleUser } from "@rsva/schema/bundle";
import { and, eq, sql as dsql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { DiskBlobStore } from "./files/store.ts";
import { png as pngImage } from "./test/images.ts";
import { importBundle } from "./import.ts";
import { lastSyncId, slug } from "./test/helpers.ts";

const { project, workflowState, label, issue, document, member, syncAction, comment, reaction, user } = schema;

async function counts(workspaceId: string) {
  const one = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
  const n = dsql<number>`count(*)::int`;
  return {
    members: await one(db.select({ n }).from(member).where(eq(member.workspaceId, workspaceId))),
    projects: await one(db.select({ n }).from(project).where(eq(project.workspaceId, workspaceId))),
    states: await one(db.select({ n }).from(workflowState).innerJoin(project, eq(project.id, workflowState.projectId)).where(eq(project.workspaceId, workspaceId))),
    labels: await one(db.select({ n }).from(label).where(eq(label.workspaceId, workspaceId))),
    issues: await one(db.select({ n }).from(issue).where(eq(issue.workspaceId, workspaceId))),
    documents: await one(db.select({ n }).from(document).where(eq(document.workspaceId, workspaceId))),
  };
}

test("importing twice gives the same rows, no duplicates, one R action per import", async () => {
  const s = slug("imp");
  const bundle = generate("sample", { slug: s });
  const first = await importBundle(bundle);
  const before = await counts(first.workspaceId);
  assert.deepEqual(before, { members: 2, projects: 10, states: 70, labels: 40, issues: 427, documents: 427 });
  assert.equal(await lastSyncId(first.workspaceId), 1);

  const second = await importBundle(bundle);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.deepEqual(await counts(first.workspaceId), before);
  assert.equal(await lastSyncId(first.workspaceId), 2);
  const log = await db.select().from(syncAction).where(eq(syncAction.workspaceId, first.workspaceId)).orderBy(syncAction.id);
  assert.deepEqual(log.map((a) => [a.id, a.model, a.action]), [[1, "Workspace", "R"], [2, "Workspace", "R"]]);
});

test("references are resolved and issue counters cover the largest number", async () => {
  const s = slug("imp");
  const bundle = generate("sample", { slug: s, seed: 5 });
  const { workspaceId } = await importBundle(bundle);
  const src = bundle.filter((l): l is BundleIssue => l.m === "Issue");

  const rows = await db.select().from(issue).where(eq(issue.workspaceId, workspaceId));
  const byExt = new Map(rows.map((r) => [r.externalId!, r]));
  const states = new Map((await db.select().from(workflowState)).map((r) => [r.id, r]));
  const labels = new Map((await db.select().from(label).where(eq(label.workspaceId, workspaceId))).map((r) => [r.id, r]));
  const projects = new Map((await db.select().from(project).where(eq(project.workspaceId, workspaceId))).map((r) => [r.id, r]));
  for (const i of src) {
    const r = byExt.get(i.ext)!;
    assert.equal(projects.get(r.projectId)!.externalId, i.project.ext);
    assert.equal(states.get(r.stateId)!.externalId, i.state.ext);
    assert.equal(states.get(r.stateId)!.projectId, r.projectId);
    assert.deepEqual(r.labelIds.map((id) => labels.get(id)!.externalId), (i.labels ?? []).map((l) => l.ext));
    assert.equal(r.labelIds.every((id) => labels.get(id)!.projectId === r.projectId), true);
    assert.equal(r.assigneeIds.length, (i.assignees ?? []).length);
    assert.equal(r.parentId ? byExt.get(i.parent!.ext)!.id === r.parentId : !i.parent, true);
    assert.equal(r.number, i.number);
  }
  for (const p of projects.values()) {
    const max = Math.max(...rows.filter((r) => r.projectId === p.id).map((r) => r.number));
    assert.ok(p.issueCounter >= max, `${p.key}: counter ${p.issueCounter} < ${max}`);
  }
});

test("the same bundle imported under two slugs makes two independent workspaces", async () => {
  // A copy of one source into a second workspace (a stand, a test) must not touch the first one's rows.
  const bundle = generate("sample", { seed: 9 });
  const a = await importBundle([{ ...bundle[0]!, workspace: { slug: slug("imp-a"), name: "A" } } as never, ...bundle.slice(1)]);
  const b = await importBundle([{ ...bundle[0]!, workspace: { slug: slug("imp-b"), name: "B" } } as never, ...bundle.slice(1)]);
  assert.notEqual(a.workspaceId, b.workspaceId);
  const expected = { members: 2, projects: 10, states: 70, labels: 40, issues: 427, documents: 427 };
  assert.deepEqual(await counts(a.workspaceId), expected);
  assert.deepEqual(await counts(b.workspaceId), expected);
  // Every issue of B points at B's own project, state and labels.
  const bad = await db.execute(dsql`
    select i.id from issue i
    join project p on p.id = i.project_id
    join workflow_state s on s.id = i.state_id
    where i.workspace_id = ${b.workspaceId} and (p.workspace_id <> i.workspace_id or s.project_id <> i.project_id
      or exists (select 1 from label l where l.id = any(i.label_ids) and l.workspace_id <> i.workspace_id))`);
  assert.equal(bad.length, 0);
});

test("a repeated import updates changed fields in place", async () => {
  const s = slug("imp");
  const bundle = generate("sample", { slug: s, seed: 11 });
  const { workspaceId } = await importBundle(bundle);
  const i = bundle.find((l): l is BundleIssue => l.m === "Issue")!;
  const { createdAt: _, ...withoutCreatedAt } = i;
  const changed = bundle.map((l) => (l === i ? { ...withoutCreatedAt, title: "Renamed in the source", labels: [], description: "new **one**" } : l));
  await importBundle(changed);
  const [row] = await db.select().from(issue).where(and(eq(issue.externalId, i.ext), eq(issue.workspaceId, workspaceId)));
  assert.equal(row!.title, "Renamed in the source");
  assert.deepEqual(row!.labelIds, []);
  // A field the source no longer sends keeps its stored value instead of the column default.
  assert.equal(Date.parse(row!.createdAt), Date.parse(i.createdAt!));
  const [doc] = await db.select().from(document).where(eq(document.id, row!.id));
  assert.deepEqual(doc!.doc, fromMarkdown("new **one**"), "Markdown wins over the HTML the generator wrote");
  assert.equal((await counts(workspaceId)).issues, 427);
});

test("an import guards the states and labels it creates under the guarded names, and keeps an admin's switch on a repeat", async () => {
  const s = slug("imp");
  const bundle = generate("sample", { slug: s, seed: 17 });
  const { workspaceId } = await importBundle(bundle);
  const states = await db.select({ id: workflowState.id, name: workflowState.name, onlyPeople: workflowState.onlyPeople }).from(workflowState).innerJoin(project, eq(project.id, workflowState.projectId)).where(eq(project.workspaceId, workspaceId));
  assert.ok(states.length > 0);
  for (const st of states) assert.equal(st.onlyPeople, st.name === "Todo" || st.name === "Approved", st.name);
  const labels = await db.select({ id: label.id, name: label.name, onlyPeople: label.onlyPeople }).from(label).where(eq(label.workspaceId, workspaceId));
  for (const l of labels) assert.equal(l.onlyPeople, ["proposed", "security", "owner"].includes(l.name), l.name);
  assert.ok(labels.some((l) => l.onlyPeople), "the fixture has a guarded label");

  // An admin switches Todo off: a repeated import leaves it as they set it.
  const todo = states.find((st) => st.name === "Todo")!;
  await db.update(workflowState).set({ onlyPeople: false }).where(eq(workflowState.id, todo.id));
  await importBundle(bundle);
  const [again] = await db.select({ onlyPeople: workflowState.onlyPeople }).from(workflowState).where(eq(workflowState.id, todo.id));
  assert.equal(again!.onlyPeople, false);
});

test("comments with replies and reactions import by external id: a repeat updates, nothing doubles", async () => {
  const s = slug("imp");
  const base = generate("sample", { slug: s, seed: 13 });
  const [i1, i2] = base.filter((l): l is BundleIssue => l.m === "Issue");
  const extra: BundleLine[] = [
    // A reply listed before its parent: the import does not depend on the order.
    { m: "Comment", ext: "c2", issue: { ext: i1!.ext }, parent: { ext: "c1" }, author: { ext: "u-agent" }, body: "Reply", createdAt: "2026-10-02T10:00:00Z" },
    { m: "Comment", ext: "c1", issue: { ext: i1!.ext }, author: { ext: "u-owner" }, body: "**Top**", createdAt: "2026-10-02T09:00:00Z", editedAt: "2026-10-02T09:30:00Z" },
    { m: "Comment", ext: "c3", issue: { ext: i2!.ext }, author: { ext: "someone-gone" }, body: "Orphan author" },
    { m: "Reaction", ext: "r1", issue: { ext: i1!.ext }, comment: { ext: "c1" }, user: { ext: "u-agent" }, emoji: "👍" },
    { m: "Reaction", ext: "r2", issue: { ext: i1!.ext }, user: { ext: "u-owner" }, emoji: "🎉" },
  ];
  const first = await importBundle([...base, ...extra]);
  assert.equal(first.counts.comments, 3);
  assert.equal(first.counts.replies, 1);
  const rows = async () => db.select().from(comment).where(eq(comment.workspaceId, first.workspaceId)).orderBy(comment.externalId);
  const [c1, c2, c3] = await rows();
  assert.equal(c2!.parentId, c1!.id);
  assert.equal(c1!.body, "**Top**");
  assert.equal(Date.parse(c1!.editedAt!), Date.parse("2026-10-02T09:30:00Z"));
  assert.equal(c3!.authorId, null, "an author who is not in the bundle imports as unknown");
  assert.equal((await db.select().from(reaction).where(eq(reaction.workspaceId, first.workspaceId))).length, 2);

  const edited = extra.map((l) => (l.m === "Comment" && l.ext === "c1" ? { ...l, body: "**Top**, edited" } : l));
  await importBundle([...base, ...edited]);
  const again = await rows();
  assert.equal(again.length, 3);
  assert.equal(again[0]!.id, c1!.id);
  assert.equal(again[0]!.body, "**Top**, edited");
  assert.equal((await db.select().from(reaction).where(eq(reaction.workspaceId, first.workspaceId))).length, 2);
});

test("mentions in the text name bundle users by ext and import as mentions of ours; an unknown ext stays the name (RSVA-42)", async () => {
  const s = slug("imp");
  const base = generate("sample", { slug: s, seed: 17 });
  const [i1] = base.filter((l): l is BundleIssue => l.m === "Issue");
  const lines = base.map((l) => (l === i1 ? { ...i1, description: "For [@Agent](mention:u-agent) and [@Gone](mention:someone-gone)" } : l));
  const extra: BundleLine[] = [
    { m: "Comment", ext: "c1", issue: { ext: i1!.ext }, author: { ext: "u-owner" }, body: "Ping [@Agent](mention:u-agent), not [@Gone](mention:someone-gone)" },
    { m: "Comment", ext: "c2", issue: { ext: i1!.ext }, author: { ext: "u-owner" }, body: "Plain  text, kept *as written*" },
  ];
  const { workspaceId } = await importBundle([...lines, ...extra]);
  const [agent] = await db.select({ id: user.id }).from(user).where(eq(user.email, `bot@${s}.test`));
  assert.ok(agent);
  const [doc] = await db.select({ doc: document.doc }).from(document).innerJoin(issue, eq(issue.id, document.id)).where(and(eq(issue.workspaceId, workspaceId), eq(issue.externalId, i1!.ext)));
  assert.deepEqual((doc!.doc as { content: unknown[] }).content, [
    { type: "paragraph", content: [{ type: "text", text: "For " }, { type: "mention", attrs: { id: agent.id, label: "Agent" } }, { type: "text", text: " and @Gone" }] },
  ]);
  const [c1, c2] = await db.select({ body: comment.body }).from(comment).where(eq(comment.workspaceId, workspaceId)).orderBy(comment.externalId);
  assert.equal(c1!.body, `Ping [@Agent](mention:${agent.id}), not @Gone`);
  assert.equal(c2!.body, "Plain  text, kept *as written*");
});

test("member roles from the bundle, users who are not members, tombstone comments", async () => {
  const s = slug("imp");
  const base = generate("sample", { slug: s, seed: 17 });
  const [i1] = base.filter((l): l is BundleIssue => l.m === "Issue");
  const extra: BundleLine[] = [
    { m: "User", ext: "u-admin", email: `${s}-admin@example.com`, name: "Admin", role: "admin" },
    { m: "User", ext: "u-former", email: `${s}-former@example.com`, name: "Former", role: null },
    { m: "Comment", ext: "t1", issue: { ext: i1!.ext }, author: { ext: "u-former" }, body: "", createdAt: "2026-10-02T09:00:00Z", deletedAt: "2026-10-03T09:00:00Z" },
    { m: "Comment", ext: "t2", issue: { ext: i1!.ext }, parent: { ext: "t1" }, author: { ext: "u-admin" }, body: "Still here", deletedAt: null },
  ];
  const first = await importBundle([...base, ...extra]);
  const roles = async () =>
    Object.fromEntries(
      (
        await db
          .select({ role: member.role, email: user.email })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(eq(member.workspaceId, first.workspaceId))
      ).map((r) => [r.email, r.role]),
    );
  const before = await roles();
  assert.equal(before[`${s}-admin@example.com`], "admin");
  assert.equal(before[`${s}-former@example.com`], undefined, "role null imports the user without a membership");
  assert.equal(Object.keys(before).length, 3);
  const [t1, t2] = await db.select().from(comment).where(eq(comment.workspaceId, first.workspaceId)).orderBy(comment.externalId);
  assert.equal(Date.parse(t1!.deletedAt!), Date.parse("2026-10-03T09:00:00Z"));
  assert.notEqual(t1!.authorId, null, "a non-member author is still a known user");
  assert.equal(t2!.parentId, t1!.id);

  // A repeated import leaves the stored membership alone; with updateRoles a role the bundle states overwrites it, and
  // one it omits still leaves it alone.
  const withRole = (role: BundleUser["role"] | undefined) =>
    extra.map((l) => (l.m === "User" && l.ext === "u-admin" ? { m: l.m, ext: l.ext, email: l.email, name: l.name, ...(role !== undefined ? { role } : {}) } : l));
  await importBundle([...base, ...withRole("guest")]);
  assert.equal((await roles())[`${s}-admin@example.com`], "admin", "without updateRoles the role here stays");
  await importBundle([...base, ...withRole("guest")], { updateRoles: true });
  assert.equal((await roles())[`${s}-admin@example.com`], "guest");
  await importBundle([...base, ...withRole(undefined)], { updateRoles: true });
  assert.equal((await roles())[`${s}-admin@example.com`], "guest");
});

test("a bundle does not say who people here are: existing users keep name and kind, agents stay members, owners stay", async () => {
  const s = slug("imp");
  const base = generate("sample", { slug: s, seed: 19 });
  const header = base[0]!;
  const ownerLine = base.find((l): l is BundleUser => l.m === "User" && l.ext === (header as { owner: { ext: string } }).owner.ext)!;
  const agentLine = base.find((l): l is BundleUser => l.m === "User" && l.kind === "agent")!;
  const first = await importBundle(base);
  const people = async () =>
    Object.fromEntries(
      (
        await db
          .select({ email: user.email, name: user.name, kind: user.kind, role: member.role })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(eq(member.workspaceId, first.workspaceId))
      ).map((r) => [r.email, r]),
    );
  const before = await people();
  assert.equal(before[agentLine.email]!.role, "member");

  // Another source, the same addresses: it calls the owner an agent and renames them, makes the agent an admin, the owner
  // a guest, and tries to create an owner of its own.
  const forged: (BundleHeader | BundleLine)[] = [
    header,
    { ...ownerLine, name: "Not me", kind: "agent", role: "guest" },
    { ...agentLine, name: "Root", role: "admin" },
    { m: "User", ext: "u-new-owner", email: `${s}-boss@example.com`, name: "Boss", role: "owner" },
    { m: "User", ext: "u-new-agent", email: `${s}-bot2@example.com`, name: "Bot 2", kind: "agent", role: "admin" },
  ];
  for (const opts of [{}, { updateRoles: true }]) {
    await importBundle(forged, opts);
    const now = await people();
    assert.deepEqual(now[ownerLine.email], before[ownerLine.email], "the owner keeps name, kind and role");
    assert.equal(now[agentLine.email]!.kind, "agent");
    assert.equal(now[agentLine.email]!.name, before[agentLine.email]!.name, "an existing user keeps their name");
    assert.equal(now[agentLine.email]!.role, "member", "an agent is never made an admin");
    assert.equal(now[`${s}-boss@example.com`]!.role, "admin", "an existing workspace gets no new owner");
    assert.equal(now[`${s}-bot2@example.com`]!.role, "member", "nor does a new agent become an admin");
    assert.equal(now[`${s}-bot2@example.com`]!.kind, "agent", "a new user takes the bundle's kind");
  }

  // An agent cannot own a new workspace either.
  const agentOwned = generate("sample", { slug: slug("imp"), seed: 21 }).map((l) => (l.m === "User" && l.ext === (header as { owner: { ext: string } }).owner.ext ? { ...l, kind: "agent" as const } : l));
  await assert.rejects(importBundle(agentOwned), /owner .* is an agent/);
});

test("the bundle's slug follows the rules of a new workspace's", async () => {
  const base = generate("sample", { seed: 23 });
  const withSlug = (slugValue: unknown) => [{ ...base[0]!, workspace: { slug: slugValue, name: "X" } } as never, ...base.slice(1)];
  for (const bad of ["api", "sync", "Upper-Case", "a", "-dash-", "x".repeat(33), "with space", "a/b", 7, undefined]) {
    await assert.rejects(importBundle(withSlug(bad)), /slug/, String(bad));
  }
});

test("relations and links: refs resolved on the end the bundle gives, bad ones dropped; a repeat adds nothing", async () => {
  const s = slug("imp");
  const bundle = generate("sample", { slug: s, seed: 7 });
  const issues = bundle.filter((l): l is BundleIssue => l.m === "Issue");
  const [a, b, c] = issues as [BundleIssue, BundleIssue, BundleIssue];
  a.blockedBy = [{ ext: b.ext }, { ext: a.ext }, { ext: "missing" }];
  a.related = [{ ext: b.ext }, { ext: c.ext }]; // b is a blocker already: dropped
  b.duplicateOf = { ext: c.ext };
  const links: BundleLine[] = [
    { m: "Link", ext: "k1", issue: { ext: a.ext }, url: "https://github.com/acme/app/pull/3", title: "PR" },
    { m: "Link", ext: "k2", issue: { ext: a.ext }, url: "javascript:alert(1)" },
  ];
  const first = await importBundle([...bundle, ...links]);
  assert.deepEqual([first.counts.links, first.counts.skippedLinks], [1, 1]);
  const byExt = new Map((await db.select().from(issue).where(eq(issue.workspaceId, first.workspaceId))).map((r) => [r.externalId!, r]));
  const id = (x: BundleIssue) => byExt.get(x.ext)!.id;
  assert.deepEqual(byExt.get(a.ext)!.blockedByIds, [id(b)]);
  assert.deepEqual(byExt.get(a.ext)!.relatedIds, [id(c)]);
  assert.equal(byExt.get(b.ext)!.duplicateOfId, id(c));
  const { attachment } = schema;
  const stored = await db.select().from(attachment).where(eq(attachment.workspaceId, first.workspaceId));
  assert.deepEqual(stored.map((l) => [l.kind, l.url, l.title, l.issueId]), [["github_pr", "https://github.com/acme/app/pull/3", "PR", id(a)]]);
  await importBundle([...bundle, ...links]);
  assert.equal((await db.select().from(attachment).where(eq(attachment.workspaceId, first.workspaceId))).length, 1);
});

test("subscriptions become the person's Subscribe from the log's start; a choice made here stays, a repeat adds nothing", async () => {
  const s = slug("imp");
  const bundle = generate("sample", { slug: s, seed: 8 });
  const [a, b] = bundle.filter((l): l is BundleIssue => l.m === "Issue") as [BundleIssue, BundleIssue];
  const person = bundle.find((l): l is BundleUser => l.m === "User")!;
  const subs: BundleLine[] = [
    { m: "Subscription", ext: "s1", issue: { ext: a.ext }, user: { ext: person.ext } },
    { m: "Subscription", ext: "s2", issue: { ext: a.ext }, user: { ext: person.ext } }, // the same person and issue again
    { m: "Subscription", ext: "s3", issue: { ext: b.ext }, user: { ext: person.ext } },
  ];
  const first = await importBundle([...bundle, ...subs]);
  assert.equal(first.counts.subscriptions, 2);
  const { inboxMark } = schema;
  const marks = async () =>
    (await db.select().from(inboxMark).where(eq(inboxMark.workspaceId, first.workspaceId))).map((m) => [m.issueId, m.subscribed, m.subscribedId]).sort();
  const byExt = new Map((await db.select().from(issue).where(eq(issue.workspaceId, first.workspaceId))).map((r) => [r.externalId!, r.id]));
  // The person unsubscribed from b here: a repeated import keeps that.
  await db.update(inboxMark).set({ subscribed: false, subscribedId: 1 }).where(eq(inboxMark.issueId, byExt.get(b.ext)!));
  await importBundle([...bundle, ...subs]);
  assert.deepEqual(await marks(), [[byExt.get(a.ext)!, true, 0], [byExt.get(b.ext)!, false, 1]].sort());
});

test("files: bytes go through the store, images keep their text, attachments land on issues; a repeat stores nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rsva-import-"));
  try {
    const png = pngImage(64, 64);
    const pdf = Buffer.from("%PDF-1.7 not an image");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const bytes = new Map([png, pdf].map((b) => [sha(b), b]));
    const store = new DiskBlobStore(dir);
    const files = { read: (s: string) => Readable.from(bytes.get(s)!), store };
    const s = slug("files");
    const header: BundleHeader = { m: "Bundle", version: 1, source: "test", workspace: { slug: s, name: s }, owner: { ext: "u" } };
    const lines: BundleLine[] = [
      { m: "User", ext: "u", email: `${s}@example.test`, name: "U" },
      { m: "Project", ext: "p", key: "F", name: "F" },
      { m: "State", ext: "st", project: { ext: "p" }, name: "Todo", group: "unstarted", color: "#000", position: 0 },
      { m: "Issue", ext: "i", project: { ext: "p" }, number: 1, title: "t", state: { ext: "st" }, priority: 0, description: `![image](/files/${s}/${sha(png)})` },
      // It claims to be an image: the bytes decide.
      { m: "File", ext: "shot", sha256: sha(png), name: "shot.png", mime: "image/png", issue: null },
      { m: "File", ext: "doc", sha256: sha(pdf), name: "report.pdf", mime: "image/png", issue: { ext: "i" }, createdBy: { ext: "u" } },
    ];
    await assert.rejects(importBundle([header, ...lines]), /pass where their bytes are/);
    const first = await importBundle([header, ...lines], { files });
    assert.equal(first.counts.files, 2);
    assert.equal(first.counts.fileAttachments, 1);
    const w = first.workspaceId;
    const blobs = await db.select().from(schema.blob).where(eq(schema.blob.workspaceId, w));
    assert.deepEqual(blobs.map((b) => b.mime).sort(), ["application/octet-stream", "image/png"]);
    assert.ok(await store.has(w, sha(png)));
    const [att] = await db.select().from(schema.attachment).where(eq(schema.attachment.workspaceId, w));
    assert.equal(att!.kind, "file");
    assert.equal(att!.url, `/files/${s}/${sha(pdf)}`);
    assert.equal(att!.title, "report.pdf");
    assert.equal(att!.size, pdf.length);
    const [d] = await db.select().from(document).where(eq(document.workspaceId, w));
    assert.equal((d!.doc as { content: { type: string }[] }).content[0]!.type, "image");
    // Written to since the caller looked: nothing is imported.
    const [{ at }] = await db.select({ at: schema.workspace.lastSyncId }).from(schema.workspace).where(eq(schema.workspace.id, w)) as [{ at: number }];
    await assert.rejects(importBundle([header, ...lines], { files, expectSyncId: at - 1 }), /changed while importing/);
    // A repeat reads no bytes and doubles nothing.
    await importBundle([header, ...lines], { files: { read: () => assert.fail("a file the workspace has is not read again"), store }, expectSyncId: at });
    assert.equal((await db.select().from(schema.attachment).where(eq(schema.attachment.workspaceId, w))).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
