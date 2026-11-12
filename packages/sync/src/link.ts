// The engine's connection to the server: one WebSocket at a time, reconnected with backoff, and checked for a link that
// went dead without a word (pings, a deadline for `hello`, patience while a big frame is on its way). It knows nothing of
// the log or the queue: frames go to the engine, and the engine says when the server has said hello.
import { parseServerFrame, type ClientFrame, type ServerFrame } from "@rsva/protocol";
import { makeObservable, observableRef, runInAction } from "mobx";
import { now, warn } from "./log.ts";
import type { ConnectionStatus, LinkHealth } from "./store.ts";

/** The part of WebSocket the engine uses: the browser's, Node's global one and `ws` all fit. */
export interface SocketLike {
  // `any`: the browser types the event as MessageEvent with a `this` binding; the engine only reads `data`.
  onmessage: ((e: any) => void) | null;
  onclose: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  /** Bytes queued and not sent yet: going down, a slow link is still a link. */
  bufferedAmount?: number;
  send(data: string): void;
  close(): void;
}

/** The times of the checks that find a link dead. A test runs them shorter. */
export interface LinkTimes {
  /** Between pings of a quiet connection. */
  every: number;
  /** A ping with no answer in this long: the link is dead. */
  pong: number;
  /** A sent change with no answer in this long: ping at once instead of waiting for `every`. */
  ack: number;
  /** A new socket with no hello in this long is given up on: a captive portal or a dead proxy holds it open for minutes. */
  connect: number;
  /** A change that has not been confirmed in this long is reported as stalled, whatever the connection says. */
  stall: number;
  /** A connection that lived this long was a good one: the reconnect backoff starts over. */
  stable: number;
}

/**
 * Considered (2026-11-01): the server pinging every socket and the client timing out on silence needs no client frame, but
 * a client can only wait: a laptop waking up would sit up to the whole timeout on a dead socket. Asking lets it check the
 * moment it matters, on wake and right after sending a change. 20 s of quiet costs 3 small frames a minute per tab.
 */
const DEFAULT_LINK: LinkTimes = { every: 20_000, pong: 8000, ack: 3000, connect: 10_000, stall: 8000, stable: 10_000 };

/** How many `pong` times a catch-up may take: it is one frame of up to 4 MB, and on a slow link the answer comes after it. */
const CATCH_UP_PATIENCE = 5;

type Health = Omit<LinkHealth, "behind"> & { tail: number | null };

/** What the link reads of the engine. */
export interface LinkHost {
  readonly disposed: boolean;
  /** The log is read up to now: silence is not a catch-up still coming down. */
  readonly caughtUp: boolean;
  setConnection(c: ConnectionStatus): void;
  /** A frame from the server on the current socket. */
  onFrame(f: ServerFrame): void;
  /** The server closed the socket with this code. True: the engine has stopped, so no reconnect. */
  closedBy(code: number | undefined, wasLive: boolean): boolean;
  /** The socket is gone, whichever way: what the engine tracks per connection goes with it. */
  down(): void;
}

export class Link {
  /** `hello` arrived on the current socket. */
  live = false;
  /**
   * What the engine's `link` reads. `tail` is the log tail the last pong named: still not reached at the next pong, the
   * deltas are not coming by themselves. One replaced object: it changes on pings and acks, and nothing observes it with
   * the panel closed.
   */
  health: Health = { pingMs: null, saveMs: null, tail: null, drops: 0, lostAt: null };
  readonly times: LinkTimes;
  private socket: SocketLike | null = null;
  /** Sockets opened so far: a hello on any but the first is a reconnect. */
  private sockets = 0;
  private retry = 0;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** What was still unsent at the last look, and how many waits for a pong have passed. */
  private buffered = 0;
  private waits = 0;
  /** When hello arrived on this socket: how long a connection lived decides whether the backoff starts over. */
  private liveSince = 0;
  /** When the ping now unanswered went out. Any frame ends the wait for it, so a second one can go before its pong. */
  private pingAt: number | null = null;
  private readonly url: string;
  private readonly WS: (new (url: string) => SocketLike) | undefined;
  private readonly backoff: readonly [number, number];
  private readonly host: LinkHost;

  constructor(url: string, WS: (new (url: string) => SocketLike) | undefined, times: Partial<LinkTimes> | undefined, backoff: readonly [number, number], host: LinkHost) {
    this.url = url;
    this.WS = WS;
    this.times = { ...DEFAULT_LINK, ...times };
    this.backoff = backoff;
    this.host = host;
    makeObservable(this, { health: observableRef });
  }

  connect(): void {
    if (this.host.disposed || !this.WS) return;
    this.host.setConnection("connecting");
    const ws = new this.WS(this.url);
    this.socket = ws;
    this.sockets++;
    this.live = false;
    this.helloTimer = setTimeout(() => this.lost(), this.times.connect);
    ws.onmessage = (e: { data: unknown }) => {
      const f = parseServerFrame(String(e.data));
      if (!f || this.socket !== ws) return;
      // Anything from the server says the link works.
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      this.host.onFrame(f);
    };
    ws.onerror = () => {}; // a close event follows; `ws` in Node throws on an unhandled error event
    ws.onclose = (e: { code?: number }) => {
      if (this.socket !== ws) return;
      const wasLive = this.live;
      this.dropped();
      if (!this.host.closedBy(e?.code, wasLive)) this.scheduleReconnect();
    };
  }

  /** The server said hello on this socket: the link is live, and pinged while quiet. True on a reconnect. */
  up(): boolean {
    this.live = true;
    this.liveSince = Date.now();
    clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    clearInterval(this.pinger); // a repeated `hello` must not leave a timer running that nothing can stop
    this.pinger = setInterval(() => this.probe(), this.times.every);
    this.host.setConnection("online");
    return this.sockets > 1;
  }

  send(f: ClientFrame): void {
    try {
      this.socket?.send(JSON.stringify(f));
    } catch (e) {
      warn(e); // closing socket: the close handler reconnects and subscribe() resends
    }
  }

  /** The socket is gone, whichever way we learned it. */
  private dropped(): void {
    if (this.live && Date.now() - this.liveSince >= this.times.stable) this.retry = 0;
    if (this.live) this.note({ drops: this.health.drops + 1, lostAt: new Date().toISOString() });
    this.note({ pingMs: null, tail: null });
    this.pingAt = null;
    this.socket = null;
    this.live = false;
    this.buffered = this.waits = 0;
    clearInterval(this.pinger);
    clearTimeout(this.pongTimer);
    clearTimeout(this.helloTimer);
    this.pinger = this.pongTimer = this.helloTimer = undefined;
    this.host.down();
    this.host.setConnection("offline");
  }

  /** For good: no reconnect is waiting, and the socket closes (stop, dispose). */
  close(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.socket;
    this.dropped();
    ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.host.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.delay());
  }

  /**
   * The link gave no answer. The socket is left, not closed and waited for: a close handshake over a dead link can take a
   * minute, and that minute is spent here looking online.
   */
  lost(): void {
    const ws = this.socket;
    if (!ws) return;
    ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch (e) {
      warn(e);
    }
    this.dropped();
    this.scheduleReconnect();
  }

  /** Exponential backoff with jitter, which spreads reconnects after a server restart. */
  delay(): number {
    const [min, max] = this.backoff;
    return Math.min(max, min * 2 ** this.retry++) * (0.5 + Math.random() / 2);
  }

  /** Asks the server whether this link works; silence past `pong` is the answer. */
  probe(): void {
    if (!this.live || this.pongTimer) return;
    this.pingAt ??= now();
    this.send({ t: "ping" });
    this.waits = 0;
    this.buffered = this.socket?.bufferedAmount ?? 0;
    this.pongTimer = setTimeout(() => this.noPong(), this.times.pong);
  }

  /**
   * Silence, but silence is not yet a dead link. A big frame on a slow link holds the ping behind it, going up (the unsent
   * bytes get fewer) and coming down (a catch-up is one frame, and nothing shows until it is whole); cut off at each timeout,
   * such a link would start over for ever. Anything that arrives ends the wait: see the socket's onmessage.
   */
  private noPong(): void {
    const left = this.socket?.bufferedAmount ?? 0;
    const moving = left > 0 && left < this.buffered;
    this.buffered = left;
    if (moving || (!this.host.caughtUp && ++this.waits < CATCH_UP_PATIENCE)) this.pongTimer = setTimeout(() => this.noPong(), this.times.pong);
    else this.lost();
  }

  /** The pong to the ping in flight: the round trip is measured. */
  pong(): void {
    if (this.pingAt !== null) this.note({ pingMs: Math.round(now() - this.pingAt) });
    this.pingAt = null;
  }

  note(change: Partial<Health>): void {
    runInAction(() => (this.health = { ...this.health, ...change }));
  }

  /**
   * The network is back, the tab came to the front or the laptop woke up. Waiting to reconnect: don't wait out the backoff.
   * Connected: timers did not run while asleep and the socket may be long dead, so check it now.
   */
  wake(): void {
    if ((globalThis as { document?: { hidden?: boolean } }).document?.hidden) return;
    if (this.live) return this.probe();
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.retry = 0;
    this.connect();
  }
}
