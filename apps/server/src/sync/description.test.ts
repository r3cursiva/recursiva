import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fromMarkdown } from "@rsva/editor/markdown";
import type { IssueHistory, Op } from "@rsva/protocol";
import type { DocJSON } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { db, migrateDb, schema } from "../db.ts";
import { importFixture, issueWithRefs, rejects, serverWithIssue, type ServerWithIssue } from "../test/helpers.ts";
import { applyTx } from "./write.ts";

const { document, issue, syncAction } = schema;

// owner: the owner's browser, agent: the agent's API token. The same wiring as comments.test.ts; the setup is shared.
/* jscpd:ignore-start */
let { server, ws, refs, owner, agent } = {} as ServerWithIssue;
before(async () => ({ server, ws, refs, owner, agent } = await serverWithIssue()));
after(() => server.close());
/* jscpd:ignore-end */

const md = (s: string) => fromMarkdown(s) as DocJSON;
const save = (id: string, doc: unknown, actor = ws.ownerId) => applyTx(ws.workspaceId, actor, randomUUID(), [{ op: "update", m: "Document", id, set: { doc } } as Op]);
const history = async (issueId: string) => (await (await owner(`${server.url}/sync/history/${issueId}`)).json()) as IssueHistory;
const api = (path: string, init?: RequestInit) => agent(`${server.url}/api/v1/workspaces/${ws.slug}${path}`, init);

test("a description save: validated, stored canonical, logged once per document, in the history without its text", async () => {
  const id = refs.issue.id;
  const r = await save(id, md("# Plan\n\n- [x] one\n- [ ] two"));
  const a = r.actions[0]!;
  assert.equal(a.m, "Document");
  assert.equal(a.d!.issueId, id);
  assert.deepEqual(a.d!.doc, md("# Plan\n\n- [x] one\n- [ ] two"));
  const [row] = await db.select().from(document).where(eq(document.id, id));
  assert.deepEqual(row!.doc, md("# Plan\n\n- [x] one\n- [ ] two"));
  const [i] = await db.select({ updatedAt: issue.updatedAt }).from(issue).where(eq(issue.id, id));
  assert.equal(Date.parse(i!.updatedAt), Date.parse(a.d!.updatedAt as string), "the issue moves to the top of 'recently updated'");

  assert.equal((await save(id, md("# Plan\n\n- [x] one\n- [ ] two"))).actions.length, 0, "the same document is no change");
  await save(id, md("# Plan\n\nrewritten"));
  const logged = await db.select({ data: syncAction.data }).from(syncAction).where(and(eq(syncAction.modelId, id), eq(syncAction.model, "Document")));
  assert.equal(logged.length, 2);
  assert.equal(logged.filter((l) => (l.data as { doc?: unknown }).doc).length, 1, "only the latest action keeps the document");

  const h = await history(id);
  assert.deepEqual(h.doc?.doc, md("# Plan\n\nrewritten"));
  const entries = h.history.filter((e) => "description" in e.d);
  assert.equal(entries.length, 2);
  assert.ok(!JSON.stringify(h.history).includes("rewritten"), "history entries carry no text");
});

test("rejected: not a document, unknown nodes, unsafe links, too big, too deep, another workspace's issue", async () => {
  const id = refs.issue.id;
  await rejects(save(id, { type: "paragraph" }), "invalid");
  await rejects(save(id, { type: "doc", content: [{ type: "iframe" }] }), "invalid");
  await rejects(save(id, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] }), "invalid");
  await rejects(save(id, md("x".repeat(500_000))), "invalid");
  let deep: unknown = { type: "paragraph" };
  for (let k = 0; k < 120; k++) deep = { type: "blockquote", content: [deep] };
  await rejects(save(id, { type: "doc", content: [deep] }), "invalid");
  const foreign = await importFixture("sample", undefined, 5);
  await rejects(save((await issueWithRefs(foreign.workspaceId)).issue.id, md("hi")), "bad_ref");
  await rejects(save(randomUUID(), md("hi")), "bad_ref");
});

test("agent API: GET the issue with its description as Markdown, PATCH it with Markdown", async () => {
  const key = `${refs.project.key}-${refs.issue.number}`;
  const patch = await api(`/issues/${key}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "## From an agent\n\nWith **bold** and <u>underline</u>.\n\n<details>\n<summary>More</summary>\n\nHidden.\n\n</details>" }),
  });
  assert.equal(patch.status, 200);
  const got = (await (await api(`/issues/${key}`)).json()) as { description: string; title: string; state: string };
  // A collapsible section is stored opened out (PLNR-378).
  assert.equal(got.description, "## From an agent\n\nWith **bold** and <u>underline</u>.\n\n**More**\n\nHidden.\n");
  assert.equal(got.title, refs.issue.title);
  const tooBig = await api(`/issues/${key}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "x".repeat(250_000) }) });
  assert.equal(tooBig.status, 400);
  const clear = await api(`/issues/${key}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "" }) });
  assert.equal(clear.status, 200);
  assert.equal(((await (await api(`/issues/${key}`)).json()) as { description: string }).description, "");
});

test("legacy HTML rows become documents at start, once", async () => {
  const id = refs.issue.id;
  await db.update(document).set({ doc: null, html: '<h2>Old</h2><p>From <strong>Plane</strong></p><div data-type="horizontalRule"><div></div></div>' }).where(eq(document.id, id));
  await migrateDb();
  const [row] = await db.select().from(document).where(eq(document.id, id));
  assert.deepEqual(row!.doc, md("## Old\n\nFrom **Plane**\n\n---"));
  assert.match(row!.html, /^<h2>Old/, "the HTML stays (additive)");
});
