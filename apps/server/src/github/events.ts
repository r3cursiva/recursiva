// What a webhook does. Each event runs through applyServerChange, the pipeline every write takes, as the GitHub bot: it
// logs, numbers and broadcasts like an agent's edit.
//
// State moves (only closing references, only forward, never out of a cancelled state): a branch or a draft → the
// project's first started state, a pull request up for review → the second, merged into the default branch or a closing
// commit on it → the first completed state. Only the moment something happens moves an issue: a later push or edit does
// not undo someone moving it back by hand. A pull request closed unmerged or reverted moves nothing. The states only
// people set stay theirs, as for agents (packages/policy).
//
// A pull request from a fork counts only when its author belongs to the repository, and a review only when its reviewer
// does: outsiders can't move our issues. A commit on the default branch counts whoever wrote it: someone with write access
// put it there, and GitHub's own closing keywords treat it the same.
//
// Deliveries can arrive out of order. A merge stands whatever comes after it, and a payload older than what is stored
// changes nothing else.
//
// Links imported from Plane become rows once, from the command line (backfillLinks): that moves no issue and writes no
// comment or feed line, because nothing happened.
import { deniedState } from "@rsva/policy";
import { GITHUB_BOT, TITLE_MAX, cleanName, isClosedGroup, issueKey, issuePath, movedKeysOf, parseIssueKey, projectsByKey, readLink, type GithubEvent, type GithubLink, type PullState } from "@rsva/schema/models";
import { and, asc, eq, inArray, isNull, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, movedUnder, schema, type Tx } from "../db.ts";
import { PUBLIC_ORIGIN } from "../auth/mail.ts";
import { MARKDOWN_PUNCTUATION } from "../http.ts";
import { asBot } from "../sync/bots.ts";
import { removeLink, updateIssue } from "../sync/write.ts";
import type { Pending } from "../sync/tx-error.ts";
import type { GithubApi } from "./api.ts";
import { commitLink, pullLink, type PullRow } from "./pull.ts";
import { branchKeys, commitKeys, commitsKeys, pullKeys } from "./refs.ts";
import { errorText } from "@rsva/schema/util";

const { attachment, githubInstallation, githubLink, githubPull, githubRepo, issue, project, workflowState, workspace } = schema;

type RepoRow = typeof githubRepo.$inferSelect;

// The parts of GitHub's payloads used here, as documented; a field the code does not read is not named.
interface Account {
  login: string;
  type?: string;
}
export interface PullPayload {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  /** Only a full pull request has `merged`; the simplified one in a review event has `merged_at`. */
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: Account | null;
  user: Account | null;
  author_association?: string;
  updated_at: string;
  head: { ref: string; sha: string; repo: { id: number } | null };
  base: { ref: string };
}
interface RepoPayload {
  id: number;
  full_name: string;
  default_branch?: string;
  private?: boolean;
  owner?: { type?: string };
}
export interface Payload {
  action?: string;
  installation?: { id: number; account?: Account; suspended_at?: string | null };
  repository?: RepoPayload;
  sender?: Account;
  pull_request?: PullPayload;
  review?: { state: string; user: Account | null; author_association?: string };
  check_run?: { name: string; status: string; conclusion: string | null; head_sha: string };
  context?: string;
  state?: string;
  sha?: string;
  ref?: string;
  ref_type?: string;
  commits?: { id: string; distinct?: boolean; message: string; timestamp: string; author?: { name?: string; username?: string } }[];
  repositories?: RepoPayload[];
  repositories_added?: RepoPayload[];
  repositories_removed?: { id: number }[];
}

export interface Context {
  api: GithubApi | null;
  log: { warn(obj: object, msg: string): void };
}

const ANONYMOUS = "ghost";
const INSIDERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** Commits read from one push, and links made from them: a huge push does not touch a whole project. */
const COMMITS_MAX = 200;
const PUSH_LINKS_MAX = 200;
const COMMENT_MARK = "<!-- rsva:github -->";

const isBot = (a: Account | null | undefined) => a?.type === "Bot" || !!a?.login.endsWith("[bot]");
const login = (a: Account | null | undefined) => (a?.login ?? ANONYMOUS).replace(/\[bot\]$/, "");
const clean = (s: string) => cleanName(s).slice(0, TITLE_MAX);
const firstLine = (s: string) => clean(s.split("\n", 1)[0] ?? "");
/** What a review says, as a webhook or the API spells it: a comment says nothing. */
function verdictOf(state: string | undefined): string | null {
  const s = state?.toLowerCase();
  return s === "approved" ? "approved" : s === "changes_requested" ? "changes" : s === "dismissed" ? "dismissed" : null;
}

function pullState(p: PullPayload): PullState {
  if (p.merged || p.merged_at) return "merged";
  if (p.state === "closed") return "closed";
  return p.draft ? "draft" : "open";
}

/** A change signed by the GitHub bot, in the repository's workspace. */
async function asGithub(repo: RepoRow, write: (tx: Tx, bot: string) => Promise<Pending[]>): Promise<void> {
  await asBot(repo.workspaceId!, GITHUB_BOT, write);
}

// ── Issues ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Target = typeof issue.$inferSelect;

/**
 * The issues keys name in a repository's workspace, deleted ones and keys outside the repository's projects left out.
 * Locked, in id order, for the transaction: a move is decided on the state it read, so one running at the same time, ours or
 * a person's, must wait.
 */
async function issuesOf(tx: Tx, repo: RepoRow, keys: string[]): Promise<Map<string, Target>> {
  const out = new Map<string, Target>();
  if (!keys.length) return out;
  const projects = projectsByKey(await tx.select({ id: project.id, key: project.key, formerKeys: project.formerKeys }).from(project).where(eq(project.workspaceId, repo.workspaceId!)));
  // By id, not by key: a renamed project stays bound, and a project that takes its old key over does not (PLNR-454).
  const bound = (projectId: string | undefined) => !!projectId && (!repo.projectIds.length || repo.projectIds.includes(projectId));
  const wanted = new Map<string, string>();
  for (const key of keys) {
    const k = parseIssueKey(key);
    const p = k && projects.get(k.projectKey);
    if (!k || !p || !bound(p.id)) continue;
    wanted.set(`${p.id}:${k.number}`, key);
  }
  const rows = !wanted.size ? [] : await tx
    .select()
    .from(issue)
    .where(
      and(
        isNull(issue.deletedAt),
        or(...[...wanted.keys()].map((w) => { const [projectId, number] = w.split(":") as [string, string]; return and(eq(issue.projectId, projectId), eq(issue.number, Number(number))); })),
      ),
    )
    .orderBy(asc(issue.id))
    .for("update");
  for (const i of rows) out.set(wanted.get(`${i.projectId}:${i.number}`)!, i);
  // A key no project's issue answers to may be one an issue had before a move (PLNR-448): a branch named after it still
  // links. In the repository's projects as the issue is now, or as the key says.
  const rest = new Map<string, { key: string; projectId: string | undefined }>();
  for (const key of keys) {
    const k = parseIssueKey(key);
    const p = k ? projects.get(k.projectKey) : undefined;
    if (k && !out.has(key)) for (const m of movedKeysOf(k.projectKey, k.number, p)) if (!rest.has(m)) rest.set(m, { key, projectId: p?.id });
  }
  if (rest.size) {
    const moved = await tx.select().from(issue).where(and(eq(issue.workspaceId, repo.workspaceId!), isNull(issue.deletedAt), movedUnder([...rest.keys()]))).orderBy(asc(issue.id)).for("update");
    for (const i of moved) {
      for (const former of i.formerKeys) {
        const r = rest.get(former);
        if (r && (bound(i.projectId) || bound(r.projectId)) && !out.has(r.key)) out.set(r.key, i);
      }
    }
  }
  return out;
}

type Stage = "progress" | "review" | "done";

/** The state a stage means in a project, if the issue is behind it: a project without a second started state has no review. */
async function stateFor(tx: Tx, i: Target, stage: Stage): Promise<string | null> {
  const states = await tx.select().from(workflowState).where(eq(workflowState.projectId, i.projectId)).orderBy(asc(workflowState.position));
  const started = states.filter((s) => s.group === "started");
  const target = stage === "done" ? states.find((s) => s.group === "completed") : started[stage === "progress" ? 0 : 1];
  const from = states.find((s) => s.id === i.stateId);
  if (!target || !from || from.group === "cancelled" || deniedState("agent", target)) return null;
  const rank = (s: typeof from) => (isClosedGroup(s.group) ? started.length + 2 : s.group === "started" ? 1 + started.indexOf(s) : 0);
  return rank(target) > rank(from) ? target.id : null;
}

/** The change an event makes to an issue: the move to `stage` if any, with `gh`; `gh` alone when `quiet` is false. */
async function issueEvent(tx: Tx, repo: RepoRow, bot: string, i: Target, stage: Stage | null, event: Omit<GithubEvent, "at">, quiet = false): Promise<Pending | null> {
  const gh: GithubEvent = { ...event, at: new Date().toISOString() };
  const stateId = stage && !i.archivedAt ? await stateFor(tx, i, stage) : null;
  const moved = stateId ? await updateIssue(tx, repo.workspaceId!, bot, false, i.id, { stateId }) : null;
  if (moved) return { ...moved, d: { ...moved.d, gh } };
  return quiet ? null : { m: "Issue", mid: i.id, a: "U", d: { gh } };
}

// ── Pull requests ───────────────────────────────────────────────────────────────────────────────────────────────

const pullOf = (tx: Tx, repo: RepoRow, number: number) => tx.select().from(githubPull).where(and(eq(githubPull.repoId, repo.id), eq(githubPull.number, number))).for("update");

/**
 * Stores what a payload says of a pull request and returns it with the row before. A payload older than the row changes
 * nothing but a merge, which stands from then on. A new head starts its checks over.
 */
async function savePull(tx: Tx, repo: RepoRow, p: PullPayload, commits: Record<string, boolean> | null): Promise<{ pull: PullRow; before: PullRow | null; stale: boolean }> {
  const [before = null] = await pullOf(tx, repo, p.number);
  const merged = before?.state === "merged" || pullState(p) === "merged";
  if (before && Date.parse(p.updated_at) < Date.parse(before.updatedAt)) {
    if (!merged || before.state === "merged") return { pull: before, before, stale: true };
    const [pull] = await tx.update(githubPull).set({ state: "merged" }).where(eq(githubPull.id, before.id)).returning();
    return { pull: pull!, before, stale: false };
  }
  const fields = {
    title: clean(p.title),
    state: merged ? "merged" : pullState(p),
    head: p.head.ref,
    headSha: p.head.sha,
    base: p.base.ref,
    author: login(p.user),
    authorBot: isBot(p.user),
    updatedAt: p.updated_at,
  };
  const [pull] = await tx
    .insert(githubPull)
    .values({ repoId: repo.id, number: p.number, ...fields, commitRefs: commits ?? {} })
    .onConflictDoUpdate({
      target: [githubPull.repoId, githubPull.number],
      set: {
        ...fields,
        ...(commits ? { commitRefs: commits } : {}),
        checks: dsql`case when ${githubPull.headSha} = ${p.head.sha} then ${githubPull.checks} else '{}'::jsonb end`,
      },
    })
    .returning();
  return { pull: pull!, before, stale: false };
}

/** A row and the same row a moment ago, the time aside: a label or a passing check nobody sees is not worth a delta. */
const sameRow = (a: GithubLink, b: GithubLink) => JSON.stringify({ ...a, at: "" }) === JSON.stringify({ ...b, at: "" });

/** Actions for the rows of a pull request that look different now. */
async function pullActions(tx: Tx, repo: RepoRow, before: PullRow, after: PullRow): Promise<Pending[]> {
  const links = await tx.select().from(githubLink).where(eq(githubLink.pullId, after.id));
  return links.filter((l) => !sameRow(pullLink(l, before, repo.fullName), pullLink(l, after, repo.fullName))).map((l) => linkAction(pullLink(l, after, repo.fullName), "U"));
}

const linkAction = (row: GithubLink, a: "I" | "U"): Pending => ({ m: "GithubLink", mid: row.id, a, d: row as unknown as Record<string, unknown> });

/** Which stage this event brings a closing issue to; links new to the pull request get it whatever the event was. */
function stageOf(p: PullRow, repo: RepoRow, action: string | undefined, added: boolean): Stage | null {
  if (p.state === "merged") return (action === "closed" || added) && p.base === repo.defaultBranch ? "done" : null;
  if (p.state === "closed") return null;
  if (!added && action !== "opened" && action !== "reopened" && action !== "ready_for_review") return null;
  return p.state === "draft" ? "progress" : "review";
}

function verbOf(p: PullRow, action: string | undefined): GithubEvent["verb"] {
  return p.state === "merged" ? "merged" : action === "ready_for_review" ? "ready" : "opened";
}

async function applyPull(ctx: Context, repo: RepoRow, body: Payload): Promise<void> {
  const pr = body.pull_request!;
  const installation = repo.installationId;
  // A new head may bring new commit messages; a failure keeps what is known and is reported, the rest of the event stands.
  let commits: Record<string, boolean> | null = null;
  if (ctx.api && installation && (body.action === "opened" || body.action === "reopened" || body.action === "synchronize")) {
    try {
      commits = commitsKeys(await ctx.api.pullCommits(installation, repo.fullName, pr.number));
    } catch (e) {
      ctx.log.warn({ err: e, repo: repo.fullName, number: pr.number }, "commits of a pull request not read");
    }
  }
  let changed = false;
  let saved: PullRow | undefined;
  await asGithub(repo, async (tx, bot) => {
    // A run the database failed left its answers here.
    changed = false;
    saved = undefined;
    const { pull, before: was, stale } = await savePull(tx, repo, pr, commits);
    if (stale) return [];
    saved = pull;
    const refs = pullKeys({ head: pr.head.ref, title: pr.title, body: pr.body ?? "", commits: pull.commitRefs });
    // Two keys can name one issue (a project's old key and its new one): it closes only if both say so.
    const issues = new Map<string, { i: Target; closing: boolean }>();
    for (const [key, i] of await issuesOf(tx, repo, [...refs.keys()])) issues.set(i.id, { i, closing: (issues.get(i.id)?.closing ?? true) && refs.get(key)! });
    const before = await tx.select().from(githubLink).where(eq(githubLink.pullId, pull.id));
    const out: Pending[] = [];
    const by = pull.state === "merged" ? login(pr.merged_by ?? body.sender) : body.action === "ready_for_review" ? login(body.sender) : pull.author;
    const merging = pull.state === "merged" && body.action === "closed";
    for (const { i, closing } of issues.values()) {
      const had = before.find((l) => l.issueId === i.id);
      const [row] = had
        ? await tx.update(githubLink).set({ closing }).where(eq(githubLink.id, had.id)).returning()
        : await tx.insert(githubLink).values({ workspaceId: repo.workspaceId!, issueId: i.id, repoId: repo.id, pullId: pull.id, closing }).returning();
      const next = pullLink(row!, pull, repo.fullName);
      if (!had || !was || !sameRow(pullLink(had, was, repo.fullName), next)) out.push(linkAction(next, had ? "U" : "I"));
      if (!had || had.closing !== closing) changed = true;
      const gh = { verb: verbOf(pull, body.action), repo: repo.fullName, number: pull.number, sha: null, title: pull.title, state: pull.state as PullState, by, closing };
      const e = await issueEvent(tx, repo, bot, i, closing ? stageOf(pull, repo, body.action, !had) : null, gh, !merging);
      if (e) out.push(e);
    }
    for (const l of before) {
      if (issues.has(l.issueId)) continue;
      await tx.delete(githubLink).where(eq(githubLink.id, l.id));
      out.push({ m: "GithubLink", mid: l.id, a: "D", d: { issueId: l.issueId } });
      changed = true;
    }
    return out;
  });
  if (changed && saved) await writeComment(ctx, repo, saved);
}

/** The first event seen of a pull request may be a review: it is stored as `applyPull` would, without its keys. */
async function applyReview(repo: RepoRow, body: Payload): Promise<void> {
  const name = login(body.review?.user);
  const verdict = verdictOf(body.review?.state);
  if (!verdict || !INSIDERS.has(body.review?.author_association ?? "")) return;
  await asGithub(repo, async (tx) => {
    const [row] = await pullOf(tx, repo, body.pull_request!.number);
    const before = row ?? (await savePull(tx, repo, body.pull_request!, null)).pull;
    const [after] = await tx
      .update(githubPull)
      .set({ reviews: dsql`${githubPull.reviews} || ${JSON.stringify({ [name]: verdict })}::jsonb` })
      .where(eq(githubPull.id, before.id))
      .returning();
    return pullActions(tx, repo, before, after!);
  });
}

/** A check or commit status of a head commit: known only for pull requests whose head that is. */
async function applyCheck(repo: RepoRow, sha: string, name: string, result: "pass" | "fail" | "run"): Promise<void> {
  await asGithub(repo, async (tx) => {
    const pulls = await tx.select().from(githubPull).where(and(eq(githubPull.repoId, repo.id), eq(githubPull.headSha, sha))).for("update");
    const out: Pending[] = [];
    for (const before of pulls) {
      const [after] = await tx
        .update(githubPull)
        .set({ checks: dsql`${githubPull.checks} || ${JSON.stringify({ [name]: result })}::jsonb` })
        .where(eq(githubPull.id, before.id))
        .returning();
      out.push(...(await pullActions(tx, repo, before, after!)));
    }
    return out;
  });
}

function checkResult(status: string, conclusion: string | null): "pass" | "fail" | "run" {
  if (status !== "completed") return "run";
  return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped" ? "pass" : "fail";
}

const statusResult = (s: string | undefined) => (s === "success" ? "pass" : s === "pending" ? "run" : "fail");

// ── Commits and branches ────────────────────────────────────────────────────────────────────────────────────────

/** A commit's link to an issue; null when it has one already: a redelivery, or a rebase's push. */
async function linkCommit(tx: Tx, repo: RepoRow, issueId: string, closing: boolean, c: { sha: string; message: string; author: string; at: string }) {
  const [row] = await tx
    .insert(githubLink)
    .values({ workspaceId: repo.workspaceId!, issueId, repoId: repo.id, closing, sha: c.sha, message: firstLine(c.message), author: c.author.replace(/\[bot\]$/, ""), authorBot: isBot({ login: c.author }), at: c.at })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Commits arriving on the default branch; any other branch's reach an issue through their pull request. */
async function applyPush(repo: RepoRow, body: Payload): Promise<void> {
  if (body.ref !== `refs/heads/${repo.defaultBranch}`) return;
  const commits = (body.commits ?? []).slice(0, COMMITS_MAX);
  const named = commits.map((c) => ({ c, refs: commitKeys(c.message) })).filter((x) => x.refs.size);
  if (!named.length) return;
  await asGithub(repo, async (tx, bot) => {
    const out: Pending[] = [];
    let links = 0;
    for (const { c, refs } of named) {
      const issues = await issuesOf(tx, repo, [...refs.keys()]);
      const by = c.author?.username ?? c.author?.name ?? login(body.sender);
      for (const [key, i] of issues) {
        if (links === PUSH_LINKS_MAX) return out;
        const closing = refs.get(key)!;
        const row = await linkCommit(tx, repo, i.id, closing, { sha: c.id, message: c.message, author: by, at: c.timestamp });
        if (!row) continue;
        links++;
        out.push(linkAction(commitLink(row, repo.fullName), "I"));
        const gh = { verb: "pushed" as const, repo: repo.fullName, number: null, sha: c.id, title: row.message ?? "", state: null, by: row.author ?? "", closing };
        const e = await issueEvent(tx, repo, bot, i, closing ? "done" : null, gh);
        if (e) out.push(e);
      }
    }
    return out;
  });
}

/** A new branch that names an issue: work on it has started. */
async function applyBranch(repo: RepoRow, body: Payload): Promise<void> {
  if (body.ref_type !== "branch" || !body.ref || body.ref === repo.defaultBranch) return;
  const keys = branchKeys(body.ref);
  if (!keys.length) return;
  await asGithub(repo, async (tx, bot) => {
    const out: Pending[] = [];
    for (const i of (await issuesOf(tx, repo, keys)).values()) {
      const gh = { verb: "branch" as const, repo: repo.fullName, number: null, sha: null, title: body.ref!, state: null, by: login(body.sender), closing: true };
      const e = await issueEvent(tx, repo, bot, i, "progress", gh, true);
      if (e) out.push(e);
    }
    return out;
  });
}

// ── The comment on the pull request ─────────────────────────────────────────────────────────────────────────────

/**
 * An issue title in a GitHub comment: plain text. Every punctuation mark is escaped, and an "@" is broken with an empty
 * HTML comment, the form GitHub does not read as a mention (an entity or a backslash still mentions, checked 2026-10-31).
 */
const commentText = (title: string) => title.replace(MARKDOWN_PUNCTUATION, (c) => (c === "@" ? "@<!-- -->" : `\\${c}`));

/** Comment writes of each pull request, one after the other: two at once would each see no comment yet and post one. */
const commentTurns = new Map<string, Promise<void>>();

function writeComment(ctx: Context, repo: RepoRow, pull: PullRow): Promise<void> {
  const next = (commentTurns.get(pull.id) ?? Promise.resolve()).then(() => putComment(ctx, repo, pull.id));
  commentTurns.set(pull.id, next);
  void next.then(() => {
    if (commentTurns.get(pull.id) === next) commentTurns.delete(pull.id);
  });
  return next;
}

/**
 * The App's one comment on a pull request, as its issues are now. Best effort: the links stand without it. Only in a
 * private repository: a public one's readers cannot open the workspace's issues, so its links would lead nowhere
 * (RSVA-628). A comment written before stays as it was.
 */
async function putComment(ctx: Context, repo: RepoRow, pullId: string): Promise<void> {
  if (!ctx.api || !repo.installationId || !repo.isPrivate) return;
  const [pull] = await db.select().from(githubPull).where(eq(githubPull.id, pullId));
  if (!pull) return;
  try {
    const rows = await db
      .select({ key: project.key, number: issue.number, title: issue.title, closing: githubLink.closing, slug: workspace.slug })
      .from(githubLink)
      .innerJoin(issue, eq(issue.id, githubLink.issueId))
      .innerJoin(project, eq(project.id, issue.projectId))
      .innerJoin(workspace, eq(workspace.id, issue.workspaceId))
      .where(eq(githubLink.pullId, pull.id))
      .orderBy(asc(project.key), asc(issue.number));
    if (!rows.length && !pull.commentId) return;
    const lines = rows.map((r) => {
      const key = issueKey(r.key, r.number);
      const link = PUBLIC_ORIGIN ? `[${key}](${PUBLIC_ORIGIN}${issuePath(r.slug, key)})` : key;
      return `- ${link}: ${commentText(r.title)} (${r.closing ? "closes on merge" : "linked"})`;
    });
    const text = `${COMMENT_MARK}\n${rows.length ? `**recursiva**\n\n${lines.join("\n")}` : "**recursiva**: no linked issues."}`;
    const id = await ctx.api.writeComment(repo.installationId, repo.fullName, pull.number, pull.commentId, text);
    if (id !== pull.commentId) await db.update(githubPull).set({ commentId: id }).where(eq(githubPull.id, pull.id));
  } catch (e) {
    ctx.log.warn({ err: e, repo: repo.fullName, number: pull.number }, "comment on a pull request not written");
  }
}

// ── Installations and repositories ──────────────────────────────────────────────────────────────────────────────

export async function saveInstallation(i: { id: number; account: string; accountType: string; installedBy?: string | null; suspended: boolean }): Promise<void> {
  const fields = { account: i.account, accountType: i.accountType, suspendedAt: i.suspended ? dsql`coalesce(${githubInstallation.suspendedAt}, now())` : null };
  await db
    .insert(githubInstallation)
    .values({ id: i.id, ...fields, suspendedAt: i.suspended ? dsql`now()` : null, installedBy: i.installedBy ?? null })
    .onConflictDoUpdate({ target: githubInstallation.id, set: fields });
}

/** A repository as GitHub describes it, set outright: a webhook asks `heldElsewhere` first, `sync` is the operator's word. */
export async function saveRepo(r: { id: number; fullName: string; defaultBranch?: string | undefined; isPrivate?: boolean | undefined }, installationId: number | null): Promise<void> {
  const fields = {
    fullName: r.fullName,
    ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
    ...(r.isPrivate !== undefined ? { isPrivate: r.isPrivate } : {}),
    ...(installationId ? { installationId } : {}),
  };
  await db.insert(githubRepo).values({ id: r.id, ...fields }).onConflictDoUpdate({ target: githubRepo.id, set: fields });
}

/** A repository under another installation is not this one's to describe: a bound repository does not pass by a claim. */
async function heldElsewhere(repoId: number, installationId: number | null): Promise<boolean> {
  if (!installationId) return false;
  const [r] = await db.select({ held: githubRepo.installationId }).from(githubRepo).where(eq(githubRepo.id, repoId));
  return !!r?.held && r.held !== installationId;
}

/** A repository leaves its installation: it stops feeding, and the operator turns it back on for a new one (`on`). */
const dropRepos = (where: SQL | undefined) => db.update(githubRepo).set({ installationId: null, enabled: false }).where(where);

async function applyInstallation(body: Payload): Promise<void> {
  const i = body.installation;
  if (!i?.account) return;
  if (body.action === "deleted") {
    await dropRepos(eq(githubRepo.installationId, i.id));
    await db.delete(githubInstallation).where(eq(githubInstallation.id, i.id));
    return;
  }
  await saveInstallation({ id: i.id, account: i.account.login, accountType: i.account.type ?? "User", installedBy: body.sender?.login ?? null, suspended: body.action === "suspend" || (body.action !== "unsuspend" && !!i.suspended_at) });
  const repos = [...(body.repositories ?? []), ...(body.repositories_added ?? [])];
  for (const r of repos) if (!(await heldElsewhere(r.id, i.id))) await saveRepo({ id: r.id, fullName: r.full_name, isPrivate: r.private }, i.id);
  const gone = (body.repositories_removed ?? []).map((r) => r.id);
  if (gone.length) await dropRepos(and(inArray(githubRepo.id, gone), eq(githubRepo.installationId, i.id)));
}

// ── Delivery ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Handled {
  repo: RepoRow | null;
  /** A bound repository's event was ignored for this reason; settings show it on the repository. */
  ignored?: string;
}

/**
 * The repository an event names, as stored after it. An event of another installation changes nothing here. An
 * installation first seen on a repository event (installed before the webhook pointed here, no `sync` yet) is recorded
 * with what that event says of its owner.
 */
async function feedOf(body: Payload): Promise<Handled> {
  const r = body.repository;
  if (!r) return { repo: null };
  const from = body.installation?.id ?? null;
  if (await heldElsewhere(r.id, from)) {
    const [known] = await db.select().from(githubRepo).where(eq(githubRepo.id, r.id));
    return { repo: known ?? null, ignored: "Delivered by another installation" };
  }
  if (from) await db.insert(githubInstallation).values({ id: from, account: r.full_name.split("/", 1)[0]!, accountType: r.owner?.type ?? "User" }).onConflictDoNothing();
  await saveRepo({ id: r.id, fullName: r.full_name, defaultBranch: r.default_branch, isPrivate: r.private }, from);
  const [repo] = await db.select().from(githubRepo).where(eq(githubRepo.id, r.id));
  return { repo: repo ?? null };
}

export async function handleEvent(ctx: Context, event: string, body: Payload): Promise<Handled> {
  if (event === "installation" || event === "installation_repositories") {
    await applyInstallation(body);
    return { repo: null };
  }
  const fed = await feedOf(body);
  const repo = fed.repo;
  if (!repo?.workspaceId || !repo.enabled || fed.ignored) return fed;
  const pr = body.pull_request;
  // Outsiders' forks: nothing they write reaches an issue, not even a link.
  if (pr && pr.head.repo?.id !== repo.id && !INSIDERS.has(pr.author_association ?? "")) return fed;
  if (event === "pull_request") await applyPull(ctx, repo, body);
  else if (event === "pull_request_review") await applyReview(repo, body);
  else if (event === "check_run") {
    const c = body.check_run!;
    await applyCheck(repo, c.head_sha, c.name, checkResult(c.status, c.conclusion));
  } else if (event === "status") await applyCheck(repo, body.sha!, body.context!, statusResult(body.state));
  else if (event === "push") await applyPush(repo, body);
  else if (event === "create") await applyBranch(repo, body);
  return fed;
}

// ── Links imported from Plane ───────────────────────────────────────────────────────────────────────────────────

type Imported = { id: string; issueId: string; key: string };

export interface BackfillLine {
  ref: string;
  key: string;
  result: "moved" | "kept" | "failed";
  why?: string;
}

/**
 * Turns imported links into rows, in one transaction: the links whose issue the pull request or commit names, the ones
 * `applyPull` or `applyPush` would make themselves. Any other link stays a link, or the pull request's next event would
 * delete its row. Returns the ids of the links moved, or that would move in a dry run.
 */
async function moveLinks(repo: RepoRow, links: Imported[], keys: Map<string, boolean>, dryRun: boolean, write: (tx: Tx, issues: Map<string, boolean>) => Promise<Pending[]>): Promise<Set<string>> {
  const moved = new Set<string>();
  const work = async (tx: Tx) => {
    moved.clear(); // a run the database failed left its answer here
    const closing = new Map<string, boolean>();
    for (const [key, i] of await issuesOf(tx, repo, [...keys.keys()])) closing.set(i.id, (closing.get(i.id) ?? true) && keys.get(key)!);
    const found = links.filter((l) => closing.has(l.issueId));
    for (const l of found) moved.add(l.id);
    if (dryRun || !found.length) return [];
    const out = await write(tx, new Map(found.map((l) => [l.issueId, closing.get(l.issueId)!])));
    for (const l of found) {
      const removed = await removeLink(tx, repo.workspaceId!, l.id);
      if (removed) out.push(removed);
    }
    return out;
  };
  if (dryRun) await db.transaction(work);
  else await asGithub(repo, work);
  return moved;
}

async function movePull(api: GithubApi, repo: RepoRow, number: number, links: Imported[], dryRun: boolean): Promise<Set<string>> {
  const installation = repo.installationId!;
  const pr = await api.pull(installation, repo.fullName, number);
  if (pr.head.repo?.id !== repo.id && !INSIDERS.has(pr.author_association ?? "")) return new Set();
  const commits = commitsKeys(await api.pullCommits(installation, repo.fullName, number));
  const reviews: Record<string, string> = {};
  for (const r of await api.pullReviews(installation, repo.fullName, number)) {
    const verdict = verdictOf(r.state);
    if (verdict && INSIDERS.has(r.author_association ?? "")) reviews[login(r.user)] = verdict;
  }
  const checks = Object.fromEntries((await api.checkRuns(installation, repo.fullName, pr.head.sha)).map((c) => [c.name, checkResult(c.status, c.conclusion)]));
  const keys = pullKeys({ head: pr.head.ref, title: pr.title, body: pr.body ?? "", commits });
  return moveLinks(repo, links, keys, dryRun, async (tx, issues) => {
    const { pull } = await savePull(tx, repo, pr, commits);
    // What a webhook stored is newer than these lists.
    const [after] = await tx
      .update(githubPull)
      .set({ reviews: dsql`${JSON.stringify(reviews)}::jsonb || ${githubPull.reviews}`, checks: dsql`${JSON.stringify(checks)}::jsonb || ${githubPull.checks}` })
      .where(eq(githubPull.id, pull.id))
      .returning();
    const out = await pullActions(tx, repo, pull, after!);
    const values = [...issues].map(([issueId, closing]) => ({ workspaceId: repo.workspaceId!, issueId, repoId: repo.id, pullId: after!.id, closing }));
    const rows = await tx.insert(githubLink).values(values).onConflictDoNothing().returning();
    return [...out, ...rows.map((l) => linkAction(pullLink(l, after!, repo.fullName), "I"))];
  });
}

async function moveCommit(api: GithubApi, repo: RepoRow, sha: string, links: Imported[], dryRun: boolean): Promise<Set<string>> {
  const c = await api.commit(repo.installationId!, repo.fullName, sha);
  return moveLinks(repo, links, commitKeys(c.message), dryRun, async (tx, issues) => {
    const out: Pending[] = [];
    for (const [issueId, closing] of issues) {
      const row = await linkCommit(tx, repo, issueId, closing, c);
      if (row) out.push(linkAction(commitLink(row, repo.fullName), "I"));
    }
    return out;
  });
}

/**
 * Reads the pull requests and commits of imported links from GitHub and moves those links to the Pull requests block
 * (PLNR-98). Running it again finds only what stayed. A dry run reads and writes nothing.
 */
export async function backfillLinks(api: GithubApi, dryRun: boolean): Promise<BackfillLine[]> {
  const rows = await db
    .select({ id: attachment.id, url: attachment.url, workspaceId: attachment.workspaceId, issueId: attachment.issueId, number: issue.number, project: project.key })
    .from(attachment)
    .innerJoin(issue, eq(issue.id, attachment.issueId))
    .innerJoin(project, eq(project.id, issue.projectId))
    .where(and(inArray(attachment.kind, ["github_pr", "github_commit"]), isNull(issue.deletedAt)));
  const repos = await db.select().from(githubRepo).where(eq(githubRepo.enabled, true));
  const groups = new Map<string, { workspaceId: string; ref: string; links: Imported[] }>();
  for (const r of rows) {
    const ref = readLink(r.url).ref;
    if (!ref) continue;
    const id = `${r.workspaceId} ${ref}`;
    const group = groups.get(id) ?? { workspaceId: r.workspaceId, ref, links: [] };
    group.links.push({ id: r.id, issueId: r.issueId, key: `${r.project}-${r.number}` });
    groups.set(id, group);
  }
  const lines: BackfillLine[] = [];
  for (const { workspaceId, ref, links } of groups.values()) {
    const [name = "", target = ""] = ref.split(/[#@]/);
    const repo = repos.find((x) => x.workspaceId === workspaceId && x.installationId && x.fullName.toLowerCase() === name.toLowerCase());
    const report = (result: BackfillLine["result"], why: string | undefined, of = links) => lines.push(...of.map((l) => ({ ref, key: l.key, result, ...(why ? { why } : {}) })));
    if (!repo) {
      report("kept", "repository not bound");
      continue;
    }
    try {
      const moved = await (ref.includes("#") ? movePull(api, repo, Number(target), links, dryRun) : moveCommit(api, repo, target, links, dryRun));
      report("moved", undefined, links.filter((l) => moved.has(l.id)));
      report("kept", "does not name the issue", links.filter((l) => !moved.has(l.id)));
    } catch (e) {
      report("failed", errorText(e));
    }
  }
  return lines;
}
