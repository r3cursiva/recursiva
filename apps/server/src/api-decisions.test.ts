import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { applyTx } from "./sync/write.ts";
import { addMember, apiFixture, asToken, fetchAs } from "./test/helpers.ts";

const f = apiFixture();
const json = async <T>(r: Promise<Response>) => (await (await r).json()) as T;
const post = (as: typeof fetch, path: string, b: unknown = {}) => as(f.api(path), { method: "POST", body: JSON.stringify(b) });
const readOnly = async () => fetchAs({ ...(await asToken(f.ws.workspaceId, f.ws.ownerId, "read")), "content-type": "application/json" });

interface View {
  id: string;
  key: string;
  status: string;
  answer: string | null;
  answerOption: number | null;
  byRule: boolean;
  recommended: number;
  options: { label: string; detail: string; why: string }[];
}
interface CommentRow {
  id: string;
  parentId: string | null;
  author: string;
  body: string;
}

const ASK = {
  question: "Which courier should ship orders to Greece?",
  options: [
    { label: "Speedy", detail: "€6.40 · 3–4 days", why: "Most orders are under €60." },
    { label: "DHL Express", detail: "€14.90 · 1–2 days" },
  ],
  recommend: 1,
  evidence: ["#77"],
};

/** A new issue of the agent's; titles apart, so the create is not refused as a likely duplicate. */
async function issue(title: string) {
  return (await json<{ key: string }>(post(f.agent, "/issues", { project: "CORE", title }))).key;
}
const ask = (key: string, b: unknown = ASK, as = f.agent) => post(as, `/issues/${key}/decisions`, b);
const comments = async (key: string) => (await json<{ comments: CommentRow[] }>(f.owner(f.api(`/issues/${key}/comments`)))).comments;
const open = async () => (await json<{ decisions: View[] }>(f.owner(f.api("/decisions")))).decisions;

test("an agent asks: the row and its mirror comment in one go, its run ends as asked, and the issue waits for the answer", async () => {
  const key = await issue("Courier for the Greek orders");
  assert.equal((await post(f.agent, `/issues/${key}/runs`, { stage: "work" })).status, 201);
  const r = await ask(key);
  assert.equal(r.status, 201, await r.clone().text());
  const { decision, runEnded } = (await r.json()) as { decision: View; runEnded: boolean };
  assert.deepEqual([decision.status, decision.recommended, decision.options[0]!.why, runEnded], ["open", 1, "Most orders are under €60.", true]);
  assert.ok((await open()).some((d) => d.id === decision.id));
  const [mirror] = await comments(key);
  assert.match(mirror!.body, /^\*\*Question:\*\* Which courier/);
  assert.match(mirror!.body, /1\. Speedy — €6\.40 · 3–4 days \(recommended\)/);

  const runs = await json<{ runs: { outcome: string }[] }>(f.agent(f.api(`/issues/${key}/runs`)));
  assert.equal(runs.runs[0]!.outcome, "asked");
  const claim = await post(f.agent, `/issues/${key}/runs`, { stage: "work" });
  assert.equal(claim.status, 409, "the issue waits for the answer");
  assert.match(((await claim.json()) as { message: string }).message, /waits for a person's answer/);

  const answered = await post(f.owner, `/decisions/${decision.id}/answer`, { option: 1 });
  assert.equal(answered.status, 200, await answered.clone().text());
  const after = ((await answered.json()) as { decision: View }).decision;
  assert.deepEqual([after.status, after.answer, after.answerOption], ["answered", "Speedy", 1]);
  const reply = (await comments(key)).find((c) => c.parentId === mirror!.id);
  assert.equal(reply?.body, "**Decision:** Speedy");
  assert.equal((await post(f.agent, `/issues/${key}/runs`, { stage: "work" })).status, 201, "answered: dispatchable again");
});

test("who may: an agent asks but never answers or takes an answer back; a read-only token does neither; a malformed ask is a 400", async () => {
  const key = await issue("Retention of the nightly dumps");
  const ro = await readOnly();
  assert.equal((await ask(key, ASK, ro)).status, 403, "read-only asks nothing");
  assert.equal((await ask(key, { ...ASK, recommend: 3 })).status, 400);
  assert.equal((await ask(key, { ...ASK, options: ["Only one"] })).status, 400);
  const { decision } = await json<{ decision: View }>(ask(key));
  assert.equal((await post(f.agent, `/decisions/${decision.id}/answer`, { option: 1 })).status, 403, "the agent that asked does not answer");
  assert.equal((await post(ro, `/decisions/${decision.id}/answer`, { option: 1 })).status, 403);
  assert.equal((await post(f.owner, `/decisions/${decision.id}/answer`, { text: "Neither: ship from Sofia" })).status, 200);
  assert.equal((await post(f.agent, `/decisions/${decision.id}/undo`)).status, 403);
  assert.equal((await post(ro, `/decisions/${decision.id}/undo`)).status, 403);
  assert.equal((await post(f.owner, `/decisions/${decision.id}/answer`, { option: 2 })).status, 409, "answered once");
});

test("undo within the window opens the question again and takes the reply and the rule back", async () => {
  const key = await issue("Backups on the new storage box");
  const { decision } = await json<{ decision: View }>(ask(key, { ...ASK, topic: "backup retention" }));
  await post(f.owner, `/decisions/${decision.id}/answer`, { option: 2, rule: true });
  assert.ok((await json<{ rules: { topic: string }[] }>(f.owner(f.api("/decision-rules")))).rules.some((r) => r.topic === "backup retention"));
  const undone = await post(f.owner, `/decisions/${decision.id}/undo`);
  assert.equal(undone.status, 200, await undone.clone().text());
  assert.equal(((await undone.json()) as { decision: View }).decision.status, "open");
  assert.equal((await comments(key)).find((c) => c.parentId), undefined, "the reply is deleted (a tombstone the API leaves out)");
  assert.ok(!(await json<{ rules: { topic: string }[] }>(f.owner(f.api("/decision-rules")))).rules.some((r) => r.topic === "backup retention"));
});

test("a rule answers the same topic of the same project at once, with a reply naming it; people remove rules, agents and read-only tokens do not", async () => {
  const first = await issue("Courier for Cyprus");
  const { decision } = await json<{ decision: View }>(ask(first, { ...ASK, topic: "courier" }));
  await post(f.owner, `/decisions/${decision.id}/answer`, { option: 1, rule: true });

  const second = await issue("Courier for Malta");
  const again = (await json<{ decision: View }>(ask(second, { ...ASK, question: "Who ships to Malta?", topic: "courier" }))).decision;
  assert.deepEqual([again.status, again.answer, again.byRule], ["answered", "Speedy", true]);
  const reply = (await comments(second)).find((c) => c.parentId);
  assert.match(reply!.body, /^\*\*Decision:\*\* Speedy\n\nAnswered by the rule for “courier”/);
  const other = (await json<{ decision: View }>(ask(second, { ...ASK, topic: "Courier" }))).decision;
  assert.equal(other.status, "open", "exact topics only");

  const { rules } = await json<{ rules: { id: string; topic: string; project: string; answer: string }[] }>(f.agent(f.api("/decision-rules")));
  const rule = rules.find((r) => r.topic === "courier")!;
  assert.deepEqual([rule.project, rule.answer], ["CORE", "Speedy"]);
  assert.equal((await f.agent(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  assert.equal((await (await readOnly())(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  assert.equal((await f.owner(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 200);
  assert.equal((await f.owner(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 404);
});

test("another member neither removes nor replaces someone's rule; an owner may remove it", async () => {
  const m = await addMember(f.ws.workspaceId, "member");
  const member = fetchAs({ ...(await asToken(f.ws.workspaceId, m.id)), "content-type": "application/json" });
  const one = (await json<{ decision: View }>(ask(await issue("Label printer for the shop"), { ...ASK, topic: "printer" }))).decision;
  const two = (await json<{ decision: View }>(ask(await issue("Label printer for the office"), { ...ASK, topic: "printer" }))).decision;
  assert.equal((await post(f.owner, `/decisions/${one.id}/answer`, { option: 1, rule: true })).status, 200);
  const replaced = await post(member, `/decisions/${two.id}/answer`, { option: 2, rule: true });
  assert.equal(replaced.status, 403, "the owner's rule is not the member's to replace");
  assert.ok((await open()).some((d) => d.id === two.id), "nothing of the refused answer was written");
  const { rules } = await json<{ rules: { id: string; topic: string; answer: string }[] }>(f.owner(f.api("/decision-rules")));
  const rule = rules.find((r) => r.topic === "printer")!;
  assert.equal(rule.answer, "Speedy");
  assert.equal((await member(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  assert.equal((await f.owner(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 200);
});

test("purging an issue takes its decisions along, and the log keeps neither the question nor the answer", async () => {
  const key = await issue("Courier for Iceland");
  const secret = "Which courier ships to Reykjavik in winter?";
  const { decision } = await json<{ decision: View }>(ask(key, { ...ASK, question: secret, topic: "iceland-courier", evidence: ["the Reykjavik tariff"] }));
  await post(f.owner, `/decisions/${decision.id}/answer`, { text: "Only by sea, never by air" });
  assert.equal((await f.owner(f.api(`/issues/${key}`), { method: "DELETE" })).status, 200);
  const [row] = await db.select({ id: schema.decision.issueId }).from(schema.decision).where(eq(schema.decision.id, decision.id));
  await applyTx(f.ws.workspaceId, f.ws.ownerId, randomUUID(), [{ op: "delete", m: "Issue", id: row!.id }], true);
  assert.equal((await db.select().from(schema.decision).where(eq(schema.decision.id, decision.id))).length, 0);
  const left = await db
    .select({ id: schema.syncAction.id })
    .from(schema.syncAction)
    .where(and(eq(schema.syncAction.workspaceId, f.ws.workspaceId), or(dsql`${schema.syncAction.data}::text like ${"%Reykjavik%"}`, dsql`${schema.syncAction.data}::text like ${"%never by air%"}`, dsql`${schema.syncAction.prev}::text like ${"%Reykjavik%"}`)));
  assert.deepEqual(left, [], "no words of the question, its evidence or its answer stay in the log");
});
