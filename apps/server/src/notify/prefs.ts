// Settings › Notifications and its Email page (PLNR-199, PLNR-208): the person's rules, kept in account_settings.notifications beside the time zone
// they are timed by. Only the changes from the defaults are stored (packages/protocol/src/notify.ts).
import { NOTIFY_DEFAULTS, NOTIFY_ROWS, QUIET_TIME, type NotifyPrefs, type NotifySettingsView } from "@rsva/protocol";
import { inArray, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { workspacesOf } from "../auth/access.ts";
import { requireActor } from "../auth/routes.ts";
import { db, schema } from "../db.ts";
import { parse } from "../http.ts";
import { telegramView, type TelegramOptions } from "../telegram/routes.ts";

const { accountSettings } = schema;

const delivery = z.enum(["now", "digest", "off"]);
const cell = z.object({ email: delivery, telegram: delivery }).partial().strict();
const time = z.string().regex(QUIET_TIME, "a time is HH:MM");
const D = NOTIFY_DEFAULTS;

// The settings added later default here, so a value saved before them still reads as it was, with their defaults.
const notifyPrefs = z
  .object({
    rules: z.object(Object.fromEntries(NOTIFY_ROWS.map((r) => [r.id, cell.optional()]))).strict(),
    quiet: z.object({ from: time, to: time }).strict().nullable(),
    urgent: z.boolean(),
    seen: z.boolean(),
    workspaces: z.record(z.uuid(), z.enum(["all", "me", "off"])).refine((w) => Object.keys(w).length <= 200, "too many workspaces"),
    email: z.object({ bundle: z.boolean(), textOnly: z.boolean(), reply: z.boolean().default(D.email.reply) }).strict().default(D.email),
    digest: z
      .object({
        on: z.boolean(),
        time,
        days: z.array(z.number().int().min(0).max(6)).max(7).refine((d) => new Set(d).size === d.length, "a day twice"),
        skipEmpty: z.boolean(),
      })
      .strict()
      .default(D.digest),
    weekly: z.boolean().default(D.weekly),
    telegram: z.object({ silent: z.boolean(), length: z.enum(["short", "full"]) }).strict().default(D.telegram),
  })
  .strict() as z.ZodType<NotifyPrefs>;

/** A stored value as the rules read it; one an older build wrote, or none, gives the defaults. */
function toPrefs(v: unknown): NotifyPrefs {
  const r = notifyPrefs.safeParse(v);
  return r.success ? r.data : NOTIFY_DEFAULTS;
}

/** The people's rules and time zones, for the notifier. */
export async function prefsOf(userIds: string[]): Promise<Map<string, { prefs: NotifyPrefs; timeZone: string | null }>> {
  const rows = userIds.length
    ? await db.select({ userId: accountSettings.userId, n: accountSettings.notifications, tz: accountSettings.timeZone }).from(accountSettings).where(inArray(accountSettings.userId, userIds))
    : [];
  const out = new Map(userIds.map((id) => [id, { prefs: NOTIFY_DEFAULTS, timeZone: null as string | null }]));
  for (const r of rows) out.set(r.userId, { prefs: toPrefs(r.n), timeZone: r.tz });
  return out;
}

export async function savePrefs(userId: string, prefs: NotifyPrefs): Promise<void> {
  await db
    .insert(accountSettings)
    .values({ userId, notifications: prefs })
    .onConflictDoUpdate({ target: accountSettings.userId, set: { notifications: prefs, updatedAt: dsql`now()` } });
}

export function registerNotifyRoutes(app: FastifyInstance, tg: TelegramOptions | null, replyDomain: string | null): void {
  const session = { preHandler: requireActor({ sessionOnly: true }) };

  app.get("/auth/notifications", session, async (req): Promise<NotifySettingsView> => {
    const me = req.actor!.userId;
    const workspaces = await workspacesOf(me);
    return { prefs: (await prefsOf([me])).get(me)!.prefs, workspaces, telegram: await telegramView(me, tg), replyDomain };
  });

  // The whole settings at once: the page holds them all, and a change is one cell or one preset.
  app.put<{ Body: unknown }>("/auth/notifications", session, async (req, reply) => {
    const prefs = parse(notifyPrefs, req.body);
    await savePrefs(req.actor!.userId, prefs);
    return prefs;
  });
}

