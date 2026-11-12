import assert from "node:assert/strict";
import { test } from "node:test";
import { retrying, transient, uniqueViolation } from "./retry.ts";
import { TxError } from "./tx-error.ts";

const pg = (code: string) => Object.assign(new Error(code), { code });
/** How drizzle reports a failed query: its own error, the driver's in `cause`. */
const wrapped = (code: string) => Object.assign(new Error("Failed query"), { cause: pg(code) });
const noPause = async () => {};

test("uniqueViolation: 23505 on the error or anywhere it wraps (RSVA-428: one reading for workspaces and email changes)", () => {
  for (const e of [pg("23505"), wrapped("23505"), Object.assign(new Error("outer"), { cause: wrapped("23505") })]) assert.equal(uniqueViolation(e), true);
  for (const e of [pg("23503"), wrapped("40P01"), new Error("23505"), null, "23505"]) assert.equal(uniqueViolation(e), false, String(e));
});

test("transient: deadlocks, serialization failures and lost connections; not bugs, bad data or refusals", () => {
  for (const code of ["40P01", "40001", "57P01", "08006", "08003", "CONNECTION_CLOSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
    assert.equal(transient(pg(code)), true, code);
    assert.equal(transient(wrapped(code)), true, `wrapped ${code}`);
  }
  for (const e of [pg("23505"), wrapped("22021"), pg("42P01"), new Error("boom"), new TxError("invalid", "no"), null, "40P01"]) assert.equal(transient(e), false, String(e));
});

test("retrying runs a transaction again while it fails transiently, up to three times", async () => {
  let calls = 0;
  const twice = () => (++calls <= 2 ? Promise.reject(wrapped("40P01")) : Promise.resolve("done"));
  assert.equal(await retrying(twice, noPause), "done");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(retrying(() => (calls++, Promise.reject(wrapped("40001"))), noPause), /Failed query/);
  assert.equal(calls, 3, "gives up after the third run");

  calls = 0;
  await assert.rejects(retrying(() => (calls++, Promise.reject(new TxError("invalid", "no"))), noPause), TxError);
  assert.equal(calls, 1, "a refusal is not retried");
});
