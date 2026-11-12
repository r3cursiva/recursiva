import assert from "node:assert/strict";
import { test } from "node:test";
import { welcomeLead } from "./welcome.ts";

test("Welcome leads with creating for a creator without invites, with the invites otherwise (RSVA-552)", () => {
  assert.equal(welcomeLead(true, 0), "create", "let in from the waitlist: nothing to join, one workspace to make");
  assert.equal(welcomeLead(true, null), "create", "while the invites load: most creators have none, no jump");
  assert.equal(welcomeLead(true, 2), "invites", "invited too: the invites first, as today");
  assert.equal(welcomeLead(false, 0), "invites", "may not create: only the ways to join");
  assert.equal(welcomeLead(false, null), "invites");
});
