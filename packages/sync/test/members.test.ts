import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_NOT_FOUND } from "@rsva/protocol";
import { ME, online, reopened, WS } from "./fake.ts";

const SAM = "00000000-0000-7000-8000-0000000000f1";

test("a member who joins shows up; a role change shows at once and reverts when refused", async () => {
  const { store, socket } = await online();
  socket().push({ t: "d", a: [{ id: 11, m: "User", mid: SAM, a: "I", d: { id: SAM, email: "sam@x.dev", name: "Sam", kind: "human", role: "member" } }] });
  assert.equal(store.users.get(SAM)?.role, "member");

  store.setMemberRole(SAM, "admin");
  assert.equal(store.users.get(SAM)?.role, "admin");
  const [tx] = socket().frames("tx");
  assert.deepEqual(tx!.ops, [{ op: "update", m: "User", id: SAM, set: { role: "admin" } }]);
  socket().push({ t: "rej", id: tx!.id, code: "forbidden", msg: "only admins change other members" });
  assert.equal(store.users.get(SAM)?.role, "member");
  store.dispose();
});

test("removing a member keeps their row with role null, so their name still shows", async () => {
  const { store, socket } = await online();
  socket().push({ t: "d", a: [{ id: 11, m: "User", mid: SAM, a: "I", d: { id: SAM, email: "sam@x.dev", name: "Sam", kind: "human", role: "member" } }] });
  store.removeMember(SAM);
  assert.equal(store.users.get(SAM)?.name, "Sam");
  assert.equal(store.users.get(SAM)?.role, null);
  const [tx] = socket().frames("tx");
  assert.deepEqual(tx!.ops, [{ op: "delete", m: "User", id: SAM }]);
  // Removing someone who is gone already sends nothing.
  store.removeMember(SAM);
  assert.equal(socket().frames("tx").length, 1);
  store.dispose();
});

test("the viewer's own role follows its User action", async () => {
  const { store, socket } = await online();
  assert.equal(store.users.get(ME)?.role, "owner");
  socket().push({ t: "d", a: [{ id: 11, m: "User", mid: ME, a: "U", d: { role: "admin" } }] });
  assert.equal(store.role, "admin");
  assert.equal(store.workspace?.id, WS.id);
  store.dispose();
});

test("a workspace that is no longer the viewer's stops the engine and deletes its copy on this device", async () => {
  const o = await online();
  await o.store.persist();
  assert.ok((await o.idb.databases()).some((d) => d.name === `rsva:${WS.slug}`));
  // A warm start learns it from the socket alone: removed while the tab was closed.
  o.socket().closeBy(CLOSE_NOT_FOUND);
  assert.equal(o.store.errorCode, "not_found");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await o.idb.databases()).some((d) => d.name === `rsva:${WS.slug}`), false);
  o.store.dispose();
});

test("a local copy saved without the User picture and avatar keeps them once they arrive (RSVA-406)", async () => {
  // fake.ts serves User without picture and avatar, as a server from before PLNR-244 and PLNR-366 (or a half-updated one).
  const h = await online();
  assert.equal(h.store.users.get(ME)?.avatar, null);
  h.socket().push({ t: "d", a: [{ id: 11, m: "User", mid: ME, a: "U", d: { picture: "a".repeat(64), avatar: "c1:5,40,60,-12,82,2,40,30,50,1" } }] });
  const again = await reopened(h);
  const me = again.store.users.get(ME)!;
  assert.equal(me.avatar, "c1:5,40,60,-12,82,2,40,30,50,1", "the creature is in the saved copy");
  assert.equal(me.picture, "a".repeat(64), "the picture is in the saved copy");
  again.store.dispose();
});
