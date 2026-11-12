// WebSocket: subscription to the workspace log and incoming transactions, as the actor the upgrade authenticated.
import { can, refusal, type Viewer } from "@rsva/policy";
import { CLOSE_FORBIDDEN, CLOSE_NOT_FOUND, CLOSE_TRY_AGAIN, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION, type ClientFrame, type RejectFrame, type ServerFrame } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import { accessBySlug, type Access } from "../auth/access.ts";
import type { Actor } from "../auth/actor.ts";
import { perToken } from "../auth/tokens.ts";
import { db, schema } from "../db.ts";
import { prime, sendEach, sendFrame, sendToUser, sentUpTo, subscribe, type Subscriber } from "./hub.ts";
import { INBOX_COST, MarkError, MARKS_MAX, marksSince, readInbox, writeMarks } from "./inbox.ts";
import { reads, takeWrite, writeRetryAfter } from "./limits.ts";
import { isServerTime, logSizes, readLog } from "./log.ts";
import { onMembershipChange } from "./membership.ts";
import { transient } from "./retry.ts";
import { readViews, viewFrameFor, viewsSince, ViewError, writeView } from "./views.ts";
import { submitTx } from "./submit.ts";

const { workspace, session, apiToken } = schema;
/** Beyond this many missed actions a new snapshot is cheaper than deltas. */
const CATCH_UP_LIMIT = 5000;
/**
 * Nor beyond this many bytes of them: the answer is built in memory, and 5,000 actions of big comments were 300 MB.
 * An ordinary day's catch-up is tens of KB (5,000 typical actions are about 1.5 MB); past the cap the client takes a
 * snapshot (resync), which is cached and compressed, and subscribes again from its number.
 */
const CATCH_UP_BYTES = 4 * 2 ** 20;
/** An idle socket re-checks its session and role this often; one that writes, on every transaction. */
const RECHECK_MS = 5 * 60_000;
/** setTimeout's longest delay; a later expiry re-arms the timer. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * The server's own check of a socket: a protocol ping, which a browser answers by itself even in a frozen tab. A client that
 * vanished without closing (a laptop shut, a phone out of range) would otherwise hold its buffers and subscription for as
 * long as TCP takes to give up.
 */
const LIVENESS_MS = 45_000;
/**
 * What a `views` answer or an `inbox` one since a time is reserved from the reader's budget before its query, and what it
 * costs at least, an empty one too: then the queries are the cost. A client asks once of each on every subscribe; a flood
 * is held to 1,024 a minute (limits.ts READ_BYTES_PER_MINUTE), and a bigger answer costs its size (RSVA-607).
 */
const ANSWER_RESERVE = INBOX_COST;
const ANSWER_MIN = 64 * 2 ** 10;
/** A rate-limited client is told to wait at least this long: `rate_limited` from a token's limit gives no time of its own. */
const MIN_WAIT_MS = 1000;
/** How long past its wait a refused transaction has to come again before the connection takes anything else. */
const BLOCK_GRACE_MS = 5000;

/** Open sockets by the session or token that opened them: signing out or revoking closes them. */
const byCredential = new Map<string, Set<WebSocket>>();

/** Subscribed sockets by workspace and user: someone removed from a workspace stops getting its deltas at once. */
const bySubscriber = new Map<string, Set<WebSocket>>();
const subscriberKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;

onMembershipChange((workspaceId, userId, role) => {
  if (role !== null) return; // a new role reaches the socket on its next transaction: the role cache was dropped
  for (const ws of bySubscriber.get(subscriberKey(workspaceId, userId)) ?? []) ws.close(CLOSE_FORBIDDEN, "no longer a member");
});

/** Closes every socket opened with a session or token that just ended; their clients see the sign-in screen. */
export function closeSockets(credentialId: string): void {
  for (const ws of byCredential.get(credentialId) ?? []) ws.close(CLOSE_UNAUTHORIZED, "signed out");
  byCredential.delete(credentialId);
}

/**
 * `recheck` authenticates the upgrade request again (sessions.ts and tokens.ts cache it, so it is cheap): a session that
 * ended, a revoked token or a changed role reach an open socket on its next transaction or within RECHECK_MS.
 */
export function handleSocket(ws: WebSocket, actor: Actor, recheck: () => Promise<Actor | null>, livenessMs = LIVENESS_MS): void {
  const send = (f: ServerFrame) => sendFrame(ws, JSON.stringify(f));
  let ctx: { slug: string; workspaceId: string; viewer: Viewer; unsubscribe: () => void } | null = null;
  let mine = byCredential.get(actor.credentialId);
  if (!mine) byCredential.set(actor.credentialId, (mine = new Set()));
  mine.add(ws);
  send({ t: "hello", v: PROTOCOL_VERSION, u: actor.userId });

  /** The session or token behind this socket now, or null after closing it. */
  async function stillSignedIn(): Promise<Actor | null> {
    const now = await recheck();
    if (now?.userId === actor.userId) return now;
    ws.close(CLOSE_UNAUTHORIZED, "signed out");
    return null;
  }

  /** The subscription's access now, or null after closing the socket. */
  async function stillAllowed(): Promise<Access | null> {
    const now = await stillSignedIn();
    if (!now || !ctx) return null;
    const w = await accessBySlug(now, ctx.slug);
    if ("status" in w) {
      ws.close(w.status === 404 ? CLOSE_NOT_FOUND : CLOSE_FORBIDDEN, w.error);
      return null;
    }
    ctx.viewer = w.viewer;
    return w;
  }

  // Frames of one connection are handled strictly in order: a tx sent right after sub must see the subscription.
  let queue = Promise.resolve();
  // A socket that never subscribed too: it must not wait out its session's end and read afterwards.
  const timer = setInterval(() => {
    queue = queue.then(() => void stillAllowed()).catch(() => {});
  }, RECHECK_MS).unref();
  // The session or token ends at its expiry, not up to RECHECK_MS later: a timer to that moment re-checks it.
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const arm = (at: number | null) => {
    if (at === null || ws.readyState >= ws.CLOSING) return;
    expiry = setTimeout(() => {
      if (Date.now() < at) return arm(at);
      queue = queue
        .then(async () => {
          if (!(await recheck())) ws.close(CLOSE_UNAUTHORIZED, "signed out");
        })
        .catch(() => {});
    }, Math.min(Math.max(at - Date.now(), 0) + 10, MAX_TIMER_MS)).unref();
  };
  expiresAt(actor).then(arm, (e: unknown) => console.error("socket: reading the credential's expiry failed", e));
  let alive = true;
  ws.on("pong", () => (alive = true));
  const liveness = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, livenessMs).unref();

  // A ping goes around the queue, and around the database: it asks whether the connection works, and neither a long
  // transaction nor a stuck pool says anything about that. An answer held up by them would read as a dead link, to every
  // client at once.
  function pong(): void {
    const s = ctx && sentUpTo(ctx.workspaceId);
    send(s === undefined || s === null ? { t: "pong" } : { t: "pong", s });
  }

  ws.on("message", (raw) => {
    alive = true;
    if (isPing(raw)) return pong();
    queue = queue.then(() => onFrame(raw)).catch((e: unknown) => {
      ws.close(1011, "internal error");
      console.error(e);
    });
  });

  // After a refused transaction nothing else is taken until that one comes again: the client sends everything unconfirmed
  // in order, so a transaction behind it would otherwise pass it as the budget refills and be run over. Only for so long: a
  // client that does not send it again (it reloaded, or it was a repeat of a confirmed one) must not be stuck for good.
  let blocked: { id: string; until: number } | null = null;
  function hold(id: string, msg: string, waitMs = MIN_WAIT_MS): void {
    send({ t: "rej", id, code: "rate_limited", msg, wait: Math.ceil(Math.max(waitMs, MIN_WAIT_MS)) } satisfies RejectFrame);
  }
  function holdTx(id: string, msg: string, waitMs = MIN_WAIT_MS): void {
    blocked ??= { id, until: Date.now() + waitMs + BLOCK_GRACE_MS };
    hold(id, msg, waitMs);
  }
  /** Time left of a block this transaction falls under, or 0 when it may pass. */
  function blockedFor(id: string): number {
    if (blocked && (blocked.id === id || Date.now() >= blocked.until)) blocked = null;
    return blocked ? Math.max(blocked.until - BLOCK_GRACE_MS - Date.now(), 0) : 0;
  }

  /** Sends a read's answer, if any, charged to the reader's budget: ANSWER_RESERVE before the query, its size after. */
  async function answer(id: "views" | "inbox", read: () => Promise<ServerFrame | null>): Promise<void> {
    if (!reads.take(actor.userId, ANSWER_RESERVE)) return hold(id, "too many requests", reads.retryAfter(actor.userId, ANSWER_RESERVE) * 1000);
    let cost = ANSWER_RESERVE;
    try {
      const f = await read();
      const text = f ? JSON.stringify(f) : "";
      cost = Math.max(text.length, ANSWER_MIN);
      if (text) sendFrame(ws, text);
    } finally {
      reads.refund(actor.userId, ANSWER_RESERVE - cost);
    }
  }

  /** Subscribes this socket to a workspace and sends what it missed; the bytes of log it read for that. */
  async function subscribeTo(f: Extract<ClientFrame, { t: "sub" }>): Promise<number> {
    const w = await accessBySlug(actor, f.ws);
    if ("status" in w) {
      ws.close(w.status === 404 ? CLOSE_NOT_FOUND : CLOSE_FORBIDDEN, w.status === 404 ? "no workspace" : w.error);
      return 0;
    }
    ctx?.unsubscribe();
    // Subscribe with a buffer first, then read what was missed: nothing falls in between.
    const sub: Subscriber = { ws, userId: actor.userId, buffer: [] };
    const key = subscriberKey(w.workspaceId, actor.userId);
    let same = bySubscriber.get(key);
    if (!same) bySubscriber.set(key, (same = new Set()));
    same.add(ws);
    const unsubscribe = subscribe(w.workspaceId, sub);
    // Removed between the check above and this registration: the close missed this socket, so check once more.
    if ("status" in (await accessBySlug(actor, f.ws))) {
      unsubscribe();
      same.delete(ws);
      ws.close(CLOSE_FORBIDDEN, "no longer a member");
      return 0;
    }
    ctx = {
      slug: f.ws,
      workspaceId: w.workspaceId,
      viewer: w.viewer,
      unsubscribe: () => {
        unsubscribe();
        same.delete(ws);
        if (!same.size && bySubscriber.get(key) === same) bySubscriber.delete(key);
      },
    };
    const [tail] = await db.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, w.workspaceId));
    // A client ahead of the log holds data this database never had (it was restored or recreated): start over.
    await prime(w.workspaceId, async () => tail!.s); // a ping can say the tail from now on
    if (f.s > tail!.s) {
      send({ t: "resync" });
      sub.buffer = null;
      return 0;
    }
    // Sizes first, then the data: a catch-up past the caps is never read into memory.
    const sizes = await logSizes(w.workspaceId, f.s, CATCH_UP_LIMIT + 1);
    let bytes = 0;
    for (const r of sizes) bytes += r.n;
    // Past the caps the sizing itself was the expensive part: it keeps the whole reservation.
    const big = sizes.length > CATCH_UP_LIMIT || bytes > CATCH_UP_BYTES;
    if (big) {
      send({ t: "resync" });
    } else {
      const actions = sizes.length ? await readLog(w.workspaceId, f.s, sizes.at(-1)!.id) : [];
      if (actions.length) send({ t: "d", a: actions });
      const last = actions.at(-1)?.id ?? f.s;
      for (const live of sub.buffer!) {
        const rest = live.filter((a) => a.id > last);
        if (rest.length) send({ t: "d", a: rest });
      }
    }
    sub.buffer = null;
    if (!big) send({ t: "caught-up" });
    return big ? CATCH_UP_BYTES : bytes;
  }

  async function onFrame(raw: unknown): Promise<void> {
    // Frames queued before a close. The client sends everything unconfirmed again, in order, so one applied now would be
    // run over by the older transaction that closed the socket, and its ack would never arrive.
    if (ws.readyState !== ws.OPEN) return;
    const text = String(raw);
    const f = parseClientFrame(text);
    if (!f) {
      ws.close(1003, "bad frame");
      return;
    }
    if (f.t === "sub") {
      // `actor` is from the upgrade, which may be long ago.
      if (!(await stillSignedIn())) return;
      // Sizing a catch-up already reads up to CATCH_UP_LIMIT log rows, so the reader's budget pays before any query:
      // a full catch-up is reserved and what the subscribe did not use is given back (PLNR-32).
      if ((actor.token && !perToken.take(actor.token.id)) || !reads.take(actor.userId, CATCH_UP_BYTES)) {
        ws.close(CLOSE_TRY_AGAIN, "too many catch-ups");
        return;
      }
      reads.refund(actor.userId, CATCH_UP_BYTES - (await subscribeTo(f)));
      return;
    }
    if (f.t === "inbox" || f.t === "mark") {
      // The viewer's own inbox in the subscribed workspace; a viewer who may read it may mark it.
      if (!ctx) return send({ t: "rej", id: f.t, code: "no_sub", msg: "send sub first" });
      const { workspaceId } = ctx;
      if (f.t === "inbox") {
        if (actor.token && !perToken.take(actor.token.id)) return hold("inbox", "too many requests for this token");
        if (!f.at) {
          if (!reads.take(actor.userId, INBOX_COST)) return hold("inbox", "too many inbox requests");
          return send(await readInbox(workspaceId, actor.userId));
        }
        const at = f.at;
        return answer("inbox", async () => {
          const changed = await marksSince(workspaceId, actor.userId, at);
          return changed && { t: "marks", ...changed };
        });
      }
      // Marks are the viewer's own writes: a read-only token may not set them, and they count against its rate limit and,
      // a row each, against the person's ops like a transaction's. More than MARKS_MAX is refused below as invalid.
      if (actor.token && !perToken.take(actor.token.id)) return hold("mark", "too many requests for this token");
      const n = Math.min(f.m.length, MARKS_MAX);
      if (!takeWrite(actor.userId, n, text.length)) return hold("mark", "too many changes", writeRetryAfter(actor.userId, n, text.length) * 1000);
      if (!(await stillAllowed())) return;
      if (ctx.viewer.scope === "read") return send({ t: "rej", id: "mark", code: "forbidden", msg: "the token is read-only" });
      try {
        const r = await writeMarks(ctx.workspaceId, actor.userId, f.m);
        sendToUser(ctx.workspaceId, actor.userId, JSON.stringify({ t: "marks", ...r } satisfies ServerFrame));
      } catch (e) {
        if (!(e instanceof MarkError)) throw e;
        send({ t: "rej", id: "mark", code: "invalid", msg: e.message });
      }
      return;
    }
    if (f.t === "views" || f.t === "view") {
      // The viewer's saved views in the subscribed workspace (PLNR-74): shared ones and their own.
      if (!ctx) return send({ t: "rej", id: f.t, code: "no_sub", msg: "send sub first" });
      if (actor.token && !perToken.take(actor.token.id)) return hold(f.t, "too many requests for this token");
      if (f.t === "views") {
        const { workspaceId } = ctx;
        const at = f.at;
        return answer("views", () => (at ? viewsSince(workspaceId, actor.userId, at) : readViews(workspaceId, actor.userId)));
      }
      if (!takeWrite(actor.userId, 1, text.length)) return hold("view", "too many changes", writeRetryAfter(actor.userId, 1, text.length) * 1000);
      if (!(await stillAllowed())) return;
      // Saved views are shared data too: a custom token needs Views: write (PLNR-271); writeView adds who may change which.
      if (!can(ctx.viewer, "views.write")) return send({ t: "rej", id: "view", code: "forbidden", msg: refusal(ctx.viewer, "views.write", "change saved views") });
      try {
        const change = await writeView(ctx.workspaceId, actor.userId, ctx.viewer.role, f.w);
        if ("own" in change) {
          sendToUser(ctx.workspaceId, actor.userId, JSON.stringify(change.own satisfies ServerFrame));
        } else if (change.view.shared || change.wasShared) {
          sendEach(ctx.workspaceId, (userId) => {
            const frame = viewFrameFor(change, userId);
            return frame && JSON.stringify(frame);
          });
        } else {
          sendToUser(ctx.workspaceId, actor.userId, JSON.stringify(viewFrameFor(change, actor.userId) satisfies ServerFrame | null));
        }
      } catch (e) {
        if (!(e instanceof ViewError)) throw e;
        send({ t: "rej", id: "view", code: "invalid", msg: e.message });
      }
      return;
    }
    if (f.t === "tx") {
      if (!ctx) {
        send({ t: "rej", id: f.id, code: "no_sub", msg: "send sub first" });
        return;
      }
      const left = blockedFor(f.id);
      if (blocked) return hold(f.id, "too many changes", left);
      if (actor.token && !perToken.take(actor.token.id)) return holdTx(f.id, "too many requests for this token");
      // Set once the access check passed: a failure before that is any frame's failure (the queue closes the socket).
      let checked = false;
      const viewer = async () => {
        const w = await stillAllowed();
        checked = true;
        return w?.viewer ?? null;
      };
      try {
        // The frame's length is what the transaction weighs; parseClientFrame checked that ops is an array.
        const out = await submitTx({ workspaceId: ctx.workspaceId, userId: actor.userId, txId: f.id, ops: f.ops, bytes: text.length, viewer, signedIn: actor.via === "session" });
        if (!out) return;
        if (out.ok) return send({ t: "ack", id: f.id, s: out.r.s });
        const no = out.refused;
        if (no.by === "budget") return holdTx(f.id, "too many changes", no.retryAfter * 1000);
        send(no.by === "rights" ? { t: "rej", id: f.id, code: "forbidden", msg: no.msg } : { t: "rej", id: f.id, code: no.code, msg: no.msg });
      } catch (e) {
        if (!checked) throw e;
        console.error("sync: transaction failed", e);
        // Still failing after the retries (the database is down or restarting): a rejection would make the client drop
        // the edit. Closed instead, the client keeps it pending, reconnects after its backoff and sends it again.
        if (transient(e)) return ws.close(CLOSE_TRY_AGAIN, "database unavailable");
        // Anything else is ours, and its text is not the client's business: a database error carries the SQL and its
        // parameters, and whether a foreign key failed tells which ids exist in other workspaces.
        send({ t: "rej", id: f.id, code: "internal", msg: "internal error" });
      }
    }
  }
  ws.on("close", () => {
    clearInterval(timer);
    clearInterval(liveness);
    clearTimeout(expiry);
    ctx?.unsubscribe();
    mine.delete(ws);
    if (!mine.size && byCredential.get(actor.credentialId) === mine) byCredential.delete(actor.credentialId);
  });
}

/** When the socket's session or token ends on its own (null: a token without expiry, or a credential already gone). */
async function expiresAt(actor: Actor): Promise<number | null> {
  const [row] =
    actor.via === "token"
      ? await db.select({ at: apiToken.expiresAt }).from(apiToken).where(eq(apiToken.id, actor.credentialId))
      : await db.select({ at: session.expiresAt }).from(session).where(eq(session.id, actor.credentialId));
  return row?.at ? Date.parse(row.at) : null;
}

/** Exactly what the client sends: the one frame read before it is parsed, as the queue's turn is what it must not wait for. */
const PING = '{"t":"ping"}';
const isPing = (raw: unknown) => Buffer.isBuffer(raw) && raw.length === PING.length && raw.toString() === PING;

/** The frame if it is well-formed; ops are validated by the write pipeline, marks by writeMarks. */
function parseClientFrame(data: string): ClientFrame | null {
  let f: unknown;
  try {
    f = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof f !== "object" || f === null) return null;
  const o = f as Record<string, unknown>;
  if (o.t === "sub" && typeof o.ws === "string" && Number.isSafeInteger(o.s) && (o.s as number) >= 0) return o as unknown as ClientFrame;
  if (o.t === "tx" && typeof o.id === "string" && o.id.length <= 64 && Array.isArray(o.ops)) return o as unknown as ClientFrame;
  if (o.t === "inbox" && (o.at === undefined || isServerTime(o.at))) return o as unknown as ClientFrame;
  if (o.t === "mark" && Array.isArray(o.m)) return o as unknown as ClientFrame;
  if (o.t === "views" && (o.at === undefined || isServerTime(o.at))) return o as unknown as ClientFrame;
  if (o.t === "view" && typeof o.w === "object" && o.w !== null) return o as unknown as ClientFrame;
  return null;
}
