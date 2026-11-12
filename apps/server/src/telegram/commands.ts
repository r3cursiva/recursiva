// Commands in the person's own chat with the bot (PLNR-205, the NotifTg artboard's "Commands in the chat"): /my, /inbox,
// /new, /mute, /help, and the buttons under the bot's answers. Who sends them is proven as for a reply (reply.ts): the
// webhook is authenticated and a chat is the person's only after they pressed Start on their own link. A chat nobody
// linked gets only the way to link it.
//
// The answer rides on the webhook's response; a pressed button redraws its message the same way and is answered with
// one call (answerCallbackQuery), which stops its spinner.
import { TELEGRAM_COMMANDS } from "@rsva/protocol";
import type { BlobStore } from "../files/store.ts";
import { html } from "../mail/template.ts";
import type { TelegramApi } from "./api.ts";
import { redraw, reply } from "./answer.ts";
import { newFromMessage, pressForward, type Incoming } from "./capture.ts";
import { ACTIONS_OFF, notificationsOnly, userOf } from "./chats.ts";
import { cardsFor, findIssue, onlyKeys, pressCard } from "./card.ts";
import { findPage, queryOf } from "./find.ts";
import { inboxPage, markInbox, myPage, tabOf, type Page } from "./lists.ts";
import { muteCommand, pressMute } from "./mute.ts";
import { pressNotMe, pressNotMyCode } from "./not-me.ts";
import { pressSnooze } from "./snooze.ts";
import { pressTriage, triagePage } from "./triage.ts";
import { aboutIssue, type RepliedTo } from "./reply.ts";

export interface CommandOptions {
  api: TelegramApi;
  files: BlobStore;
}

/** A private message as commands read it: a command is its text, or the caption of a photo or a file. */
export type CommandMessage = Incoming;

/** A pressed button. `date` and `edit_date` (seconds) say when the message was drawn. */
export interface ButtonPress {
  id: string;
  data?: string;
  message?: { message_id: number; text?: string; date: number; edit_date?: number; chat: { id: number; type: string }; reply_to_message?: RepliedTo };
}

const NOT_LINKED = "This chat is not connected to recursiva. To connect it, open Settings › Notifications › Telegram in recursiva and press Connect Telegram.";
const SHARED = "This chat is connected to more than one recursiva account, so commands do not know whose they are. Disconnect it in Settings › Notifications › Telegram of the account that should not have it.";

/** `/name` or `/name@bot`, and what follows it; null for a message that is not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][a-z0-9_]{0,31})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

const helpText = () =>
  html`<b>Commands</b>\n${TELEGRAM_COMMANDS.map((c, i) => [i ? "\n" : "", `/${c.command}${c.args ? ` ${c.args}` : ""} — ${c.description}`])}\n\n<b>Fields</b> in /new: #project @assignee !priority +label, and the filter's keys: state:, cycle:, parent:, due:, start:. Lines after the first are the description.\n\nReply to a notification to comment on its issue.`.value;

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────────────────────────

const page = (chatId: number, to: number | undefined, p: { text: string; buttons?: Page["buttons"] }) => reply(chatId, p.text, to, p.buttons);

/** /new in a reply to a card or a notification makes a sub-issue of that issue, in its project. */
async function parentOf(userId: string, m: CommandMessage) {
  const about = await aboutIssue(m.chat.id, m.reply_to_message);
  const ref = about ? ("row" in about ? about.row.issueId : about.key) : null;
  const f = ref ? await findIssue(userId, ref) : null;
  return f ? { workspaceId: f.workspaceId, projectId: f.issue.projectId, parentId: f.issue.id } : undefined;
}

/** The answer to a command in a private chat; null for a message that is not one (it may be a reply to a notification). */
export async function runCommand(m: CommandMessage, o: CommandOptions) {
  const c = parseCommand(m.text ?? m.caption ?? "");
  if (!c) return null;
  const to = m.message_id;
  const userId = await userOf(m.chat.id);
  if (!userId) return reply(m.chat.id, c.name === "help" ? `${helpText()}\n\n${NOT_LINKED}` : NOT_LINKED, to);
  if (userId === "shared") return reply(m.chat.id, SHARED, to);
  switch (c.name) {
    case "my":
      return page(m.chat.id, to, await myPage(userId, 0));
    case "inbox":
      return page(m.chat.id, to, await inboxPage(userId, 0));
    case "find":
      return page(m.chat.id, to, await findPage(userId, c.args, 0));
    case "triage":
      return page(m.chat.id, to, await triagePage(userId, c.args));
    case "new":
      return page(m.chat.id, to, await newFromMessage(o, userId, m, c.args, await parentOf(userId, m)));
    case "mute":
      return page(m.chat.id, to, await muteCommand(userId, c.args));
    case "help":
      return reply(m.chat.id, helpText(), to);
    default:
      return reply(m.chat.id, "No such command. /help lists them.", to);
  }
}

/**
 * A private message in a chat with notifications only (RSVA-496): /mute as usual, since it changes only what comes here;
 * /help with a word on why the rest is off; anything else gets ACTIONS_OFF, reading commands too, so the Telegram account
 * alone shows no issues either. An album's photos without a caption pass silently, so it is not answered once a photo.
 */
export async function notificationsOnlyMessage(m: CommandMessage, o: CommandOptions) {
  const c = parseCommand(m.text ?? m.caption ?? "");
  if (c?.name === "mute") return runCommand(m, o);
  if (c?.name === "help") return reply(m.chat.id, `${helpText()}\n\n${ACTIONS_OFF}`, m.message_id);
  if (m.media_group_id && !m.caption?.trim()) return {};
  return reply(m.chat.id, ACTIONS_OFF, m.message_id);
}

/**
 * Issue keys sent alone in a linked chat ("PLNR-12", up to five): a card for each; null for any other message. A reply
 * that is a key stays a comment. The cards before the last are sent at once, the last rides on the webhook's answer, so
 * they come in the order asked.
 */
export async function keyCards(m: CommandMessage, api: TelegramApi) {
  const keys = m.reply_to_message ? null : onlyKeys(m.text);
  const userId = keys ? await userOf(m.chat.id) : null;
  if (!keys || !userId || userId === "shared") return null;
  const pages = await cardsFor(userId, keys);
  for (const p of pages.slice(0, -1)) await api.send(m.chat.id, p.text, { buttons: p.buttons });
  return page(m.chat.id, m.message_id, pages.at(-1)!);
}

/** A pressed button under /my or /inbox: the message drawn again, and a word on what was done. */
export async function pressButton(q: ButtonPress, o: CommandOptions) {
  const { api } = o;
  const msg = q.message;
  const [kind, a, b] = (q.data ?? "").split(":");
  // Before the owner is looked up: the chat may be shared, and a stranger's link is what the button undoes.
  if (kind === "nm" && a && msg?.chat.type === "private") return pressNotMe(api, q.id, msg.chat.id, msg.message_id, a);
  if (kind === "nc" && a && msg?.chat.type === "private") return pressNotMyCode(api, q.id, msg.chat.id, msg.message_id, a, new Date(msg.date * 1000));
  const owner = msg?.chat.type === "private" ? await userOf(msg.chat.id) : null;
  const userId = owner === "shared" ? null : owner;
  // Pressed on a message drawn while actions were on: refused now, Mute aside (notificationsOnlyMessage).
  if (userId && kind !== "mu" && (await notificationsOnly(msg!.chat.id))) {
    await api.answerButton(q.id, ACTIONS_OFF).catch(() => {});
    return {};
  }
  if (kind === "sn" && a && msg && userId) return pressSnooze(api, q.id, msg.chat.id, msg.message_id, userId, a);
  if (kind === "fw" && msg && userId) return pressForward(o, q.id, q.data!, msg, userId);
  let done: { page: Page; toast?: string } | null = null;
  const pressed = msg && userId ? await pressCard(userId, q.data ?? "") : null;
  if (pressed && "gone" in pressed) {
    await api.answerButton(q.id, pressed.gone).catch(() => {});
    return {};
  }
  if (pressed) done = pressed;
  else if (msg && userId) {
    const offset = Number(a);
    const drawnAt = new Date((msg.edit_date ?? msg.date) * 1000);
    if (kind === "my") done = { page: await myPage(userId, offset) };
    else if (kind === "t") done = await pressTriage(userId, q.data ?? "", msg.text);
    else if (kind === "mu") done = { page: await pressMute(userId, a) };
    else if (tabOf(kind)) done = { page: await inboxPage(userId, offset, tabOf(kind)) };
    else if (kind === "f") done = { page: await findPage(userId, queryOf(msg.text), offset) };
    else if ((kind === "r" && b) || kind === "ra") {
      const r = await markInbox(userId, kind === "r" ? b! : null, kind === "r" ? offset : 0, drawnAt);
      done = { page: r.page, toast: r.marked ? `Marked ${r.marked === 1 ? "as read" : `${r.marked} as read`}` : "Nothing new to mark" };
    }
  }
  const why = owner === "shared" ? "This chat is connected to more than one recursiva account." : userId ? undefined : "This chat is not connected to recursiva.";
  await api.answerButton(q.id, done ? done.toast : why).catch(() => {});
  return done && msg ? redraw(msg.chat.id, msg.message_id, done.page.text, done.page.buttons) : {};
}
