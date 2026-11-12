// Names for the agent API: agents speak in keys, state and label names and emails, the write pipeline in ids. One read
// of a workspace's states, labels, members and projects answers both ways, and the issue rows come out in the shape
// agents read (issueView). The same lookups make the QueryContext for packages/query, so a list request filters exactly
// as the browser's query box does.
import type { AccountSettings } from "@rsva/protocol";
import { STRONG, similarIssues, type SimilarOptions } from "@rsva/protocol/similar";
import { inProject, issueView as viewOf, PRIORITY_KEYWORDS, type IssueIndex, type QueryContext } from "@rsva/query";
import { defaultState, isLinkKind, isOpenIssue, issueKey, movedKeysOf, parseIssueKey, projectsByKey, type Attachment, type Cycle, type Issue, type Label, type Project, type User, type WorkflowState } from "@rsva/schema/models";
import { and, asc, eq, inArray, isNull, or, sql as dsql } from "drizzle-orm";
import { db, movedUnder, schema } from "./db.ts";
import { HttpError } from "./http.ts";
import { COLUMNS } from "./sync/columns.ts";

const { project, workflowState, label, cycle, user, member, issue, attachment } = schema;

export interface Names {
  projects: Map<string, Project>;
  states: Map<string, WorkflowState>;
  labels: Map<string, Label>;
  cycles: Map<string, Cycle>;
  users: Map<string, User>;
  /** Project key (also a former one) → project. */
  byKey: Map<string, Project>;
}

export async function loadNames(workspaceId: string): Promise<Names> {
  const [projects, states, labels, cycles, users] = await Promise.all([
    db.select(COLUMNS.Project).from(project).where(eq(project.workspaceId, workspaceId)),
    db.select(COLUMNS.WorkflowState).from(workflowState).innerJoin(project, eq(project.id, workflowState.projectId)).where(eq(project.workspaceId, workspaceId)).orderBy(asc(workflowState.position)),
    db.select(COLUMNS.Label).from(label).where(eq(label.workspaceId, workspaceId)).orderBy(asc(label.position)),
    db.select(COLUMNS.Cycle).from(cycle).where(eq(cycle.workspaceId, workspaceId)),
    db.select(COLUMNS.User).from(user).innerJoin(member, eq(member.userId, user.id)).where(eq(member.workspaceId, workspaceId)),
  ]);
  return {
    projects: new Map((projects as Project[]).map((p) => [p.id, p])),
    states: new Map((states as WorkflowState[]).map((s) => [s.id, s])),
    labels: new Map((labels as Label[]).map((l) => [l.id, l])),
    cycles: new Map((cycles as Cycle[]).map((c) => [c.id, c])),
    users: new Map((users as User[]).map((u) => [u.id, u])),
    byKey: projectsByKey(projects as Project[]),
  };
}

/** Issues of the workspace, or of one project, neither archived (unless asked) nor deleted; in the shape packages/query reads. */
export async function loadIssues(workspaceId: string, projectId?: string, archived = false): Promise<Issue[]> {
  const where = and(eq(issue.workspaceId, workspaceId), archived ? undefined : isNull(issue.archivedAt), isNull(issue.deletedAt), projectId ? eq(issue.projectId, projectId) : undefined);
  return (await db.select(COLUMNS.Issue).from(issue).where(where)) as Issue[];
}

export const keyOf = (n: Names, i: Pick<Issue, "projectId" | "number">) => issueKey(n.projects.get(i.projectId)?.key ?? "?", i.number);

/** An open issue that looks like a new one (PLNR-295), as the create answer lists it. */
export interface SimilarView {
  key: string;
  title: string;
  state: string;
  score: number;
}

/** The workspace's open issues whose titles look most like `title` (up to 5 at `SHOWN` or more, best first); `strong` when one is at `STRONG`. */
export function similarTo(n: Names, issues: readonly Issue[], title: string, opts: SimilarOptions = {}): { similar: SimilarView[]; strong: boolean } {
  const found = similarIssues(title, issues, (i) => n.states.get(i.stateId)?.group, opts);
  return {
    similar: found.map(({ issue: i, score }) => ({ key: keyOf(n, i), title: i.title, state: n.states.get(i.stateId)?.name ?? "", score: Math.round(score * 100) / 100 })),
    strong: found[0] !== undefined && found[0].score >= STRONG,
  };
}

/** The workspace's issues for `parent:`, `is:` and `has:`, as the browser's pool answers them; a list that names none skips the load. */
export async function loadIssueIndex(n: Names, workspaceId: string): Promise<IssueIndex> {
  // Kinds per issue, distinct: a few rows per issue at most, and isLinkKind stays the one rule of what a link is.
  const [rows, kinds] = await Promise.all([
    loadIssues(workspaceId, undefined, true),
    db.selectDistinct({ issueId: attachment.issueId, kind: attachment.kind }).from(attachment).where(eq(attachment.workspaceId, workspaceId)),
  ]);
  const linked = new Set(kinds.filter((a) => isLinkKind(a.kind)).map((a) => a.issueId));
  const byId = new Map(rows.map((i) => [i.id, i]));
  const byKey = new Map(rows.map((i) => [keyOf(n, i), i]));
  const open = (i: Issue) => isOpenIssue(i, n.states.get(i.stateId)?.group);
  const waitedOn = new Set(rows.filter(open).flatMap((i) => i.blockedByIds));
  return {
    get: (id) => byId.get(id),
    byKey: (key) => byKey.get(key),
    isBlocked: (i) =>
      i.blockedByIds.some((id) => {
        const b = byId.get(id);
        return !!b && open(b);
      }),
    isBlocking: (i) => open(i) && waitedOn.has(i.id),
    hasLink: (i) => linked.has(i.id),
  };
}

/**
 * The lookups a query of `me` resolves against. `calendar` is their Profile's (RSVA-13): today and the days of created:
 * and updated: in their zone, this-week from their first day; without it, the server's zone and Monday.
 */
export function queryContext(n: Names, me: string, projectId?: string, issues?: IssueIndex, calendar?: Pick<AccountSettings, "timeZone" | "weekStart">): QueryContext {
  const ctx: QueryContext = {
    states: n.states,
    labels: n.labels,
    cycles: n.cycles,
    users: n.users,
    projects: n.projects,
    me,
    issueKey: (i) => keyOf(n, i),
    ...(issues ? { issues } : {}),
    ...(calendar ? { weekStart: calendar.weekStart, ...(calendar.timeZone ? { timeZone: calendar.timeZone } : {}) } : {}),
  };
  return projectId ? inProject(ctx, projectId) : ctx;
}

/**
 * A resolution failure: the message names what was asked and what exists, so an agent can correct itself. Thrown out of
 * a route, it answers 400 `bad_ref`.
 */
export class NameError extends HttpError {
  constructor(message: string) {
    super(400, "bad_ref", message);
  }
}

const list = (xs: Iterable<string>) => [...xs].map((x) => `"${x}"`).join(", ");

export function stateId(n: Names, projectId: string, name: string): string {
  const states = [...n.states.values()].filter((s) => s.projectId === projectId);
  const s = states.find((x) => x.name === name) ?? states.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) throw new NameError(`no state "${name}" in this project; states: ${list(states.map((x) => x.name))}`);
  return s.id;
}

export function defaultStateId(n: Names, projectId: string): string {
  const states = [...n.states.values()].filter((s) => s.projectId === projectId);
  const s = defaultState(states);
  if (!s) throw new NameError("the project has no states");
  return s.id;
}

/** Labels of the project and of the workspace, by name (case-insensitive). */
export function labelIds(n: Names, projectId: string, names: unknown): string[] {
  if (!Array.isArray(names) || names.some((x) => typeof x !== "string")) throw new NameError("labels: a list of label names");
  const usable = [...n.labels.values()].filter((l) => l.projectId === null || l.projectId === projectId);
  return [...new Set(names as string[])].map((name) => {
    const l = usable.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!l) throw new NameError(`no label "${name}"; labels: ${list(usable.map((x) => x.name))}`);
    return l.id;
  });
}

/** A cycle of the project by name or short form ("Cycle 12", "C12", case-insensitive); completed ones are offered too, the write pipeline refuses them. */
export function cycleId(n: Names, projectId: string, name: string): string {
  const cycles = [...n.cycles.values()].filter((c) => c.projectId === projectId);
  const l = name.toLowerCase();
  const c = cycles.find((x) => x.name.toLowerCase() === l || `c${x.number}` === l);
  if (!c) throw new NameError(`no cycle "${name}" in this project; cycles: ${list(cycles.filter((x) => !x.completedAt).map((x) => x.name))}`);
  return c.id;
}

/** A project of the workspace by key, any case; a key that is not one names those that are. */
export function projectByKey(n: Names, key: unknown): Project {
  const p = typeof key === "string" ? n.byKey.get(key.toUpperCase()) : undefined;
  if (!p) throw new NameError(`project: one of ${[...n.byKey.keys()].join(", ")}`);
  return p;
}

/** Members by email; "me" is the caller. */
export function userId(n: Names, me: string, email: string): string {
  if (email === "me") return me;
  const u = [...n.users.values()].find((x) => x.email.toLowerCase() === email.toLowerCase());
  if (!u) throw new NameError(`no member "${email}"; members: ${list([...n.users.values()].map((x) => x.email))}`);
  return u.id;
}

export function userIds(n: Names, me: string, emails: unknown): string[] {
  if (!Array.isArray(emails) || emails.some((x) => typeof x !== "string")) throw new NameError("assignees: a list of emails or \"me\"");
  return [...new Set((emails as string[]).map((e) => userId(n, me, e)))];
}

/** Priority as a number 0–4 or a keyword (urgent, high, medium, low, none). */
export function priority(v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4) return v;
  const hit = Object.entries(PRIORITY_KEYWORDS).find(([, k]) => k === String(v).toLowerCase());
  if (!hit) throw new NameError(`priority: one of ${list(Object.values(PRIORITY_KEYWORDS))} or 0–4`);
  return Number(hit[0]);
}

/**
 * The issues of the workspace by key ("PLNR-9"), each also under a project's former key, or one the issue had before a move; in
 * the order of the keys, a repeated key once. Two queries however many keys (the callers cap the list): the second only for keys
 * no project's issue answers to. The first key that names nothing is a NameError.
 */
export async function issueIdsByKeys(n: Names, workspaceId: string, keys: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(keys)].map((key) => ({ key, k: parseIssueKey(key) }));
  const current = wanted.flatMap(({ k }) => {
    const p = k && n.byKey.get(k.projectKey);
    return p ? [and(eq(issue.projectId, p.id), eq(issue.number, k.number))] : [];
  });
  const found = new Map<string, string>();
  const at = (projectId: string, number: number) => `${projectId}-${number}`;
  if (current.length) for (const r of await db.select({ id: issue.id, projectId: issue.projectId, number: issue.number }).from(issue).where(and(eq(issue.workspaceId, workspaceId), or(...current)))) found.set(at(r.projectId, r.number), r.id);
  const lost = wanted.filter(({ k }) => k && !found.has(at(n.byKey.get(k.projectKey)?.id ?? "", k.number)));
  const former = new Map<string, string>();
  if (lost.length) {
    const asked = lost.flatMap(({ k }) => movedKeysOf(k!.projectKey, k!.number, n.byKey.get(k!.projectKey)));
    for (const r of await db.select({ id: issue.id, formerKeys: issue.formerKeys }).from(issue).where(and(eq(issue.workspaceId, workspaceId), movedUnder(asked)))) for (const f of r.formerKeys) former.set(f, r.id);
  }
  return wanted.map(({ key, k }) => {
    const p = k ? n.byKey.get(k.projectKey) : undefined;
    const id = k && ((p && found.get(at(p.id, k.number))) || movedKeysOf(k.projectKey, k.number, p).map((f) => former.get(f)).find(Boolean));
    if (!id) throw new NameError(`no issue ${key}`);
    return id;
  });
}

/** An issue of the workspace by key, as issueIdsByKeys finds it. */
export async function issueIdByKey(n: Names, workspaceId: string, key: string): Promise<string> {
  return (await issueIdsByKeys(n, workspaceId, [key]))[0]!;
}

/**
 * The issue of a key among issues already read, by the same keys as issueIdByKey: under the project's key or a former
 * one, or a key the issue had before a move (only when no issue has it now). Undefined when none of them has it.
 */
export function issueOfKey<I extends Pick<Issue, "projectId" | "number" | "formerKeys">>(n: Names, issues: readonly I[], key: string): I | undefined {
  const k = parseIssueKey(key);
  if (!k) return undefined;
  const p = n.byKey.get(k.projectKey);
  const moved = movedKeysOf(k.projectKey, k.number, p);
  return issues.find((i) => i.projectId === p?.id && i.number === k.number) ?? issues.find((i) => i.formerKeys.some((f) => moved.includes(f)));
}

/** How agents read an issue: names and emails instead of ids (packages/query, shared with the TUI). */
export const issueView = (n: Names, i: Issue, parents: Map<string, string>) => viewOf({ ...n, issueKey: (x) => keyOf(n, x) }, i, (id) => parents.get(id) ?? null);

/**
 * An opened issue's relations from both ends, by key, its links and its files: what GET …/issues/:key adds to issueView. Deleted
 * issues drop out, as in the browser. The other end is found by scanning the workspace's issue rows (arrays have no index):
 * one query, fine at our sizes.
 */
export async function relationsAndLinks(n: Names, workspaceId: string, i: Issue) {
  const id = i.id;
  const own = [...i.blockedByIds, ...i.relatedIds, ...(i.duplicateOfId ? [i.duplicateOfId] : [])];
  const [rows, links] = await Promise.all([
    db
      .select({ id: issue.id, projectId: issue.projectId, number: issue.number, blockedByIds: issue.blockedByIds, relatedIds: issue.relatedIds, duplicateOfId: issue.duplicateOfId })
      .from(issue)
      .where(
        and(
          eq(issue.workspaceId, workspaceId),
          isNull(issue.deletedAt),
          or(own.length ? inArray(issue.id, own) : undefined, dsql`${id} = any(${issue.blockedByIds})`, dsql`${id} = any(${issue.relatedIds})`, eq(issue.duplicateOfId, id)),
        ),
      ),
    db
      .select({ id: attachment.id, kind: attachment.kind, url: attachment.url, title: attachment.title, size: attachment.size, mime: attachment.mime, createdById: attachment.createdById, createdAt: attachment.createdAt })
      .from(attachment)
      .where(eq(attachment.issueId, id))
      .orderBy(asc(attachment.createdAt), asc(attachment.id)),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keys = (ids: readonly string[]) => ids.filter((x) => byId.has(x)).map((x) => keyOf(n, byId.get(x)!));
  const others = rows.filter((r) => r.id !== id);
  const dup = i.duplicateOfId && byId.get(i.duplicateOfId);
  const by = (userId: string | null) => (userId ? (n.users.get(userId)?.email ?? null) : null);
  return {
    relations: {
      blockedBy: keys(i.blockedByIds),
      blocks: others.filter((r) => r.blockedByIds.includes(id)).map((r) => keyOf(n, r)),
      related: [...keys(i.relatedIds), ...others.filter((r) => r.relatedIds.includes(id)).map((r) => keyOf(n, r))],
      duplicateOf: dup ? keyOf(n, dup) : null,
      duplicates: others.filter((r) => r.duplicateOfId === id).map((r) => keyOf(n, r)),
    },
    links: links
      .filter((l) => isLinkKind(l.kind))
      .map((l) => ({ id: l.id, kind: l.kind as Attachment["kind"], url: l.url, title: l.title, createdBy: by(l.createdById), createdAt: l.createdAt })),
    files: links
      .filter((l) => l.kind === "file")
      .map((l) => ({ id: l.id, name: l.title, size: l.size, mime: l.mime, url: l.url, createdBy: by(l.createdById), createdAt: l.createdAt })),
  };
}

/** Keys of the parents of these issues, for issueView. */
export async function parentKeys(n: Names, rows: Issue[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.parentId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const parents = await db.select({ id: issue.id, projectId: issue.projectId, number: issue.number }).from(issue).where(inArray(issue.id, ids));
  return new Map(parents.map((p) => [p.id, keyOf(n, p)]));
}
