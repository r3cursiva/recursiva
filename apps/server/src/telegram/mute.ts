// /mute (PLNR-205, PLNR-365): `/mute 2h` pauses everything but urgent for that long, `/mute off` ends it, and `/mute` alone
// says where things stand with buttons to change it; a pressed button applies its choice and redraws the same message.
import { untilClock as clock, wallClock } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { html } from "../mail/template.ts";
import { prefsOf } from "../notify/prefs.ts";
import type { Buttons } from "./api.ts";
import type { Page } from "./lists.ts";

const { telegramChat } = schema;

const MUTE_MAX_MS = 7 * 86_400_000;
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const MORNING = "09:00";

/** "30m", "2h", "1d" in milliseconds; null for anything else or past a week. */
export function muteFor(args: string): number | null {
  const m = /^(\d{1,4})\s*([mhd])$/i.exec(args);
  const ms = m ? Number(m[1]) * UNITS[m[2]!.toLowerCase()]! : 0;
  return ms > 0 && ms <= MUTE_MAX_MS ? ms : null;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** The next 09:00 on the person's wall clock, found across a change of the zone's offset (daylight saving). */
function nextMorning(now: Date, timeZone: string | null): Date {
  const zone = timeZone ?? "UTC";
  const wait = ((minutes(MORNING) - minutes(wallClock(now, zone).time) + 1440 - 1) % 1440) + 1;
  const naive = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + wait * 60_000);
  const off = minutes(MORNING) - minutes(wallClock(naive, zone).time);
  return new Date(naive.getTime() + (off > 720 ? off - 1440 : off < -720 ? off + 1440 : off) * 60_000);
}

/** When a mute stored as `mutedUntil` ends, while it still runs at `now`; null when there is none or it has run out. */
export const muteRunning = (mutedUntil: string | null | undefined, now: Date): Date | null =>
  mutedUntil && Date.parse(mutedUntil) > now.getTime() ? new Date(mutedUntil) : null;

/** Mutes the person's chat until then, or ends the mute with null: /mute, its buttons and Resume on the Telegram page. */
export async function setMute(userId: string, until: Date | null): Promise<void> {
  await db.update(telegramChat).set({ mutedUntil: until?.toISOString() ?? null }).where(eq(telegramChat.userId, userId));
}

/** Where things stand and the buttons to change it; Off only while muted. */
async function mutePage(userId: string, now: Date): Promise<Page> {
  const [chat] = await db.select({ mutedUntil: telegramChat.mutedUntil }).from(telegramChat).where(eq(telegramChat.userId, userId)).limit(1);
  const until = muteRunning(chat?.mutedUntil, now);
  const { timeZone } = (await prefsOf([userId])).get(userId)!;
  const row = [
    { text: "1h", data: "mu:60" },
    { text: "2h", data: "mu:120" },
    { text: `Until ${MORNING}`, data: "mu:am" },
    ...(until ? [{ text: "Off", data: "mu:off" }] : []),
  ];
  return { text: until ? html`Muted until ${clock(until, now, timeZone)}. Urgent issues still come.`.value : "Notifications are on.", buttons: [row] satisfies Buttons };
}

/** `/mute` with what follows it: the state with buttons for no argument, otherwise the choice applied and said. */
export async function muteCommand(userId: string, args: string, now = new Date()): Promise<{ text: string; buttons?: Buttons }> {
  if (!args) return mutePage(userId, now);
  if (/^(off|stop|0)$/i.test(args)) {
    await setMute(userId, null);
    return { text: "Notifications are on again." };
  }
  const ms = muteFor(args);
  if (ms === null) return { text: "Mute for how long? <code>/mute 30m</code>, <code>/mute 2h</code> or <code>/mute 1d</code>, a week at most. <code>/mute off</code> turns notifications back on." };
  const until = new Date(now.getTime() + ms);
  await setMute(userId, until);
  const { timeZone } = (await prefsOf([userId])).get(userId)!;
  return { text: html`Muted until ${clock(until, now, timeZone)}. Urgent issues still come; the rest waits in your inbox. <code>/mute off</code> ends it.`.value };
}

/** A pressed `mu:` button (`mu:60` minutes, `mu:am` until the morning, `mu:off`): applied, and the message drawn anew. */
export async function pressMute(userId: string, choice: string | undefined, now = new Date()): Promise<Page> {
  if (choice === "off") await setMute(userId, null);
  else if (choice === "am") await setMute(userId, nextMorning(now, (await prefsOf([userId])).get(userId)!.timeZone));
  else {
    const ms = muteFor(`${Number(choice)}m`);
    if (ms !== null) await setMute(userId, new Date(now.getTime() + ms));
  }
  return mutePage(userId, now);
}
