// A settings page waiting for Telegram (PLNR-202, PLNR-204): the person pressed Start, or sent a group's code, and the
// webhook in this process answers the page's held request at once. Keyed by person and what they wait for.
import type { FastifyReply } from "fastify";

/** How long the page's wait is held before it asks again: under the proxies' idle timeouts. */
const WAIT_MS = 25_000;

const waiting = new Map<string, Set<() => void>>();

export function wake(key: string): void {
  for (const done of waiting.get(key) ?? []) done();
}

/** Every page still waiting is answered now, so a restart does not wait for them: they ask the new process. */
export function wakeAll(): void {
  for (const set of waiting.values()) for (const done of [...set]) done();
}

/** Resolves when `key` is woken, WAIT_MS pass or the page goes away. */
export function held(key: string, reply: FastifyReply): Promise<void> {
  return new Promise<void>((resolve) => {
    let set = waiting.get(key);
    if (!set) waiting.set(key, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size) waiting.delete(key);
      reply.raw.off("close", done);
      resolve();
    };
    const timer = setTimeout(done, WAIT_MS);
    set.add(done);
    // The response's close, not the request's: a GET's request closes as soon as it is read. A page that went away
    // frees its place at once.
    reply.raw.once("close", done);
  });
}
