// Deleting an issue for good (RSVA-457, ADR 0050). Deleting puts an issue in its project's trash (deletedAt, PLNR-33);
// from there a person takes it out for good with Delete permanently, and the app's bot does it to every issue that has been
// in the trash for TRASH_DAYS, as Linear and Plane empty theirs.
//
// One transaction per issue. First the other issues let go of it, each a logged change in their history: sub-issues lose
// their parent, and relations to it (blocked by, related, duplicate of) go. Then everything that is the issue's own goes
// with its row: the description, comments, reactions, links and files, GitHub links, inbox marks and queued
// notifications. The log gets one D for the issue: open clients drop it, and a snapshot made after never had it.
//
// The log's earlier rows of the issue stay. Removing them would leave holes in the numbering, and a client reads a hole
// as a missed frame and asks again from before it, for ever (packages/sync/src/client.ts, onDelta). They forget the words,
// though (RSVA-609): a catch-up from an early number would otherwise hand any member the title, the comments, the links
// and the last description of an issue deleted for good. What stays is ids, numbers, times and choices (state, labels,
// people). The issue's history is no longer reachable (it is read by the issue), and the inbox and the timelines skip an
// issue that is not there. A client that already holds those actions keeps what it has.
// Files' bytes stay in `blob`, as when one file is detached: the same bytes may be another issue's or a picture in a text.
//
// The sweep runs at the server's start and every hour (main.ts), as the cycle rollover does, and looks at state, not at
// the clock: a server that was off catches up on its first run, and two sweeps at once purge each issue once (the row is
// locked and read again in the transaction).
import { mayDeleteIssue } from "@rsva/policy";
import { APP_BOT, TRASH_DAYS } from "@rsva/schema/models";
import { and, arrayContains, asc, eq, lt, or, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import { asBot } from "./bots.ts";
import { TxError, type Pending } from "./tx-error.ts";
import { forgetText } from "./log.ts";
import { roleOf, updateIssue } from "./write.ts";

const { issue, comment, reaction, attachment, githubLink, inboxMark, notifyOutbox, document, user, syncAction } = schema;

/** A person's Delete permanently: an issue in the trash, by its creator or an admin, never by an agent. */
export async function purgeIssueAs(tx: Tx, workspaceId: string, actorId: string, id: string): Promise<Pending[]> {
  const row = await lockTrashed(tx, workspaceId, id);
  if (!row) throw new TxError("not_found", `no issue ${id}`);
  if (!row.deletedAt) throw new TxError("invalid", "only an issue in the trash is deleted permanently: delete it first");
  const [u] = await tx.select({ kind: user.kind }).from(user).where(eq(user.id, actorId));
  if (u?.kind !== "human") throw new TxError("forbidden", "an issue is deleted permanently by a person, not an agent");
  if (!mayDeleteIssue(await roleOf(tx, workspaceId, actorId), row.createdById === actorId))
    throw new TxError("forbidden", "only the issue's creator or an admin deletes it permanently");
  return purge(tx, workspaceId, actorId, row);
}

/**
 * Deletes for good every issue in the trash for over TRASH_DAYS, oldest first, each in its own transaction signed by the
 * app's bot: one that fails is tried again next time and leaves the others done. Returns how many it deleted.
 */
export async function sweepTrash(onError: (e: unknown, issueId: string) => void, now = new Date()): Promise<number> {
  const due = await db
    .select({ id: issue.id, workspaceId: issue.workspaceId })
    .from(issue)
    .where(lt(issue.deletedAt, cutoff(now)))
    .orderBy(asc(issue.deletedAt), asc(issue.id));
  let purged = 0;
  for (const i of due) {
    try {
      const r = await asBot(i.workspaceId, APP_BOT, async (tx, bot) => {
        // Read again under the lock: a person may have restored it, or another sweep deleted it, since the list.
        const row = await lockTrashed(tx, i.workspaceId, i.id, cutoff(now));
        return row ? purge(tx, i.workspaceId, bot, row) : [];
      });
      if (r.actions.some((a) => a.m === "Issue" && a.a === "D")) purged++;
    } catch (e) {
      onError(e, i.id);
    }
  }
  return purged;
}

/** The moment before which a deletion is old enough for the sweep. */
const cutoff = (now: Date) => new Date(now.getTime() - TRASH_DAYS * 86_400_000).toISOString();

/** The issue, locked; with `before`, only if it went to the trash before then. */
async function lockTrashed(tx: Tx, workspaceId: string, id: string, before?: string) {
  const [row] = await tx
    .select({ id: issue.id, projectId: issue.projectId, createdById: issue.createdById, deletedAt: issue.deletedAt })
    .from(issue)
    .where(and(eq(issue.id, id), eq(issue.workspaceId, workspaceId), before === undefined ? undefined : lt(issue.deletedAt, before)))
    .for("update");
  return row;
}

async function purge(tx: Tx, workspaceId: string, actorId: string, row: { id: string; projectId: string }): Promise<Pending[]> {
  const { id } = row;
  const out: Pending[] = [];
  // The other issues let go of it first: each change is theirs, in their history, made by whoever deletes.
  const holding = await tx
    .select({ id: issue.id, parentId: issue.parentId, blockedByIds: issue.blockedByIds, relatedIds: issue.relatedIds, duplicateOfId: issue.duplicateOfId })
    .from(issue)
    .where(
      and(
        eq(issue.workspaceId, workspaceId),
        or(eq(issue.parentId, id), eq(issue.duplicateOfId, id), arrayContains(issue.blockedByIds, [id]), arrayContains(issue.relatedIds, [id])),
      ),
    );
  for (const h of holding) {
    const set = {
      ...(h.parentId === id ? { parentId: null } : {}),
      ...(h.duplicateOfId === id ? { duplicateOfId: null } : {}),
      ...(h.blockedByIds.includes(id) ? { blockedByIds: h.blockedByIds.filter((x) => x !== id) } : {}),
      ...(h.relatedIds.includes(id) ? { relatedIds: h.relatedIds.filter((x) => x !== id) } : {}),
    };
    const p = await updateIssue(tx, workspaceId, actorId, false, h.id, set);
    if (p) out.push(p);
  }
  // The log's earlier actions of the issue, its description, its comments and its links (GitHub's too), also those
  // removed before, forget their words while the rows that say which are still here (forgetText). A removed link has no
  // row left: it is found by its I action in the log. That one lookup reads the workspace's log (0.1 to 0.7 s a million
  // actions, measured); it runs only here, outside the workspace lock, and costs the writes nothing.
  await forgetText(
    tx,
    workspaceId,
    dsql`select 'Issue', ${id}::uuid union all select 'Document', ${id}::uuid
      union all select 'Comment', ${comment.id} from ${comment} where ${comment.issueId} = ${id}
      union all select 'Attachment', ${attachment.id} from ${attachment} where ${attachment.issueId} = ${id}
      union all select 'GithubLink', ${githubLink.id} from ${githubLink} where ${githubLink.issueId} = ${id}
      union all select ${syncAction.model}, ${syncAction.modelId} from ${syncAction}
        where ${syncAction.workspaceId} = ${workspaceId} and ${syncAction.model} in ('Attachment', 'GithubLink') and ${syncAction.action} = 'I' and ${syncAction.data} ->> 'issueId' = ${id}`,
  );
  // Reactions point at comments: they go before them.
  await tx.delete(reaction).where(eq(reaction.issueId, id));
  await tx.delete(comment).where(eq(comment.issueId, id));
  for (const t of [attachment, githubLink, inboxMark, notifyOutbox] as const) await tx.delete(t).where(eq(t.issueId, id));
  await tx.delete(document).where(eq(document.id, id));
  await tx.delete(issue).where(eq(issue.id, id));
  out.push({ m: "Issue", mid: id, a: "D", d: { projectId: row.projectId } });
  return out;
}

