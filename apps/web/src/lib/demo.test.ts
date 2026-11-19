import assert from "node:assert/strict";
import { test } from "node:test";
import { isDemo } from "./demo.ts";

test("a server that is not the demo keeps its email sign-in, though it answers the address with its page and 200", async () => {
  assert.equal(await isDemo(new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html; charset=utf-8" } })), false);
  assert.equal(await isDemo(new Response(null, { status: 404 })), false);
  assert.equal(await isDemo(Response.json({ error: "not_found" }, { status: 404 })), false);
  assert.equal(await isDemo(Response.json({})), false);
});

test("the demo names its workspace", async () => {
  assert.equal(await isDemo(Response.json({ workspace: "lumen" })), true);
});
