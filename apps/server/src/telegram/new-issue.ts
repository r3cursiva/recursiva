// /new <title> in the person's chat (PLNR-205): an issue in their last project, the one of the issue they created last.
// A photo or a file sent with `/new <title>` as its caption becomes the issue's attachment, stored as an upload from the
// browser is (files/routes.ts, storeFile: the workspace's quota, the person's upload budget, the type read off the bytes).
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { can } from "@rsva/policy";
import { uuidv7, type Op } from "@rsva/protocol";
import { TITLE_MAX } from "@rsva/schema/models";
import { and, desc, eq, isNull } from "drizzle-orm";
import { defaultStateId } from "../api-names.ts";
import { description } from "../api.ts";
import { roleIn } from "../auth/access.ts";
import { db, schema } from "../db.ts";
import { storeFile, StoreError } from "../files/routes.ts";
import type { BlobStore } from "../files/store.ts";
import { html } from "../mail/template.ts";
import { uploads } from "../sync/limits.ts";
import { DOWNLOAD_MAX, type TelegramApi } from "./api.ts";
import { card, findIssue } from "./card.ts";
import { offeredState, placeOf, readFields, todayOf } from "./fields.ts";
import type { Page } from "./lists.ts";
import { writeAs } from "./write.ts";

const { issue, project } = schema;

/** A photo or a file in the message. */
export interface SentFile {
  fileId: string;
  name: string;
  size: number | undefined;
  mime: string | undefined;
}

/** What a message carries besides text: a photo (its sizes, the largest last) or a file. */
export interface Media {
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

/** The file a photo or a document message carries: the largest size of a photo. */
export function sentFile(m: Media): SentFile | null {
  const photo = m.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, name: "photo.jpg", size: photo.file_size, mime: "image/jpeg" };
  const d = m.document;
  return d ? { fileId: d.file_id, name: (d.file_name ?? "file").slice(0, 255), size: d.file_size, mime: d.mime_type } : null;
}

/** What the message was forwarded from: `forward_origin` of the Bot API, and the fields older clients still send. */
export interface Forward {
  forward_origin?: { type: string; date?: number; sender_user?: { first_name?: string; last_name?: string; username?: string }; sender_user_name?: string; sender_chat?: { title?: string }; chat?: { title?: string } };
  forward_from?: { first_name?: string; last_name?: string; username?: string };
  forward_sender_name?: string;
  forward_from_chat?: { title?: string };
  forward_date?: number;
}

/**
 * Downloads under way: one per person, two in the process. A file is held whole in memory (up to DOWNLOAD_MAX) to be
 * hashed before it is stored, so many at once would cost the server's memory, not the person's budget.
 */
const downloading = new Set<string>();
const DOWNLOADS_MAX = 2;

/** How many of the person's newest issues are looked through for a project they may still write in. */
const LOOK_BACK = 20;

/** The project of the newest issue the person created where they may still create issues; null when there is none. */
export async function lastProject(userId: string) {
  const rows = await db
    .select({ workspaceId: project.workspaceId, projectId: project.id })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .where(and(eq(issue.createdById, userId), isNull(project.archivedAt)))
    .orderBy(desc(issue.createdAt))
    .limit(LOOK_BACK);
  for (const r of rows) {
    const role = await roleIn(r.workspaceId, userId);
    if (role && can({ role }, "issues.write")) return r;
  }
  return null;
}

const HOW =
  "Write the title after the command: <code>/new Fix the sign-in page #infra @me !high +bug</code>. #project, @assignee, !priority and +label are optional; lines after the first become the description. Send it as a photo’s caption to attach the photo.";

/** A word with no buttons: why no issue was created. */
const said = (text: string): Page => ({ text, buttons: [] });

/** A title the text does not carry (a forwarded message's), and text for the description after the message's own lines. */
export interface More {
  title?: string;
  body?: string;
}

/** What the bot answers /new with: the card of the issue it created, or why not. Every file in `sent` is attached. */
export async function newIssue(api: TelegramApi, files: BlobStore, userId: string, args: string, sent: SentFile[], under?: { workspaceId: string; projectId: string; parentId: string }, more: More = {}): Promise<Page> {
  const [line = "", ...rest] = args.split("\n");
  const place = await placeOf(userId, line, under ?? (await lastProject(userId)));
  if ("error" in place) return said(line.trim() || more.title ? html`${place.error}`.value : HOW);
  const p = { ...place.project, workspaceId: place.workspaceId, slug: place.slug, role: place.role };
  const read = await readFields(line, place, p.id, userId, await todayOf(userId));
  if ("error" in read) return said(html`${read.error} Nothing was created.`.value);
  const title = (more.title ?? read.title).slice(0, TITLE_MAX);
  if (!title) return said(HOW);
  let doc;
  try {
    doc = await description([rest.join("\n").trim(), more.body?.trim()].filter(Boolean).join("\n\n") || undefined, async () => place.n, userId);
  } catch (e) {
    return said(html`${(e as Error).message}. Nothing was created.`.value);
  }
  if (sent.some((file) => (file.size ?? 0) > DOWNLOAD_MAX)) return said(`The file is over ${DOWNLOAD_MAX / 2 ** 20} MB, more than Telegram lets a bot download. Attach it in recursiva.`);

  const id = uuidv7();
  const set = { assigneeIds: [userId], ...(under ? { parentId: under.parentId } : {}), ...read.set, title, stateId: (read.set.stateId as string | undefined) ?? defaultStateId(place.n, p.id) };
  const s = place.n.states.get(set.stateId);
  if (s && !offeredState(s)) return said(html`The project's default state, ${s.name}, is set in recursiva. Name another: state:Backlog. Nothing was created.`.value);
  const ops: Op[] = [{ op: "create", m: "Issue", id, projectId: p.id, set } as Op];
  if (doc) ops.push({ op: "update", m: "Document", id, set: { doc } } as Op);
  if (sent.length) {
    if (downloading.has(userId) || downloading.size >= DOWNLOADS_MAX) return said("Another file is on its way. Send this one again in a moment.");
    // The upload budget is taken before the bytes are fetched, for the most Telegram may send when it does not say.
    if (!uploads.take(userId, sent.reduce((n, file) => n + (file.size ?? DOWNLOAD_MAX), 0))) return said("Too many files at once. Try again in a minute.");
    downloading.add(userId);
    try {
      // One at a time, so only one file is held in memory.
      for (const file of sent) {
        let bytes: Buffer;
        try {
          bytes = await api.download(file.fileId);
        } catch {
          return said("Telegram did not give the file. Try again, or attach it in recursiva.");
        }
        const sha = createHash("sha256").update(bytes).digest("hex");
        try {
          await storeFile(files, p.workspaceId, userId, sha, Readable.from(bytes), bytes.length, file.mime, true);
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
          return said(html`The file was not stored (${e.message}), so no issue was created.`.value);
        }
        ops.push({ op: "create", m: "Attachment", id: uuidv7(), set: { issueId: id, sha256: sha, title: file.name } } as Op);
      }
    } finally {
      downloading.delete(userId);
    }
  }
  const w = await writeAs(p.workspaceId, userId, p.role, ops, `create an issue in ${p.key}`, `No issue was created in ${p.key}`);
  if (!w.ok) return said(w.why);
  const made = await findIssue(userId, id);
  return made ? card(made, `Created${sent.length ? (sent.length > 1 ? `, with ${sent.length} files attached` : ", with the file attached") : ""}.`) : said("Created.");
}
