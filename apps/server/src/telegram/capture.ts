// Making an issue out of what the person already has in the chat (PLNR-364): a message forwarded to the bot answers with
// a draft; /new sent as a reply to a message that is not the bot's takes that message as the description; an album sent
// with one /new caption comes back as one issue with every photo.
//
// The draft keeps no state on the server. Telegram sends the draft message with every press, and that message carries
// `reply_to_message`: the forwarded message itself, with its text, caption, photo or file and where it came from. The
// project the person chose is the draft's own "Project:" line.
import { TITLE_MAX } from "@rsva/schema/models";
import { loadNames } from "../api-names.ts";
import { html } from "../mail/template.ts";
import type { BlobStore } from "../files/store.ts";
import type { TelegramApi } from "./api.ts";
import { redraw, reply } from "./answer.ts";
import { userOf } from "./chats.ts";
import { writable, placeOf } from "./fields.ts";
import { lastProject, newIssue, sentFile, type Forward, type Media, type SentFile } from "./new-issue.ts";
import type { RepliedTo } from "./reply.ts";

/** A private message as the webhook delivers it. */
export interface Incoming extends Media, Forward {
  message_id?: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string };
  /** The same for the photos of an album, which arrive as separate messages. */
  media_group_id?: string;
  reply_to_message?: RepliedTo;
}

interface Options {
  api: TelegramApi;
  files: BlobStore;
}

// ── Albums ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** How long the first message of an album waits for the rest. Tests shorten it. */
export const albumWait = { ms: 1500 };
/** Telegram's album is ten files at most. */
const ALBUM_MAX = 10;
/**
 * The files of the albums being collected, by chat and group. Telegram may deliver an album's messages in any order and
 * at once, so a message without a command is kept whether or not its /new has come: the /new takes what came before it
 * and waits a moment for the rest. What no /new takes is forgotten after a while. Memory only: a restart in that second
 * loses one album.
 */
const albums = new Map<string, { files: SentFile[]; at: number }>();
const albumKey = (m: Incoming) => `${m.chat.id}:${m.media_group_id}`;
/** How long files of an album wait for its /new before they are forgotten; and how many albums are kept at most. */
const ORPHAN_MS = 30_000;
const ALBUMS_MAX = 500;

function albumOf(m: Incoming, now = Date.now()) {
  for (const [k, v] of albums) if (now - v.at > ORPHAN_MS || albums.size >= ALBUMS_MAX) albums.delete(k);
  const k = albumKey(m);
  const a = albums.get(k) ?? { files: [], at: now };
  albums.set(k, a);
  return a;
}

/**
 * A message of an album with no command of its own (the caption is on one message only), in a chat linked to one person:
 * its file is kept for the album's /new, and nothing else is done with it. False for anything else: a stranger's albums
 * are not kept, so they cannot push out the files of an album being collected.
 */
export async function joinAlbum(m: Incoming): Promise<boolean> {
  const file = sentFile(m);
  if (!m.media_group_id || !file || (m.caption ?? "").trim().startsWith("/")) return false;
  const owner = await userOf(m.chat.id);
  if (!owner || owner === "shared") return false;
  albumOf(m).files.push(file);
  return true;
}

/** The files of the album `first` opens: those already come, and the rest after a moment. */
async function collect(m: Incoming, first: SentFile): Promise<SentFile[]> {
  albumOf(m).files.unshift(first);
  await new Promise((done) => setTimeout(done, albumWait.ms));
  const files = albums.get(albumKey(m))?.files ?? [first];
  albums.delete(albumKey(m));
  return files.slice(0, ALBUM_MAX);
}

// ── Where a message came from ───────────────────────────────────────────────────────────────────────────────────

const person = (u: { first_name?: string; last_name?: string; username?: string }) => [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.username ? `@${u.username}` : "");

/** Who and when a forwarded message was first sent; null for a message that is not forwarded. */
function origin(m: Forward): { name: string; date: string | undefined } | null {
  const o = m.forward_origin;
  const name = o ? ((o.sender_user && person(o.sender_user)) || o.sender_user_name || o.sender_chat?.title || o.chat?.title) : ((m.forward_from && person(m.forward_from)) || m.forward_sender_name || m.forward_from_chat?.title);
  const seconds = o ? o.date : m.forward_date;
  if (!o && !name && seconds === undefined) return null;
  return { name: name || "an unknown sender", date: seconds === undefined ? undefined : new Date(seconds * 1000).toISOString().slice(0, 10) };
}

/** The last line of a description made from a forwarded message. */
function footer(m: Forward): string {
  const o = origin(m);
  return o ? `Forwarded from ${o.name}${o.date ? `, ${o.date}` : ""}` : "";
}

const textOf = (m: { text?: string; caption?: string }) => (m.text ?? m.caption ?? "").trim();

/** The message made into description text: its words, then where it came from if it was forwarded. */
const bodyOf = (m: RepliedTo) => [textOf(m), footer(m)].filter(Boolean).join("\n\n");

// ── /new in a reply to the person's own message ────────────────────────────────────────────────────────────────

/**
 * /new: the issue, with the files of the message (all of an album's), and, when it replies to a message that is not the
 * bot's, that message's words as the description and its file as the attachment if the command has none.
 */
export async function newFromMessage(o: Options, userId: string, m: Incoming, args: string, under?: Parameters<typeof newIssue>[5]) {
  const note = !under && m.reply_to_message && !m.reply_to_message.from?.is_bot ? m.reply_to_message : undefined;
  const own = sentFile(m);
  let sent = own ? (m.media_group_id ? await collect(m, own) : [own]) : [];
  const noted = note && !sent.length ? sentFile(note) : null;
  if (noted) sent = [noted];
  return newIssue(o.api, o.files, userId, args, sent, under, note ? { body: bodyOf(note) } : {});
}

// ── The draft of a forwarded message ───────────────────────────────────────────────────────────────────────────

const HEAD = "New issue from this message?";
const mainButtons = [[{ text: "Create", data: "fw:c" }, { text: "Project ▾", data: "fw:pick" }, { text: "Cancel", data: "fw:x" }]];

/** The title a message would give: its first line, clipped, else the name of its file. */
function titleOf(m: Media & { text?: string; caption?: string }): string {
  const line = textOf(m).split("\n")[0]!.trim().slice(0, TITLE_MAX);
  return line || sentFile(m)?.name || "";
}

const draftText = (title: string, key: string) => html`${HEAD}\n${title}\nProject: ${key}`.value;

/** The answer to a message forwarded to the bot: the draft, under that message. Null for a chat nobody linked. */
export async function forwardDraft(m: Incoming) {
  if (!origin(m)) return null;
  const userId = await userOf(m.chat.id);
  if (!userId || userId === "shared") return null;
  const title = titleOf(m);
  if (!title) return reply(m.chat.id, "Nothing to make an issue of.", m.message_id);
  const place = await placeOf(userId, "", await lastProject(userId));
  if ("error" in place) return reply(m.chat.id, html`${place.error}`.value, m.message_id);
  return reply(m.chat.id, draftText(title, place.project.key), m.message_id, mainButtons);
}

/** Every project key the person may create in. */
async function keysOf(userId: string): Promise<string[]> {
  const keys: string[] = [];
  for (const w of await writable(userId)) keys.push(...[...(await loadNames(w.workspaceId)).projects.values()].filter((p) => !p.archivedAt).map((p) => p.key));
  return [...new Set(keys)];
}

/**
 * A button of the draft: Create, Project ▾ (a key per button, then `fw:p:<KEY>`), Cancel. Everything is read back from
 * the draft message; the answer is the draft drawn again.
 */
export async function pressForward(o: Options, callbackId: string, data: string, msg: { message_id: number; text?: string; chat: { id: number }; reply_to_message?: RepliedTo }, userId: string) {
  const [, action, arg] = data.split(":");
  const toast = (text?: string) => o.api.answerButton(callbackId, text).catch(() => {});
  const source = msg.reply_to_message;
  const lines = (msg.text ?? "").split("\n");
  const title = lines[1] ?? "";
  // The draft's own third line, not a line of the forwarded text that reads the same.
  const key = /^Project: (\S+)$/.exec(lines[2] ?? "")?.[1];
  const chat = msg.chat.id;
  if (lines[0] !== HEAD || !title || !key) {
    await toast("This draft is out of date. Forward the message again.");
    return {};
  }
  if (action === "x") {
    await toast();
    return redraw(chat, msg.message_id, "Not created.", []);
  }
  if (action === "pick") {
    await toast();
    const keys = (await keysOf(userId)).slice(0, 40);
    const rows = Array.from({ length: Math.ceil(keys.length / 4) }, (_, i) => keys.slice(i * 4, i * 4 + 4).map((k) => ({ text: k, data: `fw:p:${k}` })));
    // Drawn anew from its parts: the text Telegram sends back is plain, and the message is HTML.
    return redraw(chat, msg.message_id, draftText(title, key), [...rows, [{ text: "‹ Back", data: `fw:p:${key}` }]]);
  }
  if (action === "p" && arg) {
    await toast(`Project ${arg}`);
    return redraw(chat, msg.message_id, draftText(title, arg), mainButtons);
  }
  if (action !== "c") {
    await toast();
    return {};
  }
  if (!source) {
    await toast("The forwarded message is gone.");
    return redraw(chat, msg.message_id, "Not created: the forwarded message was deleted.", []);
  }
  await toast();
  const file = sentFile(source);
  const made = await newIssue(o.api, o.files, userId, `#${key}`, file ? [file] : [], undefined, { title: titleOf(source), body: bodyOf(source) });
  // An issue made draws its card; a refusal keeps the draft's buttons, so the person can choose a project and try again.
  return made.buttons.length ? redraw(chat, msg.message_id, made.text, made.buttons) : redraw(chat, msg.message_id, `${draftText(title, key)}\n${made.text}`, mainButtons);
}
