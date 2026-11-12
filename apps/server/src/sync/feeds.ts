// The activity of many issues in one answer: POST /sync/feeds (PLNR-80). The browser keeps it in IndexedDB, so opening an
// issue needs no request (docs/research/feed-prefetch-2026-10-30.md).
//
// Sizes first, rows after: one aggregate says what every candidate weighs without sending a body anywhere, then only what fits
// the budget is read, eight queries in one REPEATABLE READ transaction whatever the number of issues. Reading the issues
// one at a time (issueHistory) would cost eight queries an issue. An issue over FEED_ISSUE_BYTES stays out rather than
// spending the answer on one long discussion: it loads when opened, in pages. FEEDS_BYTES bounds what is read; an
// answer is built in memory like every history page, which it is two to four of.
import type { IssueFeeds } from "@rsva/protocol";
import { and, asc, desc, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import { issueLinks } from "../github/pull.ts";
import { ISSUE_MODEL_COLUMNS } from "./columns.ts";
import { ENTRY_COLUMNS, entriesOf, ITEM_BYTES, metered, toEntry } from "./history.ts";

const { workspace, issue, comment, reaction, document, syncAction } = schema;

/** Bytes of activity an answer holds at most, about: 3,800 of our issues, 6 s at the owner's 120 KB/s after compression. */
const FEEDS_BYTES = 4 * 2 ** 20;
/** The longest issue an answer takes: about 800 changes, so that the issues with the most going on are not the ones left out. */
const FEED_ISSUE_BYTES = 256 * 2 ** 10;
/** Issues looked at when none are named, most recently updated first; more would not fit FEEDS_BYTES anyway. */
const CANDIDATES = 4000;

const sizes = (tx: Tx, workspaceId: string, ids: string[] | undefined) =>
  tx
    .select({
      id: issue.id,
      // A row of the log, comment, reaction or GitHub link weighs ITEM_BYTES (the same count as history pages) on top of its text.
      // Names written out: inside a select's expression Drizzle drops the table from a column, and every `id` would be the
      // innermost one.
      n: dsql<string>`
        coalesce((select octet_length(d.doc::text) from document d where d.id = issue.id), 0)
        + (select coalesce(sum(octet_length(c.body) + ${ITEM_BYTES}), 0) from comment c where c.issue_id = issue.id)
        + (select count(*) * ${ITEM_BYTES} from reaction r where r.issue_id = issue.id)
        + (select count(*) * ${ITEM_BYTES} from github_link g where g.issue_id = issue.id)
        + (select count(*) * ${ITEM_BYTES} from sync_action a where a.model_id = issue.id and a.workspace_id = ${workspaceId})`,
    })
    .from(issue)
    .where(and(eq(issue.workspaceId, workspaceId), isNull(issue.deletedAt), ids ? inArray(issue.id, ids) : undefined))
    .orderBy(desc(issue.updatedAt))
    .limit(CANDIDATES);

/** The activity of `ids`, or of the most recently updated issues when omitted, counted against the reader's budget. */
export function readFeeds(userId: string, workspaceId: string, ids: string[] | undefined): Promise<IssueFeeds | null | "rate_limited"> {
  return metered(userId, FEEDS_BYTES * 2, () =>
    db.transaction(
      async (tx): Promise<IssueFeeds> => {
        const [w] = await tx.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, workspaceId));
        const picked: string[] = [];
        let total = 0;
        for (const { id, n } of await sizes(tx, workspaceId, ids)) {
          const bytes = Number(n);
          if (bytes > FEED_ISSUE_BYTES) continue;
          if (total + bytes > FEEDS_BYTES) break;
          total += bytes;
          picked.push(id);
        }
        if (!picked.length) return { s: w!.s, feeds: [] };
        const [log, comments, reactions, github, docs] = await Promise.all([
          tx.select(ENTRY_COLUMNS).from(syncAction).where(entriesOf(picked, workspaceId)).orderBy(asc(syncAction.id)),
          tx.select(ISSUE_MODEL_COLUMNS.Comment).from(comment).where(inArray(comment.issueId, picked)).orderBy(asc(comment.createdAt)),
          tx.select(ISSUE_MODEL_COLUMNS.Reaction).from(reaction).where(inArray(reaction.issueId, picked)).orderBy(asc(reaction.createdAt)),
          issueLinks(tx, picked),
          tx.select(ISSUE_MODEL_COLUMNS.Document).from(document).where(inArray(document.id, picked)),
        ]);
        const by = new Map(picked.map((id) => [id, { id, s: w!.s, history: [], comments: [], reactions: [], github: [], doc: null } as IssueFeeds["feeds"][number]]));
        for (const e of log) {
          const entry = toEntry(e);
          if (entry) by.get(e.mid)!.history.push(entry);
        }
        for (const c of comments) by.get(c.issueId)!.comments.push(c);
        for (const r of reactions) by.get(r.issueId)!.reactions.push(r);
        for (const l of github) by.get(l.issueId)!.github.push(l);
        for (const d of docs) by.get(d.id)!.doc = d;
        return { s: w!.s, feeds: [...by.values()] };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ),
  );
}
