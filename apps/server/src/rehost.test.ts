import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fromMarkdown } from "@rsva/editor/markdown";
import type { Op } from "@rsva/protocol";
import type { DocJSON } from "@rsva/schema/models";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { rehost, rehostDoc, rehostText, rule } from "./rehost.ts";
import { addMember, importFixture, issueWithRefs, lastSyncId } from "./test/helpers.ts";
import { applyTx } from "./sync/write.ts";

const { issue, document, comment, attachment, syncAction } = schema;

const r = rule(["plan.rsva.dev", "old.example.com"], "https://app.rsva.dev");
const text = (s: string) => rehostText(s, r).text;

test("a link to a page of the app moves; the bare address, its endpoints and the host alone stay", () => {
  assert.equal(text("see https://plan.rsva.dev/arsen/browse/PLNR-1."), "see https://app.rsva.dev/arsen/browse/PLNR-1.");
  assert.equal(text("[PLNR-1](https://old.example.com/arsen/browse/PLNR-1)"), "[PLNR-1](https://app.rsva.dev/arsen/browse/PLNR-1)");
  assert.equal(text("<HTTPS://Plan.Rsva.Dev/arsen/inbox>"), "<https://app.rsva.dev/arsen/inbox>");
  assert.equal(text("http://plan.rsva.dev/arsen/projects/PLNR/issues?x=1"), "https://app.rsva.dev/arsen/projects/PLNR/issues?x=1");
  for (const kept of [
    "moved to https://plan.rsva.dev today",
    "moved to https://plan.rsva.dev/.",
    "(https://plan.rsva.dev)",
    "Kuma checks https://plan.rsva.dev/healthz",
    "the webhook: https://plan.rsva.dev/api/github/webhook",
    "the record plan.rsva.dev is gone",
    "https://plan.rsva.dev.example.com/arsen",
    "https://xplan.rsva.dev/arsen",
    "https://plan.rsva.dev-old/arsen",
  ])
    assert.equal(text(kept), kept, kept);
  const { hits } = rehostText("a https://plan.rsva.dev/arsen/browse/PLNR-1), b https://plan.rsva.dev/healthz.", r);
  assert.deepEqual(hits, [
    { url: "https://plan.rsva.dev/arsen/browse/PLNR-1", to: "https://app.rsva.dev/arsen/browse/PLNR-1" },
    { url: "https://plan.rsva.dev/healthz", to: null },
  ]);
});

test("the rule takes host names and an https origin that is not one of them", () => {
  assert.throws(() => rule([], "https://app.rsva.dev"), /old host/);
  assert.throws(() => rule(["plan.rsva.dev/x"], "https://app.rsva.dev"), /host name/);
  assert.throws(() => rule(["plan.*"], "https://app.rsva.dev"), /host name/);
  assert.throws(() => rule(["plan.rsva.dev"], "http://app.rsva.dev"), /https origin/);
  assert.throws(() => rule(["plan.rsva.dev"], "https://app.rsva.dev/arsen"), /https origin/);
  assert.throws(() => rule(["app.rsva.dev"], "https://app.rsva.dev"), /not an old one/);
});

test("a description: its text and a link's href move, everything else is kept as it was", () => {
  const doc = fromMarkdown("Plan: [the issue](https://plan.rsva.dev/arsen/browse/PLNR-2)\n\n- [x] https://plan.rsva.dev/arsen/inbox\n- [ ] https://plan.rsva.dev/healthz") as DocJSON;
  const out = rehostDoc(doc, r);
  assert.deepEqual(out.doc, fromMarkdown("Plan: [the issue](https://app.rsva.dev/arsen/browse/PLNR-2)\n\n- [x] https://app.rsva.dev/arsen/inbox\n- [ ] https://plan.rsva.dev/healthz"));
  assert.deepEqual(out.hits.map((h) => h.to !== null), [true, true, false]);
  assert.equal(JSON.stringify(doc).includes("app.rsva.dev"), false, "the original is not changed");
});

test("rehost: a dry run writes nothing; a run rewrites through the log; a non-member writes nothing", async () => {
  const ws = await importFixture();
  const { issue: i } = await issueWithRefs(ws.workspaceId);
  const tx = (ops: Op[], actor = ws.ownerId) => applyTx(ws.workspaceId, actor, randomUUID(), ops);
  const link = "https://plan.rsva.dev/x/browse/A-1";
  const said = randomUUID();
  const kept = randomUUID();
  const att = randomUUID();
  await tx([
    { op: "update", m: "Issue", id: i.id, set: { title: `Moved: ${link}` } },
    { op: "update", m: "Document", id: i.id, set: { doc: fromMarkdown(`Read [this](${link}) and https://plan.rsva.dev/healthz`) } },
    { op: "create", m: "Attachment", id: att, set: { issueId: i.id, url: link, title: "" } },
  ] as Op[]);
  await tx([{ op: "create", m: "Comment", id: kept, set: { issueId: i.id, body: "Monitor: https://plan.rsva.dev/healthz" } }]);
  await tx([{ op: "create", m: "Comment", id: said, set: { issueId: i.id, body: `By the agent: ${link}` } }], ws.agentId);
  const opts = { from: ["plan.rsva.dev"], to: "https://app.rsva.dev", ws: ws.slug };

  const before = await lastSyncId(ws.workspaceId);
  const found = await rehost(opts);
  assert.deepEqual(found.map((f) => f.where).sort(), ["comment", "comment", "description", "link", "title"]);
  assert.deepEqual(found.find((f) => f.id === kept)!.hits, [{ url: "https://plan.rsva.dev/healthz", to: null }]);
  assert.equal(await lastSyncId(ws.workspaceId), before, "a dry run writes nothing");

  const outsider = await addMember((await importFixture()).workspaceId, "member");
  await assert.rejects(rehost({ ...opts, as: outsider.email }), /not a member/);
  await assert.rejects(rehost({ ...opts, as: "nobody@example.test" }), /no user/);
  assert.equal(await lastSyncId(ws.workspaceId), before);

  const [owner] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, ws.ownerId));
  await rehost({ ...opts, as: owner!.email });
  const moved = link.replace("plan.rsva.dev", "app.rsva.dev");
  const [row] = await db.select({ title: issue.title }).from(issue).where(eq(issue.id, i.id));
  assert.equal(row!.title, `Moved: ${moved}`);
  const [d] = await db.select({ doc: document.doc }).from(document).where(eq(document.id, i.id));
  assert.deepEqual(d!.doc, fromMarkdown(`Read [this](${moved}) and https://plan.rsva.dev/healthz`));
  const [c] = await db.select().from(comment).where(eq(comment.id, said));
  assert.equal(c!.body, `By the agent: ${moved}`, "another person's comment too");
  assert.equal(c!.authorId, ws.agentId);
  assert.equal((await db.select({ body: comment.body }).from(comment).where(eq(comment.id, kept)))[0]!.body, "Monitor: https://plan.rsva.dev/healthz");
  assert.equal((await db.select({ url: attachment.url }).from(attachment).where(eq(attachment.id, att)))[0]!.url, moved);

  const log = await db.select().from(syncAction).where(and(eq(syncAction.workspaceId, ws.workspaceId))).orderBy(desc(syncAction.id)).limit(4);
  assert.equal(await lastSyncId(ws.workspaceId), before + 4, "one action per changed row, in one transaction");
  assert.equal(new Set(log.map((a) => a.txId)).size, 1);
  assert.ok(log.every((a) => a.actorId === ws.ownerId));
  const docAction = log.find((a) => a.model === "Document")!;
  assert.equal((docAction.data as { tx: string }).tx, docAction.txId, "the description's action names its transaction");
  // The next save from a window that had this description is no conflict.
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Document", id: i.id, set: { doc: fromMarkdown("Next") }, base: docAction.txId } as Op]);

  assert.deepEqual(
    (await rehost({ ...opts, as: owner!.email })).filter((f) => f.hits.some((h) => h.to)),
    [],
    "a second run finds nothing to rewrite",
  );
  assert.equal(await lastSyncId(ws.workspaceId), before + 5);
});
