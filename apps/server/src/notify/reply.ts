// A reply to a notification becomes a comment, whichever channel it came by: Telegram (PLNR-203) or email (PLNR-211).
// The channel proves who replied and finds the notification's notify_outbox row; from there it is the same write path
// and checks as a comment from the browser: the person's role now, their write budget, the issue not in the trash, and
// the thread of the comment the notification was about.
import { mayRead } from "@rsva/policy";
import { uuidv7, type Op, type Via } from "@rsva/protocol";
import { issueKey } from "@rsva/schema/models";
import { eq } from "drizzle-orm";
import { roleIn } from "../auth/access.ts";
import { db, schema } from "../db.ts";
import { writeAs } from "../telegram/write.ts";
import type { Outbox } from "./send.ts";

const { issue, project, comment } = schema;

/** What came of a reply: the issue's key when it posted, or why not; `why` is the write path's refusal, as HTML text. */
export type ReplyOutcome = { posted: string } | { refused: "access" } | { refused: "trash"; key: string } | { refused: "write"; key: string; why: string };

/**
 * Posts `body` as the row's person, on its issue, in the thread of its comment. `txId` makes a retried delivery a replay:
 * the email webhook derives it from the mail's id, so a second delivery of the same mail posts nothing new.
 */
export async function postReply(row: Pick<Outbox, "workspaceId" | "userId" | "issueId" | "commentId">, body: string, via: Via, txId: string = uuidv7()): Promise<ReplyOutcome> {
  const role = await roleIn(row.workspaceId, row.userId);
  const [i] = await db.select({ number: issue.number, key: project.key, deletedAt: issue.deletedAt }).from(issue).innerJoin(project, eq(project.id, issue.projectId)).where(eq(issue.id, row.issueId));
  if (!role || !mayRead(role) || !i) return { refused: "access" };
  const key = issueKey(i.key, i.number);
  if (i.deletedAt) return { refused: "trash", key };
  // A deleted comment leaves the reply at the top level.
  const [c] = row.commentId ? await db.select({ id: comment.id, parentId: comment.parentId, deletedAt: comment.deletedAt }).from(comment).where(eq(comment.id, row.commentId)) : [];
  const parentId = c && !c.deletedAt ? (c.parentId ?? c.id) : null;
  const ops: Op[] = [{ op: "create", m: "Comment", id: uuidv7(), set: { issueId: row.issueId, body, ...(parentId ? { parentId } : {}) } } as Op];
  const w = await writeAs(row.workspaceId, row.userId, role, ops, `comment on ${key}`, `Not posted to ${key}`, txId, via);
  if (!w.ok) return { refused: "write", key, why: w.why };
  return { posted: key };
}
