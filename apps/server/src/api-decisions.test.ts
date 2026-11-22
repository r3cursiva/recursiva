import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnswer, formatAsk, type Ask, type OpenDecision } from "@rsva/protocol/decisions";
import { apiFixture, asToken, fetchAs } from "./test/helpers.ts";

const f = apiFixture();
const json = async <T>(r: Promise<Response>) => (await (await r).json()) as T;
const post = (as: typeof fetch, path: string, b: unknown) => as(f.api(path), { method: "POST", body: JSON.stringify(b) });
const open = (as = f.owner) => json<{ decisions: OpenDecision[] }>(as(f.api("/decisions"))).then((r) => r.decisions);

const ASK: Ask = {
  kind: "question",
  question: "Which courier should ship orders to Greece?",
  options: [
    { label: "Speedy", detail: "€6.40 · 3–4 days" },
    { label: "DHL Express", detail: "€14.90 · 1–2 days" },
  ],
  recommended: 0,
  why: "Most orders are under €60.",
  evidence: ["#77"],
  group: null,
};

/** A new issue with the agent's question on it; titles apart, so the create is not refused as a likely duplicate. */
async function issueWithAsk(title: string, ask: Ask, description?: string) {
  const { key } = await json<{ key: string }>(post(f.agent, "/issues", { project: "CORE", title, ...(description ? { description } : {}) }));
  const { id } = await json<{ id: string }>(post(f.agent, `/issues/${key}/comments`, { body: formatAsk(ask) }));
  return { key, id };
}

test("an agent's question waits on the owner until a person replies; an agent's reply and plain comments do not count", async () => {
  const { key, id } = await issueWithAsk("Courier for the Greek orders", ASK);
  await post(f.agent, `/issues/${key}/comments`, { body: "Just a note, not a question." });
  const listed = (await open()).filter((d) => d.key === key);
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0]!.commentId, listed[0]!.question, listed[0]!.options.length, listed[0]!.recommended, listed[0]!.kind], [id, ASK.question, 2, 0, "question"]);

  await post(f.agent, `/issues/${key}/comments`, { body: "Still waiting", parentId: id });
  assert.equal((await open()).filter((d) => d.key === key).length, 1, "an agent's reply is not an answer");

  const r = await post(f.owner, `/issues/${key}/comments`, { body: formatAnswer({ option: 0, label: "Speedy" }), parentId: id });
  assert.equal(r.status, 201);
  assert.equal((await open()).filter((d) => d.key === key).length, 0, "answered");
});

test("a hand-off carries its issue's Done when; a closed issue's question is not open", async () => {
  const hand = await issueWithAsk("Cycle report as CSV", { ...ASK, kind: "hand", question: "Hand it to Claude?" }, "Plan.\n\n## Done when\n\n- Export CSV in the menu\n- A test covers an empty cycle\n");
  const listed = (await open()).find((d) => d.key === hand.key);
  assert.deepEqual(listed?.doneWhen, ["Export CSV in the menu", "A test covers an empty cycle"]);

  const done = await issueWithAsk("Retention of the nightly dumps", ASK);
  const r = await f.owner(f.api(`/issues/${done.key}`), { method: "PATCH", body: JSON.stringify({ state: "Done" }) });
  assert.equal(r.status, 200, await r.text());
  assert.equal((await open()).find((d) => d.key === done.key), undefined);
});

test("rules: a person saves, lists and removes their own; an agent reads them and saves none", async () => {
  const saved = await post(f.owner, "/decision-rules", { project: "core", question: ASK.question, answer: "Speedy" });
  assert.equal(saved.status, 201);
  const { rule } = (await saved.json()) as { rule: { id: string; project: string } };
  assert.equal(rule.project, "CORE");

  const read = await json<{ rules: { id: string; mine: boolean; answer: string }[] }>(f.agent(f.api("/decision-rules")));
  assert.deepEqual(read.rules.find((r) => r.id === rule.id) && { mine: false, answer: "Speedy" }, { mine: false, answer: "Speedy" });
  assert.equal((await post(f.agent, "/decision-rules", { project: "CORE", question: "Q", answer: "A" })).status, 403);
  assert.equal((await post(f.owner, "/decision-rules", { project: "NOPE", question: "Q", answer: "A" })).status, 400);
  assert.equal((await f.agent(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  const readOnly = fetchAs({ ...(await asToken(f.ws.workspaceId, f.ws.ownerId, "read")), "content-type": "application/json" });
  assert.equal((await post(readOnly, "/decision-rules", { project: "CORE", question: "Q", answer: "A" })).status, 403);
  assert.equal((await readOnly(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 403);
  assert.equal((await readOnly(f.api("/decisions"))).status, 200, "reading is open to a read-only token");

  assert.equal((await f.owner(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 200);
  const after = await json<{ rules: { id: string }[] }>(f.owner(f.api("/decision-rules")));
  assert.equal(after.rules.find((r) => r.id === rule.id), undefined);
  assert.equal((await f.owner(f.api(`/decision-rules/${rule.id}`), { method: "DELETE" })).status, 404);
});
