// The buttons under a notification (PLNR-361): Open, which is a link to the issue, and Snooze 2h, which snoozes the issue's
// line in the person's inbox as the web inbox does (a mark with `snoozedId` = the line's latest event and `snoozedUntil`),
// so it shows in their open tabs at once and wakes on a newer event. A group chat gets Open alone.
import { mayRead } from "@rsva/policy";
import { blankMark, wallClock } from "@rsva/protocol";
import { UUID, issueKey, issuePath } from "@rsva/schema/models";
import { eq } from "drizzle-orm";
import { linesOf, writeLineMarks } from "../api-inbox.ts";
import { roleIn } from "../auth/access.ts";
import { PUBLIC_ORIGIN } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { prefsOf } from "../notify/prefs.ts";
import { redrawButtons } from "./answer.ts";
import type { Buttons, TelegramApi } from "./api.ts";

const { issue, project, workspace } = schema;

/** How long Snooze 2h hides the line. */
const SNOOZE_MS = 2 * 3_600_000;
const GONE = "You cannot see this issue any more";

/**
 * The buttons under a message about an issue: Open, and Snooze 2h unless `snoozedUntil` says the line sleeps already, which
 * the second button then states (pressing it answers the same). The third, ⋯, turns the message into the issue's card (card.ts).
 */
export function noticeButtons(link: string, issueId: string | null, snoozedUntil?: string): Buttons {
  const open = { text: "Open", url: link };
  if (!issueId) return [[open]];
  return [[open, snoozedUntil ? { text: `Snoozed until ${snoozedUntil}`, data: `sn:${issueId}` } : { text: "Snooze 2h", data: `sn:${issueId}` }, { text: "⋯", data: `c:x:${issueId}` }]];
}

/** A pressed Snooze 2h of `userId`'s own chat: answers the press, and returns the buttons redrawn when it snoozed. */
export async function pressSnooze(api: TelegramApi, callbackId: string, chatId: number, messageId: number, userId: string, issueId: string, now = new Date()) {
  const [row] = UUID.test(issueId)
    ? await db
        .select({ workspaceId: issue.workspaceId, deletedAt: issue.deletedAt, key: project.key, number: issue.number, slug: workspace.slug })
        .from(issue)
        .innerJoin(project, eq(project.id, issue.projectId))
        .innerJoin(workspace, eq(workspace.id, issue.workspaceId))
        .where(eq(issue.id, issueId))
    : [];
  const role = row && !row.deletedAt ? await roleIn(row.workspaceId, userId) : null;
  if (!row || !mayRead(role)) {
    await api.answerButton(callbackId, GONE).catch(() => {});
    return {};
  }
  const { groups, marks } = await linesOf(row.workspaceId, userId);
  const line = groups.find((g) => g.issueId === issueId);
  const { timeZone } = (await prefsOf([userId])).get(userId)!;
  const at = (until: string) => wallClock(new Date(until), timeZone ?? "UTC").time;
  if (!line) {
    await api.answerButton(callbackId, "Nothing to snooze: it is not in your inbox").catch(() => {});
    return {};
  }
  const open = `${PUBLIC_ORIGIN ?? ""}${issuePath(row.slug, issueKey(row.key, row.number))}`;
  if (line.snoozedUntil) {
    await api.answerButton(callbackId, `Already snoozed until ${at(line.snoozedUntil)}`).catch(() => {});
    return redrawButtons(chatId, messageId, noticeButtons(open, issueId, at(line.snoozedUntil)));
  }
  const until = new Date(now.getTime() + SNOOZE_MS).toISOString();
  await writeLineMarks(row.workspaceId, userId, [{ ...(marks.get(issueId) ?? blankMark(issueId)), snoozedId: line.latest.id, snoozedUntil: until }]);
  await api.answerButton(callbackId, `Snoozed until ${at(until)}`).catch(() => {});
  return redrawButtons(chatId, messageId, noticeButtons(open, issueId, at(until)));
}
