// Limits of the sign-in paths that a client spread over many addresses would slip: per-IP keys take an IPv6 client by
// its /64 (RSVA-599), and a client's passkey ceremonies have a share of their own (RSVA-600). Its own file: the server
// trusts a proxy here so each request can come from its own address, and the limits it uses up are per process.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { guardConfig } from "../guard.ts";
import { ORIGIN, startServer } from "../test/helpers.ts";
import { finishLogin, loginOptions } from "./passkeys.ts";
import { b64u, type AssertionJSON } from "./webauthn.ts";

let server: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  process.env.RSVA_TRUST_PROXY = "127.0.0.1";
  server = await startServer({ guard: guardConfig({ RSVA_ALLOWED_ORIGINS: ORIGIN }) });
});
after(() => server.close());

const post = (path: string, body: unknown, from: string) =>
  fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": from }, body: JSON.stringify(body) });
const address = () => `nobody-${randomUUID().slice(0, 8)}@example.test`;
/** Statuses of `n` requests, the i-th from `from(i)`, in order. */
async function statuses(n: number, send: (i: number) => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send(i)).status);
  return out;
}

test("an IPv6 client is one client per /64: walking its addresses does not reset the per-IP limits", async () => {
  // 2001:db8:<net>::<i>: one /64 per path, a new address on every request.
  const in64 = (net: number) => (i: number) => `2001:db8:${net.toString(16)}::${(i + 1).toString(16)}`;
  const codes = await statuses(31, (i) => post("/auth/code", { email: address() }, in64(1)(i)));
  assert.deepEqual([codes.slice(0, 30).every((s) => s === 204), codes[30]], [true, 429], "codes");
  const verify = await statuses(31, (i) => post("/auth/verify", { email: address(), code: "000000" }, in64(2)(i)));
  assert.deepEqual([verify.slice(0, 30).every((s) => s === 400), verify[30]], [true, 429], "verify");
  // Guesses at one address: ten per address and client, whichever address of the /64 sends them.
  const email = address();
  const guesses = await statuses(11, (i) => post("/auth/verify", { email, code: "000000" }, in64(3)(i)));
  assert.equal(guesses[10], 429, "guesses at one address");
  const passkey = await statuses(61, (i) => post("/auth/passkey/options", {}, in64(4)(i)));
  assert.deepEqual([passkey.slice(0, 60).every((s) => s === 200), passkey[60]], [true, 429], "passkey options");
  const waitlist = await statuses(6, (i) => post("/api/waitlist", { email: address() }, in64(5)(i)));
  assert.deepEqual(waitlist, [204, 204, 204, 204, 204, 429], "waitlist");
  // Another /64 is another client.
  assert.equal((await post("/auth/code", { email: address() }, "2001:db8:1:1::1")).status, 204);
});

test("passkey challenges: one client cannot push out another's, only its own oldest (RSVA-600)", async () => {
  const rp = { origin: ORIGIN, rpId: "127.0.0.1" };
  /** How a sign-in with this challenge fails before any passkey is looked at: "unknown passkey" while it is live. */
  const outcome = (challenge: string) => {
    const clientDataJSON = b64u.encode(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN })));
    return finishLogin({ id: "nobody", clientDataJSON, authenticatorData: "", signature: "" } as AssertionJSON, rp).catch((e: Error) => e.message);
  };
  const victim = loginOptions(rp, "198.51.100.9").challenge;
  // More ceremonies than the table holds, from 200 clients at their rate limit (60 in 15 minutes).
  for (let c = 0; c < 200; c++) for (let i = 0; i < 60; i++) loginOptions(rp, `10.200.${c}.1`);
  assert.equal(await outcome(victim), "unknown passkey");
  const mine = loginOptions(rp, "198.51.100.10").challenge;
  for (let i = 0; i < 10; i++) loginOptions(rp, "198.51.100.10");
  assert.equal(await outcome(mine), "unknown or used challenge");
});
