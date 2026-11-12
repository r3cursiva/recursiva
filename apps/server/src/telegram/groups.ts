// Group chats (PLNR-204, NotifTgGroup and NotifTgError): a member gives a Telegram group the events of some projects,
// and everyone in it sees them. The settings page asks for a code; the bot's startgroup link (`t.me/<bot>?startgroup=`)
// lets Telegram ask which group to add the bot to and send the code there itself, and in a group the bot is already in
// `/link@<bot> <code>` does the same. The group is then linked with nothing picked, and the page that waits shows which
// group it was: nothing goes to it until the person who linked it saves its projects and events. A code read off a
// screen links someone else's group to nothing.
//
// A group gets only what its linker may read in the workspace, checked when each message goes (notify/telegram.ts).
// The linker and the workspace's admins change or remove it. Removed from the group, the bot learns it at once
// (my_chat_member) and marks the group; a group that becomes a supergroup moves to its new id.
//
// A group keeps getting messages after the session that linked it ends, so asking for a code and widening what a group
// gets need a fresh sign-in, as the personal chat does (PLNR-223), and the linker's address hears of every group linked
// (PLNR-246): a stolen cookie of any age must not give the thief's group the workspace's news.
import { isRole, mayManage, mayRead } from "@rsva/policy";
import { GROUP_EVENTS, type GroupEvent, type TelegramGroupLink, type TelegramGroupView, type TelegramView } from "@rsva/protocol";
import { settingsPath } from "@rsva/schema/models";
import { and, eq, gt, inArray, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { roleIn } from "../auth/access.ts";
import { PUBLIC_ORIGIN, type Mail } from "../auth/mail.ts";
import { freshBrowser, freshBrowserMailed, requireActor } from "../auth/routes.ts";
import { sha256 } from "../auth/secret.ts";
import { db, schema } from "../db.ts";
import { parse } from "../http.ts";
import { telegramGroupLinkedMail } from "../mail/emails.ts";
import { html } from "../mail/template.ts";
import { TelegramError, type Buttons, type TelegramApi } from "./api.ts";
import { reply } from "./answer.ts";
import { chatFailed, chatWorks } from "./chats.ts";
import { freshCode } from "./code.ts";
import { held, wake } from "./wait.ts";

const { telegramGroup, telegramGroupCode, telegramChat, member, workspace, user, project } = schema;

const waitKey = (userId: string) => `group ${userId}`;

/** The group chats the person may change: the ones they linked, and as an admin every one of the workspace. */
export async function groupsOf(userId: string): Promise<TelegramGroupView[]> {
  const rows = await db
    .select({ g: telegramGroup, role: member.role, linker: user.name })
    .from(telegramGroup)
    .innerJoin(member, and(eq(member.workspaceId, telegramGroup.workspaceId), eq(member.userId, userId)))
    .innerJoin(user, eq(user.id, telegramGroup.linkedBy))
    .orderBy(telegramGroup.linkedAt);
  return rows
    .filter((r) => mayRead(r.role) && isRole(r.role) && (r.g.linkedBy === userId || mayManage(r.role)))
    .map(({ g, linker }) => ({
      id: g.id,
      workspaceId: g.workspaceId,
      title: g.title,
      members: g.members,
      linkedBy: linker,
      linkedByMe: g.linkedBy === userId,
      linkedAt: g.linkedAt,
      projectIds: g.projectIds,
      events: g.events.filter((e): e is GroupEvent => GROUP_EVENTS.some((x) => x.id === e)),
      error: g.error,
      errorAt: g.errorAt,
    }));
}

/** A group the person may change, or a 404 that does not say whether it exists. */
async function changeable(userId: string, id: string) {
  const [g] = z.uuid().safeParse(id).success ? await db.select().from(telegramGroup).where(eq(telegramGroup.id, id)) : [];
  const role = g ? await roleIn(g.workspaceId, userId) : null;
  if (!g || !mayRead(role) || (g.linkedBy !== userId && !mayManage(role!))) throw Object.assign(new Error("No such group chat."), { statusCode: 404 });
  return g;
}

interface GroupMessage {
  message_id?: number;
  text?: string;
  chat: { id: number; type: string; title?: string };
  migrate_to_chat_id?: number;
  new_chat_title?: string;
}


/**
 * A message in a group the bot is in. Telegram sends a bot in privacy mode only commands, replies to it and service
 * messages: a code (`/link <code>`, or `/start <code>` from the startgroup link), the group's new title, or its move
 * to a supergroup. A command for another bot (`/link@other_bot`) is not ours. `notify` sends the linker's notice; the
 * answer does not wait for it.
 */
export async function groupMessage(m: GroupMessage, api: TelegramApi, notify: (m: Mail) => void): Promise<object> {
  if (m.migrate_to_chat_id) {
    await db.update(telegramGroup).set({ chatId: m.migrate_to_chat_id }).where(eq(telegramGroup.chatId, m.chat.id));
    return {};
  }
  if (m.new_chat_title) {
    await db.update(telegramGroup).set({ title: m.new_chat_title.slice(0, 120) }).where(eq(telegramGroup.chatId, m.chat.id));
    return {};
  }
  const [head, code] = (m.text ?? "").trim().split(/\s+/, 2);
  const [command, to] = (head ?? "").split("@", 2);
  if (command !== "/link" && command !== "/start" && command !== "/help") return {};
  if (to && to.toLowerCase() !== (await api.username().catch(() => "")).toLowerCase()) return {};
  if (command === "/help") return reply(m.chat.id, await groupHelp(m.chat.id));
  if (!code) return command === "/link" ? reply(m.chat.id, "To link this group, open Settings › Notifications › Telegram in recursiva and press Add a group chat.") : {};
  return link(m.chat, code.slice(0, 64), api, notify);
}

/** /help in a group (PLNR-358): what the group gets and who linked it; the commands are for the person's own chat. */
async function groupHelp(chatId: number): Promise<string> {
  const rows = await db
    .select({ projectIds: telegramGroup.projectIds, events: telegramGroup.events, by: user.name })
    .from(telegramGroup)
    .innerJoin(user, eq(user.id, telegramGroup.linkedBy))
    .where(eq(telegramGroup.chatId, chatId));
  const own = "Commands such as /new, /find and /triage work in your own chat with the bot.";
  if (!rows.length) return `This group is not linked to recursiva. To link it, open Settings › Notifications › Telegram and press Add a group chat. ${own}`;
  const keys = new Map((await db.select({ id: project.id, key: project.key }).from(project).where(inArray(project.id, rows.flatMap((r) => r.projectIds).concat(["00000000-0000-0000-0000-000000000000"])))).map((p) => [p.id, p.key]));
  const lines = rows.map((r) => {
    const events = GROUP_EVENTS.filter((e) => r.events.includes(e.id)).map((e) => e.label);
    const where = r.projectIds.map((id) => keys.get(id)).filter(Boolean);
    return events.length && where.length ? html`This group gets ${events.join(", ")} of ${where.join(", ")}. Linked by ${r.by}.` : html`Linked by ${r.by}; nothing is picked for it yet.`;
  });
  return html`${lines.map((l, i) => [i ? "\n" : "", l])}\n\n${own}`.value;
}

async function link(chat: GroupMessage["chat"], code: string, api: TelegramApi, notify: (m: Mail) => void) {
  const [row] = await db
    .delete(telegramGroupCode)
    .where(and(eq(telegramGroupCode.id, sha256(code)), gt(telegramGroupCode.expiresAt, dsql`now()`)))
    .returning({ userId: telegramGroupCode.userId, workspaceId: telegramGroupCode.workspaceId });
  if (!row) return reply(chat.id, "This code has expired or was already used. In recursiva, press Add a group chat again for a new one.");
  const role = await roleIn(row.workspaceId, row.userId);
  if (!mayRead(role)) return reply(chat.id, "Whoever asked for this code no longer has access to that workspace.");
  const members = await api.memberCount(chat.id).catch(() => null);
  const title = (chat.title ?? "Group chat").slice(0, 120);
  const linked = { title, members, linkedBy: row.userId, linkedAt: new Date().toISOString(), error: null, errorAt: null };
  // A group linked before keeps what it was given when its linker or an admin links it again (Reconnect after the bot
  // was removed). Another member who links it takes it over with nothing picked: they choose again, rather than
  // inheriting someone else's choice and the right to change it.
  const keep = mayManage(role!) ? dsql`true` : dsql`${telegramGroup.linkedBy} = ${row.userId}`;
  await db
    .insert(telegramGroup)
    .values({ workspaceId: row.workspaceId, chatId: chat.id, ...linked })
    .onConflictDoUpdate({
      target: [telegramGroup.workspaceId, telegramGroup.chatId],
      set: {
        ...linked,
        projectIds: dsql`case when ${keep} then ${telegramGroup.projectIds} else '{}'::uuid[] end`,
        events: dsql`case when ${keep} then ${telegramGroup.events} else '{}'::text[] end`,
      },
    });
  wake(waitKey(row.userId));
  const [[ws], [who]] = await Promise.all([
    db.select({ name: workspace.name, slug: workspace.slug }).from(workspace).where(eq(workspace.id, row.workspaceId)),
    db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, row.userId)),
  ]);
  if (who) notify(telegramGroupLinkedMail({ to: who.email, groupTitle: title, workspaceName: ws!.name, origin: PUBLIC_ORIGIN ?? "" }));
  const settings = `${PUBLIC_ORIGIN ?? ""}${settingsPath(ws!.slug, "notifications/telegram")}`;
  return reply(chat.id, html`<b>recursiva is connected</b>\nThis group will get notifications from ${ws!.name}, linked by ${who?.name ?? "a member"}. Which projects and events come here is chosen in <a href="${settings}">Settings › Notifications › Telegram</a>.`.value);
}

/** The bot's own membership changed: blocked or unblocked in a personal chat, removed from a group. */
export async function membershipChanged(u: { chat: { id: number; type: string }; new_chat_member?: { status?: string } }): Promise<void> {
  const status = u.new_chat_member?.status;
  const gone = status === "left" || status === "kicked";
  // The person blocked the bot: delivery stops now, not at the next message. Unblocked: it works again.
  if (u.chat.type === "private") {
    if (status === "kicked") await chatFailed(eq(telegramChat.chatId, u.chat.id), "Bot blocked");
    else if (status === "member") await chatWorks(eq(telegramChat.chatId, u.chat.id));
  } else if (gone) await groupFailed(u.chat.id, "Bot removed");
}

/** A group that will not take messages: marked, and nothing more goes to it until it is linked again. */
export const groupFailed = (chatId: number, reason: string) =>
  db.update(telegramGroup).set({ error: reason, errorAt: dsql`now()` }).where(and(eq(telegramGroup.chatId, chatId), dsql`${telegramGroup.error} is null`));

/** Sends to a group, and to its new id when it became a supergroup meanwhile: the row and `g.chatId` follow it there. */
export function sendToGroup(api: TelegramApi, g: { chatId: number }, html: string, buttons?: Buttons): Promise<number> {
  return api.send(g.chatId, html, { ...(buttons ? { buttons } : {}) }).catch(async (e: unknown) => {
    if (!(e instanceof TelegramError && e.migrateTo)) throw e;
    await db.update(telegramGroup).set({ chatId: e.migrateTo }).where(eq(telegramGroup.chatId, g.chatId));
    g.chatId = e.migrateTo;
    return api.send(g.chatId, html, { ...(buttons ? { buttons } : {}) });
  });
}

const groupPatch = z
  .object({
    projectIds: z.array(z.uuid()).max(200),
    events: z.array(z.enum(GROUP_EVENTS.map((e) => e.id) as [GroupEvent, ...GroupEvent[]])).max(GROUP_EVENTS.length),
  })
  .partial()
  .strict();

/** What a group gets, as project and event pairs: a patch that adds one widens it (PLNR-246). */
const reach = (projectIds: readonly string[], events: readonly string[]) => new Set(projectIds.flatMap((p) => events.map((e) => `${p} ${e}`)));

export function registerTelegramGroups(app: FastifyInstance, tg: { api: TelegramApi } | null, view: (userId: string) => Promise<TelegramView>): void {
  const session = { preHandler: requireActor({ sessionOnly: true }) };

  app.post<{ Body: unknown }>("/auth/telegram/groups/link", session, async (req, reply): Promise<TelegramGroupLink | typeof reply> => {
    const body = parse(z.object({ workspaceId: z.uuid() }).strict(), req.body);
    if (!tg) throw Object.assign(new Error("Telegram is not set up on this server."), { statusCode: 503 });
    freshBrowserMailed(req, "link a group chat");
    const userId = req.actor!.userId;
    if (!mayRead(await roleIn(body.workspaceId, userId))) throw Object.assign(new Error("No such workspace."), { statusCode: 404 });
    const { bot, code, id, createdAt, expiresAt } = await freshCode(tg.api);
    await db
      .insert(telegramGroupCode)
      .values({ id, userId, workspaceId: body.workspaceId, expiresAt })
      .onConflictDoUpdate({ target: telegramGroupCode.userId, set: { id, workspaceId: body.workspaceId, expiresAt } });
    return { code, url: `https://t.me/${bot}?startgroup=${code}`, command: `/link@${bot} ${code}`, createdAt, expiresAt };
  });

  // Held until a group is linked by this person or the wait runs out, then answered with their Telegram either way.
  app.get("/auth/telegram/groups/wait", session, async (req, reply): Promise<TelegramView> => {
    await held(waitKey(req.actor!.userId), reply);
    return view(req.actor!.userId);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/auth/telegram/groups/:id", session, async (req, reply) => {
    const g = await changeable(req.actor!.userId, req.params.id);
    const patch = parse(groupPatch, req.body);
    if (patch.projectIds?.length) {
      const ids = [...new Set(patch.projectIds)];
      const found = await db.select({ id: project.id }).from(project).where(and(eq(project.workspaceId, g.workspaceId), inArray(project.id, ids)));
      if (found.length !== ids.length) return reply.code(400).send({ error: "bad_ref", message: "A project is not in this workspace." });
      patch.projectIds = ids;
    }
    if (patch.events) patch.events = [...new Set(patch.events)];
    // Narrowing stays open to any session: that is protection, not new access.
    const before = reach(g.projectIds, g.events);
    const widened = [...reach(patch.projectIds ?? g.projectIds, patch.events ?? g.events)].some((x) => !before.has(x));
    if (widened) freshBrowser(req, "widen a group chat");
    await db.update(telegramGroup).set(patch).where(eq(telegramGroup.id, g.id));
    return reply.code(204).send();
  });

  // Removed: nothing more goes there (its pending messages go with it), and the bot leaves the group.
  app.delete<{ Params: { id: string } }>("/auth/telegram/groups/:id", session, async (req, reply) => {
    const g = await changeable(req.actor!.userId, req.params.id);
    await db.delete(telegramGroup).where(eq(telegramGroup.id, g.id));
    // Another workspace may still have the same group linked: the bot stays for it.
    const [still] = await db.select({ id: telegramGroup.id }).from(telegramGroup).where(eq(telegramGroup.chatId, g.chatId)).limit(1);
    if (tg && !still && !g.error) await tg.api.leave(g.chatId).catch((e: unknown) => req.log.warn(e, "the bot could not leave a removed group"));
    return reply.code(204).send();
  });
}
