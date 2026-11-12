import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountSettings } from "@rsva/protocol";

/** A server whose answers the test releases in any order. */
function server() {
  const held: { body: unknown; release: (s: AccountSettings | null) => void }[] = [];
  globalThis.fetch = ((_: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      held.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        release: (s) => resolve(s ? Response.json({ settings: s }) : Response.json({ error: "invalid", message: "no" }, { status: 400 })),
      });
    })) as typeof fetch;
  return held;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// First: the module is fresh here, as on a new device.
test("settings from the snapshot are kept and spare GET /auth/me; a person without a zone gets this browser's", async () => {
  const held = server();
  const { account, deviceTimeZone } = await import("./account.ts");
  account.fromSnapshot({ timeZone: null, weekStart: 0, theme: null, ui: null });
  assert.equal(account.settings.weekStart, 0);
  account.startup();
  await tick();
  // The one request is the zone being filled in, not a GET.
  assert.equal(held.length, 1);
  assert.deepEqual(held[0]!.body, { timeZone: deviceTimeZone() });
  held[0]!.release({ timeZone: deviceTimeZone(), weekStart: 0, theme: null, ui: null });
  await tick();
  assert.equal(account.settings.timeZone, deviceTimeZone());
});

test("the answer to the last change wins, whatever order the answers come in", async () => {
  const held = server();
  const { account } = await import("./account.ts");
  const sunday = account.update({ weekStart: 0 });
  const saturday = account.update({ weekStart: 6 });
  assert.equal(account.settings.weekStart, 6);
  held[1]!.release({ timeZone: null, weekStart: 6, theme: null, ui: null });
  await saturday;
  held[0]!.release({ timeZone: null, weekStart: 0, theme: null, ui: null });
  await sunday;
  assert.equal(account.settings.weekStart, 6);
});

test("a refused last change brings back what the server holds", async () => {
  const held = server();
  const { account } = await import("./account.ts");
  const p = account.update({ weekStart: 0 });
  assert.equal(account.settings.weekStart, 0);
  held[0]!.release(null);
  await assert.rejects(p);
  await tick();
  // The page asks the server again; it still has Saturday from the test above.
  assert.equal(held.length, 2);
  held[1]!.release({ timeZone: "Europe/Sofia", weekStart: 6, theme: null, ui: null });
  await tick();
  await tick();
  assert.equal(account.settings.weekStart, 6);
});
