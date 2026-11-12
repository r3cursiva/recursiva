import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Op } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "./db.ts";
import { moveLink, relink } from "./relink.ts";
import { applyTx } from "./sync/write.ts";
import { addMember, importFixture, issueWithRefs, lastSyncId } from "./test/helpers.ts";

after(() => sql.end({ timeout: 1 }));
const { attachment, user } = schema;

test("only an address under the old repository moves, whatever its case", () => {
  assert.equal(moveLink("https://github.com/r3cursiva/recursiva/pull/12"), "https://github.com/r3cursiva/recursiva-archive/pull/12");
  assert.equal(moveLink("https://GitHub.com/R3cursiva/Recursiva/commit/abc1234"), "https://github.com/r3cursiva/recursiva-archive/commit/abc1234");
  for (const kept of ["https://github.com/r3cursiva/recursiva-archive/pull/12", "https://github.com/r3cursiva/recursiva", "https://github.com/r3cursiva/recursiva-internal/pull/1", "https://example.com/r3cursiva/recursiva/pull/1"])
    assert.equal(moveLink(kept), null, kept);
});

test("relink: a dry run counts; a run rewrites through the log what was made before the switch, and nothing else", async () => {
  const ws = await importFixture();
  const { issue: i } = await issueWithRefs(ws.workspaceId);
  const tx = (ops: Op[]) => applyTx(ws.workspaceId, ws.ownerId, randomUUID(), ops);
  const add = (url: string) => {
    const id = randomUUID();
    return tx([{ op: "create", m: "Attachment", id, set: { issueId: i.id, url, title: "" } } as Op]).then(() => id);
  };
  const old = await add("https://github.com/r3cursiva/recursiva/pull/12");
  const commit = await add("https://github.com/r3cursiva/recursiva/commit/0123456789abcdef");
  const archive = await add("https://github.com/r3cursiva/recursiva-archive/pull/3");
  const other = await add("https://example.com/r3cursiva/recursiva/pull/1");
  await new Promise((r) => setTimeout(r, 20));
  const before = new Date();
  await new Promise((r) => setTimeout(r, 20));
  const after_ = await add("https://github.com/r3cursiva/recursiva/pull/99");
  const url = async (id: string) => (await db.select({ url: attachment.url, kind: attachment.kind }).from(attachment).where(eq(attachment.id, id)))[0]!;

  const mine = (found: Awaited<ReturnType<typeof relink>>) => found.filter((f) => f.ws === ws.slug);
  const seen = mine(await relink({ before }));
  assert.deepEqual(seen.map((f) => f.to).sort(), ["https://github.com/r3cursiva/recursiva-archive/commit/0123456789abcdef", "https://github.com/r3cursiva/recursiva-archive/pull/12"]);
  const logged = await lastSyncId(ws.workspaceId);

  const outsider = await addMember((await importFixture()).workspaceId, "member");
  await assert.rejects(relink({ before, as: outsider.email }), /not a member/);
  await assert.rejects(relink({ before, as: "nobody@example.test" }), /no user/);
  assert.equal((await url(old)).url, "https://github.com/r3cursiva/recursiva/pull/12", "nothing written yet");

  const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, ws.ownerId));
  await relink({ before, as: owner!.email });
  assert.deepEqual(await url(old), { url: "https://github.com/r3cursiva/recursiva-archive/pull/12", kind: "github_pr" });
  assert.equal((await url(commit)).url, "https://github.com/r3cursiva/recursiva-archive/commit/0123456789abcdef");
  assert.equal((await url(archive)).url, "https://github.com/r3cursiva/recursiva-archive/pull/3");
  assert.equal((await url(other)).url, "https://example.com/r3cursiva/recursiva/pull/1");
  assert.equal((await url(after_)).url, "https://github.com/r3cursiva/recursiva/pull/99", "made after the switch: the new repository's");
  assert.equal(await lastSyncId(ws.workspaceId), logged + 2, "one action per link");
  assert.equal(mine(await relink({ before })).length, 0, "run again: nothing left");
});
