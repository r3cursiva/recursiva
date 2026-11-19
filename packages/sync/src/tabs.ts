// The tabs of one browser share one connection per workspace (ADR 0058). One tab, the leader, holds the WebSocket: Web
// Locks pick it, and when it closes, freezes or stops answering another takes over. The others reach the server through
// it over a BroadcastChannel: to their engine the leader is a socket (RelaySocket), so reconnects, pings and the checks
// that find a dead link work as they do on a real one. The leader answers a follower's `sub` from the log it has applied
// itself, and passes on to every tab the deltas it applies and the server's answers.
//
// Every change made in a tab goes to all the others at once, offline too (RSVA-144): each shows it as pending, and the
// leader sends it. A tab that closes leaves its changes with the others, and the next leader sends them.
import type { Action, ClientFrame, HelloFrame, Op, ServerFrame } from "@rsva/protocol";
import type { SocketLike } from "./link.ts";

/** A BroadcastChannel: what one tab posts, the others with the same name receive, in the order it was posted. */
export interface ChannelLike {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

/** navigator.locks: one holder of a name at a time; `steal` takes it from a holder that does not let go. */
export interface LocksLike {
  request(name: string, options: { steal?: boolean; signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
}

export interface TabsOptions {
  channel(name: string): ChannelLike;
  locks: LocksLike;
}

/** The browser's own BroadcastChannel and Web Locks; null where either is missing (then each tab connects by itself). */
export function browserTabs(): TabsOptions | null {
  const g = globalThis as { BroadcastChannel?: new (name: string) => ChannelLike; navigator?: { locks?: LocksLike } };
  const BC = g.BroadcastChannel;
  const locks = g.navigator?.locks;
  if (!BC || !locks) return null;
  return { channel: (name) => new BC(name), locks };
}

/** A change as it travels between tabs: what the disk keeps of it (client.ts, `stored`). */
export interface QueuedTx {
  id: string;
  n: number;
  ops: Op[];
  at?: string | undefined;
  by?: string | undefined;
}

/** What the tabs read of and ask from the engine. */
export interface TabHost {
  readonly lastSyncId: number;
  /** The engine's own link has said hello. */
  readonly live: boolean;
  /** A full copy, read up to the log tail: a follower's catch-up can be answered. */
  readonly current: boolean;
  /** A frame to the server on the leader's socket. */
  toServer(f: ClientFrame): void;
  /** Another tab's change: shown here as pending; the leader sends it. */
  adopt(tx: QueuedTx, tab: string): void;
  /** Another tab replaced a change of its own that had not gone out (an offline description save). */
  replaced(old: string, tx: QueuedTx, tab: string): void;
  /** This tab's own changes not yet confirmed. */
  ownQueue(): QueuedTx[];
  /** That tab closed: its changes here are this tab's now (a refusal shows here). */
  orphaned(tab: string): void;
  /** The tab became the leader or stopped being it: the connection it has goes, and a new one opens at once. */
  reconnect(): void;
}

type Message =
  | { k: "tx"; tx: QueuedTx }
  | { k: "replace"; old: string; tx: QueuedTx }
  | { k: "queue?" }
  | { k: "queue"; to: string; txs: QueuedTx[] }
  | { k: "bye" }
  /** A follower's link opens: hello if the leader is connected, else down. */
  | { k: "hi" }
  /** Follower → leader: a frame for the server, or `sub` and `ping`, which the leader answers itself. */
  | { k: "c"; f: ClientFrame }
  /** Leader → followers: a server frame, to one tab or to all. */
  | { k: "f"; f: ServerFrame; to?: string }
  | { k: "up" }
  | { k: "down"; to?: string }
  | { k: "alive?" }
  | { k: "alive"; to: string };

type Envelope = Message & { from: string };

/** Most actions the leader keeps for followers' catch-ups; one further behind takes a snapshot instead. */
const LOG_MAX = 5000;

/** How long a leader has to answer "alive?" before a follower takes the lead from it. */
const ALIVE_MS = 1500;

export class Tabs {
  readonly id = crypto.randomUUID();
  leading = false;
  private readonly channel: ChannelLike;
  private readonly lock: string;
  /** Lets go of the lock while leading. */
  private release: (() => void) | null = null;
  /** Withdraws a request still waiting for the lock. */
  private waiting: AbortController | null = null;
  /** Which request is the current one: an older one's end must not touch the tab's role. */
  private claims = 0;
  relay: RelaySocket | null = null;
  /** The leader's hello, for followers' links. */
  private hello: HelloFrame | null = null;
  /** The actions the leader applied after number `from`, in order, for followers' catch-ups. */
  private from = 0;
  private log: Action[] = [];
  /** Followers' `sub`s waiting for the leader to be read up to the tail. */
  private subs: Array<{ to: string; s: number }> = [];
  private aliveTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private readonly o: TabsOptions;
  private readonly host: TabHost;

  constructor(o: TabsOptions, workspace: string, host: TabHost) {
    this.o = o;
    this.host = host;
    this.lock = `rsva:leader:${workspace}`;
    this.channel = o.channel(`rsva:tabs:${workspace}`);
    this.channel.onmessage = (e) => this.receive(e.data as Envelope);
  }

  start(): void {
    this.post({ k: "queue?" });
    this.claim(false);
    const d = (globalThis as { document?: { addEventListener?: (t: string, f: () => void) => void } }).document;
    d?.addEventListener?.("freeze", this.onFreeze);
    d?.addEventListener?.("resume", this.onResume);
  }

  /** A link for a follower's engine: the leader, through the channel. */
  relaySocket(): SocketLike {
    return new RelaySocket(this);
  }

  // ── Leadership ──────────────────────────────────────────────────────────────────────────────────────────────

  private claim(steal: boolean): void {
    if (this.disposed) return;
    const claim = ++this.claims;
    this.waiting?.abort();
    const waiting = steal ? null : new AbortController();
    this.waiting = waiting;
    const held = () =>
      new Promise<void>((resolve) => {
        if (this.disposed || claim !== this.claims) return resolve();
        this.waiting = null;
        this.release = resolve;
        this.lead();
      });
    // A steal takes no signal (the spec refuses the pair): it is granted at once.
    this.o.locks.request(this.lock, waiting ? { signal: waiting.signal } : { steal: true }, held).then(
      () => undefined,
      // Withdrawn, or taken by a tab that found this one silent: the latter only while this claim is the current one.
      () => {
        if (claim === this.claims && this.leading) this.follow();
      },
    );
  }

  private lead(): void {
    this.leading = true;
    this.from = this.host.lastSyncId;
    this.log = [];
    this.host.reconnect();
    // Changes a tab made while there was no leader, or before this one listened: they go out from here.
    this.post({ k: "queue?" });
  }

  /** The lock is gone (taken, or let go on freeze): a follower again, waiting for its turn. */
  private follow(): void {
    this.leading = false;
    this.release = null;
    this.hello = null;
    this.subs = [];
    this.post({ k: "down" });
    this.host.reconnect();
    this.claim(false);
  }

  /** A link to the leader closed without the leader saying so: ask whether it is there, and take over if it is not. */
  checkLeader(): void {
    if (this.disposed || this.leading || this.aliveTimer) return;
    this.post({ k: "alive?" });
    this.aliveTimer = setTimeout(() => {
      this.aliveTimer = undefined;
      if (!this.disposed && !this.leading) this.claim(true);
    }, ALIVE_MS);
  }

  /** A frozen tab runs nothing: it lets the others lead, and asks for its turn again when it resumes. */
  private readonly onFreeze = () => {
    if (!this.leading) return;
    this.leading = false;
    this.claims++;
    this.release?.();
    this.release = null;
  };

  private readonly onResume = () => {
    if (this.disposed || this.leading) return;
    this.host.reconnect();
    this.claim(false);
  };

  dispose(): void {
    if (this.disposed) return;
    this.post({ k: "bye" });
    if (this.leading) this.post({ k: "down" });
    this.disposed = true;
    this.leading = false;
    this.release?.();
    this.waiting?.abort();
    clearTimeout(this.aliveTimer);
    this.relay = null;
    const d = (globalThis as { document?: { removeEventListener?: (t: string, f: () => void) => void } }).document;
    d?.removeEventListener?.("freeze", this.onFreeze);
    d?.removeEventListener?.("resume", this.onResume);
    this.channel.close();
  }

  // ── What the engine reports ─────────────────────────────────────────────────────────────────────────────────

  /** A change made in this tab: every other tab shows it. */
  made(tx: QueuedTx): void {
    this.post({ k: "tx", tx });
  }

  /** A change of this tab replaced by a newer one before it went out. */
  replace(old: string, tx: QueuedTx): void {
    this.post({ k: "replace", old, tx });
  }

  /** The engine holds a full copy at `s`: the log for catch-ups starts there. */
  based(s: number): void {
    this.from = s;
    this.log = [];
  }

  /** Actions the engine applied, in order: the leader keeps them and passes them on. */
  applied(actions: readonly Action[]): void {
    if (!this.leading || !actions.length) return;
    for (const a of actions) this.log.push(a);
    if (this.log.length > LOG_MAX) {
      const cut = this.log.length - LOG_MAX;
      this.from = this.log[cut - 1]!.id;
      this.log = this.log.slice(cut);
    }
    this.post({ k: "f", f: { t: "d", a: actions as Action[] } });
  }

  /** The leader is read up to the tail: followers' catch-ups waiting for it are answered. */
  current(): void {
    if (!this.leading) return;
    const subs = this.subs;
    this.subs = [];
    for (const { to, s } of subs) this.serve(to, s);
  }

  /** A frame the leader's socket received. What concerns every tab goes to them. */
  fromServer(f: ServerFrame): void {
    if (!this.leading) return;
    if (f.t === "hello") {
      this.hello = f;
      this.post({ k: "up" });
    } else if (f.t === "ack" || f.t === "rej" || f.t === "inbox" || f.t === "marks" || f.t === "views") this.post({ k: "f", f });
  }

  /** The leader's socket is gone: followers' links go too, and come back with its next hello. */
  linkDown(): void {
    if (!this.leading) return;
    this.hello = null;
    this.subs = [];
    this.post({ k: "down" });
  }

  // ── Messages ────────────────────────────────────────────────────────────────────────────────────────────────

  post(m: Message): void {
    if (this.disposed) return;
    try {
      this.channel.postMessage({ ...m, from: this.id });
    } catch {
      // A closed channel (the page is going): nothing to tell.
    }
  }

  private receive(m: Envelope): void {
    if (this.disposed || ("to" in m && m.to !== undefined && m.to !== this.id)) return;
    switch (m.k) {
      case "tx":
        return this.host.adopt(m.tx, m.from);
      case "replace":
        return this.host.replaced(m.old, m.tx, m.from);
      case "queue?": {
        const txs = this.host.ownQueue();
        if (txs.length) this.post({ k: "queue", to: m.from, txs });
        return;
      }
      case "queue":
        for (const tx of m.txs) this.host.adopt(tx, m.from);
        return;
      case "bye":
        return this.host.orphaned(m.from);
      case "hi":
        if (!this.leading) return;
        if (this.host.live && this.hello) this.post({ k: "f", to: m.from, f: this.hello });
        else this.post({ k: "down", to: m.from });
        return;
      case "c":
        return this.leading ? this.fromFollower(m.from, m.f) : undefined;
      case "f":
        if (!this.leading) this.relay?.deliver(m.f, m.to === this.id);
        return;
      case "up":
        // A follower without a link (the leader had none) connects now instead of waiting out its backoff.
        if (!this.leading && !this.relay) this.host.reconnect();
        return;
      case "down":
        if (!this.leading) this.relay?.leaderDown();
        return;
      case "alive?":
        if (this.leading) this.post({ k: "alive", to: m.from });
        return;
      case "alive":
        clearTimeout(this.aliveTimer);
        this.aliveTimer = undefined;
        return;
    }
  }

  private fromFollower(from: string, f: ClientFrame): void {
    if (f.t === "sub") return this.serve(from, f.s);
    if (f.t === "ping") return this.post({ k: "f", to: from, f: { t: "pong", s: this.host.lastSyncId } });
    // Changes come by `tx` messages, which every tab gets; a follower sends none on its link.
    if (f.t !== "tx") this.host.toServer(f);
  }

  /**
   * A follower's subscription from number `s`: the actions after it from the leader's log, then caught-up; once the
   * leader is read up to the tail. One behind the log's start takes a snapshot.
   */
  private serve(to: string, s: number): void {
    if (!this.host.current) {
      this.subs.push({ to, s });
      return;
    }
    if (s < this.from) return this.post({ k: "f", to, f: { t: "resync" } });
    const missed = this.log.filter((a) => a.id > s);
    if (missed.length) this.post({ k: "f", to, f: { t: "d", a: missed } });
    this.post({ k: "f", to, f: { t: "caught-up" } });
  }
}

/**
 * A follower's link: the leader through the channel. It opens with "hi" and is live from the leader's hello; it closes
 * when the leader says it has no connection, or when the engine gives up on it (no hello, no pong, the system offline),
 * and then the tabs check whether the leader is there at all.
 */
class RelaySocket implements SocketLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code?: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private open = false;
  private closed = false;

  private readonly tabs: Tabs;

  constructor(tabs: Tabs) {
    this.tabs = tabs;
    tabs.relay = this;
    tabs.post({ k: "hi" });
  }

  send(data: string): void {
    if (!this.closed) this.tabs.post({ k: "c", f: JSON.parse(data) as ClientFrame });
  }

  deliver(f: ServerFrame, toMe: boolean): void {
    if (this.closed) return;
    if (f.t === "hello") {
      if (!toMe) return;
      this.open = true;
    } else if (!this.open) return;
    this.onmessage?.({ data: JSON.stringify(f) });
  }

  /** The leader has no connection: this link closes as a socket would, and comes back with the leader's "up". */
  leaderDown(): void {
    if (this.end()) this.onclose?.({});
  }

  close(): void {
    if (!this.end()) return;
    this.tabs.checkLeader();
    queueMicrotask(() => this.onclose?.({}));
  }

  private end(): boolean {
    if (this.closed) return false;
    this.closed = true;
    if (this.tabs.relay === this) this.tabs.relay = null;
    return true;
  }
}
