// A comment from the issue screen (PLNR-334): `@` offers people, Tab completes, and on sending an email becomes a mention.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMarkdown } from "@rsva/editor/markdown";
import { U } from "../../../packages/query/test/fixture.ts";
import { bodyOf, complete, mentionAt } from "./reply.ts";

const users = Object.values(U);

test("@ and the start of a name or an email offers the people it may be, as the web's editors do; Tab puts in the email", () => {
  assert.deepEqual(mentionAt("thanks @zo", users)?.people.map((u) => u.email), [U.zoe.email]);
  assert.deepEqual(mentionAt("@qui", users)?.people.map((u) => u.email), [U.zoe.email], "by a later word of the name");
  assert.deepEqual(mentionAt("@bot", users)?.people.map((u) => u.email), [U.bot.email], "an agent too, as in the web");
  assert.equal(mentionAt("mail a@example.com", users), null, "an address in the text is not a mention being typed");
  const at = mentionAt("ask @a", users)!;
  assert.deepEqual(complete({ text: "ask @a", at: 6 }, at, at.people[0]!), { text: `ask @${U.alex.email} `, at: 6 + U.alex.email.length });
  // At the cursor (RSVA-465): the `@` before it is completed, the text after it stays.
  const mid = mentionAt("ask @a", users)!;
  assert.deepEqual(complete({ text: "ask @a, thanks", at: 6 }, mid, mid.people[0]!), { text: `ask @${U.alex.email} , thanks`, at: 6 + U.alex.email.length });
});

test("on sending, each @email of a person is the web's mention; other text, an unknown address and punctuation stay", () => {
  const body = bodyOf(`  @${U.zoe.email}, look. Cc @${U.alex.email}. Not @nobody@example.com  `, users);
  assert.equal(body, `[@Zoe Quinn](mention:${U.zoe.id}), look. Cc [@Alex](mention:${U.alex.id}). Not @nobody@example.com`);
  // The editor reads it back as two mentions of those people.
  const ids: string[] = [];
  JSON.stringify(fromMarkdown(body), (_, v: { type?: string; attrs?: { id?: string } }) => (v?.type === "mention" && v.attrs?.id && ids.push(v.attrs.id), v));
  assert.deepEqual(ids, [U.zoe.id, U.alex.id]);
});
