import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError, telegramApi, webhookSecret } from "./api.ts";

/** Telegram as a fetch: records the request and answers with `body`. */
function fake(body: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { calls, fetchFn };
}

test("a message goes as HTML without a link preview, silently when asked", async () => {
  const t = fake({ ok: true, result: { message_id: 1 } });
  assert.equal(await telegramApi("123:abc", t.fetchFn).send(42, "<b>hi</b>", { silent: true }), 1, "the message id");
  assert.equal(t.calls[0]!.url, "https://api.telegram.org/bot123:abc/sendMessage");
  assert.deepEqual(t.calls[0]!.body, { chat_id: 42, text: "<b>hi</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true }, disable_notification: true });
});

test("a blocked bot or a gone chat is for good; a rate limit is not", async () => {
  const refusal = async (code: number, description: string) =>
    telegramApi("t", fake({ ok: false, error_code: code, description }).fetchFn)
      .send(1, "x")
      .then(() => assert.fail("sent"), (e: unknown) => e as TelegramError);
  assert.equal((await refusal(403, "Forbidden: bot was blocked by the user")).permanent, true);
  assert.equal((await refusal(400, "Bad Request: chat not found")).permanent, true);
  assert.equal((await refusal(429, "Too Many Requests: retry after 5")).permanent, false);
  assert.equal((await refusal(400, "Bad Request: can't parse entities")).permanent, false);
  assert.equal((await refusal(403, "Forbidden: bot was blocked by the user")).reason, "Bot blocked");
  assert.equal((await refusal(403, "Forbidden: bot was kicked from the group chat")).reason, "Bot removed");
  assert.equal((await refusal(403, "Forbidden: user is deactivated")).reason, "Account deleted");
});

test("a rate limit names its wait (RSVA-212)", async () => {
  const refusal = (body: unknown) =>
    telegramApi("t", fake(body).fetchFn)
      .send(1, "x")
      .then(() => assert.fail("sent"), (e: unknown) => e as TelegramError);
  const e = await refusal({ ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } });
  assert.equal(e.retryAfter, 7);
  assert.equal(e.permanent, false);
  assert.equal((await refusal({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" })).retryAfter, undefined);
});

test("a group that became a supergroup names its new id and is not refused for good", async () => {
  const e = await telegramApi("t", fake({ ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1001 } }).fetchFn)
    .send(-1, "x")
    .then(() => assert.fail("sent"), (e: unknown) => e as TelegramError);
  assert.equal(e.migrateTo, -1001);
  assert.equal(e.permanent, false);
});

test("the bot's name is asked once; the webhook secret fits Telegram's alphabet", async () => {
  const t = fake({ ok: true, result: { username: "plnr_bot" } });
  const api = telegramApi("t", t.fetchFn);
  assert.equal(await api.username(), "plnr_bot");
  assert.equal(await api.username(), "plnr_bot");
  assert.equal(t.calls.length, 1);
  assert.match(webhookSecret("123:abc"), /^[A-Za-z0-9_-]{43}$/);
});

test("pictures go as an upload under their message, silently: one as a photo, more as an album (RSVA-652)", async () => {
  const calls: { url: string; form: FormData }[] = [];
  const answers: unknown[] = [{ message_id: 7 }, [{ message_id: 8 }, { message_id: 9 }]];
  const api = telegramApi("123:abc", (async (url: string, init: RequestInit) => {
    calls.push({ url, form: init.body as FormData });
    return new Response(JSON.stringify({ ok: true, result: answers.shift() }));
  }) as typeof fetch);
  const png = { bytes: Buffer.from("png bytes"), mime: "image/png" };
  const jpeg = { bytes: Buffer.from("jpeg bytes"), mime: "image/jpeg" };

  assert.deepEqual(await api.sendPictures(42, [png], 5), [7]);
  const one = calls[0]!;
  assert.equal(one.url, "https://api.telegram.org/bot123:abc/sendPhoto");
  assert.deepEqual([one.form.get("chat_id"), one.form.get("disable_notification")], ["42", "true"]);
  assert.deepEqual(JSON.parse(one.form.get("reply_parameters") as string), { message_id: 5, allow_sending_without_reply: true });
  const photo = one.form.get("photo") as File;
  assert.deepEqual([photo.type, await photo.text()], ["image/png", "png bytes"]);

  assert.deepEqual(await api.sendPictures(42, [png, jpeg], 5), [8, 9], "the ids in order");
  const album = calls[1]!;
  assert.equal(album.url, "https://api.telegram.org/bot123:abc/sendMediaGroup");
  assert.deepEqual(JSON.parse(album.form.get("media") as string), [
    { type: "photo", media: "attach://p0" },
    { type: "photo", media: "attach://p1" },
  ]);
  assert.deepEqual([await (album.form.get("p0") as File).text(), (album.form.get("p1") as File).type], ["png bytes", "image/jpeg"]);
});
