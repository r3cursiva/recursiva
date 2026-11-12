import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTIFY_DEFAULTS, NOTIFY_PRESETS, NOTIFY_ROWS, TELEGRAM_STARTS, afterQuiet, delivery, notifyEvent, unsubscribed, withCell, withPreset, workspaceAllows } from "@rsva/protocol";

test("a cell set back to its default leaves the person's changes", () => {
  const p = withCell(NOTIFY_DEFAULTS, "comment", "email", "now");
  assert.deepEqual(p.rules, { comment: { email: "now" } });
  assert.equal(delivery(p, "comment", "email"), "now");
  assert.deepEqual(withCell(p, "comment", "email", "digest").rules, {}, "digest is the comment's default");
});

test("a preset sets one channel's every cell", () => {
  const all = withPreset(NOTIFY_DEFAULTS, "email", NOTIFY_PRESETS[1].pick);
  assert.equal(delivery(all, "state", "email"), "now");
  assert.equal(delivery(all, "state", "telegram"), "off");
  const waiting = withPreset(all, "email", NOTIFY_PRESETS[0].pick);
  assert.equal(delivery(waiting, "assigned", "email"), "digest");
  assert.equal(delivery(waiting, "mention", "email"), "now");
  const digest = withPreset(all, "email", NOTIFY_PRESETS[2].pick);
  assert.equal(delivery(digest, "mention", "email"), "digest");
});

test("what should come to Telegram: no digest there, so the same as email takes only email's Instantly", () => {
  const start = (id: (typeof TELEGRAM_STARTS)[number]["id"], p = NOTIFY_DEFAULTS) => withPreset(p, "telegram", (r) => TELEGRAM_STARTS.find((s) => s.id === id)!.pick(r, p));
  const waiting = start("waiting");
  assert.deepEqual(NOTIFY_ROWS.filter((r) => delivery(waiting, r.id, "telegram") === "now").map((r) => r.id), ["plan", "review", "mention"]);
  const asEmail = start("email");
  // Email: assigned now, reply and comment in the digest, state off.
  assert.equal(delivery(asEmail, "assigned", "telegram"), "now");
  assert.equal(delivery(asEmail, "reply", "telegram"), "off");
  assert.equal(delivery(asEmail, "comment", "telegram"), "off");
  const all = start("everything");
  for (const r of NOTIFY_ROWS) assert.equal(delivery(all, r.id, "telegram"), "now", r.id);
  for (const r of NOTIFY_ROWS) assert.equal(delivery(all, r.id, "email"), delivery(NOTIFY_DEFAULTS, r.id, "email"), "email untouched");
});

test("unsubscribing turns every email cell, the digest and the weekly summary off", () => {
  const p = unsubscribed({ ...NOTIFY_DEFAULTS, weekly: true });
  for (const r of NOTIFY_ROWS) assert.equal(delivery(p, r.id, "email"), "off", r.id);
  assert.equal(delivery(p, "mention", "telegram"), "now", "Telegram is not email");
  assert.equal(p.digest.on, false);
  assert.equal(p.weekly, false);
});

test("an inbox kind maps to its row; a review by an agent is a plan", () => {
  assert.equal(notifyEvent("review", true), "plan");
  assert.equal(notifyEvent("review", false), "review");
  assert.equal(notifyEvent("approved", false), "state");
  assert.equal(notifyEvent("mention", true), "mention");
});

test("only about me keeps what is addressed to the person", () => {
  const p = { ...NOTIFY_DEFAULTS, workspaces: { w: "me" as const, x: "off" as const } };
  assert.equal(workspaceAllows(p, "w", "mention"), true);
  assert.equal(workspaceAllows(p, "w", "comment"), false);
  assert.equal(workspaceAllows(p, "x", "mention"), false);
  assert.equal(workspaceAllows(p, "other", "comment"), true);
});

test("quiet hours across midnight hold a message until they end, in the person's zone", () => {
  const quiet = { from: "22:00", to: "08:00" };
  // 23:30 in Sofia (UTC+2 in November) is 21:30 UTC: held until 08:00 Sofia, 06:00 UTC.
  assert.equal(afterQuiet(new Date("2026-11-03T21:30:20Z"), quiet, "Europe/Sofia").toISOString(), "2026-11-04T06:00:00.000Z");
  // 07:59 Sofia: one minute.
  assert.equal(afterQuiet(new Date("2026-11-04T05:59:00Z"), quiet, "Europe/Sofia").toISOString(), "2026-11-04T06:00:00.000Z");
  // 12:00 Sofia: at once.
  const noon = new Date("2026-11-04T10:00:00Z");
  assert.equal(afterQuiet(noon, quiet, "Europe/Sofia"), noon);
  assert.equal(afterQuiet(noon, null, "Europe/Sofia"), noon);
});

test("quiet hours end on the wall clock across a change to and from daylight saving; no zone, no quiet hours", () => {
  const quiet = { from: "22:00", to: "08:00" };
  // Berlin, 2026-10-24 23:00 CEST (21:00 UTC): clocks go back that night, 08:00 CET is 07:00 UTC.
  assert.equal(afterQuiet(new Date("2026-10-24T21:00:00Z"), quiet, "Europe/Berlin").toISOString(), "2026-10-25T07:00:00.000Z");
  // Berlin, 2027-03-27 23:00 CET (22:00 UTC): clocks go forward, 08:00 CEST is 06:00 UTC.
  assert.equal(afterQuiet(new Date("2027-03-27T22:00:00Z"), quiet, "Europe/Berlin").toISOString(), "2027-03-28T06:00:00.000Z");
  const night = new Date("2026-11-03T23:30:00Z");
  assert.equal(afterQuiet(night, quiet, null), night);
});
