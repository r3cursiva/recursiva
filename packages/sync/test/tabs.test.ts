// Tabs of one browser (tabs.ts): one connection for all, and a change in one shows in the others at once (RSVA-144).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action } from "@rsva/protocol";
import { IDBFactory } from "fake-indexeddb";
import type { ChannelLike, LocksLike, TabsOptions } from "../src/tabs.ts";
import { harness, ISSUE, until, type Harness } from "./fake.ts";

const [A, B] = ISSUE;
const U = (id: number, mid: string, d: Record<string, unknown>): Action => ({ id, m: "Issue", mid, a: "U", d });

/** Web Locks as the spec has them for one exclusive name: a queue, `signal` withdraws a waiter, `steal` breaks the holder. */
class Locks implements LocksLike {
  private readonly held = new Map<string, object>();
  private readonly queue = new Map<string, Array<() => void>>();
  /** How to break each holder's request: a steal rejects it. */
  private readonly breakers = new Map<object, () => void>();
  request(name: string, options: { steal?: boolean; signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        const token = {};
        this.held.set(name, token);
        this.breakers.set(token, () => reject(new DOMException("stolen", "AbortError")));
        void callback().then(() => {
          this.breakers.delete(token);
          if (this.held.get(name) !== token) return;
          this.held.delete(name);
          this.queue.get(name)?.shift()?.();
          resolve(undefined);
        });
      };
      if (options.steal) {
        const was = this.held.get(name);
        if (was) this.breakers.get(was)?.();
        return grant();
      }
      if (!this.held.has(name)) return grant();
      const q = this.queue.get(name) ?? [];
      this.queue.set(name, q);
      q.push(grant);
      options.signal?.addEventListener("abort", () => {
        const i = q.indexOf(grant);
        if (i < 0) return;
        q.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
}

/** BroadcastChannel and Web Locks of one browser, in memory. A muted tab neither hears nor is heard: a frozen page. */
class Browser {
  readonly locks = new Locks();
  /** Channels in the order tabs opened them: one per tab here, as the tests open one workspace. */
  readonly opened: ChannelLike[] = [];
  private readonly muted = new Set<ChannelLike>();
  private readonly channels = new Map<string, Set<ChannelLike>>();
  options(): TabsOptions {
    return { locks: this.locks, channel: (name) => this.open(name) };
  }
  mute(tab: number): void {
    this.muted.add(this.opened[tab]!);
  }
  private open(name: string): ChannelLike {
    const all = this.channels.get(name) ?? new Set<ChannelLike>();
    this.channels.set(name, all);
    const muted = this.muted;
    const ch: ChannelLike = {
      onmessage: null,
      postMessage(m: unknown) {
        if (muted.has(ch)) return;
        for (const other of all) if (other !== ch) setTimeout(() => muted.has(other) || other.onmessage?.({ data: structuredClone(m) }), 0);
      },
      close: () => all.delete(ch),
    };
    all.add(ch);
    this.opened.push(ch);
    return ch;
  }
}

/** A tab started in this browser on this disk. */
async function tab(browser: Browser, idb: IDBFactory, opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness({ idb, tabs: browser.options(), ...opts });
  await h.store.start();
  return h;
}

/** The first tab: it leads, its socket says hello and the server has caught it up. */
async function leader(browser: Browser, idb: IDBFactory): Promise<Harness> {
  const h = await tab(browser, idb);
  await until(() => h.sockets.length > 0, "the leader's socket");
  h.socket().hello();
  await until(() => h.socket().frames("sub").length > 0, "sub");
  h.socket().push({ t: "caught-up" });
  return h;
}

/** A second tab, online through the leader. */
async function follower(browser: Browser, idb: IDBFactory, opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await tab(browser, idb, opts);
  await until(() => h.store.connection === "online", "the follower online through the leader");
  return h;
}

test("tabs share one connection: a follower's change shows in the leader, goes out on its socket and settles in both", async () => {
  const browser = new Browser();
  const idb = new IDBFactory();
  const a = await leader(browser, idb);
  const b = await follower(browser, idb);
  assert.equal(b.sockets.length, 0, "the follower opens no socket");
  b.store.updateIssue(A, { title: "from B" });
  await until(() => a.store.issues.get(A)?.title === "from B", "the leader shows it");
  await until(() => a.socket().frames("tx").length === 1, "the leader sends it");
  const sent = a.socket().frames("tx")[0]!;
  a.socket().push({ t: "ack", id: sent.id, s: 11 });
  a.socket().push({ t: "d", a: [U(11, A, { title: "from B" })] });
  await until(() => a.store.pendingCount === 0 && b.store.pendingCount === 0, "settled in both");
  assert.equal(b.store.lastSyncId, 11);
  // And someone else's change reaches the follower by the leader.
  a.socket().push({ t: "d", a: [U(12, B, { title: "someone's" })] });
  await until(() => b.store.issues.get(B)?.title === "someone's", "a delta reaches the follower");
  a.store.dispose();
  b.store.dispose();
});

test("offline, a change in one tab shows in the other at once, and goes out when the connection is back (RSVA-144)", async () => {
  const browser = new Browser();
  const idb = new IDBFactory();
  const a = await leader(browser, idb);
  const b = await follower(browser, idb);
  const first = a.socket();
  first.closeBy(1006);
  await until(() => b.store.connection !== "online", "the follower learns the connection is gone");
  b.store.updateIssue(A, { title: "typed offline in B" });
  await until(() => a.store.issues.get(A)?.title === "typed offline in B", "the other tab shows it offline");
  assert.equal(first.frames("tx").length, 0);
  await until(() => a.socket() !== first, "the leader reconnects");
  a.socket().hello();
  await until(() => a.socket().frames("tx").length === 1, "the change goes out on the new socket");
  a.store.dispose();
  b.store.dispose();
});

test("a tab behind the leader catches up from the leader's log, not from the server", async () => {
  const browser = new Browser();
  const a = await leader(browser, new IDBFactory());
  a.socket().push({ t: "d", a: [U(11, A, { title: "eleven" }), U(12, B, { title: "twelve" })] });
  await until(() => a.store.lastSyncId === 12, "the leader applied 11 and 12");
  // Its own disk: its copy is the server's snapshot at 10.
  const b = await follower(browser, new IDBFactory());
  await until(() => b.store.lastSyncId === 12, "caught up to 12");
  assert.equal(b.store.issues.get(B)?.title, "twelve");
  assert.equal(a.socket().frames("sub").length, 1, "the leader asked the server nothing for it");
  a.store.dispose();
  b.store.dispose();
});

test("the leader's tab closes: another tab takes the lead, connects, and sends what the closed tab left", async () => {
  const browser = new Browser();
  const idb = new IDBFactory();
  const a = await leader(browser, idb);
  const b = await follower(browser, idb);
  a.socket().closeBy(1006);
  a.store.updateIssue(A, { title: "left by A" });
  await until(() => b.store.issues.get(A)?.title === "left by A", "the other tab has it");
  a.store.dispose();
  await until(() => b.sockets.length > 0, "the follower opens a socket of its own");
  b.socket().hello();
  await until(() => b.socket().frames("tx").length === 1, "and sends the closed tab's change");
  assert.equal(b.socket().frames("tx")[0]!.ops[0]!.id, A);
  b.store.dispose();
});

test("a leader that stops answering (a frozen page) loses the lead to a tab that needs it", async () => {
  const browser = new Browser();
  const idb = new IDBFactory();
  const a = await leader(browser, idb);
  const link = { every: 20, pong: 30, ack: 30, connect: 60, stall: 5000, stable: 1000 };
  const b = await follower(browser, idb, { link });
  browser.mute(0);
  await until(() => b.sockets.length > 0, "the follower takes the lead and connects");
  b.store.dispose();
  a.store.dispose();
});

test("a refusal shows in the tab that made the change; the others only take it back", async () => {
  const browser = new Browser();
  const idb = new IDBFactory();
  const a = await leader(browser, idb);
  const b = await follower(browser, idb);
  b.store.updateIssue(A, { title: "refused" });
  await until(() => a.socket().frames("tx").length === 1, "sent by the leader");
  a.socket().push({ t: "rej", id: a.socket().frames("tx")[0]!.id, code: "invalid", msg: "no" });
  await until(() => b.store.lastRejection !== null, "the tab that made it is told");
  assert.equal(a.store.lastRejection, null);
  assert.equal(a.store.issues.get(A)?.title, "First");
  assert.equal(b.store.issues.get(A)?.title, "First");
  a.store.dispose();
  b.store.dispose();
});
