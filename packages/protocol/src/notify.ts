// Notifications by email and Telegram (PLNR-198): which events reach a person where. The inbox gets everything (inbox.ts);
// these rules decide the other channels. One table for the server, which sends, and the settings page, which edits it.
//
// A person's settings keep only the cells they changed from the defaults: a default that improves later reaches everyone
// who never touched that cell. Rows are the events the app produces now; the artboard's others (proposals, agent finished)
// join when they have a source (PLNR-206); agent stuck or failed was cancelled (PLNR-251).
//
// Most rows are log actions (follow.ts). "Due today" and "Cycle starts or ends" are days rather than actions: the morning
// pass (morning.ts) sends them at the person's digest time, and the digest lists them when their email cell is Digest.
import type { TileColor } from "@rsva/schema/models";
import type { InboxKind } from "./inbox.ts";

/** How an event reaches a channel: at once, in the morning digest (PLNR-201), or not at all. */
export type Delivery = "now" | "digest" | "off";
export type Channel = "email" | "telegram";

export type NotifyEvent = "plan" | "review" | "mention" | "assigned" | "reply" | "comment" | "state" | "due" | "cycle";

export interface NotifyRow {
  id: NotifyEvent;
  label: string;
  hint?: string;
  /** Addressed to the person, rather than traffic on an issue they follow: what "Only about me" keeps. */
  personal: boolean;
  /** False for a day's notice (due today, a cycle's day): it is not an action on the log, so the inbox has no line for it. */
  inbox?: false;
  email: Delivery;
  telegram: Delivery;
}

/** The rows of "What reaches you where", by group, with their defaults (NotifRules artboard). */
export const NOTIFY_GROUPS: readonly { name: string; rows: readonly NotifyRow[] }[] = [
  {
    name: "Waiting on you",
    rows: [
      { id: "plan", label: "Agent asks for a review", hint: "An agent moved your issue into review", personal: true, email: "now", telegram: "now" },
      { id: "review", label: "Review requested", hint: "Someone hands work back to you", personal: true, email: "now", telegram: "now" },
    ],
  },
  {
    name: "About you",
    rows: [
      { id: "mention", label: "Mentioned", hint: "@you in a comment or description", personal: true, email: "now", telegram: "now" },
      { id: "assigned", label: "Assigned to you", personal: true, email: "now", telegram: "off" },
      { id: "reply", label: "Reply to your comment", personal: true, email: "digest", telegram: "now" },
    ],
  },
  {
    name: "Issues you follow",
    rows: [
      { id: "comment", label: "New comment", personal: false, email: "digest", telegram: "off" },
      { id: "state", label: "State changed", hint: "In review, approved, done, canceled", personal: false, email: "off", telegram: "off" },
      // Telegram off: the artboard's Digest, which Telegram does not have (account-notifications.tsx draws it as Off).
      { id: "due", label: "Due today", hint: "Your open issues, at your digest time", personal: false, inbox: false, email: "digest", telegram: "off" },
    ],
  },
  {
    name: "Cycles",
    rows: [{ id: "cycle", label: "Cycle starts or ends", hint: "Cycles you lead, on their first and last day", personal: false, inbox: false, email: "now", telegram: "off" }],
  },
];

export const NOTIFY_ROWS: readonly NotifyRow[] = NOTIFY_GROUPS.flatMap((g) => g.rows);
const ROW = new Map(NOTIFY_ROWS.map((r) => [r.id, r]));
export const isNotifyEvent = (v: unknown): v is NotifyEvent => typeof v === "string" && ROW.has(v as NotifyEvent);

/** "Everything" follows the rules, "me" only what is addressed to the person, "off" nothing from that workspace. */
export type WorkspaceMode = "all" | "me" | "off";

export interface NotifyPrefs {
  /** Cells changed from the defaults. */
  rules: Partial<Record<NotifyEvent, Partial<Record<Channel, Delivery>>>>;
  /** Quiet hours in the person's time zone, "HH:MM"; null: none. Urgent issues get through when `urgent` is on. */
  quiet: { from: string; to: string } | null;
  urgent: boolean;
  /** Wait 10 minutes and send nothing if the person has read it in the app meanwhile. */
  seen: boolean;
  /** By workspace id; a workspace not here is "all". */
  workspaces: Record<string, WorkspaceMode>;
  /**
   * How instant emails go (Email page, PLNR-208): one each or a bundle every 30 minutes; HTML with text, or text only;
   * whether a reply to one posts as a comment (PLNR-211).
   */
  email: { bundle: boolean; textOnly: boolean; reply: boolean };
  /** The morning digest: at `time` in the person's zone on the `days` (as getDay counts), skipped when there is nothing. */
  digest: { on: boolean; time: string; days: number[]; skipEmpty: boolean };
  /** The weekly summary, Mondays at 09:00 in the person's zone. */
  weekly: boolean;
  /**
   * How Telegram messages come (PLNR-202): during quiet hours silently (`silent`) or held until they end; with the
   * comment they are about (`full`) or only what happened (`short`).
   */
  telegram: { silent: boolean; length: "short" | "full" };
}

export const NOTIFY_DEFAULTS: NotifyPrefs = {
  rules: {},
  quiet: { from: "22:00", to: "08:00" },
  urgent: true,
  seen: true,
  workspaces: {},
  email: { bundle: false, textOnly: false, reply: true },
  digest: { on: true, time: "08:00", days: [1, 2, 3, 4, 5], skipEmpty: true },
  weekly: false,
  // With the comment: a comment can be read, and answered (PLNR-203), without opening the app.
  telegram: { silent: true, length: "full" },
};

/** How long a notification email's reply address takes replies (PLNR-211). */
export const REPLY_DAYS = 30;

/** Bundled instant emails go out on the half hour. */
export const BUNDLE_MS = 30 * 60_000;
/** The weekly summary: Monday, 09:00. */
export const WEEKLY = { day: 1, time: "09:00" } as const;

/** Everything off by email: "Unsubscribe from everything" and the link in every notification. Sign-in mail is not this. */
export function unsubscribed(prefs: NotifyPrefs): NotifyPrefs {
  return { ...withPreset(prefs, "email", () => "off"), digest: { ...prefs.digest, on: false }, weekly: false };
}

/** How long "already seen" waits for the person to open it in the app. */
export const SEEN_WAIT_MS = 10 * 60_000;

/** The cell as it stands for this person: their change, else the default. */
export function delivery(prefs: NotifyPrefs, event: NotifyEvent, channel: Channel): Delivery {
  return prefs.rules[event]?.[channel] ?? ROW.get(event)![channel];
}

/** Changes from the defaults only: a cell set back to its default leaves `rules`. */
export function withCell(prefs: NotifyPrefs, event: NotifyEvent, channel: Channel, value: Delivery): NotifyPrefs {
  const cell = { ...prefs.rules[event], [channel]: value };
  if (value === ROW.get(event)![channel]) delete cell[channel];
  const rules = { ...prefs.rules, [event]: cell };
  if (!Object.keys(cell).length) delete rules[event];
  return { ...prefs, rules };
}

/** What waits on the person: the rows "Only what waits on me" sends at once. */
const WAITING = new Set<NotifyEvent>(["plan", "review", "mention"]);

/** The presets under the matrix ("Start from"): every cell of a channel at once. */
export const NOTIFY_PRESETS = [
  { id: "waiting", label: "Only what waits on me", pick: (r: NotifyRow): Delivery => (WAITING.has(r.id) ? "now" : "digest") },
  { id: "everything", label: "Everything instantly", pick: (): Delivery => "now" },
  { id: "digest", label: "Digest only", pick: (): Delivery => "digest" },
] as const;

export function withPreset(prefs: NotifyPrefs, channel: Channel, pick: (r: NotifyRow) => Delivery): NotifyPrefs {
  return NOTIFY_ROWS.reduce((p, r) => withCell(p, r.id, channel, pick(r)), prefs);
}

/** The row an inbox notification belongs to; an approval is a state change of the person's issue. */
export function notifyEvent(kind: InboxKind, byAgent: boolean): NotifyEvent {
  if (kind === "review") return byAgent ? "plan" : "review";
  if (kind === "approved") return "state";
  return kind;
}

/** Whether the workspace's mode lets the event through. */
export function workspaceAllows(prefs: NotifyPrefs, workspaceId: string, event: NotifyEvent): boolean {
  const mode = prefs.workspaces[workspaceId] ?? "all";
  return mode === "all" || (mode === "me" && ROW.get(event)!.personal);
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A moment on the person's wall clock: their date, "HH:MM" and weekday (as getDay counts). */
export function wallClock(at: Date, timeZone: string): { date: string; time: string; weekday: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: WEEKDAYS.indexOf(p.weekday!) };
}

/** "20:30", or "Thu 09:15" on another day than `now`, on the person's wall clock: when a /mute ends (RSVA-255). */
export function untilClock(at: Date, now: Date, timeZone: string | null): string {
  const then = wallClock(at, timeZone ?? "UTC");
  return then.date === wallClock(now, timeZone ?? "UTC").date ? then.time : `${WEEKDAYS[then.weekday]} ${then.time}`;
}

/** The zone's offset from UTC at that moment, in minutes ("GMT+02:00" → 120). */
function offset(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")!.value;
  const m = /([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/**
 * When a message due at `at` may go out: `at` itself, or the end of quiet hours in the person's zone if it falls inside
 * them. Quiet hours may cross midnight (22:00 to 08:00), and the end is found on the wall clock across a change of the
 * zone's offset (daylight saving). Without a zone there are no quiet hours: the server's own zone is nobody's night.
 */
export function afterQuiet(at: Date, quiet: NotifyPrefs["quiet"], timeZone: string | null): Date {
  if (!quiet || quiet.from === quiet.to || !timeZone) return at;
  const now = minutes(wallClock(at, timeZone).time);
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  const inside = from < to ? now >= from && now < to : now >= from || now < to;
  if (!inside) return at;
  const wait = (to - now + 24 * 60) % (24 * 60);
  // Wall-clock minutes from the start of this minute; a change of offset meanwhile moves the instant by its difference.
  const naive = new Date(Math.floor(at.getTime() / 60_000) * 60_000 + wait * 60_000);
  return new Date(naive.getTime() - (offset(naive, timeZone) - offset(at, timeZone)) * 60_000);
}

export const QUIET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What a group chat can be given (PLNR-204, NotifTgGroup): events of a project rather than about a person, so the whole
 * group can act on them. "cycle" (PLNR-253) is a day, as the person's row is: the cycles of the group's projects that
 * start or end today, one message at GROUP_CYCLES_TIME in its linker's zone (notify/morning.ts). The artboard's other
 * one, agent stuck or failed, was cancelled (PLNR-251).
 */
export type GroupEvent = "urgent" | "plan" | "cycle";
/** A group has no digest time of its own: the start of a working day. */
export const GROUP_CYCLES_TIME = "09:00";
export const GROUP_EVENTS: readonly { id: GroupEvent; label: string; hint: string }[] = [
  { id: "urgent", label: "New urgent issue", hint: "Created as urgent, or raised to urgent" },
  { id: "plan", label: "Plans waiting for approval", hint: "An agent moved an issue into review" },
  { id: "cycle", label: "Cycle starts or ends", hint: `On its first and last day, at ${GROUP_CYCLES_TIME}` },
];
export const isGroupEvent = (v: unknown): v is GroupEvent => GROUP_EVENTS.some((e) => e.id === v);

/**
 * The bot's commands in a person's own chat (PLNR-205), as the Telegram page lists them under "Commands in the chat",
 * /help answers and Telegram's own command menu shows them (setMyCommands).
 */
export const TELEGRAM_COMMANDS: readonly { command: string; args: string; description: string }[] = [
  { command: "my", args: "", description: "Your My work, five at a time" },
  { command: "inbox", args: "", description: "Unread, with buttons to mark read" },
  { command: "find", args: "query", description: "Search issues, e.g. #INFRA @me !urgent" },
  { command: "triage", args: "#project", description: "Proposed issues one card at a time: open to approve, or cancel" },
  { command: "new", args: "Title", description: "New issue in your last project; a photo becomes an attachment" },
  { command: "mute", args: "2h", description: "Pause everything but urgent" },
  { command: "help", args: "", description: "All commands" },
];

/** A linked group chat as the Telegram page lists it: to its linker and to the workspace's admins, who may change it. */
export interface TelegramGroupView {
  id: string;
  workspaceId: string;
  title: string;
  members: number | null;
  linkedBy: string;
  linkedByMe: boolean;
  linkedAt: string;
  projectIds: string[];
  events: GroupEvent[];
  /** Why it stopped ("Bot removed from the group"), and when: nothing goes to it until it is linked again. */
  error: string | null;
  errorAt: string | null;
}

/**
 * Telegram as the person sees it (PLNR-202): whether this server has a bot at all, and their chat if they linked one.
 * A chat with an error is linked but not delivering (the bot was blocked or the chat is gone); `fallbacks` is how many
 * messages went by email instead since then (PLNR-204). `groups`: the group chats they linked or, as an admin, may change.
 */
export interface TelegramView {
  bot: string | null;
  /**
   * `actions`: the chat's buttons, commands and replies act for the person; off, it gets notifications only (RSVA-496).
   * `mutedUntil`: while a /mute runs, when it ends; null once it has run out (RSVA-255).
   */
  chat: { username: string | null; name: string; linkedAt: string; error: string | null; errorAt: string | null; fallbacks: number; actions: boolean; mutedUntil: string | null } | null;
  groups: TelegramGroupView[];
}

/**
 * POST /auth/telegram/groups/link: a code for one group of the workspace, ten minutes. `url` is the bot's startgroup
 * link (Telegram asks which group to add the bot to, then sends the code there itself); `command` is what to send in a
 * group the bot is already in. A group linked at `createdAt` or later by the person was linked by it.
 */
export interface TelegramGroupLink {
  code: string;
  url: string;
  command: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * POST /auth/telegram/link: a start link good for ten minutes, and its QR code as one SVG path over a `size` square. A
 * chat linked at `createdAt` or later was linked by it (rather than being one from before, on Reconnect).
 */
export interface TelegramLink {
  code: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  qr: { size: number; path: string };
}

/** GET /auth/notifications: the settings, the person's workspaces for "Per workspace", and their Telegram. */
export interface NotifySettingsView {
  prefs: NotifyPrefs;
  workspaces: { id: string; slug: string; name: string; color: TileColor | null; role: string }[];
  telegram: TelegramView;
  /** Where replies to notification emails go (PLNR-211), as in `infra-112.<token>@<domain>`; null when the server takes none. */
  replyDomain: string | null;
}

/** Whether Telegram gets anything: a linked chat that has not failed. */
export const telegramDelivering = (t: TelegramView): boolean => !!t.chat && !t.chat.error;

/**
 * "What should come to Telegram?" once a chat is linked (NotifTgDone). Telegram has no digest: a cell is Instantly or
 * Off, so "The same as email" takes only email's Instantly cells.
 */
export const TELEGRAM_STARTS = [
  { id: "waiting", label: "Only what waits on me", hint: "Plans, reviews and mentions", pick: (r: NotifyRow): Delivery => (WAITING.has(r.id) ? "now" : "off") },
  { id: "email", label: "The same as email", hint: "Whatever is set to Instantly for email", pick: (r: NotifyRow, p: NotifyPrefs): Delivery => (delivery(p, r.id, "email") === "now" ? "now" : "off") },
  { id: "everything", label: "Everything instantly", hint: "Every event on the list", pick: (): Delivery => "now" },
] as const;
