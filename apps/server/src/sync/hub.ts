// Delta fan-out. A frame is encoded once and the same string goes to every subscriber of the workspace, so the cost
// grows with the volume of changes, not with the number of clients (an idea from Superlogical Rex, docs/plan.html).
//
// Prototype: subscribers in memory of one process. Writes of other processes (another server on the same database,
// the command-line import) reach this process's subscribers when it next writes, through the gap fill below; pushing
// them at once is a Postgres NOTIFY that calls catchUp ("Full engine" stage).
import type { Action, DeltaFrame } from "@rsva/protocol";
import type { WebSocket } from "ws";
import { readLog } from "./log.ts";

/**
 * Unsent bytes a socket may hold. A client that reads slower than the workspace writes, or one that asks and never reads
 * (RSVA-607), would otherwise grow the server's memory; dropped, it reconnects and catches up from its number.
 */
const MAX_BUFFERED = 16 * 2 ** 20;

/** Every frame the server sends, deltas and replies alike: a socket past MAX_BUFFERED is dropped instead of fed. */
export function sendFrame(ws: WebSocket, frame: string): void {
  if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate();
  else ws.send(frame);
}

export interface Subscriber {
  ws: WebSocket;
  /** Whose socket it is: the viewer's own frames (inbox marks) go to their sockets only. */
  userId: string;
  /** While the client catches up, live frames queue here so no number is skipped. */
  buffer: Action[][] | null;
}

const byWorkspace = new Map<string, Set<Subscriber>>();

/**
 * Clients receive the log strictly in order. Numbers are taken under the workspace row lock at the very end of a
 * transaction and the lock is held until commit, so once batch N is committed, every number below N is committed too.
 * A batch that arrives ahead of the last sent number therefore never waits: the gap is read from sync_action and sent
 * first. A batch whose numbers were already sent that way is dropped. Deliveries of one workspace run one at a time
 * (`chain`), so concurrent gaps coalesce into one read.
 */
interface Order {
  last: number;
  chain: Promise<void>;
}
const orders = new Map<string, Order>();
const priming = new Map<string, Promise<void>>();

export function subscribe(workspaceId: string, sub: Subscriber): () => void {
  let set = byWorkspace.get(workspaceId);
  if (!set) byWorkspace.set(workspaceId, (set = new Set()));
  set.add(sub);
  return () => set.delete(sub);
}

/**
 * Sets the starting point of the workspace's order from the committed log tail before this process writes to it.
 * Without it the first batch after a restart would set the point, and an earlier batch arriving after it would be
 * dropped instead of sent. Writers await this once per workspace (write.ts).
 */
export function prime(workspaceId: string, loadLastSyncId: () => Promise<number>): Promise<void> {
  if (orders.has(workspaceId)) return Promise.resolve();
  let p = priming.get(workspaceId);
  if (!p) {
    p = loadLastSyncId()
      .then((last) => {
        if (!orders.has(workspaceId)) orders.set(workspaceId, { last, chain: Promise.resolve() });
      })
      .finally(() => priming.delete(workspaceId));
    priming.set(workspaceId, p);
  }
  return p;
}

/** The last log number sent out: a read of memory, so a ping is answered whatever the database is doing. */
export const sentUpTo = (workspaceId: string): number | undefined => orders.get(workspaceId)?.last;

/** Sends a committed batch after everything before it. Resolves once sent; never rejects. */
export function broadcast(workspaceId: string, actions: Action[]): Promise<void> {
  if (actions.length === 0) return Promise.resolve();
  return enqueue(workspaceId, actions[0]!.id - 1, async (o) => {
    try {
      await catchUpTo(workspaceId, o, actions[0]!.id - 1);
    } catch (e) {
      // The batch still goes out: clients notice the gap and resubscribe from their last number.
      console.error("hub: gap fill failed", e);
    }
    send(workspaceId, o, actions);
  });
}

/** Sends every committed action up to `upTo` that was not sent yet (a NOTIFY from another process). */
export function catchUp(workspaceId: string, upTo: number): Promise<void> {
  return enqueue(workspaceId, upTo, (o) => catchUpTo(workspaceId, o, upTo));
}

function enqueue(workspaceId: string, start: number, run: (o: Order) => Promise<void>): Promise<void> {
  let o = orders.get(workspaceId);
  if (!o) orders.set(workspaceId, (o = { last: start, chain: Promise.resolve() }));
  const order = o;
  const done = order.chain.then(() =>
    run(order).catch((e: unknown) => {
      console.error("hub: delivery failed", e);
    }),
  );
  order.chain = done;
  return done;
}

async function catchUpTo(workspaceId: string, o: Order, upTo: number): Promise<void> {
  if (upTo <= o.last) return;
  const missed = await readLog(workspaceId, o.last, upTo);
  send(workspaceId, o, missed);
  o.last = Math.max(o.last, upTo);
}

function send(workspaceId: string, o: Order, actions: Action[]): void {
  const fresh = actions[0] && actions[0].id <= o.last ? actions.filter((a) => a.id > o.last) : actions;
  if (fresh.length === 0) return;
  o.last = fresh.at(-1)!.id;
  const set = byWorkspace.get(workspaceId);
  if (!set) return;
  const frame = JSON.stringify({ t: "d", a: fresh } satisfies DeltaFrame);
  for (const sub of set) {
    if (sub.buffer) sub.buffer.push(fresh);
    else sendFrame(sub.ws, frame);
  }
}

/** A frame for one person's sockets on the workspace: every tab and device of theirs, nobody else's. */
export function sendToUser(workspaceId: string, userId: string, frame: string): void {
  for (const sub of byWorkspace.get(workspaceId) ?? []) if (sub.userId === userId) sendFrame(sub.ws, frame);
}

/**
 * A frame per person on the workspace, built once per person (null: nothing for them): a saved view goes to those who
 * see it, and as gone to those who no longer do (PLNR-74).
 */
export function sendEach(workspaceId: string, frameFor: (userId: string) => string | null): void {
  const frames = new Map<string, string | null>();
  for (const sub of byWorkspace.get(workspaceId) ?? []) {
    if (!frames.has(sub.userId)) frames.set(sub.userId, frameFor(sub.userId));
    const f = frames.get(sub.userId);
    if (f) sendFrame(sub.ws, f);
  }
}
