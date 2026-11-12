// Links to the old repository, pointed at its archive (RSVA-591). On switch-over day r3cursiva/recursiva is renamed
// recursiva-archive and a new repository takes the name. GitHub redirects nothing to the new one for an old PR link:
// `/pull/12` of the old name would open pull request 12 of the new repository. A link someone attached by hand is
// stored as typed, so those made before the switch move to the archive's name. A dry run unless `as` names who writes.
//
// Only attachments (kind link, github_pr, github_commit): the links the GitHub integration makes are github_link rows,
// kept by repository id, and follow the rename with `github.ts sync`. Every change goes through the write path an edit
// takes (sync/write.ts, as rehost.ts does), so it is logged and open windows get it.
import { and, eq, inArray, isNull, lt, sql as dsql } from "drizzle-orm";
import { db, issueKeySql, schema } from "./db.ts";
import { writer } from "./rehost.ts";
import { applyServerChange, editLink } from "./sync/write.ts";
import type { Pending } from "./sync/tx-error.ts";

const { workspace, project, issue, attachment } = schema;

const OLD_PREFIX = "https://github.com/r3cursiva/recursiva/";
const NEW_PREFIX = "https://github.com/r3cursiva/recursiva-archive/";

export interface Moved {
  ws: string;
  key: string;
  id: string;
  url: string;
  to: string;
}

/** The new address of a link to the old repository, or null for any other. The match is case-blind, as GitHub's. */
export const moveLink = (url: string): string | null => (url.toLowerCase().startsWith(OLD_PREFIX) ? NEW_PREFIX + url.slice(OLD_PREFIX.length) : null);

export interface RelinkOptions {
  /** Only attachments created before this moment: the ones made after the switch mean the new repository. */
  before: Date;
  /** Write as this member (an email); without it nothing is written. */
  as?: string;
}

/** The attachments to move, live issues only. */
function find(tx: Pick<typeof db, "select">, before: Date, ids?: string[]) {
  return tx
    .select({ workspaceId: attachment.workspaceId, ws: workspace.slug, key: issueKeySql, id: attachment.id, url: attachment.url })
    .from(attachment)
    .innerJoin(issue, eq(issue.id, attachment.issueId))
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(workspace, eq(workspace.id, attachment.workspaceId))
    .where(
      and(
        isNull(issue.deletedAt),
        inArray(attachment.kind, ["link", "github_pr", "github_commit"]),
        dsql`lower(${attachment.url}) like ${OLD_PREFIX.toLowerCase() + "%"}`,
        lt(attachment.createdAt, before.toISOString()),
        ids ? inArray(attachment.workspaceId, ids) : undefined,
      ),
    )
    .orderBy(workspace.slug, attachment.createdAt);
}

const report = ({ workspaceId: _, ...r }: Awaited<ReturnType<typeof find>>[number]): Moved => ({ ...r, to: moveLink(r.url)! });

/** Counts and, given `as`, rewrites: each workspace in one transaction that reads its links again, so an edit made since the report is not lost. */
export async function relink(o: RelinkOptions): Promise<Moved[]> {
  const found = await find(db, o.before);
  if (!o.as) return found.map(report);
  const { actorId, touched } = await writer(o.as, found);
  const written: Moved[] = [];
  for (const id of touched)
    await applyServerChange(id, actorId, async (tx) => {
      const rows = await find(tx, o.before, [id]);
      const out: Pending[] = [];
      for (const r of rows) {
        const p = await editLink(tx, id, r.id, { url: moveLink(r.url)! });
        if (p) out.push(p);
      }
      written.push(...rows.map(report));
      return out;
    });
  return written;
}
