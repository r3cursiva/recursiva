// What the notifier's test files share: a server and an imported workspace whose log the notifier starts reading at
// its end, and the writes the tests make in it.
import { randomUUID } from "node:crypto";
import { NOTIFY_DEFAULTS, type NotifyPrefs, type Op } from "@rsva/protocol";
import type { Mail } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { applyTx } from "../sync/write.ts";
import { addMember, fileFixture } from "../test/helpers.ts";
import { follow } from "./follow.ts";

export function notifyFixture() {
  const f = fileFixture((ws) => follow(ws.workspaceId));
  const tx = (actor: string, ops: Op[]) => applyTx(f.ws.workspaceId, actor, randomUUID(), ops);
  /** A fresh issue, so no test sees another's events. */
  async function newIssue(creator: string, set: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await tx(creator, [{ op: "create", m: "Issue", id, projectId: f.refs.project.id, set: { title: "Rotate the edge nodes", stateId: f.refs.states[0]!.id, ...set } } as Op]);
    return id;
  }
  /**
   * A member with these settings, quiet hours and "already seen" off, whom the digest and the morning pass have met
   * before: on a first meeting today only counts as sent (digest.ts).
   */
  async function person(prefs: Partial<NotifyPrefs>, timeZone: string | null = "UTC") {
    const me = await addMember(f.ws.workspaceId, "member");
    await db.insert(schema.accountSettings).values({ userId: me.id, timeZone, notifications: { ...NOTIFY_DEFAULTS, seen: false, quiet: null, ...prefs } });
    await db.insert(schema.notifyDigest).values(["daily", "weekly", "morning"].map((kind) => ({ userId: me.id, kind, sentOn: "2026-10-01" })));
    return me;
  }
  /** A cycle in the project, numbered far from any other test's; its key as the digest writes it ("ENG C12345"). */
  async function newCycle(set: Partial<typeof schema.cycle.$inferInsert>): Promise<string> {
    const number = 10_000 + Math.floor(Math.random() * 1_000_000);
    await db.insert(schema.cycle).values({ workspaceId: f.ws.workspaceId, projectId: f.refs.project.id, number, name: `Sprint ${number}`, ...set });
    return `${f.refs.project.key} C${number}`;
  }
  /** A fresh issue with a thread in which a comment mentions the person, and the notifier's pass over it. */
  async function mentionedInThread(userId: string, telegram = false): Promise<{ id: string; root: string; now: Date }> {
    const id = await newIssue(f.ws.ownerId);
    const root = randomUUID();
    await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: root, set: { issueId: id, body: "Ready?" } }]);
    await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, parentId: root, body: `Have a look [@x](mention:${userId})` } }]);
    const now = new Date();
    await follow(f.ws.workspaceId, now, telegram);
    return { id, root, now };
  }
  return { f, tx, newIssue, person, newCycle, mentionedInThread };
}

/** A person's notification settings and time zone, as the settings page saves them. */
export const setPrefs = (userId: string, notifications: NotifyPrefs, timeZone: string | null = null) =>
  db.insert(schema.accountSettings).values({ userId, notifications, timeZone }).onConflictDoUpdate({ target: schema.accountSettings.userId, set: { notifications, timeZone } });

/**
 * Quiet hours, in UTC, that hold `now`: all day long but the minute before it. Unlike a fixed "00:00"–"23:59", which
 * leaves out 23:59 (RSVA-404), `now` is inside them whatever the time the test runs.
 */
export function quietAround(now: Date): { from: string; to: string } {
  const hhmm = (ms: number) => new Date(now.getTime() - ms).toISOString().slice(11, 16);
  return { from: hhmm(60_000), to: hhmm(120_000) };
}

/** A mailer that keeps what it is given. Filter by recipient: test files beside this one mail their own people. */
export function collect() {
  const mails: Mail[] = [];
  return { mails, mailer: async (m: Mail) => void mails.push(m) };
}
