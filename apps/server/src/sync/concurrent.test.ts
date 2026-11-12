// Two people at one row: what the server does with changes made from different versions of it, and the frames that keep a
// client honest about its connection.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Op } from "@rsva/protocol";
import type { DocJSON } from "@rsva/schema/models";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import WebSocket from "ws";
import { addMember, asToken, asUser, Client, delay, fetchAs, fileFixture, lastSyncId, rejects, startServer } from "../test/helpers.ts";
import { applyTx } from "./write.ts";

const f = fileFixture();
const tx = (ops: Op[], id: string = randomUUID()) => applyTx(f.ws.workspaceId, f.ws.ownerId, id, ops);
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) as DocJSON;

async function newIssue(): Promise<string> {
  const id = randomUUID();
  await tx([{ op: "create", m: "Issue", id, projectId: f.refs.project.id, set: { title: "concurrent", stateId: f.refs.states[0]!.id } }]);
  return id;
}
const row = async (id: string) => (await db.select().from(schema.issue).where(eq(schema.issue.id, id)))[0]!;
const labels = (id: string, labelIds: string[], base: string[]) => tx([{ op: "update", m: "Issue", id, set: { labelIds }, base: { labelIds: base } }]);

test("two people add a label each from the same list: both stay", async () => {
  const id = await newIssue();
  const [one, two] = f.refs.labels.map((l) => l.id);
  await labels(id, [one!], []);
  await labels(id, [two!], []);
  assert.deepEqual((await row(id)).labelIds, [one, two]);
});

test("one takes a label off while another adds one: both changes stay", async () => {
  const id = await newIssue();
  const [one, two, three] = f.refs.labels.map((l) => l.id);
  await labels(id, [one!, two!], []);
  await labels(id, [two!], [one!, two!]);
  await labels(id, [one!, two!, three!], [one!, two!]);
  assert.deepEqual((await row(id)).labelIds, [two, three]);
});

test("both add the same label: it is there once", async () => {
  const id = await newIssue();
  const [one] = f.refs.labels.map((l) => l.id);
  await labels(id, [one!], []);
  const { s } = await labels(id, [one!], []);
  assert.deepEqual((await row(id)).labelIds, [one]);
  assert.equal(s, await lastSyncId(f.ws.workspaceId), "nothing changed: no action");
});

test("nobody else changed the list: it is taken as sent, its order too", async () => {
  const id = await newIssue();
  const [one, two] = f.refs.labels.map((l) => l.id);
  await labels(id, [one!, two!], []);
  await labels(id, [two!, one!], [one!, two!]);
  assert.deepEqual((await row(id)).labelIds, [two, one]);
});

test("at the same moment, two lists merge under the row's lock", async () => {
  const id = await newIssue();
  const ids = f.refs.labels.map((l) => l.id);
  await Promise.all(ids.map((l) => labels(id, [l], [])));
  assert.deepEqual(new Set((await row(id)).labelIds), new Set(ids));
});

test("a list merged past its size is refused", async () => {
  const id = await newIssue();
  const many = Array.from({ length: 30 }, () => randomUUID());
  await db.update(schema.issue).set({ labelIds: many }).where(eq(schema.issue.id, id));
  await rejects(tx([{ op: "update", m: "Issue", id, set: { labelIds: Array.from({ length: 30 }, () => randomUUID()) }, base: { labelIds: [] } }]), "invalid", /more than 50/);
});

test("a change without a base replaces the list, as the API says", async () => {
  const id = await newIssue();
  const [one, two] = f.refs.labels.map((l) => l.id);
  await labels(id, [one!], []);
  await tx([{ op: "update", m: "Issue", id, set: { labelIds: [two!] } }]);
  assert.deepEqual((await row(id)).labelIds, [two]);
});

const save = (id: string, text: string, base: string | null | undefined, txId: string = randomUUID()) => tx([{ op: "update", m: "Document", id, set: { doc: doc(text) }, ...(base === undefined ? {} : { base }) }], txId);

test("a save from the text as it stands goes through, and the next names it", async () => {
  const id = await newIssue();
  const first = randomUUID();
  const r = await save(id, "first", null, first);
  assert.equal(r.actions[0]!.d!.tx, first);
  await save(id, "second", first);
});

test("a save from an older text is refused: the other person's words stay", async () => {
  const id = await newIssue();
  const theirs = randomUUID();
  await save(id, "theirs", null, theirs);
  await rejects(save(id, "mine, from the empty text", null), "conflict", /someone else changed/);
  const [d] = await db.select().from(schema.document).where(eq(schema.document.id, id));
  assert.deepEqual((d!.doc as { content: { content: { text: string }[] }[] }).content[0]!.content[0]!.text, "theirs");
});

test("the same text is no conflict, whatever it was edited from", async () => {
  const id = await newIssue();
  await save(id, "same", null);
  await save(id, "same", null);
});

/** An issue with a text, then a save of the same text, which writes no action; the saves' ids. */
async function savedTwice() {
  const id = await newIssue();
  const first = randomUUID();
  const noop = randomUUID();
  await save(id, "text", null, first);
  await save(id, "text", first, noop);
  return { id, first, noop };
}

test("a save of the same text writes nothing, and one that names it is no conflict", async () => {
  const { id, noop } = await savedTwice();
  await save(id, "more text", noop);
});

test("naming a save that wrote nothing does not pass over someone's text after it", async () => {
  const { id, first, noop } = await savedTwice();
  await save(id, "theirs", first);
  await rejects(save(id, "mine", noop), "conflict");
});

test("a save with no base replaces what is there (the agent API)", async () => {
  const id = await newIssue();
  await save(id, "theirs", null);
  await save(id, "the agent's", undefined);
});

test("a save sent twice is one save: the replay is not a conflict with itself", async () => {
  const id = await newIssue();
  const once = randomUUID();
  const first = await save(id, "once", null, once);
  const again = await save(id, "once", null, once);
  assert.equal(again.s, first.s);
});

test("the history answer says which save the text is", async () => {
  const id = await newIssue();
  const made = randomUUID();
  await save(id, "text", null, made);
  const owner = fetchAs(await asUser(f.ws.ownerId));
  const h = (await (await owner(`${f.server.url}/sync/history/${id}`)).json()) as { doc: { tx: string } };
  assert.equal(h.doc.tx, made);
});

test("a ping is answered with the log tail once subscribed, and without it before", async () => {
  const c = await Client.open(f.server.url, await asUser(f.ws.ownerId));
  await c.next((x) => x.t === "hello", 3000, true);
  c.send({ t: "ping" });
  const early = await c.next((x) => x.t === "pong");
  assert.equal("s" in early, false);
  await c.subscribe(f.ws);
  await c.next((x) => x.t === "caught-up", 3000, true);
  c.send({ t: "ping" });
  const late = await c.next((x) => x.t === "pong");
  assert.equal((late as { s?: number }).s, await lastSyncId(f.ws.workspaceId));
  c.close();
});

/** A new person's headers: a write budget of their own. */
const asPerson = async () => asToken(f.ws.workspaceId, (await addMember(f.ws.workspaceId, "member")).id);

/**
 * Spends the socket's person's budget. Invalid, so nothing is written, and each still counts: the twentieth passes 16 MiB.
 * Returns the refusal.
 */
async function overBudget(c: Client): Promise<{ id: string; wait: number }> {
  const big = [{ op: "update", m: "Issue", id: f.refs.issue.id, set: { title: "x".repeat(900_000) } }];
  for (let i = 0; i < 20; i++) c.send({ t: "tx", id: randomUUID(), ops: big });
  return (await c.next((x) => x.t === "rej" && x.code === "rate_limited", 8000, true)) as unknown as { id: string; wait: number };
}

test("past the budget nothing overtakes the refused transaction, and when it comes again the rest go on", async () => {
  const c = await Client.open(f.server.url, await asPerson());
  await c.subscribe(f.ws);
  await c.next((x) => x.t === "caught-up", 3000, true);
  try {
    const first = await overBudget(c);
    const small = randomUUID();
    const ops = [{ op: "update", m: "Issue", id: f.refs.issue.id, set: { priority: 1 } }];
    c.send({ t: "tx", id: small, ops });
    const passed = (await c.next((x) => x.t === "rej" && x.id === small, 8000)) as { code: string; wait: number };
    assert.equal(passed.code, "rate_limited", "a small transaction does not slip past the refused one");
    assert.ok(passed.wait >= 1000);
    await delay(first.wait);
    c.send({ t: "tx", id: first.id, ops });
    await c.next((x) => (x.t === "ack" || x.t === "rej") && x.id === first.id, 8000);
    c.send({ t: "tx", id: small, ops });
    await c.next((x) => x.t === "ack" && x.id === small, 8000);
  } finally {
    c.close();
  }
});

test("a client that vanished without closing is let go: it does not answer the server's ping", async () => {
  const server = await startServer({ socketLiveness: 50 });
  try {
    const dead = new WebSocket(server.url.replace(/^http/, "ws") + "/ws", { headers: await asUser(f.ws.ownerId), autoPong: false });
    const live = await Client.open(server.url, await asUser(f.ws.ownerId));
    const closed = new Promise<number>((resolve) => dead.once("close", resolve));
    await closed;
    await delay(120);
    assert.equal(live.ws.readyState, live.ws.OPEN, "one that answers stays");
    live.close();
  } finally {
    await server.close();
  }
});

test("a refused transaction that never comes again does not stop the connection for good", async () => {
  const c = await Client.open(f.server.url, await asPerson());
  try {
    await c.subscribe(f.ws);
    const first = await overBudget(c);
    await delay(first.wait + 5100); // its wait and the block's grace
    const id = randomUUID();
    c.send({ t: "tx", id, ops: [{ op: "update", m: "Issue", id: f.refs.issue.id, set: { priority: 2 } }] });
    await c.next((x) => x.t === "ack" && x.id === id, 8000);
  } finally {
    c.close();
  }
});
