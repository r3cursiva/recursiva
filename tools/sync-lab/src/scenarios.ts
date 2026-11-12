// What may happen to a change on its way to the server, as runnable scenarios: real engines, a real server, a broken
// network. The same list runs against a local server (CI) and against production. Every scenario ends with the check
// that matters: all computers hold the same data, nothing is pending, and nothing was lost without the user being told.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { DocJSON, Issue } from "@rsva/schema/models";
import { seeded } from "@rsva/schema/util";
import { until } from "@rsva/test-kit";
import { Computer } from "./computer.ts";
import type { Target } from "./target.ts";

export interface Lab {
  target: Target;
  a: Computer;
  b: Computer;
  /** How long the engine may take to find out and tell the user; the local target runs a faster heartbeat. */
  bound: number;
  /** A number to report (detection times). */
  note(key: string, value: number): void;
}

export interface Scenario {
  id: string;
  title: string;
  /** Needs what only a local target allows: killing the server, spending a person's budget. */
  local?: boolean;
  run(lab: Lab): Promise<void>;
}

const online = (c: Computer) => c.store.connection === "online";
/** The computer knows its changes are not reaching the server. */
const told = (c: Computer) => c.store.connection !== "online";
const pendingZero = (c: Computer) => c.store.pendingCount === 0;

/** Everything on all computers has reached the server, and each holds the same log position. */
async function settled(lab: Lab, ...cs: Computer[]): Promise<void> {
  const ms = Math.max(lab.bound, 15_000) * 3;
  await until(() => cs.every((c) => online(c) && pendingZero(c)), ms, `all sent: ${cs.map((c) => `${c.name} ${c.store.connection} pending ${c.store.pendingCount}`).join(", ")}`);
  await until(() => new Set(cs.map((c) => c.store.lastSyncId)).size === 1, ms, `same position: ${cs.map((c) => c.store.lastSyncId).join(", ")}`);
}

/** Issue fields compared across computers. */
const FIELDS = ["title", "stateId", "priority", "assigneeIds", "labelIds", "parentId", "blockedByIds", "relatedIds", "duplicateOfId", "sortOrder", "archivedAt", "deletedAt", "cycleId"] as const;

/** The data of a computer, in a form two computers can be compared by. */
function fingerprint(c: Computer): string {
  const rows = [...c.store.issues.values()].map((i) => [i.id, ...FIELDS.map((k) => i[k])]);
  const labels = [...c.store.labels.values()].map((l) => [l.id, l.name]);
  const states = [...c.store.states.values()].map((s) => [s.id, s.name, s.isDefault]);
  return JSON.stringify([rows.sort(byId), labels.sort(byId), states.sort(byId)]);
}
const byId = (x: unknown[], y: unknown[]) => String(x[0]).localeCompare(String(y[0]));

function assertSame(...cs: Computer[]): void {
  const [first, ...rest] = cs;
  for (const c of rest) assert.equal(fingerprint(c), fingerprint(first!), `${c.name} and ${first!.name} differ`);
}

const projectOf = (c: Computer) => c.store.projectList()[0]!;
const stateOf = (c: Computer, group: string) => c.store.statesOf(projectOf(c).id).find((s) => s.group === group)!;

/** A new issue both computers hold. */
async function issue(lab: Lab, title = "lab issue"): Promise<Issue> {
  const { a, b } = lab;
  const made = a.store.createIssue(projectOf(a).id, { title: `${title} ${Date.now()}`, stateId: stateOf(a, "backlog").id });
  await until(() => pendingZero(a) && b.store.issues.has(made.id), lab.bound * 3, "the issue reaches both");
  return made;
}

async function goOffline({ bound }: Lab, ...cs: Computer[]): Promise<void> {
  for (const c of cs) c.disconnect();
  await until(() => cs.every(told), bound, "offline");
}

/** A new issue that A then renames to `title` while offline. */
async function editedOffline(lab: Lab, title: string): Promise<Issue> {
  const i = await issue(lab);
  await goOffline(lab, lab.a);
  lab.a.store.updateIssue(i.id, { title });
  return i;
}

/** A's change, made online, reaches the server; then B comes back with what it did offline. */
async function bReturnsAfter(lab: Lab, what: string): Promise<void> {
  await until(() => pendingZero(lab.a), lab.bound * 3, what);
  lab.b.connect();
  await settled(lab, lab.a, lab.b);
}

/** A's changes reach the server first, then B's. */
async function backInTurn(lab: Lab): Promise<void> {
  const { a, b } = lab;
  a.connect();
  await settled(lab, a);
  b.connect();
  await settled(lab, a, b);
}

const doc = (text: string): DocJSON => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) as DocJSON;
/** The words: Postgres keeps a document's keys in its own order, so two equal texts may differ as JSON. */
const docText = (c: Computer, id: string) => (JSON.stringify(c.store.description(id)?.doc ?? null).match(/"text":"[^"]*"/g) ?? []).join();

async function feedReady(lab: Lab, c: Computer, id: string) {
  // Ready is not complete: a kept copy known to be stale shows at once and reloads behind that (`behind`).
  await until(() => {
    const f = c.store.feed(id);
    return f.status === "ready" && !f.behind;
  }, lab.bound * 3, "the feed loads");
  return c.store.feed(id);
}

/** A new issue, with B's feed of it loaded. */
async function issueWithFeed(lab: Lab) {
  const i = await issue(lab);
  return { i, feed: await feedReady(lab, lab.b, i.id) };
}

export const SCENARIOS: Scenario[] = [
  // ── The connection breaks ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "net.cut",
    title: "connection reset while idle: told at once, an edit waits and arrives",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      a.disconnect();
      lab.note("toldMs", await until(() => told(a), lab.bound, "A knows it is offline"));
      a.store.updateIssue(i.id, { title: "made offline" });
      assert.equal(a.store.pendingCount, 1);
      assert.equal(b.store.issues.get(i.id)!.title === "made offline", false);
      a.connect();
      await settled(lab, a, b);
      assert.equal(b.store.issues.get(i.id)!.title, "made offline");
      assertSame(a, b);
    },
  },
  {
    id: "net.half-open-idle",
    title: "the link dies silently while idle: the computer finds out by itself",
    async run(lab) {
      const { a } = lab;
      await issue(lab);
      a.relay.stall();
      lab.note("toldMs", await until(() => told(a), lab.bound, "A notices the dead link with no edit made"));
      a.relay.heal();
      await until(() => online(a), lab.bound, "A is back");
    },
  },
  {
    id: "net.half-open-edit",
    title: "the link dies silently, then an edit: the user learns it was not saved, and it arrives after",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      a.relay.stall();
      a.store.updateIssue(i.id, { title: "into the void" });
      lab.note("toldMs", await until(() => told(a), lab.bound, "A notices the edit gets no answer"));
      assert.equal(a.store.pendingCount, 1, "the edit is kept");
      a.relay.heal();
      await settled(lab, a, b);
      assert.equal(b.store.issues.get(i.id)!.title, "into the void");
      assertSame(a, b);
    },
  },
  {
    id: "net.ack-lost",
    title: "the server applies a change and the answer is lost: the resend does not apply it twice",
    async run(lab) {
      const { a, b } = lab;
      const { i, feed } = await issueWithFeed(lab);
      a.relay.stallDown();
      const c = a.store.addComment(i.id, "exactly once");
      await until(() => feed.threads.some((t) => t.comment.id === c.id), lab.bound, "the comment reached the server");
      assert.equal(a.store.pendingCount, 1, "A has no answer yet");
      a.relay.heal();
      await settled(lab, a, b);
      assert.equal(feed.threads.filter((t) => t.comment.body === "exactly once").length, 1);
      assert.equal(a.store.lastRejection, null, "a repeat is answered as the first time, not refused");
    },
  },
  {
    id: "net.ack-lost-edit",
    title: "an edit whose answer was lost does not come back over what someone wrote after it",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      a.relay.stallDown();
      a.store.updateIssue(i.id, { title: "from A, answer lost" });
      await until(() => b.store.issues.get(i.id)!.title === "from A, answer lost", lab.bound, "the edit reached the server");
      b.store.updateIssue(i.id, { title: "from B, after it" });
      await until(() => pendingZero(b), lab.bound * 3, "B's edit is in");
      a.relay.heal();
      await settled(lab, a, b);
      assert.equal(a.store.issues.get(i.id)!.title, "from B, after it", "the resend applied nothing");
      assertSame(a, b);
    },
  },
  {
    id: "net.connect-hang",
    title: "a new connection hangs (captive portal): the engine gives up on it and connects when the way is back",
    async run(lab) {
      const { a } = lab;
      a.relay.hang();
      lab.note("toldMs", await until(() => told(a), lab.bound, "A is offline"));
      await sleep(200);
      a.relay.heal();
      lab.note("backMs", await until(() => online(a), lab.bound * 2, "A connects after the hang"));
    },
  },
  {
    id: "net.flap",
    title: "the connection drops again and again during a burst: order holds, nothing doubles",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      for (let n = 0; n < 8; n++) {
        a.store.updateIssue(i.id, { title: `burst ${n}` });
        a.store.addComment(i.id, `flap ${n}`);
        if (n % 2) a.relay.cut();
        await sleep(40);
      }
      await settled(lab, a, b);
      assert.equal(b.store.issues.get(i.id)!.title, "burst 7");
      const feed = await feedReady(lab, b, i.id);
      assert.deepEqual(feed.threads.map((t) => t.comment.body), Array.from({ length: 8 }, (_, n) => `flap ${n}`));
      assertSame(a, b);
    },
  },
  {
    id: "net.latency",
    title: "a slow link: edits arrive in order",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      a.relay.latency = 300;
      for (let n = 0; n < 5; n++) a.store.updateIssue(i.id, { title: `slow ${n}` });
      await settled(lab, a, b);
      a.relay.latency = 0;
      assert.equal(b.store.issues.get(i.id)!.title, "slow 4");
    },
  },

  // ── Offline, the tab closes ─────────────────────────────────────────────────────────────────────────────────
  {
    id: "off.reload",
    title: "edits made offline survive closing the tab, offline, and go out after",
    async run(lab) {
      const { a, b } = lab;
      const i = await editedOffline(lab, "survives a reload");
      await a.reload();
      assert.equal(a.store.status, "ready", "opens from the disk with no network");
      assert.equal(a.store.pendingCount, 1);
      assert.equal(a.store.issues.get(i.id)!.title, "survives a reload");
      a.connect();
      await settled(lab, a, b);
      assert.equal(b.store.issues.get(i.id)!.title, "survives a reload");
    },
  },
  {
    id: "off.crash",
    title: "the tab dies right after an edit: the queue on disk still has it",
    async run(lab) {
      const { a, b } = lab;
      const i = await editedOffline(lab, "survives a crash");
      await sleep(50);
      await a.crash();
      assert.equal(a.store.pendingCount, 1);
      a.connect();
      await settled(lab, a, b);
      assert.equal(b.store.issues.get(i.id)!.title, "survives a crash");
    },
  },
  {
    id: "off.chain",
    title: "offline: a new issue, an edit of it, a comment on it, a reply: all arrive, in order",
    async run(lab) {
      const { a, b } = lab;
      await issue(lab);
      await goOffline(lab, a);
      const made = a.store.createIssue(projectOf(a).id, { title: "made offline", stateId: stateOf(a, "backlog").id });
      a.store.updateIssue(made.id, { priority: 2 });
      const c = a.store.addComment(made.id, "first");
      a.store.addComment(made.id, "reply", c.id);
      a.connect();
      await settled(lab, a, b);
      assert.equal(b.store.issues.get(made.id)!.priority, 2);
      const feed = await feedReady(lab, b, made.id);
      assert.equal(feed.threads[0]!.replies[0]!.body, "reply");
      assert.ok(b.store.issues.get(made.id)!.number > 0, "the server gave it a number");
    },
  },

  // ── Two computers at once ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "two.same-field",
    title: "both change the title: the server picks one, both computers show it",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      a.store.updateIssue(i.id, { title: "from A" });
      b.store.updateIssue(i.id, { title: "from B" });
      await settled(lab, a, b);
      assertSame(a, b);
    },
  },
  {
    id: "two.other-fields",
    title: "offline, each changes another field: both changes stay",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      await goOffline(lab, a, b);
      a.store.updateIssue(i.id, { title: "title from A" });
      b.store.updateIssue(i.id, { priority: 3 });
      b.connect();
      a.connect();
      await settled(lab, a, b);
      assert.equal(a.store.issues.get(i.id)!.title, "title from A");
      assert.equal(a.store.issues.get(i.id)!.priority, 3);
      assertSame(a, b);
    },
  },
  {
    id: "two.labels",
    title: "offline, each adds a different label: both labels stay",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      const [one, two] = a.store.labelsOf(i.projectId);
      await goOffline(lab, a, b);
      a.store.updateIssue(i.id, { labelIds: [one!.id] });
      b.store.updateIssue(i.id, { labelIds: [two!.id] });
      await backInTurn(lab);
      assert.deepEqual(new Set(a.store.issues.get(i.id)!.labelIds), new Set([one!.id, two!.id]));
      assertSame(a, b);
    },
  },
  {
    id: "two.label-off",
    title: "offline, one takes a label off and the other adds another: both changes stay",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      const [one, two, three] = a.store.labelsOf(i.projectId);
      a.store.updateIssue(i.id, { labelIds: [one!.id, two!.id] });
      await settled(lab, a, b);
      await goOffline(lab, a, b);
      a.store.updateIssue(i.id, { labelIds: [two!.id] });
      b.store.updateIssue(i.id, { labelIds: [one!.id, two!.id, three!.id] });
      await backInTurn(lab);
      assert.deepEqual([...a.store.issues.get(i.id)!.labelIds].sort(), [two!.id, three!.id].sort());
    },
  },
  {
    id: "two.description",
    title: "both rewrite a description: the loser is told, nobody's text vanishes in silence",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      await Promise.all([feedReady(lab, a, i.id), feedReady(lab, b, i.id)]);
      await goOffline(lab, a, b);
      a.store.updateDescription(i.id, doc("text from A"));
      b.store.updateDescription(i.id, doc("text from B"));
      await backInTurn(lab);
      assert.equal(docText(a, i.id), docText(b, i.id), `both show one text`);
      assert.ok(a.store.lastRejection || b.store.lastRejection, "someone's text was replaced and nobody was told");
    },
  },
  {
    id: "two.delete-vs-edit",
    title: "one deletes an issue while the other comments on it offline: the comment is kept as not sent",
    async run(lab) {
      const { a, b } = lab;
      const { i, feed } = await issueWithFeed(lab);
      await goOffline(lab, b);
      b.store.addComment(i.id, "too late");
      a.store.updateIssue(i.id, { deletedAt: new Date().toISOString() });
      await bReturnsAfter(lab, "deleted");
      assert.equal(feed.notSent[0]?.body, "too late");
      assert.ok(b.store.lastRejection, "told why");
      assertSame(a, b);
    },
  },
  {
    id: "two.label-deleted",
    title: "one deletes a label while the other puts it on an issue offline: refused, reverted, both alike",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      const label = a.store.createLabel(i.projectId, `gone ${Date.now()}`, "#ff0000");
      await settled(lab, a, b);
      await goOffline(lab, b);
      b.store.updateIssue(i.id, { labelIds: [label.id] });
      a.store.deleteLabel(label.id);
      await bReturnsAfter(lab, "deleted");
      assert.ok(b.store.lastRejection, "told why");
      assert.deepEqual(b.store.issues.get(i.id)!.labelIds, []);
      assertSame(a, b);
    },
  },
  {
    id: "two.parents",
    title: "each makes the other's issue its parent: the tree stays a tree, the second is refused",
    async run(lab) {
      const { a, b } = lab;
      const x = await issue(lab, "x");
      const y = await issue(lab, "y");
      await goOffline(lab, a, b);
      a.store.updateIssue(x.id, { parentId: y.id });
      b.store.updateIssue(y.id, { parentId: x.id });
      await backInTurn(lab);
      assert.ok(b.store.lastRejection, "told why");
      assertSame(a, b);
    },
  },
  {
    id: "two.move",
    title: "both drop an issue into one place: same order on both",
    async run(lab) {
      const { a, b } = lab;
      const x = await issue(lab, "x");
      const y = await issue(lab, "y");
      a.store.updateIssue(x.id, { sortOrder: "a5" });
      b.store.updateIssue(y.id, { sortOrder: "a5" });
      await settled(lab, a, b);
      const order = (c: Computer) => c.store.issuesOf(x.projectId).map((i) => i.id);
      assert.deepEqual(order(a), order(b));
    },
  },
  {
    id: "two.tabs",
    title: "two tabs of one browser share a queue: each change is applied once",
    async run(lab) {
      const { a, b } = lab;
      const { i, feed } = await issueWithFeed(lab);
      await goOffline(lab, a);
      a.store.addComment(i.id, "from a shared queue");
      await a.store.persist();
      // A second tab opens on the same disk and goes online with the queue while the first still holds it.
      const tab = new Computer("a2", lab.target, lab.target.tokens.a);
      Object.assign(tab, { idb: a.idb });
      await tab.open();
      await until(() => online(tab) && pendingZero(tab), lab.bound * 3, "the second tab sent it");
      a.connect();
      await settled(lab, a, b);
      tab.close();
      assert.equal(feed.threads.filter((t) => t.comment.body === "from a shared queue").length, 1);
    },
  },

  {
    id: "two.other-person",
    title: "someone else signs in in this browser while a change waits offline: it is not sent in their name",
    async run(lab) {
      const { a, b } = lab;
      const i = await editedOffline(lab, "made by A offline");
      a.signedInAs(lab.target.tokens.b);
      a.connect();
      await until(() => a.store.errorCode !== null || (online(a) && pendingZero(a)), lab.bound * 3, "A stops or sends");
      assert.equal(a.store.errorCode, "unauthorized", `A sent its change as B: B sees "${b.store.issues.get(i.id)!.title}"`);
      assert.equal(a.store.pendingCount, 1, "the change waits for its own person");
      await sleep(lab.bound);
      assert.notEqual(b.store.issues.get(i.id)!.title, "made by A offline", "B's credential did not carry A's change");
    },
  },

  // ── The server refuses ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: "rej.too-big",
    title: "a change over the frame limit: told, and it does not block the changes behind it",
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      const other = await issue(lab, "other");
      await feedReady(lab, a, i.id);
      a.store.updateDescription(i.id, doc("x".repeat(1_200_000)));
      a.store.updateIssue(other.id, { title: "behind the big one" });
      await until(() => b.store.issues.get(other.id)!.title === "behind the big one", lab.bound * 2, "the edit behind the big one arrives");
      await settled(lab, a, b);
      assert.ok(a.store.lastRejection, "told why");
    },
  },
  {
    id: "rej.flood",
    title: "more than a person's write budget: everything still arrives, slower",
    local: true,
    async run(lab) {
      const { a, b } = lab;
      const i = await issue(lab);
      await goOffline(lab, a);
      // 300 comments of 60 KB: more than the 16 MiB a person may write in a minute, sent at once when the link is back.
      const bodies = Array.from({ length: 300 }, (_, n) => `${n} ` + "y".repeat(60_000));
      for (const body of bodies) a.store.addComment(i.id, body);
      a.connect();
      await until(() => pendingZero(a), 120_000, `all sent, ${a.store.pendingCount} pending`);
      await settled(lab, a, b);
      assert.equal(a.store.lastRejection, null, `nothing refused: ${a.store.lastRejection?.message}`);
      const feed = await feedReady(lab, b, i.id);
      // The answer comes in pages of about a megabyte.
      while (feed.hasOlder) {
        const loaded = feed.threads.length;
        feed.loadOlder();
        await until(() => feed.threads.length > loaded, lab.bound * 3, "an older page");
      }
      const order = feed.threads.map((t) => Number(t.comment.body.split(" ")[0]));
      assert.deepEqual(order, order.toSorted((x, y) => x - y), "in the order they were written");
      assert.equal(order.length, bodies.length);
    },
  },

  // ── The server goes away ────────────────────────────────────────────────────────────────────────────────────
  {
    id: "srv.kill",
    title: "the server is killed in a burst: every client gets back, nothing doubles or vanishes",
    local: true,
    async run(lab) {
      const { a, b, target } = lab;
      const i = await issue(lab);
      const titles = Array.from({ length: 30 }, (_, n) => `kill ${n}`);
      for (const [n, t] of titles.entries()) {
        a.store.addComment(i.id, t);
        if (n === 15) void target.restart!();
        await sleep(15);
      }
      await settled(lab, a, b);
      const feed = await feedReady(lab, b, i.id);
      assert.deepEqual(feed.threads.map((t) => t.comment.body), titles);
    },
  },
];

/** Random edits on random computers under random faults, then the network heals: whatever happened, they must converge. */
export async function fuzz(lab: Lab, seed: number, steps: number): Promise<void> {
  const next = seeded(seed);
  // A seed reproduces the run; the unit float times 2^32 is the generator's 32-bit word, exactly.
  const rand = (n: number) => (next() * 4294967296) % n;
  const { a, b } = lab;
  const computers = [a, b];
  const ids = [(await issue(lab, "f1")).id, (await issue(lab, "f2")).id, (await issue(lab, "f3")).id];
  const comments = new Set<string>();
  const labels = a.store.labelsOf(a.store.issues.get(ids[0]!)!.projectId).map((l) => l.id);
  for (let step = 0; step < steps; step++) {
    const c = computers[rand(2)]!;
    const id = ids[rand(ids.length)]!;
    switch (rand(10)) {
      case 9:
        c.store.feed(id);
        if (c.store.feed(id).status === "ready" && !c.store.feed(id).behind) c.store.updateDescription(id, doc(`d${seed}.${step}`));
        break;
      case 0:
        c.store.updateIssue(id, { title: `t${seed}.${step}` });
        break;
      case 1:
        c.store.updateIssue(id, { priority: rand(5) });
        break;
      case 2: {
        const body = `c${seed}.${step}`;
        comments.add(body);
        c.store.addComment(id, body);
        break;
      }
      case 3: {
        const have = c.store.issues.get(id)!.labelIds;
        const l = labels[rand(labels.length)]!;
        c.store.updateIssue(id, { labelIds: have.includes(l) ? have.filter((v) => v !== l) : [...have, l] });
        break;
      }
      case 4:
        c.relay.cut();
        break;
      case 5:
        c.disconnect();
        break;
      case 6:
        c.connect();
        break;
      case 7:
        c.relay.stall();
        break;
      case 8:
        await c.reload();
        break;
    }
    await sleep(rand(40));
  }
  for (const c of computers) c.connect();
  await settled(lab, a, b);
  assertSame(a, b);
  await Promise.all(computers.flatMap((c) => ids.map((id) => feedReady(lab, c, id))));
  await until(() => ids.every((id) => docText(a, id) === docText(b, id)), lab.bound * 3, "one text on both computers");
  // Nothing here is refusable: a refusal would be a change lost to the faults.
  for (const c of computers) assert.equal(c.refusal(), null, `${c.name} was refused: ${c.refusal()}`);
  // A computer that starts now, from the server alone, sees the same.
  const fresh = new Computer("fresh", lab.target, lab.target.tokens.a);
  await fresh.open();
  await until(() => fresh.store.lastSyncId >= a.store.lastSyncId, 15_000, "the fresh one is here");
  assertSame(a, fresh);
  const seen = new Map<string, number>();
  for (const id of ids) {
    const feed = fresh.store.feed(id);
    await until(() => feed.status === "ready", 15_000, "its feed");
    for (const t of feed.threads) seen.set(t.comment.body, (seen.get(t.comment.body) ?? 0) + 1);
  }
  fresh.close();
  for (const body of comments) assert.equal(seen.get(body), 1, `comment ${body} arrived ${seen.get(body) ?? 0} times`);
}
