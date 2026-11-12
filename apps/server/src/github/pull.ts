// A pull request as stored and as clients see it.
import type { GithubLink, PullChecks, PullReview, PullState } from "@rsva/schema/models";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { schema, type Tx } from "../db.ts";

const { githubLink, githubPull, githubRepo, issue } = schema;

export type PullRow = typeof githubPull.$inferSelect;
export type LinkRow = typeof githubLink.$inferSelect;

/** One reviewer asking for changes outweighs the others; closed pull requests nobody reviewed say nothing. */
function reviewOf(reviews: Record<string, string>, state: string): PullReview | null {
  const v = Object.values(reviews);
  if (v.includes("changes")) return "changes";
  if (v.includes("approved")) return "approved";
  return state === "open" || state === "draft" ? "required" : null;
}

function checksOf(checks: Record<string, string>): { checks: PullChecks | null; failing: number } {
  const v = Object.values(checks);
  const failing = v.filter((c) => c === "fail").length;
  return { checks: !v.length ? null : failing ? "fail" : v.includes("run") ? "run" : "pass", failing };
}

/** The row a client gets for a pull request's link. */
export function pullLink(l: Pick<LinkRow, "id" | "issueId" | "closing">, p: PullRow, repo: string): GithubLink {
  return {
    id: l.id,
    issueId: l.issueId,
    kind: "pull",
    repo,
    number: p.number,
    sha: null,
    title: p.title,
    state: p.state as PullState,
    head: p.head,
    base: p.base,
    review: reviewOf(p.reviews, p.state),
    ...checksOf(p.checks),
    author: p.author,
    authorBot: p.authorBot,
    at: p.updatedAt,
    closing: l.closing,
  };
}

/** The row a client gets for a commit's link. */
export function commitLink(l: LinkRow, repo: string): GithubLink {
  return {
    id: l.id,
    issueId: l.issueId,
    kind: "commit",
    repo,
    number: null,
    sha: l.sha,
    title: l.message ?? "",
    state: null,
    head: null,
    base: null,
    review: null,
    checks: null,
    failing: 0,
    author: l.author ?? "",
    authorBot: l.authorBot ?? false,
    at: l.at ?? l.createdAt,
    closing: l.closing,
  };
}

/** Links to pull requests with the pull request and its repository's name, to be narrowed by the caller. */
const linkedPulls = (tx: Pick<Tx, "select">) =>
  tx
    .select({ link: githubLink, pull: githubPull, repo: githubRepo.fullName })
    .from(githubLink)
    .innerJoin(githubPull, eq(githubPull.id, githubLink.pullId))
    .innerJoin(githubRepo, eq(githubRepo.id, githubLink.repoId));

/** All pull requests and commits of one issue, in a read's transaction. */
export async function issueLinks(tx: Pick<Tx, "select">, issueIds: string[]): Promise<GithubLink[]> {
  const [pulls, commits] = await Promise.all([
    linkedPulls(tx).where(inArray(githubLink.issueId, issueIds)),
    tx
      .select({ link: githubLink, repo: githubRepo.fullName })
      .from(githubLink)
      .innerJoin(githubRepo, eq(githubRepo.id, githubLink.repoId))
      .where(and(inArray(githubLink.issueId, issueIds), isNull(githubLink.pullId), isNotNull(githubLink.sha))),
  ]);
  return [...pulls.map((r) => pullLink(r.link, r.pull, r.repo)), ...commits.map((r) => commitLink(r.link, r.repo))];
}

/**
 * A project's pull requests still open (RSVA-519, RSVA-572): the links of its live issues to open and draft pull
 * requests, the latest change first. A project's home lists them: the pool holds a link only once its issue was opened,
 * so the page asks for them. One linked to several issues comes once per issue; the page shows it once.
 */
export async function projectPulls(tx: Pick<Tx, "select">, projectId: string): Promise<GithubLink[]> {
  const rows = await linkedPulls(tx)
    .innerJoin(issue, eq(issue.id, githubLink.issueId))
    .where(and(eq(issue.projectId, projectId), isNull(issue.deletedAt), isNull(issue.archivedAt), inArray(githubPull.state, ["open", "draft"])))
    .orderBy(desc(githubPull.updatedAt));
  return rows.map((r) => pullLink(r.link, r.pull, r.repo));
}

