// Settings in the write pipeline: the workspace (name, color, member rights), the project itself (new, name, key, color, archive, cycle
// rollover), its workflow states and its labels. Called from applyTx inside its transaction, like the issue and comment ops in write.ts.
//
// Two rules are checked once per transaction rather than per op (checkProjects, at the end of applyTx): every project
// touched keeps at least one state and exactly one default. A new project counts as touched, so it comes with its
// states in the same transaction (the client sends DEFAULT_WORKFLOW) and is never seen without them. A client moves the default as two updates in one
// transaction (the old one off, the new one on) and sees exactly that locally, with no hidden server-side cascade.
//
// Deleting a state or a label that issues still use is refused instead of cascading: the client moves those issues
// first, as ordinary issue updates in the transactions before, so each move is in the issue's history and shows at once.
import { MEMBER_RIGHTS } from "@rsva/policy";
import { TILE_COLORS, PROJECT_KEY, STATE_GROUPS, isClosedGroup, type LabelCreate, type LabelPatch, type ProjectCreate, type ProjectPatch, type StateCreate, type StatePatch, type WorkspacePatch } from "@rsva/schema/models";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { projectKeyIs, schema, type Tx } from "../db.ts";
import { name } from "../http.ts";
import { COLUMNS, labelColumns, stateColumns } from "./columns.ts";
import { momentChanges, moment } from "./moments.ts";
import { created, diff, lockOwned, unusedBy } from "./rows.ts";
import { TxError, type Pending } from "./tx-error.ts";

const { workspace, project, workflowState, label, issue } = schema;

const uuid = z.uuid();
const position = z.number().finite();
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "not a #rrggbb color");

/** What members may change (packages/policy, MEMBER_RIGHTS): each at most once, kept in the policy's order. */
const memberRights = z
  .array(z.enum(MEMBER_RIGHTS))
  .refine((r) => new Set(r).size === r.length, "each member right once")
  .transform((r) => MEMBER_RIGHTS.filter((x) => r.includes(x)));
/** Who triages: members by id, each once; empty is every owner and admin. */
const triagers = z.array(uuid).max(200).refine((r) => new Set(r).size === r.length, "each person once");
const workspacePatch = z.object({ name, color: z.enum(TILE_COLORS).nullable(), memberRights, triagers }).partial().strict();
const projectKey = z.string().regex(PROJECT_KEY, "a key is a letter, then up to 11 letters or digits, upper case");
const tileColor = z.enum(TILE_COLORS).nullable();
const projectPatch = z.object({ name, key: projectKey, color: tileColor, archivedAt: moment, cycleRollover: z.boolean() }).partial().strict();
const statePatch = z.object({ name, group: z.enum(STATE_GROUPS), position, isDefault: z.boolean(), onlyPeople: z.boolean() }).partial().strict();
const labelPatch = z.object({ name, color: hex, parentId: uuid.nullable(), position, onlyPeople: z.boolean() }).partial().strict();

const target = { id: uuid };
export const settingsOpSchemas = [
  z.discriminatedUnion("op", [z.object({ op: z.literal("update"), m: z.literal("Workspace"), ...target, set: workspacePatch }).strict()]),
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("create"), m: z.literal("Project"), ...target, set: z.object({ name, key: projectKey, color: tileColor.optional() }).strict() }).strict(),
    z.object({ op: z.literal("update"), m: z.literal("Project"), ...target, set: projectPatch }).strict(),
  ]),
  z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("create"),
        m: z.literal("WorkflowState"),
        ...target,
        set: statePatch
          .pick({ name: true, group: true, position: true })
          .required()
          .extend({ projectId: uuid, isDefault: z.boolean().optional(), onlyPeople: z.boolean().optional() })
          .strict(),
      })
      .strict(),
    z.object({ op: z.literal("update"), m: z.literal("WorkflowState"), ...target, set: statePatch }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("WorkflowState"), ...target }).strict(),
  ]),
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("create"), m: z.literal("Label"), ...target, set: labelPatch.required({ name: true, color: true, position: true }).extend({ projectId: uuid }).strict() }).strict(),
    z.object({ op: z.literal("update"), m: z.literal("Label"), ...target, set: labelPatch }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("Label"), ...target }).strict(),
  ]),
] as const;

/** State colors by group, Plane's defaults: the ledger draws states by group, the color is kept for export and Plane. */
export const GROUP_COLOR: Record<string, string> = {
  backlog: "#60646C",
  unstarted: "#60646C",
  started: "#F59E0B",
  completed: "#46A758",
  cancelled: "#9AA4BC",
};

// ── Workspace ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Locks the workspace row before the log numbers do, so the client sends this op alone in its transaction: mixed with
 * issue ops it could wait on rows another transaction holds while that one waits for the workspace row.
 */
export async function updateWorkspace(tx: Tx, workspaceId: string, id: string, set: WorkspacePatch): Promise<Pending | null> {
  if (id !== workspaceId) throw new TxError("not_found", `no workspace ${id}`);
  const [row] = await tx.select({ name: workspace.name, color: workspace.color, memberRights: workspace.memberRights, triagers: workspace.triagers }).from(workspace).where(eq(workspace.id, id)).for("update");
  const { changed, prev } = diff(row!, set);
  if (Object.keys(changed).length === 0) return null;
  await tx.update(workspace).set(changed).where(eq(workspace.id, id));
  return { m: "Workspace", mid: id, a: "U", d: changed, p: prev };
}

// ── Project ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether `key` can be taken by a project other than `except`, and from whom. Another project's key is refused; so is a key
 * another project had before a rename (its old links lead there) while that project has issues. An emptied project
 * gives such a key up (PLNR-448): `from` is it, to lose the key from its former keys.
 */
async function keyHolder(tx: Tx, workspaceId: string, key: string, except?: string): Promise<{ problem: string } | { from?: { id: string; formerKeys: string[] } }> {
  const [taken] = await tx
    .select({ id: project.id, key: project.key, formerKeys: project.formerKeys })
    .from(project)
    .where(and(eq(project.workspaceId, workspaceId), except ? ne(project.id, except) : undefined, projectKeyIs(key)));
  if (!taken) return {};
  const [{ n }] = (await tx.select({ n: dsql<number>`count(*)::int` }).from(issue).where(eq(issue.projectId, taken.id))) as [{ n: number }];
  if (taken.key === key) return { problem: n ? `project ${key} exists` : `project ${key} exists; it has no issues: change its key first, and ${key} is free to take` };
  if (n) return { problem: `${key} was a key of project ${taken.key}: its old links lead there (${n} issues, archived and deleted ones too; move them out to free the key)` };
  return { from: { id: taken.id, formerKeys: taken.formerKeys } };
}

/** The key's holder, or a conflict naming why it cannot be taken. */
async function takeKey(tx: Tx, workspaceId: string, key: string, except?: string): Promise<{ id: string; formerKeys: string[] } | undefined> {
  const h = await keyHolder(tx, workspaceId, key, except);
  if ("problem" in h) throw new TxError("conflict", h.problem);
  return h.from;
}

/**
 * A key goes to a project that never had it: the emptied project that had it before loses it from its former keys, and
 * issues moved out with keys under it ("KEY-3", PLNR-448) stop answering to them. The new owner wins: KEY-3 is its issue
 * 3 from now on, and a moved issue's history keeps "was KEY-3" as text.
 */
async function handOver(tx: Tx, workspaceId: string, key: string, from: { id: string; formerKeys: string[] } | undefined): Promise<Pending[]> {
  const out: Pending[] = [];
  if (from) {
    const formerKeys = from.formerKeys.filter((k) => k !== key);
    await tx.update(project).set({ formerKeys }).where(eq(project.id, from.id));
    out.push({ m: "Project", mid: from.id, a: "U", d: { formerKeys }, p: { formerKeys: from.formerKeys } });
  }
  const prefix = `${key}-`;
  const moved = await tx
    .select({ id: issue.id, formerKeys: issue.formerKeys })
    .from(issue)
    .where(and(eq(issue.workspaceId, workspaceId), dsql`${issue.formerKeys} <> '{}'`, dsql`exists (select 1 from unnest(${issue.formerKeys}) k where starts_with(k, ${prefix}))`))
    .orderBy(issue.id)
    .for("update");
  for (const i of moved) {
    const formerKeys = i.formerKeys.filter((k) => !k.startsWith(prefix));
    await tx.update(issue).set({ formerKeys }).where(eq(issue.id, i.id));
    out.push({ m: "Issue", mid: i.id, a: "U", d: { formerKeys }, p: { formerKeys: i.formerKeys } });
  }
  return out;
}

/** Every project of the workspace, locked: two key changes at once cannot both take a key, former keys included. */
const lockProjects = (tx: Tx, workspaceId: string) => tx.select({ id: project.id }).from(project).where(eq(project.workspaceId, workspaceId)).orderBy(project.id).for("update");

/**
 * A new project, last in everyone's order. Its states follow in the same transaction: it is touched, so checkProjects
 * refuses it without them. Two projects created at once with one key: the unique index stops the second.
 */
export async function createProject(tx: Tx, workspaceId: string, touched: Touched, id: string, set: ProjectCreate): Promise<Pending[]> {
  await lockProjects(tx, workspaceId);
  const from = await takeKey(tx, workspaceId, set.key);
  const row = await created(tx.insert(project).values({ id, workspaceId, key: set.key, name: set.name, color: set.color ?? null }).onConflictDoNothing().returning(COLUMNS.Project), `project ${set.key} or ${id}`);
  touched.add(id);
  return [...(await handOver(tx, workspaceId, set.key, from)), { m: "Project", mid: id, a: "I", d: row as Record<string, unknown> }];
}

export async function updateProject(tx: Tx, workspaceId: string, id: string, set: ProjectPatch): Promise<Pending[]> {
  if (set.key !== undefined) await lockProjects(tx, workspaceId);
  const row = await lockOwned(tx, project, workspaceId, id, "project");

  const { archivedAt, ...fields } = set;
  const { changed, prev } = diff(row, fields);
  const before: Pending[] = [];
  if (changed.key) {
    const key = changed.key as string;
    const from = await takeKey(tx, workspaceId, key, id);
    // Taking back a key of its own changes nobody else's: the issues moved out under it are still its own history.
    if (!row.formerKeys.includes(key)) before.push(...(await handOver(tx, workspaceId, key, from)));
    // The old key stays an alias; taking back a former key drops it from the aliases.
    changed.formerKeys = [...row.formerKeys.filter((k) => k !== key), row.key];
    prev.formerKeys = row.formerKeys;
  }
  const update: Record<string, unknown> = { ...changed, ...momentChanges(row, { archivedAt }, prev) };
  if (Object.keys(update).length === 0) return [];
  const [after] = await tx.update(project).set(update).where(eq(project.id, id)).returning({ archivedAt: project.archivedAt });
  if ("archivedAt" in update) changed.archivedAt = after!.archivedAt;
  return [...before, { m: "Project", mid: id, a: "U", d: changed, p: prev }];
}

// ── Workflow states ───────────────────────────────────────────────────────────────────────────────────────────

/** Projects whose states a transaction changed: checkProjects runs over them before commit. */
export type Touched = Set<string>;

async function projectInWorkspace(tx: Tx, workspaceId: string, projectId: string): Promise<void> {
  const [p] = await tx.select({ id: project.id }).from(project).where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)));
  if (!p) throw new TxError("bad_ref", "project is not in the workspace");
}

async function stateRow(tx: Tx, workspaceId: string, id: string) {
  const [s] = await tx
    .select({ state: workflowState })
    .from(workflowState)
    .innerJoin(project, eq(project.id, workflowState.projectId))
    .where(and(eq(workflowState.id, id), eq(project.workspaceId, workspaceId)))
    .for("update", { of: workflowState });
  if (!s) throw new TxError("not_found", `no state ${id}`);
  return s.state;
}

export async function createState(tx: Tx, workspaceId: string, touched: Touched, id: string, set: StateCreate): Promise<Pending> {
  await projectInWorkspace(tx, workspaceId, set.projectId);
  const row = await created(
    tx
      .insert(workflowState)
      .values({ id, projectId: set.projectId, name: set.name, group: set.group, position: set.position, isDefault: set.isDefault ?? false, onlyPeople: set.onlyPeople ?? false, color: GROUP_COLOR[set.group]! })
      .onConflictDoNothing()
      .returning(stateColumns),
    `state ${id}`,
  );
  touched.add(set.projectId);
  return { m: "WorkflowState", mid: id, a: "I", d: row as Record<string, unknown> };
}

/**
 * A group change moves the state's issues between open and closed: their completedAt follows (set once on closing,
 * cleared on reopening), as when an issue itself changes state.
 */
export async function updateState(tx: Tx, workspaceId: string, touched: Touched, id: string, set: StatePatch): Promise<Pending[]> {
  const row = await stateRow(tx, workspaceId, id);
  const { changed, prev } = diff(row, set);
  if (Object.keys(changed).length === 0) return [];
  await tx.update(workflowState).set(changed).where(eq(workflowState.id, id));
  touched.add(row.projectId);
  const out: Pending[] = [{ m: "WorkflowState", mid: id, a: "U", d: changed, p: prev }];
  if (changed.group) {
    if (isClosedGroup(row.group) !== isClosedGroup(changed.group as string)) {
      const moved = isClosedGroup(changed.group as string)
        ? await tx.update(issue).set({ completedAt: dsql`now()` }).where(and(eq(issue.stateId, id), isNull(issue.completedAt))).returning({ id: issue.id, completedAt: issue.completedAt })
        : await tx.update(issue).set({ completedAt: null }).where(and(eq(issue.stateId, id), isNotNull(issue.completedAt))).returning({ id: issue.id, completedAt: issue.completedAt });
      for (const i of moved) out.push({ m: "Issue", mid: i.id, a: "U", d: { completedAt: i.completedAt } });
    }
  }
  return out;
}

export async function deleteState(tx: Tx, workspaceId: string, touched: Touched, id: string): Promise<Pending> {
  const row = await stateRow(tx, workspaceId, id);
  await unusedBy(tx, eq(issue.stateId, id), (n) => `state ${row.name} still has ${n} issues: move them to another state first`);
  await tx.delete(workflowState).where(eq(workflowState.id, id));
  touched.add(row.projectId);
  return { m: "WorkflowState", mid: id, a: "D", d: { projectId: row.projectId }, p: { name: row.name } };
}

/** The transaction's end: every project whose states changed has states and exactly one default among them. */
export async function checkProjects(tx: Tx, touched: Touched): Promise<void> {
  if (!touched.size) return;
  const ids = [...touched];
  const rows = await tx
    .select({ projectId: workflowState.projectId, defaults: dsql<number>`count(*) filter (where ${workflowState.isDefault})::int` })
    .from(workflowState)
    .where(inArray(workflowState.projectId, ids))
    .groupBy(workflowState.projectId);
  const defaults = new Map(rows.map((r) => [r.projectId, r.defaults]));
  for (const p of ids) {
    if (!defaults.has(p)) throw new TxError("invalid", "a project needs at least one state");
    if (defaults.get(p) !== 1) throw new TxError("invalid", "a project needs exactly one default state");
  }
}

// ── Labels ────────────────────────────────────────────────────────────────────────────────────────────────────

const labelRow = (tx: Tx, workspaceId: string, id: string) => lockOwned(tx, label, workspaceId, id, "label");

/** Names are unique among the labels a project's issues can use (its own and the workspace's), ignoring case. */
async function nameFree(tx: Tx, workspaceId: string, projectId: string | null, nameValue: string, except?: string): Promise<void> {
  const scope = projectId ? or(isNull(label.projectId), eq(label.projectId, projectId)) : undefined;
  const [dup] = await tx
    .select({ id: label.id })
    .from(label)
    .where(and(eq(label.workspaceId, workspaceId), scope, dsql`lower(${label.name}) = lower(${nameValue})`, except ? ne(label.id, except) : undefined));
  if (dup) throw new TxError("conflict", `label ${nameValue} exists`);
}

/** A parent is a label of the same workspace, usable in the child's project, and not the child or below it. */
async function checkParent(tx: Tx, workspaceId: string, projectId: string | null, parentId: string, childId: string): Promise<void> {
  let at: string | null = parentId;
  for (let depth = 0; at; depth++) {
    if (at === childId || depth > 32) throw new TxError("bad_ref", "a label cannot be inside itself");
    const [p] = await tx.select({ projectId: label.projectId, parentId: label.parentId }).from(label).where(and(eq(label.id, at), eq(label.workspaceId, workspaceId)));
    if (!p) throw new TxError("bad_ref", "parent label is not in the workspace");
    if (depth === 0 && p.projectId !== null && p.projectId !== projectId) throw new TxError("bad_ref", "parent label is in another project");
    at = p.parentId;
  }
}

export async function createLabel(tx: Tx, workspaceId: string, id: string, set: LabelCreate): Promise<Pending> {
  await projectInWorkspace(tx, workspaceId, set.projectId);
  await nameFree(tx, workspaceId, set.projectId, set.name);
  if (set.parentId) await checkParent(tx, workspaceId, set.projectId, set.parentId, id);
  const row = await created(
    tx
      .insert(label)
      .values({ id, workspaceId, projectId: set.projectId, parentId: set.parentId ?? null, name: set.name, color: set.color, position: set.position, onlyPeople: set.onlyPeople ?? false })
      .onConflictDoNothing()
      .returning(labelColumns),
    `label ${id}`,
  );
  return { m: "Label", mid: id, a: "I", d: row as Record<string, unknown> };
}

export async function updateLabel(tx: Tx, workspaceId: string, id: string, set: LabelPatch): Promise<Pending | null> {
  const row = await labelRow(tx, workspaceId, id);
  const { changed, prev } = diff(row, set);
  if (Object.keys(changed).length === 0) return null;
  if (changed.name) await nameFree(tx, workspaceId, row.projectId, changed.name as string, id);
  if (changed.parentId) await checkParent(tx, workspaceId, row.projectId, changed.parentId as string, id);
  await tx.update(label).set(changed).where(eq(label.id, id));
  return { m: "Label", mid: id, a: "U", d: changed, p: prev };
}

export async function deleteLabel(tx: Tx, workspaceId: string, id: string): Promise<Pending> {
  const row = await labelRow(tx, workspaceId, id);
  await unusedBy(tx, and(eq(issue.workspaceId, workspaceId), dsql`${id}::uuid = any(${issue.labelIds})`), (n) => `label ${row.name} is still on ${n} issues: take it off them first`);
  const [child] = await tx.select({ id: label.id }).from(label).where(eq(label.parentId, id)).limit(1);
  if (child) throw new TxError("bad_ref", `label ${row.name} has labels inside: move them out first`);
  await tx.delete(label).where(eq(label.id, id));
  // The project finds the deletion in its Timeline after the row is gone, and the name says what went (PLNR-270).
  return { m: "Label", mid: id, a: "D", d: { projectId: row.projectId }, p: { name: row.name } };
}
