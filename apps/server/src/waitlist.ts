// The waitlist of the cloud (RSVA-542, ADR 0054). The landing at rsva.dev puts an address on it; the operator lets
// people in a batch at a time (cli/waitlist.ts); a let-in address signs in with a code and creates one workspace
// (auth/eligibility.ts, workspaces.ts).
//
// POST /api/waitlist {email, note} answers 204 for any valid address, on the list already or not: the answer tells
// nobody who asked. It is the one path a page at RSVA_WAITLIST_ORIGINS may call (guard.ts), and only such a page gets
// the CORS headers that let it read the answer.
import { and, asc, desc, inArray, isNull, sql as dsql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Limiter } from "./auth/limits.ts";
import type { Mailer } from "./auth/mail.ts";
import { db, schema } from "./db.ts";
import { WAITLIST_PATH, waitlistOrigin, type GuardConfig } from "./guard.ts";
import { clientKey, email, limit, parse } from "./http.ts";
import { admittedMail } from "./mail/emails.ts";
import type { WaitlistNotifier } from "./telegram/waitlist.ts";

const { waitlist } = schema;

const HOUR = 3_600_000;
/** Per client (an IPv6 address by its /64): a person asks once; a few retries and an office behind one address still fit. */
const byIp = new Limiter(5, HOUR);
/** Per address: asking again changes nothing, so a loop of it only costs us. */
const byEmail = new Limiter(3, 24 * HOUR);
/** In all: a flood of new addresses fills the table at most this fast. */
const overall = new Limiter(500, HOUR);

/** One line about their work: what the operator reads to pick a batch. */
const NOTE_MAX = 200;
const body = z.object({ email, note: z.string().max(NOTE_MAX * 4).optional() });
/** The note on one line, without control characters, at most NOTE_MAX characters. */
const oneLine = (s: string | undefined) =>
  [...(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, NOTE_MAX).join("");

function cors(req: FastifyRequest, reply: FastifyReply, guard: GuardConfig): void {
  const origin = req.headers.origin;
  if (!waitlistOrigin(origin, guard)) return;
  reply.header("access-control-allow-origin", origin!).header("vary", "origin");
}

/** `notifier`: new requests to the creators' Telegram (RSVA-553), none without a bot. */
export function registerWaitlist(app: FastifyInstance, guard: GuardConfig, notifier: WaitlistNotifier | null): void {
  // The preflight of a JSON POST from the landing.
  app.options(WAITLIST_PATH, async (req, reply) => {
    cors(req, reply, guard);
    return reply.header("access-control-allow-methods", "POST").header("access-control-allow-headers", "content-type").header("access-control-max-age", "86400").code(204).send();
  });

  app.post<{ Body: unknown }>(WAITLIST_PATH, async (req, reply) => {
    cors(req, reply, guard);
    const b = parse(body, req.body);
    const address = b.email.toLowerCase();
    limit(byIp, clientKey(req.ip));
    limit(byEmail, address);
    limit(overall, "all");
    const note = oneLine(b.note);
    const added = await db.insert(waitlist).values({ email: address, note }).onConflictDoNothing().returning({ id: waitlist.id });
    // Only a new address: asking again tells nobody anything, the owner included.
    if (added.length) notifier?.add({ email: address, note });
    return reply.code(204).send();
  });
}

export interface Entry {
  email: string;
  note: string;
  createdAt: string;
  admittedAt: string | null;
  usedAt: string | null;
}

/** The waitlist, oldest first: everyone with `all`, else those still waiting. */
export async function listWaitlist(all = false): Promise<Entry[]> {
  const cols = { email: waitlist.email, note: waitlist.note, createdAt: waitlist.createdAt, admittedAt: waitlist.admittedAt, usedAt: waitlist.usedAt };
  const q = db.select(cols).from(waitlist);
  return all ? q.orderBy(desc(waitlist.createdAt)) : q.where(isNull(waitlist.admittedAt)).orderBy(asc(waitlist.createdAt));
}

/**
 * Lets in the given addresses, or the `next` who waited longest, and mails each one how to get in. Only addresses still
 * waiting change: one let in already is not mailed again. Returns the addresses let in now.
 */
export async function admit(who: { emails: string[] } | { next: number }, mailer: Mailer, origin: string): Promise<string[]> {
  const waiting = isNull(waitlist.admittedAt);
  const pick =
    "emails" in who
      ? and(waiting, inArray(waitlist.email, who.emails.map((e) => e.trim().toLowerCase())))
      : and(waiting, inArray(waitlist.id, db.select({ id: waitlist.id }).from(waitlist).where(waiting).orderBy(asc(waitlist.createdAt)).limit(who.next)));
  const rows = await db.update(waitlist).set({ admittedAt: dsql`now()` }).where(pick).returning({ email: waitlist.email });
  const emails = rows.map((r) => r.email).toSorted();
  // One after another: a batch is small, and a refused mail says which address it was.
  for (const to of emails) await mailer(admittedMail(to, origin));
  return emails;
}
