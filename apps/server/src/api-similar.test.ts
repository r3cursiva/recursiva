// Similar issues on create (PLNR-295): the answer lists the open issues that look like the new one, and a strong match
// refuses it until the caller says `force: true`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiFixture, importFixture, jsonTokens } from "./test/helpers.ts";

const f = apiFixture();
interface Similar {
  key: string;
  title: string;
  state: string;
  score: number;
}
interface Created {
  key?: string;
  error?: string;
  message?: string;
  similar: Similar[];
}
const create = async (title: string, more: Record<string, unknown> = {}, as = f.agent, space = f.ws.slug) => {
  const r = await as(f.api("/issues", space), { method: "POST", body: JSON.stringify({ project: "CORE", title, ...more }) });
  return { status: r.status, body: (await r.json()) as Created };
};
const total = async () => ((await (await f.agent(f.api("/issues?limit=1"))).json()) as { total: number }).total;
const patch = (key: string, body: object) => f.owner(f.api(`/issues/${key}`), { method: "PATCH", body: JSON.stringify(body) });

test("the answer lists the open issues that look like the new one; none is an empty list", async () => {
  const first = await create("Zebra crossing paint fades in the evening");
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.similar, []);
  const second = await create("Zebra crossing paint wears off at dusk");
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.similar.length, 1);
  assert.deepEqual(second.body.similar[0], { key: first.body.key, title: "Zebra crossing paint fades in the evening", state: "Backlog", score: 0.36 });
});

test("a strong match is refused with 409 and nothing is written; force: true creates it", async () => {
  const original = await create("Quartz clock drifts by a minute a week");
  assert.equal(original.status, 201);
  const before = await total();
  const again = await create("Quartz clock drifts by a minute a week!");
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "similar");
  assert.match(again.body.message!, new RegExp(`looks like ${original.body.key} "Quartz clock drifts by a minute a week" \\(1\\)`));
  assert.match(again.body.message!, /send force: true to create it anyway/);
  assert.deepEqual(again.body.similar, [{ key: original.body.key, title: "Quartz clock drifts by a minute a week", state: "Backlog", score: 1 }]);
  assert.equal(await total(), before, "the refused issue was not written");

  const forced = await create("Quartz clock drifts by a minute a week!", { force: true });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.similar[0]!.key, original.body.key);
  assert.equal(await total(), before + 1);
  // `force: "true"` is not true.
  assert.equal((await create("Quartz clock drifts by a minute a week?", { force: "true" })).status, 409);
});

test("a refusal comes after the checks of the fields: a bad label is still a 400 with its names", async () => {
  await create("Lighthouse lamp flickers when it rains");
  const r = await create("Lighthouse lamp flickers when it rains", { labels: ["no-such-label"] });
  assert.equal(r.status, 400);
});

test("closed, archived and deleted issues never match", async () => {
  const title = "Harbour crane squeals while turning left";
  const a = (await create(title)).body.key!;
  assert.equal((await patch(a, { state: "Done" })).status, 200);
  const closed = await create(title);
  assert.equal(closed.status, 201, "a finished issue is not a match");
  assert.deepEqual(closed.body.similar, []);

  assert.equal((await patch(a, { archived: true })).status, 200);
  const archived = await create(title, { force: true });
  assert.deepEqual(archived.body.similar.map((s) => s.key), [closed.body.key], "only the open one, not the archived");

  assert.equal((await patch(closed.body.key!, { state: "Cancelled" })).status, 200);
  assert.equal((await patch(archived.body.key!, { deleted: true })).status, 200);
  const left = await create(title);
  assert.equal(left.status, 201, JSON.stringify(left.body));
  assert.deepEqual(left.body.similar, []);
});

test("another workspace never matches", async () => {
  const title = "Weather vane points south in every wind";
  const here = await create(title);
  assert.equal(here.status, 201);
  const other = await importFixture();
  const r = await create(title, {}, (await jsonTokens(other)).agent, other.slug);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.similar, []);
});

test("a project of the workspace other than the new issue's counts at four fifths", async () => {
  const projects = (await (await f.agent(f.api("/projects"))).json()) as { key: string }[];
  const elsewhere = projects.find((p) => p.key !== "CORE")!.key;
  const title = "Bell tower clock is four minutes fast";
  const first = await create(title, { project: elsewhere });
  assert.equal(first.status, 201);
  // An identical title in another project scores 0.8: listed, and over STRONG (0.75).
  const twin = await create(title);
  assert.equal(twin.status, 409);
  assert.equal(twin.body.similar[0]!.score, 0.8);
  // The same sentence with one word changed, as a twin of another site: 0.79 raw, 0.63 here: only listed.
  const sibling = await create("Bell tower clock is four minutes slow");
  assert.equal(sibling.status, 201, JSON.stringify(sibling.body));
  assert.deepEqual(sibling.body.similar.map((s) => s.key), [first.body.key]);
});
