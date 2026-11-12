import assert from "node:assert/strict";
import { test } from "node:test";
import { can, capRole, deniedGuardedChange, deniedOps, deniedState, deniedStateUpdate, grantable, GRANTS, mayManage, mayRead, MEMBER_RIGHTS, ROLES, tokenGrants, tokenReach, widens, type Capability, type Viewer } from "../src/index.ts";

const CAPS: Capability[] = ["read", ...GRANTS, "agents.manage", "members.manage"];

/** Every subset of a list: small enough to walk whole (256 grant sets, 8 member right sets). */
const subsets = <T>(all: readonly T[]): T[][] => Array.from({ length: 1 << all.length }, (_, n) => all.filter((_, i) => n & (1 << i)));
const RIGHTS = subsets(MEMBER_RIGHTS);

test("roles grow monotonically: a higher role can do everything a lower one can, whatever members were opened", () => {
  for (const rights of RIGHTS)
    for (const cap of CAPS) {
      let allowed = false;
      for (const role of ROLES) {
        const now = can({ role, rights }, cap);
        assert.ok(!allowed || now, `${role} lost ${cap}`);
        allowed = now;
      }
    }
});

test("guests can do nothing until per-viewer snapshots exist", () => {
  for (const cap of CAPS) assert.equal(can({ role: "guest" }, cap), false, cap);
});

test("members edit issues, admins edit settings", () => {
  assert.equal(can({ role: "member" }, "issues.write"), true);
  assert.equal(can({ role: "member" }, "comments.write"), true);
  assert.equal(can({ role: "member" }, "cycles.write"), true);
  for (const cap of ["labels.write", "states.write", "projects.write", "workspace.write"] as const) {
    assert.equal(can({ role: "member" }, cap), false, cap);
    assert.equal(can({ role: "admin" }, cap), true, cap);
  }
  assert.equal(can({ role: "owner" }, "agents.manage"), true);
});

test("an admin opens labels, states and projects to members, nothing else; guests stay out", () => {
  for (const cap of MEMBER_RIGHTS) {
    assert.equal(can({ role: "member", rights: [cap] }, cap), true, cap);
    assert.equal(can({ role: "guest", rights: [cap] }, cap), false, cap);
  }
  for (const cap of ["workspace.write", "members.manage", "agents.manage"] as const) assert.equal(can({ role: "member", rights: [cap] }, cap), false, `${cap} is never opened`);
  assert.match(deniedOps({ role: "member", rights: [] }, [{ op: "create", m: "Label", id: "x", set: {} }])!, /a member cannot change Label; an admin can open Labels to members/);
  assert.equal(deniedOps({ role: "member", rights: ["labels.write"] }, [{ op: "create", m: "Label", id: "x", set: {} }]), null);
});

test("a project comes with its states: Projects alone makes one, States still guards the others", () => {
  const member: Viewer = { role: "member", rights: ["projects.write"] };
  const project = { op: "create", m: "Project", id: "p", set: {} };
  const ofIt = { op: "create", m: "WorkflowState", id: "s", set: { projectId: "p", onlyPeople: true } };
  assert.equal(deniedOps(member, [project, ofIt]), null);
  assert.match(deniedOps(member, [{ ...ofIt, set: { projectId: "other" } }])!, /cannot change WorkflowState/, "a state of another project");
  assert.match(deniedOps(member, [project, { op: "update", m: "WorkflowState", id: "s", set: {} }])!, /cannot change WorkflowState/);
  assert.match(deniedOps({ role: "member", rights: [] }, [project, ofIt])!, /cannot change Project/);
});

test("the rules agents work under are a signed-in admin's: member rights and the Only people switch", () => {
  const rights = { op: "update", m: "Workspace", id: "w", set: { memberRights: ["states.write"] } };
  assert.equal(deniedOps({ role: "admin" }, [rights]), null);
  assert.match(deniedOps({ role: "owner", scope: "write" }, [rights])!, /signed-in admin/, "not even the owner's token");
  const off = { op: "update", m: "WorkflowState", id: "s", set: { onlyPeople: false } };
  assert.equal(deniedOps({ role: "admin" }, [off]), null);
  assert.match(deniedOps({ role: "member", rights: ["states.write"] }, [off])!, /signed-in admin/, "a member opened to states");
  assert.match(deniedOps({ role: "admin", scope: "custom", grants: new Set(["labels.write"]) }, [{ op: "update", m: "Label", id: "l", set: { onlyPeople: true } }])!, /signed-in admin/);
  // Made guarded, a new state or label only takes away: a new project's Todo comes so from anyone who may make projects.
  assert.equal(deniedOps({ role: "member", rights: ["states.write"] }, [{ op: "create", m: "WorkflowState", id: "s", set: { onlyPeople: true } }]), null);
  assert.match(deniedOps({ role: "member", rights: ["states.write"] }, [{ op: "create", m: "WorkflowState", id: "s", set: { onlyPeople: false } }])!, /signed-in admin/);
});

test("admins manage members; a member's role or membership is a User op", () => {
  assert.equal(can({ role: "member" }, "members.manage"), false);
  assert.equal(can({ role: "admin" }, "members.manage"), true);
  const remove = { op: "delete", m: "User", id: "x" };
  assert.match(deniedOps({ role: "member" }, [remove])!, /member cannot change User/);
  assert.equal(deniedOps({ role: "admin" }, [remove]), null);
  assert.match(deniedOps({ role: "owner", scope: "write" }, [remove])!, /signed-in person/);
});

test("an issue is deleted for good by a signed-in person, never a token: to the trash a token may (RSVA-457)", () => {
  const purge = { op: "delete", m: "Issue", id: "x" };
  assert.equal(deniedOps({ role: "member" }, [purge]), null, "the write pipeline checks creator or admin");
  assert.match(deniedOps({ role: "owner", scope: "write" }, [purge])!, /signed-in person, not a token/);
  assert.equal(deniedOps({ role: "owner", scope: "write" }, [{ op: "update", m: "Issue", id: "x", set: { deletedAt: "2026-11-07T00:00:00Z" } }]), null);
});

test("a read-only token reads and nothing else, whatever the role", () => {
  assert.equal(can({ role: "owner", scope: "read" }, "read"), true);
  for (const cap of CAPS.slice(1)) assert.equal(can({ role: "owner", scope: "read" }, cap), false, cap);
  assert.equal(can({ role: "member", scope: "write" }, "issues.write"), true);
});

test("ops are checked by model, unknown models are refused", () => {
  const issue = { op: "update", m: "Issue", id: "x", set: {} };
  const state = { op: "create", m: "WorkflowState", id: "x", set: {} };
  assert.equal(deniedOps({ role: "member" }, [issue]), null);
  assert.match(deniedOps({ role: "member" }, [issue, state])!, /member cannot change WorkflowState/);
  assert.equal(deniedOps({ role: "admin" }, [issue, state]), null);
  const workspace = { op: "update", m: "Workspace", id: "x", set: { name: "y" } };
  assert.match(deniedOps({ role: "member" }, [workspace])!, /member cannot change Workspace/);
  assert.equal(deniedOps({ role: "admin" }, [workspace]), null);
  assert.match(deniedOps({ role: "owner" }, [{ op: "delete", m: "Member", id: "x" }])!, /Member are not allowed/);
  assert.match(deniedOps({ role: "owner" }, [{ op: "delete", m: "constructor" }])!, /not allowed/);
  assert.match(deniedOps({ role: "owner" }, [null])!, /not allowed/);
  assert.match(deniedOps({ role: "owner", scope: "read" }, [issue])!, /read-only/);
  // Cycles are planning (PLNR-63): members create and complete them, a read token does not.
  const cycle = { op: "create", m: "Cycle", id: "x", set: {} };
  assert.equal(deniedOps({ role: "member" }, [cycle]), null);
  assert.match(deniedOps({ role: "member", scope: "read" }, [cycle])!, /read-only/);
});

const guarded = (name: string) => ({ name, onlyPeople: true });
const open = (name: string) => ({ name, onlyPeople: false });

test("agents move issues anywhere but into a state only people set, whatever it is called", () => {
  assert.match(deniedState("agent", guarded("Todo"))!, /people set this state/);
  assert.match(deniedState("agent", guarded("Ready to start"))!, /Ready to start/, "renamed, still guarded");
  assert.equal(deniedState("agent", open("Approved")), null, "the switch decides, not the name");
  assert.equal(deniedState("human", guarded("Approved")), null);
  assert.match(deniedStateUpdate("agent", guarded("Todo"))!, /default state or move it to another group/);
  assert.equal(deniedStateUpdate("agent", open("Backlog")), null);
  assert.equal(deniedStateUpdate("human", guarded("Todo")), null);
});

test("agents neither rename nor delete a guarded state or label, nor name another like one", () => {
  const names = ["Todo", "Approved"];
  const change = (before: ReturnType<typeof open> | undefined, after: ReturnType<typeof open> | undefined) => deniedGuardedChange("agent", "state", before, after, names);
  assert.match(change(guarded("Todo"), open("Ready"))!, /cannot rename or delete the state "Todo"/);
  assert.match(change(guarded("Todo"), undefined)!, /cannot rename or delete/);
  assert.equal(change(guarded("Todo"), guarded("Todo")), null, "a move or a recolor keeps the name");
  assert.match(change(undefined, open("APPROVED"))!, /reads as "Approved"/);
  assert.match(change(open("Foo"), open(" todo "))!, /reads as "Todo"/, "renaming into");
  assert.equal(change(undefined, guarded("Todo")), null, "a new guarded Todo only takes away: a new project's");
  assert.equal(change(open("Foo"), undefined), null);
  assert.equal(deniedGuardedChange("admin", "state", guarded("Todo"), undefined, names), null, "a signed-in admin deletes it");
  assert.equal(deniedGuardedChange("admin", "state", undefined, open("Todo"), names), null);
  for (const look of ["\u0410pproved", "Todo\u200b", "T o d o", "Ｔｏｄｏ", "Appróved", "T0do", "\u0422\u043edo"]) {
    assert.ok(change(undefined, open(look)), `lookalike ${JSON.stringify(look)}`);
  }
  assert.equal(change(undefined, open("To review")), null);
  assert.equal(change(undefined, open("Ревью")), null, "one script other than Latin");
  for (const look of ["\ua4d4\ua4f3\ua4d3\ua4f3", "\u0422\u043e\u0501\u043e", "Caf\u00e9"]) {
    assert.ok(change(undefined, open(look)), `outside the agents' alphabet: ${JSON.stringify(look)}`);
  }
  assert.match(change(open("Foo"), open("Аpprovеd-ish"))!, /not mixed/, "mixed scripts in a new name");
  assert.equal(change(open("🐛 bug"), undefined), null, "a delete gives no name: any old name goes");
  // Labels: the same rules, people's marks of the process.
  const label = (before: ReturnType<typeof open> | undefined, after: ReturnType<typeof open> | undefined) => deniedGuardedChange("agent", "label", before, after, ["proposed", "security", "owner"]);
  assert.match(label(undefined, open("pr\u043eposed"))!, /reads as "proposed"|not mixed/);
  assert.match(label(guarded("security"), open("sec"))!, /label "security"/);
  assert.equal(label(open("frontend"), open("web")), null);
});

test("a guard comes off only by a signed-in admin: a member or a token neither deletes, renames nor shadows a guarded row", () => {
  const names = ["Approved"];
  const person = (before: ReturnType<typeof open> | undefined, after: ReturnType<typeof open> | undefined) => deniedGuardedChange("person", "state", before, after, names);
  // Delete Approved and make a new one, or rename it away and make a new one: either would drop the guard.
  assert.match(person(guarded("Approved"), undefined)!, /only a signed-in admin can rename or delete the state "Approved"/);
  assert.match(person(guarded("Approved"), guarded("Old"))!, /only a signed-in admin can rename or delete/);
  assert.match(person(undefined, open("approved"))!, /only a signed-in admin can name a state "approved" without Only people/);
  assert.equal(person(undefined, guarded("Approved")), null, "made guarded, it only takes away");
  assert.equal(person(open("Foo"), open("Bar")), null);
  assert.equal(person(undefined, open("Café")), null, "people name freely");
});

// ── Tokens: Read or Write per resource (ADR 0037) ─────────────────────────────────────────────────────────────────

test("a custom token holds only what it was given and its member may do; never people or tokens", () => {
  for (const stored of subsets(GRANTS))
    for (const role of ROLES)
      for (const rights of RIGHTS) {
        const held = tokenGrants(stored, role, rights);
        const viewer: Viewer = { role, scope: "custom", grants: held, rights };
        for (const g of held) {
          assert.ok(stored.includes(g), `${g} not given`);
          assert.ok(can({ role, rights }, g), `${role} holds ${g} past the role`);
        }
        assert.equal(can(viewer, "members.manage"), false);
        assert.equal(can(viewer, "agents.manage"), false);
        for (const cap of GRANTS) assert.equal(can(viewer, cap), held.has(cap), cap);
        assert.equal(can(viewer, "read"), role !== "guest");
        // What may be given is exactly what may be held.
        assert.deepEqual(grantable(role, rights).filter((g) => stored.includes(g)), [...held]);
      }
});

test("a custom token's refusal names the grant it lacks, or the role's limit when the member could not either", () => {
  const agent: Viewer = { role: "member", scope: "custom", grants: tokenGrants(["issues.write", "labels.write"], "member", ["labels.write"]), rights: ["labels.write"] };
  assert.equal(deniedOps(agent, [{ op: "create", m: "Label", id: "x", set: {} }, { op: "update", m: "Issue", id: "i", set: {} }]), null);
  assert.match(deniedOps(agent, [{ op: "create", m: "Comment", id: "c", set: {} }])!, /the token lacks Comments: write/);
  assert.match(deniedOps(agent, [{ op: "create", m: "WorkflowState", id: "s", set: {} }])!, /a member cannot change WorkflowState; an admin can open States/);
  assert.match(deniedOps(agent, [{ op: "frobnicate", m: "Labels", id: "x" }])!, /not allowed/);
  assert.deepEqual([...tokenGrants(["labels.create", "members.manage", "x"], "owner", [])], [], "not grants: dropped");
});

test("a token's reach: nothing for read, the member's for write, the holding grants for custom", () => {
  assert.deepEqual([...tokenReach("read", ["issues.write"], "owner", [])], []);
  assert.deepEqual([...tokenReach("write", [], "member", [])], ["issues.write", "comments.write", "cycles.write", "views.write"]);
  assert.deepEqual([...tokenReach("write", [], "member", ["labels.write"])], ["issues.write", "comments.write", "cycles.write", "views.write", "labels.write"]);
  assert.deepEqual([...tokenReach("write", [], "admin", [])], [...GRANTS]);
  assert.deepEqual([...tokenReach("custom", ["labels.write"], "member", [])], [], "closed to members: held back");
});

test("a token's change widens when it could do anything it could not, now or once its member may more (RSVA-606)", () => {
  const read = { scope: "read", grants: [] } as const;
  const write = { scope: "write", grants: [] } as const;
  const custom = (...grants: string[]) => ({ scope: "custom", grants }) as const;
  const member = ["issues.write", "comments.write", "cycles.write", "views.write", "labels.write"];
  assert.ok(widens(read, custom("issues.write")), "read to grants");
  assert.ok(widens(read, write), "read to write");
  assert.ok(widens(custom("issues.write"), custom("issues.write", "labels.write")), "grants to more grants");
  assert.ok(widens(custom(...member), write), "grants to write, even all a member may do today: write follows the member");
  assert.ok(widens(custom(...GRANTS), write), "every grant there is to write: write also holds what is not a grant, and grants added later");
  assert.ok(!widens(write, custom(...member)), "write to grants narrows");
  assert.ok(!widens(write, read) && !widens(custom("issues.write"), read), "to read narrows");
  assert.ok(!widens(custom("issues.write", "labels.write"), custom("labels.write")), "fewer grants narrow");
  assert.ok(!widens(custom("labels.write", "issues.write"), custom("issues.write", "labels.write")), "the same grants in another order");
  assert.ok(!widens(read, read) && !widens(write, write), "the same scope");
  assert.ok(widens(custom("issues.write"), custom("comments.write")), "a swap adds one");
  assert.ok(!widens(write, custom(...GRANTS)), "write to every grant narrows");
  assert.ok(!widens(custom("issues.write"), custom("issues.write", "labels.create")), "not a grant: reaches nothing");
});

test("mayRead, mayManage and capRole take a role as stored: anything not a role reads nothing and manages nothing (RSVA-428)", () => {
  const read: Record<string, boolean> = { owner: true, admin: true, member: true, guest: false };
  const manage: Record<string, boolean> = { owner: true, admin: true, member: false, guest: false };
  for (const role of ROLES) {
    assert.equal(mayRead(role), read[role], `read ${role}`);
    assert.equal(mayManage(role), manage[role], `manage ${role}`);
    assert.equal(capRole(role, "human"), role, "a person keeps the role asked");
    assert.equal(capRole(role, "agent"), manage[role] ? "member" : role, `an agent asked ${role}`);
  }
  for (const junk of [null, undefined, "", "boss", "Owner"]) {
    assert.equal(mayRead(junk), false);
    assert.equal(mayManage(junk), false);
  }
});
