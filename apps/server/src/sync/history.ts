// What an opened issue loads beyond the snapshot: GET /sync/history/:issueId[?until=<time>].
//
// One REPEATABLE READ transaction reads the issue's log entries, comments and reactions together with the workspace's
// lastSyncId, so the client can apply deltas after `s` on top without gaps or double counting (the same cut as the
// snapshot). History is the log itself: actions on the issue with their stored before-values (`sync_action.prev`),
// found through the (model_id, id) index; there is no separate activity table to keep in step.
//
// Pages (PLNR-32). The answer used to hold everything, built in memory: a member could fill one issue with thousands of
// 64 KB comments and have every opening of it cost hundreds of megabytes. Now an answer holds the newest activity up to
// about HISTORY_PAGE_BYTES (comment text plus a fixed amount per item) and says where older activity starts (`older`);
// the client asks for the page before that with `until`. One time cut for entries, comments and reactions alike, so a
// page is a stretch of the timeline the activity panel draws as it is. Considered: a count per kind (entries, comments)
// bounds neither bytes nor the timeline's continuity; cursors per kind make the client merge two half-pages.
import { descriptionEntry, githubOf, historyFields, movedFrom, type HistoryEntry, type IssueHistory, type Via } from "@rsva/protocol";
import { and, asc, eq, gt, inArray, lte, sql as dsql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, schema, type Tx } from "../db.ts";
import { issueLinks } from "../github/pull.ts";
import { ISSUE_MODEL_COLUMNS } from "./columns.ts";
import { reads } from "./limits.ts";

const { workspace, issue, comment, reaction, document, syncAction } = schema;

/** Bytes of activity a page holds at most, about: comment text plus ITEM_BYTES for every entry, comment and reaction. */
const HISTORY_PAGE_BYTES = 2 ** 20;
/** What an item weighs besides a comment's text: ids, times, an entry's fields. */
export const ITEM_BYTES = 300;

/** The issues' log entries that make history: changes and archiving, not creation. */
export const entriesOf = (issueIds: string[], workspaceId: string) =>
  and(inArray(syncAction.modelId, issueIds), eq(syncAction.workspaceId, workspaceId), inArray(syncAction.model, ["Issue", "Document"]), inArray(syncAction.action, ["U", "A"]));

// The document's own text stays out: an entry only says the description changed.
export const ENTRY_COLUMNS = { id: syncAction.id, mid: syncAction.modelId, m: syncAction.model, a: syncAction.action, by: syncAction.actorId, at: syncAction.createdAt, d: dsql<unknown>`${syncAction.data} - 'doc'`, p: syncAction.prev, via: syncAction.via };

/** A log row as a history entry; an update of nothing history shows is none. */
export function toEntry(e: { id: number; m: string; a: string; by: string | null; at: string; d: unknown; p: unknown; via?: string | null }): HistoryEntry | null {
  const via: { via?: Via } = e.via === "telegram" || e.via === "email" ? { via: e.via } : {};
  if (e.m === "Document") return { ...descriptionEntry(e.id, e.by, e.at), ...via };
  const d = historyFields(e.d);
  const gh = githubOf(e.d);
  if (e.a === "U" && Object.keys(d).length === 0 && !gh.gh) return null;
  return { id: e.id, a: e.a as HistoryEntry["a"], by: e.by, at: e.at, d, p: historyFields(e.p), ...gh, ...via, ...movedFrom(e.d) };
}

/** Every item of an issue's activity with its size, for pageStart. */
const issueItems = (issueId: string, workspaceId: string, upTo: (at: PgColumn) => SQL) => dsql`
  select ${syncAction.createdAt} as at, ${ITEM_BYTES} as n from ${syncAction} where ${entriesOf([issueId], workspaceId)} and ${upTo(syncAction.createdAt)}
  union all
  select ${comment.createdAt}, octet_length(${comment.body}) + ${ITEM_BYTES} from ${comment} where ${comment.issueId} = ${issueId} and ${upTo(comment.createdAt)}
  union all
  select ${reaction.createdAt}, ${ITEM_BYTES} from ${reaction} where ${reaction.issueId} = ${issueId} and ${upTo(reaction.createdAt)}`;

/**
 * A page for a reader, counted against their read budget (sync/limits.ts): a whole page is reserved before reading, so
 * many requests at once cannot all start, and what the answer did not use is given back.
 */
export function readHistory(userId: string, issueId: string, until?: string): Promise<IssueHistory | null | "rate_limited"> {
  return metered(userId, HISTORY_PAGE_BYTES * 2, () => issueHistory(issueId, until));
}

/** A read of up to `reserve` bytes of answer, counted against the reader's budget; null answers cost nothing. */
export async function metered<T>(userId: string, reserve: number, read: () => Promise<T | null>): Promise<T | null | "rate_limited"> {
  if (!reads.take(userId, reserve)) return "rate_limited";
  let used = reserve;
  try {
    const h = await read();
    used = h ? Math.min(reserve, JSON.stringify(h).length) : 0;
    return h;
  } finally {
    reads.refund(userId, reserve - used);
  }
}

/**
 * The newest page of the issue's activity at or before `until` (all of it when omitted), or null when there is no such
 * issue. The description comes with the first page only.
 */
async function issueHistory(issueId: string, until?: string): Promise<IssueHistory | null> {
  return db.transaction(
    async (tx) => {
      const [row] = await tx
        .select({ s: workspace.lastSyncId, workspaceId: issue.workspaceId })
        .from(issue)
        .innerJoin(workspace, eq(workspace.id, issue.workspaceId))
        .where(eq(issue.id, issueId));
      if (!row) return null;
      const { from, older } = await pageStart(tx, (upTo) => issueItems(issueId, row.workspaceId, upTo), until, HISTORY_PAGE_BYTES);
      const page = inPage(from, until);
      const [log, comments, reactions, github, [doc]] = await Promise.all([
        tx
          .select(ENTRY_COLUMNS)
          .from(syncAction)
          // Creation is not an entry: the client draws it from the issue's createdAt, also for imported issues.
          .where(and(entriesOf([issueId], row.workspaceId), page(syncAction.createdAt)))
          .orderBy(asc(syncAction.id)),
        tx.select(ISSUE_MODEL_COLUMNS.Comment).from(comment).where(and(eq(comment.issueId, issueId), page(comment.createdAt))).orderBy(asc(comment.createdAt)),
        tx.select(ISSUE_MODEL_COLUMNS.Reaction).from(reaction).where(and(eq(reaction.issueId, issueId), page(reaction.createdAt))).orderBy(asc(reaction.createdAt)),
        until === undefined ? issueLinks(tx, [issueId]) : Promise.resolve([]),
        until === undefined ? tx.select(ISSUE_MODEL_COLUMNS.Document).from(document).where(eq(document.id, issueId)) : Promise.resolve([]),
      ]);
      const history = log.map(toEntry).filter((e) => e !== null);
      return { s: row.s, history, comments, reactions, github, doc: doc ?? null, older };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Where a page of activity starts. `items` selects `at` and `n` (bytes, about) of every item of the activity at or before
 * `until` (it gets the condition to apply to each source's time). Walking them from the newest, the first item past
 * `budget` marks the cut: the page takes what is newer, and `older` is the cut itself (the next page's `until`, so items
 * at that very moment are not lost). Items of one moment come from one transaction, which is at most 500 ops and 1 MiB:
 * if they alone fill a page, the page is that moment and `older` the moment before. Only sizes are read here
 * (octet_length of a toasted text does not decompress it), and the times stay Postgres text: a JS Date would drop the
 * microseconds.
 */
export async function pageStart(
  tx: Tx,
  items: (upTo: (at: PgColumn) => SQL) => SQL,
  until: string | undefined,
  budget: number,
): Promise<{ from: PageFrom; older: string | null }> {
  const upTo = (at: PgColumn) => (until === undefined ? dsql`true` : lte(at, until));
  const [r] = (await tx.execute(dsql`
    with items as (${items(upTo)}), run as (
      select at, sum(n) over (order by at desc rows between unbounded preceding and current row) as total from items
    ), cut as (select max(at) as at from run where total > ${budget})
    select (select at from cut)::text as cut, (select max(at) from items)::text as newest,
      (select max(at) from items where at < (select at from cut))::text as before`)) as unknown as [{ cut: string | null; newest: string | null; before: string | null }];
  if (r!.cut === null) return { from: null, older: null };
  if (r!.cut !== r!.newest) return { from: { at: r!.cut, exact: false }, older: r!.cut };
  // One moment fills the page: take it alone; older starts at the moment before it.
  return { from: { at: r!.cut, exact: true }, older: r!.before };
}

type PageFrom = { at: string; exact: boolean } | null;

/** Items in a page: after `from` (or exactly at it, when one moment alone fills a page) and at or before `until`. */
export const inPage = (from: PageFrom, until: string | undefined) => (at: PgColumn): SQL | undefined =>
  and(from === null ? undefined : from.exact ? eq(at, from.at) : gt(at, from.at), until === undefined ? undefined : lte(at, until));
