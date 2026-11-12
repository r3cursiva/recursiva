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
