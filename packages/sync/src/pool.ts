// The in-memory object pool: one MobX map per model, one observable object per row.
//
// Rows are shallow observables (each field is its own atom, values are kept by reference), so a component that reads
// issue.title re-renders only when that title changes. Derived lists are MobX computeds cached per key: a read is a
// cache hit until a field the list depends on changes.
import { isLinkKind, isLiveIssue, isOpenIssue, issueKey, movedKeysOf, parseIssueKey, projectsByKey, type Attachment, type Comment, type Cycle, type Equal, type GithubLink, type Issue, type IssueModelName, type IssueModels, type Label, type ModelName, type Models, type Project, type Reaction, type WorkflowState, type WorkspaceInfo } from "@rsva/schema/models";
import { computed, observable, type IComputedValue, type ObservableMap, type ObservableSet } from "mobx";
import { groupBy } from "@rsva/schema/util";

export type Row = Record<string, unknown>;
/**
 * The workspace's own row lives in the pool too, so its optimistic edits share the issues' machinery; it comes in the
 * snapshot's meta line and is saved apart from the batches.
 */
type All = Models & IssueModels & { Workspace: WorkspaceInfo };
export type AnyModel = ModelName | IssueModelName | "Workspace";
/** Where an issue is: in the lists, in its project's archive, or in its trash (deleted). */
export type IssueShelf = "live" | "archived" | "deleted";
type Maps = { [M in AnyModel]: ObservableMap<string, All[M]> };

/** Snapshot models: replaced by a new snapshot and written to IndexedDB. */
export const MODELS = ["User", "Project", "WorkflowState", "Label", "Cycle", "Issue", "Attachment"] as const satisfies readonly ModelName[];
true satisfies Equal<(typeof MODELS)[number], ModelName>;

/**
 * Fields a model gained after a local copy may have been saved without them, with the value such a row gets. The
 * protocol version guards copies made by older code, but a copy cut while the server ran a half-updated build (dev) has
 * the current version and lacks the field: it must not break reads, and saving it writes the field from then on.
 */
const ADDED: Partial<Record<AnyModel, Row>> = {
  Workspace: { color: null },
  User: { picture: null, avatar: null },
  Project: { color: null, formerKeys: [], cycleRollover: false },
  Issue: { blockedByIds: [], relatedIds: [], duplicateOfId: null, cycleId: null, formerKeys: [] },
} satisfies { [M in AnyModel]?: Partial<All[M]> };

/** Child models are indexed by their parent, so a project's or an issue's list never scans the whole workspace. */
const PARENT: Partial<Record<AnyModel, "projectId" | "issueId">> = {
  WorkflowState: "projectId",
  Label: "projectId",
  Cycle: "projectId",
  Issue: "projectId",
  Attachment: "issueId",
  Comment: "issueId",
  Reaction: "issueId",
  GithubLink: "issueId",
};

/** Arrays (assigneeIds, labelIds) arrive as new instances in every delta; equal contents must not wake observers. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]));
}

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;
/** Creation order; UUIDv7 ids break ties the same way. */
const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
const bySortOrder = (a: Issue, b: Issue) => (a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.id < b.id ? -1 : 1);

/** Both ends of an issue's relations, live issues only. */
export interface IssueRelations {
  blockedBy: Issue[];
  blocks: Issue[];
  related: Issue[];
  duplicateOf: Issue | null;
  duplicates: Issue[];
}

export class Pool {
  readonly maps: Maps = {
    User: observable.map(undefined, { deep: false }),
    Project: observable.map(undefined, { deep: false }),
    WorkflowState: observable.map(undefined, { deep: false }),
    Label: observable.map(undefined, { deep: false }),
    Cycle: observable.map(undefined, { deep: false }),
    Issue: observable.map(undefined, { deep: false }),
    Attachment: observable.map(undefined, { deep: false }),
    Comment: observable.map(undefined, { deep: false }),
    Reaction: observable.map(undefined, { deep: false }),
    Document: observable.map(undefined, { deep: false }),
    GithubLink: observable.map(undefined, { deep: false }),
    Workspace: observable.map(undefined, { deep: false }),
  };
  /** Column order per model as the snapshot sent it; reused when the pool is written to IndexedDB. */
  readonly columns = new Map<ModelName, string[]>();
  /** "<model>:<projectId>" → row ids. Workspace labels (projectId null) live under "Label:". */
  private readonly buckets = new Map<string, ObservableSet<string>>();
  private readonly derived = new Map<string, IComputedValue<unknown>>();

  get(m: AnyModel, id: string): Row | undefined {
    return this.maps[m].get(id) as Row | undefined;
  }

  /** Inserts a row or merges fields into the existing one. Call inside an action. */
  put(m: AnyModel, data: Row): void {
    const id = data.id as string;
    const cur = this.get(m, id);
    if (cur) return this.patch(m, cur, data);
    // deep: false: values (arrays included) are kept by reference; replacing a field is the only change.
    const row = observable.object({ ...ADDED[m], ...data }, undefined, { deep: false });
    (this.maps[m] as unknown as ObservableMap<string, Row>).set(id, row);
    const pk = PARENT[m];
    if (pk) this.bucket(m, row[pk]).add(id);
  }

  /** Sets changed fields only; unchanged ones do not notify. Call inside an action. */
  patch(m: AnyModel, row: Row, d: Row): void {
    const pk = PARENT[m];
    if (pk && pk in d && d[pk] !== row[pk]) {
      this.bucket(m, row[pk]).delete(row.id as string);
      this.bucket(m, d[pk]).add(row.id as string);
    }
    // The row is a MobX proxy, so a field the row did not have yet becomes observable on assignment too.
    for (const k in d) if (!same(row[k], d[k])) row[k] = d[k];
  }

  remove(m: AnyModel, id: string): void {
    const row = this.get(m, id);
    if (!row) return;
    const pk = PARENT[m];
    if (pk) this.bucket(m, row[pk]).delete(id);
    this.maps[m].delete(id);
  }

  /**
   * Empties the snapshot models but keeps the buckets and computeds: observers stay subscribed across a resync.
   * Comments, reactions and GitHub links stay: the engine reloads them for the issues it tracks.
   */
  clear(): void {
    for (const m of MODELS) this.maps[m].clear();
    for (const [k, b] of this.buckets) if (!k.startsWith("Comment:") && !k.startsWith("Reaction:") && !k.startsWith("GithubLink:")) b.clear();
  }

  /** Columnar rows → pool. Call inside an action. */
  putBatch(m: ModelName, c: string[], rows: unknown[][]): void {
    if (!this.columns.has(m)) this.columns.set(m, c);
    for (const r of rows) {
      const o: Row = {};
      for (let i = 0; i < c.length; i++) o[c[i]!] = r[i];
      this.put(m, o);
    }
  }

  /**
   * Pool → columnar batches for IndexedDB. `view` returns the row as it should be stored (null skips it): local
   * optimistic values are swapped for server ones, so the stored copy is exactly the server state at lastSyncId.
   * `extra`: server rows that are not in the pool (removed here, the removal not confirmed yet).
   */
  toBatches(view: (m: ModelName, row: Row) => Row | null, extra?: (m: ModelName) => Row[]): { m: ModelName; c: string[]; r: unknown[][] }[] {
    const out = [];
    for (const m of MODELS) {
      const rows = [...(this.maps[m].values() as Iterable<Row>), ...(extra?.(m) ?? [])];
      const known = this.columns.get(m) ?? (rows[0] ? Object.keys(rows[0]) : []);
      const c = [...known, ...Object.keys(ADDED[m] ?? {}).filter((k) => !known.includes(k))];
      const r: unknown[][] = [];
      for (const row of rows) {
        const v = view(m, row);
        if (v) r.push(c.map((k) => v[k]));
      }
      out.push({ m, c, r });
    }
    return out;
  }

  // ── Derived reads ─────────────────────────────────────────────────────────────────────────────────────────

  private bucket(m: AnyModel, key: unknown): ObservableSet<string> {
    const k = `${m}:${(key as string | null) ?? ""}`;
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = observable.set<string>(undefined, { deep: false })));
    return b;
  }

  /**
   * keepAlive: a computed read outside a reaction would otherwise recompute on every call. Keys are bounded by the
   * number of projects, so keeping them alive costs little.
   */
  private memo<T>(key: string, fn: () => T): T {
    let c = this.derived.get(key);
    if (!c) this.derived.set(key, (c = computed(fn, { keepAlive: true })));
    return c.get() as T;
  }

  private rows<M extends AnyModel>(m: M, key: string | null): All[M][] {
    const map = this.maps[m];
    return [...this.bucket(m, key)].map((id) => map.get(id)!);
  }

  projectList(): Project[] {
    return this.memo("projects", () =>
      [...this.maps.Project.values()].filter((p) => !p.archivedAt).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    );
  }

  archivedProjects(): Project[] {
    return this.memo("archived", () => [...this.maps.Project.values()].filter((p) => p.archivedAt).sort((a, b) => (a.key < b.key ? -1 : 1)));
  }

  /** By key, or by a key the project had before a rename (old links); a current key always wins. */
  projectByKey(key: string): Project | undefined {
    return this.memo("projectKeys", () => projectsByKey([...this.maps.Project.values()])).get(key);
  }

  statesOf(projectId: string): WorkflowState[] {
    return this.memo(`s:${projectId}`, () => this.rows("WorkflowState", projectId).sort(byPosition));
  }

  labelsOf(projectId: string): Label[] {
    return this.memo(`l:${projectId}`, () => [...this.rows("Label", projectId), ...this.rows("Label", null)].sort(byPosition));
  }

  /** A project's cycles by number, completed ones too (PLNR-63); screens order them with sortedCycles (packages/query). */
  cyclesOf(projectId: string): Cycle[] {
    return this.memo(`cy:${projectId}`, () => this.rows("Cycle", projectId).sort((a, b) => a.number - b.number));
  }

  /** A cycle's live issues by sortOrder: one index for the workspace, rebuilt when an issue changes cycle. */
  issuesInCycle(cycleId: string): Issue[] {
    return (
      this.memo("byCycle", () => {
        const m = groupBy(
          [...this.maps.Issue.values()].filter((i) => i.cycleId && isLiveIssue(i)),
          (i) => i.cycleId!,
        );
        for (const list of m.values()) list.sort(bySortOrder);
        return m;
      }).get(cycleId) ?? []
    );
  }

  issuesOf(projectId: string, shelf: IssueShelf = "live"): Issue[] {
    if (shelf === "live") return this.memo(`i:${projectId}`, () => this.rows("Issue", projectId).filter(isLiveIssue).sort(bySortOrder));
    // The project's archive and trash: most recently put there first.
    const field = shelf === "archived" ? "archivedAt" : "deletedAt";
    return this.memo(`${shelf}:${projectId}`, () =>
      this.rows("Issue", projectId)
        .filter((i) => i[field] && (shelf === "deleted" || !i.deletedAt))
        .sort((a, b) => (a[field]! < b[field]! ? 1 : -1)),
    );
  }

  /**
   * Live issues whose state is neither completed nor cancelled. Walks the project's bucket without sorting, so a count
   * in the sidebar does not build every project's list; it re-runs on a state, archive or delete change in the project.
   */
  activeCount(projectId: string): number {
    return this.memo(`a:${projectId}`, () => {
      let n = 0;
      for (const id of this.bucket("Issue", projectId)) if (this.isActive(this.maps.Issue.get(id)!)) n++;
      return n;
    });
  }

  /** Whether an active issue of the project is urgent; stops at the first, walks without sorting like the count. */
  hasUrgent(projectId: string): boolean {
    return this.memo(`u:${projectId}`, () => {
      for (const id of this.bucket("Issue", projectId)) {
        const i = this.maps.Issue.get(id)!;
        if (i.priority === 1 && this.isActive(i)) return true;
      }
      return false;
    });
  }

  /** When anything in the project last changed: its newest issue change, or its making (RSVA-566: Quiet in the sidebar). */
  lastChange(projectId: string): string {
    return this.memo(`c:${projectId}`, () => {
      let at = this.maps.Project.get(projectId)?.createdAt ?? "";
      for (const id of this.bucket("Issue", projectId)) {
        const t = this.maps.Issue.get(id)!.updatedAt;
        if (t > at) at = t;
      }
      return at;
    });
  }

  /** Whether an active issue of the project was due before `today` (a local day, YYYY-MM-DD). */
  hasOverdue(projectId: string, today: string): boolean {
    return this.memo(`d:${projectId}:${today}`, () => {
      for (const id of this.bucket("Issue", projectId)) {
        const i = this.maps.Issue.get(id)!;
        if (i.dueDate && i.dueDate < today && this.isActive(i)) return true;
      }
      return false;
    });
  }

  private isActive(i: Issue): boolean {
    return isOpenIssue(i, this.maps.WorkflowState.get(i.stateId)?.group);
  }

  /**
   * Sub-issues of an issue, in any project, by sortOrder: the live ones, or with `all` the archived and deleted too (the
   * tree the server checks for loops). One index for the workspace, built on first use.
   */
  subIssuesOf(issueId: string, all = false): Issue[] {
    const children = this.memo("children", () => {
      const m = groupBy(
        [...this.maps.Issue.values()].filter((i) => i.parentId),
        (i) => i.parentId!,
      );
      for (const list of m.values()) list.sort(bySortOrder);
      return m;
    }).get(issueId);
    if (!children) return [];
    // A handful of rows: filtered on each read rather than a computed kept alive per issue.
    return all ? children : children.filter(isLiveIssue);
  }

  /**
   * An issue's relations from both ends: what it stores (blocked by, related, duplicate of) and what other issues store
   * about it (blocks, related, duplicates). Deleted issues drop out; archived ones stay, they are still reachable. One
   * reverse index for the workspace, rebuilt only when a relation field changes.
   */
  relationsOf(issueId: string): IssueRelations {
    const rev = this.reverseRelations();
    const issue = this.maps.Issue.get(issueId);
    const r = rev.get(issueId);
    const live = (i: Issue | undefined): i is Issue => !!i && !i.deletedAt;
    const byId = (ids: readonly string[]) => ids.map((id) => this.maps.Issue.get(id)).filter(live);
    const dup = issue?.duplicateOfId ? this.maps.Issue.get(issue.duplicateOfId) : undefined;
    return {
      blockedBy: byId(issue?.blockedByIds ?? []),
      blocks: (r?.blocks ?? []).filter(live),
      related: [...byId(issue?.relatedIds ?? []), ...(r?.related ?? []).filter(live)],
      duplicateOf: live(dup) ? dup : null,
      duplicates: (r?.duplicates ?? []).filter(live),
    };
  }

  private reverseRelations() {
    return this.memo("relations", () => {
      const m = new Map<string, { blocks: Issue[]; related: Issue[]; duplicates: Issue[] }>();
      const at = (id: string) => {
        let r = m.get(id);
        if (!r) m.set(id, (r = { blocks: [], related: [], duplicates: [] }));
        return r;
      };
      for (const i of this.maps.Issue.values()) {
        for (const b of i.blockedByIds) at(b).blocks.push(i);
        for (const r of i.relatedIds) at(r).related.push(i);
        if (i.duplicateOfId) at(i.duplicateOfId).duplicates.push(i);
      }
      return m;
    });
  }

  /** Waits on an open issue: one of its blockers is live and neither completed nor cancelled. */
  isBlocked(issue: Issue): boolean {
    return issue.blockedByIds.some((id) => {
      const b = this.maps.Issue.get(id);
      return !!b && this.isActive(b);
    });
  }

  /** It is open and an open issue waits on it. */
  isBlocking(issue: Issue): boolean {
    return this.isActive(issue) && !!this.reverseRelations().get(issue.id)?.blocks.some((b) => this.isActive(b));
  }

  /** A link, a pull request or a commit is attached to it; files do not count. One set for the pool, not a lookup per row. */
  hasLink(issue: Issue): boolean {
    return this.memo("linked", () => {
      const s = new Set<string>();
      for (const a of this.maps.Attachment.values()) if (isLinkKind(a.kind)) s.add(a.issueId);
      return s;
    }).has(issue.id);
  }

  /** An issue's links, oldest first. */
  attachmentsOf(issueId: string): Attachment[] {
    return this.memo(`at:${issueId}`, () => this.rows("Attachment", issueId).sort(byCreated));
  }

  /**
   * By key: the project's issue of that number (a former key of the project too), else an issue moved out of a project
   * that kept the key, under any key that project has had (PLNR-448), as the server finds it.
   */
  issueByKey(key: string): Issue | undefined {
    const k = parseIssueKey(key); // no number 0: unnumbered local issues have it
    if (!k) return undefined;
    const p = this.projectByKey(k.projectKey);
    // Archived issues stay reachable by key; numbers are only read here, so titles and states don't invalidate it.
    const own = p && this.memo(`n:${p.id}`, () => new Map(this.rows("Issue", p.id).map((i) => [i.number, i]))).get(k.number);
    if (own) return own;
    const moved = this.memo("moved", () => {
      const m = new Map<string, Issue>();
      for (const i of this.maps.Issue.values()) for (const f of i.formerKeys) m.set(f, i);
      return m;
    });
    if (!moved.size) return undefined;
    for (const f of movedKeysOf(k.projectKey, k.number, p)) {
      const i = moved.get(f);
      if (i) return i;
    }
    return undefined;
  }

  /** An issue's comments, replies included, oldest first. */
  commentsOf(issueId: string): Comment[] {
    return this.memo(`c:${issueId}`, () => this.rows("Comment", issueId).sort(byCreated));
  }

  /** An issue's reactions, to the issue and to its comments, oldest first. */
  reactionsOf(issueId: string): Reaction[] {
    return this.memo(`r:${issueId}`, () => this.rows("Reaction", issueId).sort(byCreated));
  }

  /** An issue's pull requests and commits as they arrived; the panel orders them. */
  githubOf(issueId: string): GithubLink[] {
    return this.memo(`g:${issueId}`, () => this.rows("GithubLink", issueId));
  }

  issueKey(issue: Issue): string {
    const key = this.maps.Project.get(issue.projectId)?.key ?? "?";
    // A local issue has no number until the server gives it one.
    return issue.number ? issueKey(key, issue.number) : `${key}-?`;
  }
}
