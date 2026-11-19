// The public demo (demo.ts): the instance seeds Lumen itself, lets a visitor in with no sign-up and takes no files.
// The mode is read when the modules load, so they are loaded after it is set.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEMO } from "@rsva/protocol";

process.env.RSVA_DEMO = "on";
const { sql } = await import("../db.ts");
const { buildApp } = await import("../app.ts");
const { checkDemo, keepDemoDay, seedDemo } = await import("./demo.ts");
const { importFixture } = await import("../test/helpers.ts");

const app = buildApp({ logLevel: "warn", mailer: async () => {} });
after(() => app.close());

const lumen = async () => (await sql<{ id: string }[]>`select id from workspace where slug = ${DEMO.slug}`)[0]!.id;
const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;

test("a demo instance seeds Lumen once: cycles under way, finished issues, delegations and the agents' questions", async () => {
  assert.equal(await seedDemo(app), true);
  assert.equal(await seedDemo(app), false, "a second start finds it");
  const ws = await lumen();
  assert.equal(await count(sql`select count(*)::int as n from cycle c join project p on p.id = c.project_id where p.workspace_id = ${ws}`), 4);
  assert.equal(await count(sql`select count(*)::int as n from issue where workspace_id = ${ws} and delegate_id is not null`), 7);
  // The burn-up has a past: the finished issues are dated over the last days, not all today.
  const days = await count(sql`select count(distinct completed_at::date)::int as n from issue where workspace_id = ${ws} and completed_at > now() - interval '6 days'`);
  assert.ok(days >= 4, `finished on ${days} days`);
  const asks = await count(sql`select count(*)::int as n from comment c join "user" u on u.id = c.author_id where c.workspace_id = ${ws} and u.email = 'atlas@example.com' and c.body like '%mention:%'`);
  assert.equal(asks, 2);
  assert.equal(await count(sql`select count(*)::int as n from api_token where workspace_id = ${ws} and revoked_at is null`), 0, "the seed's tokens are revoked");
});

test("a visitor walks in with no sign-up, as a member of their own, and may upload nothing", async () => {
  await seedDemo(app);
  assert.deepEqual((await app.inject({ method: "GET", url: "/auth/demo" })).json(), { workspace: DEMO.slug });
  const r = await app.inject({ method: "POST", url: "/auth/demo", payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  const me = r.json<{ user: { id: string; email: string; name: string }; mayCreateWorkspaces: boolean }>();
  assert.ok(me.user.email.endsWith(`@${DEMO.emailDomain}`));
  assert.match(me.user.name, /^Visitor \d{4}$/);
  assert.equal(me.mayCreateWorkspaces, false);
  const [m] = await sql<{ role: string }[]>`select role from member where user_id = ${me.user.id} and workspace_id = ${await lumen()}`;
  assert.equal(m?.role, "member");
  const cookie = [r.headers["set-cookie"]].flat().map((c) => String(c).split(";")[0]).join("; ");
  const bytes = Buffer.from("hello");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const up = await app.inject({ method: "PUT", url: `/files/${DEMO.slug}/${sha}`, headers: { cookie, origin: "http://localhost", "content-type": "text/plain" }, payload: bytes });
  assert.match(up.json<{ message: string }>().message, /in the demo/, up.body);
  const pic = await app.inject({ method: "PUT", url: "/auth/me/picture", headers: { cookie, origin: "http://localhost", "content-type": "image/png" }, payload: bytes });
  assert.match(pic.json<{ message: string }>().message, /in the demo/, pic.body);
});

test("the day is kept before the reset: who walked in, how many changed something, and how many changes", async () => {
  await seedDemo(app);
  const enter = async () => {
    const r = await app.inject({ method: "POST", url: "/auth/demo", payload: {} });
    return [r.headers["set-cookie"]].flat().map((c) => String(c).split(";")[0]).join("; ");
  };
  const busy = await enter();
  await enter(); // walks in and does nothing
  const change = await app.inject({ method: "PATCH", url: `/api/v1/workspaces/${DEMO.slug}/issues/WEB-4`, headers: { cookie: busy, origin: "http://localhost" }, payload: { title: "Changed by a visitor" } });
  assert.equal(change.statusCode, 200, change.body);
  const dir = mkdtempSync(join(tmpdir(), "rsva-demo-"));
  const logged: object[] = [];
  await keepDemoDay(dir, { info: (o) => logged.push(o) });
  const day = JSON.parse(readFileSync(join(dir, "demo-days.jsonl"), "utf8").trim()) as { visitors: number; active: number; changes: number; since: string };
  assert.ok(day.visitors >= 2, `${day.visitors} visitors`);
  assert.equal(day.active, 1, "only the one who changed something");
  assert.equal(day.changes, 1);
  assert.ok(Date.parse(day.since) <= Date.now());
  assert.deepEqual(logged, [day]);
});

test("the demo refuses a database with anything else in it, and mail or Telegram set up", async () => {
  await importFixture();
  await assert.rejects(checkDemo({}), /a database of its own/);
  await assert.rejects(checkDemo({ RESEND_API_KEY: "re_x" }), /sends no mail/);
  await assert.rejects(checkDemo({ TELEGRAM_BOT_TOKEN: "1:x" }), /sends no messages/);
});
