// Push notifications (RSVA-647): the notifier's third channel beside email and Telegram, to the devices a person turned
// push on for in Settings › Notifications. follow.ts writes "push" rows of notify_outbox by the rules' push column, as it
// does Telegram's; sendPushDue sends them once due, with the rules read again then (send.ts, stillDue). A row goes to
// every device of the person; a device its push service has forgotten (404, 410) is removed.
//
// A device is a browser's subscription (push_device), made in one sign-in and gone with it (signing out, or ending that
// session from Security). The server posts to the subscription's endpoint, an address the browser chose: only the push
// services' own hosts are taken, so a made-up endpoint cannot turn the server into a client of anything else.
import type { PushDevice, PushSubscribe, PushView } from "@rsva/protocol";
import { and, asc, eq, inArray, notInArray, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deviceName } from "../auth/device.ts";
import { requireActor } from "../auth/routes.ts";
import { db, schema } from "../db.ts";
import { HttpError, parse } from "../http.ts";
import { prefsOf } from "./prefs.ts";
import { failed, finish, stillDue, take, type IssueFacts } from "./send.ts";
import { clipped, headline } from "./words.ts";
import { PAYLOAD_MAX, type PushApi, type PushTarget } from "./web-push.ts";

const { pushDevice } = schema;

/** The push services of the browsers that have one: Apple's, Google's (Chrome, Edge on Android), Mozilla's, Microsoft's. */
const PUSH_HOSTS = ["push.apple.com", "fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "notify.windows.com"];
const pushHost = (host: string) => PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
/** Devices a person keeps: a new one past this replaces their oldest. */
const DEVICES_MAX = 20;

const base64url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((s) => Buffer.from(s, "base64url").length === bytes, `${bytes} bytes, base64url`);
const subscription = z
  .object({
    endpoint: z
      .url({ protocol: /^https$/ })
      .max(1000)
      .refine((u) => {
        const url = new URL(u);
        return !url.username && !url.password && !url.port && pushHost(url.hostname);
      }, "the address of a browser's push service"),
    // The browser's P-256 point (uncompressed, 65 bytes) and its 16-byte auth secret (RFC 8291).
    keys: z.object({ p256dh: base64url(65), auth: base64url(16) }),
  })
  .loose() as z.ZodType<PushSubscribe>;

/** The person's devices, oldest first. */
async function devicesOf(userId: string): Promise<PushDevice[]> {
  const rows = await db
    .select({ id: pushDevice.id, name: pushDevice.name, endpoint: pushDevice.endpoint, createdAt: pushDevice.createdAt, sentAt: pushDevice.sentAt })
    .from(pushDevice)
    .where(eq(pushDevice.userId, userId))
    .orderBy(asc(pushDevice.createdAt));
  return rows;
}

/** Push as the settings page shows it: nothing to turn on without the server's key. */
export async function pushView(userId: string, api: PushApi | null): Promise<PushView> {
  return { key: api?.publicKey ?? null, devices: api ? await devicesOf(userId) : [] };
}

/** What a push says: what happened as its title, the issue and the comment's first lines below, the issue to open. */
function pushMessage(n: IssueFacts, issueId: string): string {
  const { comment, title } = clipped(n);
  const body = [title, comment].filter(Boolean).join("\n");
  const msg = (text: string) => JSON.stringify({ title: `${headline(n).title}${n.urgent ? " · urgent" : ""}`, body: text, url: n.link, tag: issueId });
  // Well inside one record; a long comment is cut further rather than not sent.
  let text = body;
  while (Buffer.byteLength(msg(text)) > PAYLOAD_MAX - 1024) text = `${text.slice(0, Math.floor(text.length * 0.8)).trimEnd()}…`;
  return msg(text);
}

/** A device's push service took it (2xx), forgot it (404, 410: removed here), or did not take it now. */
async function deliver(api: PushApi, d: PushTarget & { id: string }, payload: string): Promise<"sent" | "gone" | "refused"> {
  const status = await api.send(d, payload);
  if (status >= 200 && status < 300) {
    await db.update(pushDevice).set({ sentAt: dsql`now()` }).where(eq(pushDevice.id, d.id));
    return "sent";
  }
  if (status === 404 || status === 410) {
    await db.delete(pushDevice).where(eq(pushDevice.id, d.id));
    return "gone";
  }
  return "refused";
}

/**
 * Sends the push rows that are due; returns how many it handled, sent or not. A row is sent once any device took it; a
 * row no device took (the services down, or refusing) tries again after its lease. `workspaceId` is one workspace's rows
 * only (a test's); `null` is every workspace, which only the server's loop wants.
 */
export async function sendPushDue(api: PushApi, origin: string, now = new Date(), workspaceId: string | null): Promise<number> {
  const rows = await take(now, "push", workspaceId);
  if (!rows.length) return 0;
  const people = [...new Set(rows.map((r) => r.userId))];
  const [prefs, devices] = await Promise.all([prefsOf(people), db.select().from(pushDevice).where(inArray(pushDevice.userId, people))]);
  for (const r of rows) {
    try {
      const mine = devices.filter((d) => d.userId === r.userId);
      const facts = mine.length ? await stillDue(r, prefs.get(r.userId)!.prefs, "push", origin, now) : "dropped";
      if (typeof facts === "string") {
        await finish(r.id, facts);
        continue;
      }
      const payload = pushMessage(facts, r.issueId);
      const results = await Promise.allSettled(mine.map((d) => deliver(api, d, payload)));
      const outcomes = results.map((x) => (x.status === "fulfilled" ? x.value : "refused"));
      // A device gone with this row is not tried for the rows after it.
      mine.forEach((d, i) => outcomes[i] === "gone" && devices.splice(devices.indexOf(d), 1));
      if (outcomes.includes("sent")) await finish(r.id, "sent");
      else if (outcomes.every((o) => o === "gone")) await finish(r.id, "dropped");
      else {
        const why = results.find((x) => x.status === "rejected");
        await failed([r], why ? why.reason : new Error("the push service did not take it"));
      }
    } catch (e) {
      await failed([r], e);
    }
  }
  return rows.length;
}

export function registerPush(app: FastifyInstance, api: PushApi | null): void {
  const session = { preHandler: requireActor({ sessionOnly: true }) };
  const ready = (): PushApi => {
    if (!api) throw new HttpError(404, "not_found", "push is not set up on this server");
    return api;
  };

  // This browser's subscription, for this sign-in. The same endpoint again (a page that subscribed before, or another
  // sign-in in the same browser) is the same device, now this session's and this person's.
  app.post<{ Body: unknown }>("/auth/push", session, async (req): Promise<PushView> => {
    const push = ready();
    const sub = parse(subscription, req.body);
    const { userId, credentialId } = req.actor!;
    const set = { userId, sessionId: credentialId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, name: deviceName(req.headers["user-agent"]) };
    await db.transaction(async (tx) => {
      const [{ id }] = (await tx
        .insert(pushDevice)
        .values({ ...set, endpoint: sub.endpoint })
        .onConflictDoUpdate({ target: pushDevice.endpoint, set: { ...set, createdAt: dsql`now()`, sentAt: null } })
        .returning({ id: pushDevice.id })) as [{ id: string }];
      const keep = await tx.select({ id: pushDevice.id }).from(pushDevice).where(eq(pushDevice.userId, userId)).orderBy(dsql`${pushDevice.createdAt} desc`).limit(DEVICES_MAX);
      await tx.delete(pushDevice).where(and(eq(pushDevice.userId, userId), notInArray(pushDevice.id, [id, ...keep.map((k) => k.id)])));
    });
    return pushView(userId, push);
  });

  app.delete<{ Params: { id: string } }>("/auth/push/:id", session, async (req): Promise<PushView> => {
    const push = ready();
    const userId = req.actor!.userId;
    if (z.uuid().safeParse(req.params.id).success) await db.delete(pushDevice).where(and(eq(pushDevice.id, req.params.id), eq(pushDevice.userId, userId)));
    return pushView(userId, push);
  });

  // Send a test: to one of the person's devices, now, whatever the rules say.
  app.post<{ Params: { id: string } }>("/auth/push/:id/test", session, async (req): Promise<{ sent: boolean; view: PushView }> => {
    const push = ready();
    const userId = req.actor!.userId;
    const [d] = z.uuid().safeParse(req.params.id).success ? await db.select().from(pushDevice).where(and(eq(pushDevice.id, req.params.id), eq(pushDevice.userId, userId))) : [];
    if (!d) throw new HttpError(404, "not_found", "no such device");
    const payload = JSON.stringify({ title: "Push works", body: `recursiva will notify ${d.name} here, as you set in Notifications.`, url: "/", tag: "test" });
    const sent = (await deliver(push, d, payload)) === "sent";
    return { sent, view: await pushView(userId, push) };
  });
}
