import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { createToken } from "./auth/tokens.ts";
import { applyTx } from "./sync/write.ts";
import { addMember, apiFixture, asToken, fetchAs } from "./test/helpers.ts";

const f = apiFixture();
const json = async <T>(r: Promise<Response>) => (await (await r).json()) as T;
const post = (as: typeof fetch, path: string, b: unknown = {}) => as(f.api(path), { method: "POST", body: JSON.stringify(b) });
const tokenOf = async (userId: string, scope: "read" | "write" = "write") => fetchAs({ ...(await asToken(f.ws.workspaceId, userId, scope)), "content-type": "application/json" });

interface View {
  id: string;
  key: string;
  status: string;
  answer: string | null;
  answerOption: number | null;
  answeredBy: string | null;
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
const claim = (key: string, as = f.agent) => post(as, `/issues/${key}/runs`, { stage: "work" });
const ask = (key: string, b: unknown = ASK, as = f.agent) => post(as, `/issues/${key}/decisions`, b);
/** A question from the run's holder: the agent claims the issue, then asks. */
async function asked(title: string, b: Record<string, unknown> = {}) {
  const key = await issue(title);
  assert.equal((await claim(key)).status, 201);
  const r = await ask(key, { ...ASK, ...b });
  assert.equal(r.status, 201, await r.clone().text());
  return { key, ...((await r.json()) as { decision: View; runEnded: boolean }) };
}
const comments = async (key: string) => (await json<{ comments: CommentRow[] }>(f.owner(f.api(`/issues/${key}/comments`)))).comments;
const open = async () => (await json<{ decisions: View[] }>(f.owner(f.api("/decisions")))).decisions;
const runsOf = async (key: string) => (await json<{ runs: { outcome: string | null }[] }>(f.agent(f.api(`/issues/${key}/runs`)))).runs;
const rulesOf = async () => (await json<{ rules: { id: string; kind: string; topic: string; answer: string; answered: { key: string }[] }[] }>(f.owner(f.api("/decision-rules")))).rules;

test("the run's holder asks: the row, its mirror comment and the run's end in one go; one open question per issue; the issue waits", async () => {
  const { key, decision, runEnded } = await asked("Courier for the Greek orders");
  assert.deepEqual([decision.status, decision.recommended, decision.options[0]!.why, runEnded], ["open", 1, "Most orders are under €60.", true]);
  assert.ok((await open()).some((d) => d.id === decision.id));
  const [mirror] = await comments(key);
  assert.match(mirror!.body, /^\*\*Question:\*\* Which courier/);
  assert.equal((await runsOf(key))[0]!.outcome, "asked");

  const blocked = await claim(key);
  assert.equal(blocked.status, 409, "the issue waits for the answer");

  assert.equal((await post(f.owner, `/decisions/${decision.id}/answer`, { option: 1 })).status, 200);
  const reply = (await comments(key)).find((c) => c.parentId === mirror!.id);
  assert.equal(reply?.body, "**Decision:** Speedy");
  assert.equal((await claim(key)).status, 201, "answered: dispatchable again");
});

test("one open decision of each kind per issue: another agent's close proposal does not block the working agent's question", async () => {
  const key = await issue("Courier for Albania");
  const other = await tokenOf((await addMember(f.ws.workspaceId, "member", "agent")).id);
  assert.equal((await ask(key, { ...ASK, kind: "close", question: "Close it?" }, other)).status, 201);
  const twice = await ask(key, { ...ASK, kind: "close", question: "Close it, really?" });
  assert.equal(twice.status, 409, "a second close proposal waits for the first");
  assert.match(((await twice.json()) as { message: string }).message, /already waits on “Close it\?”/);
  assert.equal((await claim(key)).status, 201);
  assert.equal((await ask(key)).status, 201, "the run holder's question is not blocked by the proposal");

  const done = await issue("Courier for Kosovo");
  assert.equal((await f.owner(f.api(`/issues/${done}`), { method: "PATCH", body: JSON.stringify({ state: "Done" }) })).status, 200);
  assert.equal((await ask(done, { ...ASK, kind: "close" })).status, 400, "nothing is asked on a closed issue");
});

test("an issue's decisions by its key, answered ones too: where the agent reads its answer", async () => {
  const { key, decision } = await asked("Courier for Montenegro");
  await post(f.owner, `/decisions/${decision.id}/answer`, { option: 2 });
  const { decisions } = await json<{ decisions: View[] }>(f.agent(f.api(`/issues/${key}/decisions`)));
  assert.deepEqual(decisions.map((d) => [d.id, d.status, d.answer]), [[decision.id, "answered", "DHL Express"]]);
});

test("who asks: a question only from the run's holder; a close proposal or hand-off needs no run; read-only asks nothing", async () => {
  const key = await issue("Retention of the nightly dumps");
  assert.equal((await ask(key)).status, 403, "no live run: no question");
  assert.equal((await ask(key, ASK, f.owner)).status, 403, "a person without the run asks no question either");
  assert.equal((await ask(key, ASK, await tokenOf(f.ws.ownerId, "read"))).status, 403);
  assert.equal((await ask(key, { ...ASK, recommend: 3 })).status, 400);
  const close = await ask(key, { ...ASK, kind: "close", question: "Close it as a duplicate?" });
  assert.equal(close.status, 201, await close.clone().text());
  assert.equal(((await close.json()) as { runEnded: boolean }).runEnded, false);
  assert.equal((await claim(key)).status, 201, "a close proposal does not block the work");
});

test("who answers: never an agent, never a read-only token; an answered question takes no second answer", async () => {
  const { decision } = await asked("Courier for Bulgaria");
  const ro = await tokenOf(f.ws.ownerId, "read");
  assert.equal((await post(f.agent, `/decisions/${decision.id}/answer`, { option: 1 })).status, 403, "the agent that asked does not answer");
  assert.equal((await post(ro, `/decisions/${decision.id}/answer`, { option: 1 })).status, 403);
  assert.equal((await post(f.owner, `/decisions/${decision.id}/answer`, { text: "Neither: ship from Sofia" })).status, 200);
  assert.equal((await post(f.agent, `/decisions/${decision.id}/undo`)).status, 403);
  assert.equal((await post(ro, `/decisions/${decision.id}/undo`)).status, 403);
  assert.equal((await post(f.owner, `/decisions/${decision.id}/answer`, { option: 2 })).status, 409, "answered once");
});

test("a decision's comments stay as written: the asking agent neither edits nor deletes the question or the answer", async () => {
  const { key, decision } = await asked("Courier for Romania");
  await post(f.owner, `/decisions/${decision.id}/answer`, { option: 2 });
  for (const c of await comments(key)) {
    const as = c.author === "bot@sample.test" || c.parentId === null ? f.agent : f.owner;
    assert.equal((await as(f.api(`/issues/${key}/comments/${c.id}`), { method: "PATCH", body: JSON.stringify({ body: "Speedy, of course" }) })).status, 403, c.body);
    assert.equal((await as(f.api(`/issues/${key}/comments/${c.id}`), { method: "DELETE" })).status, 403, c.body);
  }
  assert.ok((await comments(key)).some((c) => c.body === "**Decision:** DHL Express"));
});

test("a question on a closed issue waits on nobody: not listed, and it blocks no claim", async () => {
  const { key, decision } = await asked("Courier for Serbia");
  assert.equal((await f.owner(f.api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify({ state: "Done" }) })).status, 200);
  assert.equal((await open()).find((d) => d.id === decision.id), undefined);
  assert.equal((await claim(key)).status, 201);
});

test("undo within the window opens the question again, takes the reply back, and puts back the rule the answer replaced", async () => {
  const first = await asked("Backups on the new storage box", { topic: "backup retention" });
  await post(f.owner, `/decisions/${first.decision.id}/answer`, { option: 1, rule: true });
  const before = (await rulesOf()).find((r) => r.topic === "backup retention")!;
  assert.equal(before.answer, "Speedy");

  const second = await asked("Backups on the old box", { topic: "backup retention", options: [{ label: "DHL Express" }, { label: "Post" }] });
  assert.equal(second.decision.status, "open", "the rule's answer is not among the options: it answers nothing");
  await post(f.owner, `/decisions/${second.decision.id}/answer`, { option: 2, rule: true });
  assert.equal((await rulesOf()).find((r) => r.topic === "backup retention")!.answer, "Post");
  const undone = await post(f.owner, `/decisions/${second.decision.id}/undo`);
  assert.equal(undone.status, 200, await undone.clone().text());
  assert.equal(((await undone.json()) as { decision: View }).decision.status, "open");
  assert.equal((await comments(second.key)).find((c) => c.parentId), undefined, "the reply is deleted (a tombstone the API leaves out)");
  const after = (await rulesOf()).find((r) => r.topic === "backup retention")!;
  assert.deepEqual([after.id, after.answer], [before.id, "Speedy"], "the replaced rule is back as it was");
});

test("a rule answers only its kind and topic, and only with one of the options asked; nobody is its answerer and the run goes on", async () => {
  const first = await asked("Courier for Cyprus", { topic: "courier" });
  await post(f.owner, `/decisions/${first.decision.id}/answer`, { option: 1, rule: true });

  const same = await asked("Courier for Malta", { question: "Who ships to Malta?", topic: "courier" });
  assert.deepEqual([same.decision.status, same.decision.answer, same.decision.byRule, same.decision.answeredBy, same.runEnded], ["answered", "Speedy", true, null, false]);
  assert.equal((await runsOf(same.key))[0]!.outcome, null, "answered at once: the run is still live");
  const reply = (await comments(same.key)).find((c) => c.parentId);
  assert.match(reply!.body, /^\*\*Decision:\*\* Speedy\n\nAnswered by the rule for “courier”/);

  const offered = await asked("Courier for Crete", { topic: "courier", options: [{ label: "Hand it to a friend" }, { label: "Post" }] });
  assert.equal(offered.decision.status, "open", "an agent cannot make the rule pick what it offers");
  const otherKind = await ask(await issue("Close the Corfu courier issue"), { ...ASK, kind: "close", topic: "courier" });
  assert.equal(((await otherKind.json()) as { decision: View }).decision.status, "open", "a close proposal is no question");
  assert.equal((await ask(await issue("Courier for Rhodes"), { ...ASK, topic: "Courier" })).status, 403, "no run, no question");

  const rule = (await rulesOf()).find((r) => r.topic === "courier")!;
  assert.deepEqual(rule.answered.map((a) => a.key), [same.key], "the rule's own answers are listed for the owner to review");
});

test("rules: people remove them, an agent and a read-only token do not; another member neither removes nor replaces the owner's", async () => {
  const one = await asked("Label printer for the shop", { topic: "printer" });
  const two = await asked("Label printer for the office", { topic: "printer", options: [{ label: "Zebra" }, { label: "Brother" }] });
  assert.equal((await post(f.owner, `/decisions/${one.decision.id}/answer`, { option: 1, rule: true })).status, 200);
  const m = await addMember(f.ws.workspaceId, "member");
  const member = await tokenOf(m.id);
  assert.equal((await post(member, `/decisions/${two.decision.id}/answer`, { option: 2, rule: true })).status, 403, "the owner's rule is not the member's to replace");
  assert.ok((await open()).some((d) => d.id === two.decision.id), "nothing of the refused answer was written");
  const rule = (await rulesOf()).find((r) => r.topic === "printer")!;
  assert.equal((await f.agent(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  assert.equal((await (await tokenOf(f.ws.ownerId, "read"))(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  assert.equal((await member(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  assert.equal((await f.owner(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 200);
  assert.equal((await f.owner(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 404);
});

test("a hand-over writes the proposed Done when into a description that has none, keeps one it has, and is not taken back", async () => {
  const HAND = { kind: "handoff", question: "Hand it to Claude?", options: ["Hand it over", "Keep it for me"], recommend: 1, criteria: ["Export CSV in the menu", "A test covers an empty cycle"] };
  const bare = await issue("Cycle report as CSV");
  const d = ((await json<{ decision: View }>(ask(bare, HAND))) as { decision: View }).decision;
  assert.equal((await post(f.owner, `/decisions/${d.id}/answer`, { option: 1 })).status, 200);
  const doc = await json<{ description: string }>(f.owner(f.api(`/issues/${bare}`)));
  assert.match(doc.description, /## Done when\n\n- Export CSV in the menu\n- A test covers an empty cycle/);
  assert.equal((await post(f.owner, `/decisions/${d.id}/undo`)).status, 409);

  const { key: own } = await json<{ key: string }>(post(f.agent, "/issues", { project: "CORE", title: "Cycle report as PDF", description: "## Done when\n\n- The PDF opens" }));
  const kept = ((await json<{ decision: View }>(ask(own, HAND))) as { decision: View }).decision;
  await post(f.owner, `/decisions/${kept.id}/answer`, { option: 1 });
  assert.match((await json<{ description: string }>(f.owner(f.api(`/issues/${own}`)))).description, /- The PDF opens/);
  assert.doesNotMatch((await json<{ description: string }>(f.owner(f.api(`/issues/${own}`)))).description, /Export CSV/);
  assert.match((await comments(own)).find((c) => c.parentId)!.body, /has its own Done when, so it is kept/);
});

test("no rule for hand-offs: none is saved from one, and none answers one", async () => {
  const HAND = { kind: "handoff", question: "Hand it over?", options: ["Hand it over", "Keep it for me"], recommend: 1, criteria: ["It works"], topic: "small fixes" };
  const first = ((await json<{ decision: View }>(ask(await issue("Small fix one"), HAND))) as { decision: View }).decision;
  assert.equal((await post(f.owner, `/decisions/${first.id}/answer`, { option: 2, rule: true })).status, 400);
  await db.insert(schema.decisionRule).values({ workspaceId: f.ws.workspaceId, projectId: (await db.select({ p: schema.issue.projectId }).from(schema.issue).where(eq(schema.issue.id, (await db.select({ i: schema.decision.issueId }).from(schema.decision).where(eq(schema.decision.id, first.id)))[0]!.i)))[0]!.p, kind: "handoff", topic: "small fixes", answer: "Hand it over", userId: f.ws.ownerId });
  const second = ((await json<{ decision: View }>(ask(await issue("Small fix two"), HAND))) as { decision: View }).decision;
  assert.equal(second.status, "open", "a hand-off's criteria are read by a person, every time");
});

test("a hand-over writes the description: a token without the issues grant is refused before anything is written; its other answers go", async () => {
  const { secret } = await createToken({ workspaceId: f.ws.workspaceId, userId: f.ws.ownerId, name: "comments only", scope: "custom", grants: ["comments.write"], createdById: f.ws.ownerId });
  const commentsOnly = fetchAs({ authorization: `Bearer ${secret}`, "content-type": "application/json" });
  const HAND = { kind: "handoff", question: "Hand it to Claude?", options: ["Hand it over", "Keep it for me"], recommend: 1, criteria: ["Export works"] };
  const key = await issue("Cycle report as XLSX");
  const d = ((await json<{ decision: View }>(ask(key, HAND))) as { decision: View }).decision;
  const refused = await post(commentsOnly, `/decisions/${d.id}/answer`, { option: 1 });
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.ok((await open()).some((x) => x.id === d.id), "still open");
  assert.equal((await comments(key)).filter((c) => c.parentId).length, 0, "no reply written");
  assert.doesNotMatch((await json<{ description: string }>(f.owner(f.api(`/issues/${key}`)))).description, /Done when/);
  assert.equal((await post(commentsOnly, `/decisions/${d.id}/answer`, { option: 2 })).status, 200, "keeping it is a comment's answer");
});

test("purging an issue takes its decisions along, and the log keeps neither the question nor the answer", async () => {
  const secret = "Which courier ships to Reykjavik in winter?";
  const { key, decision } = await asked("Courier for Iceland", { question: secret, topic: "iceland-courier", evidence: ["the Reykjavik tariff"] });
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
