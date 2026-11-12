// The workspace's settings for agents and the CLI (PLNR-239): projects, workflow states, labels, the workspace itself, its
// members and saved views, by key and name. Writes are the browser's ops (packages/protocol settings.ts), so the rules
// stay in the write pipeline (sync/settings.ts) and the policy. Projects, states, labels and the workspace need an admin:
// an agent's role is at most member (sync/members.ts, capRole), so its write token is refused with the pipeline's words;
// a person changes them with their own token, or an admin gives the agent's token those grants (PLNR-271, ADR 0036).
// Members are only read here: roles and removals are a signed-in person's.
import { can, GRANTS, ROLES } from "@rsva/policy";
import { defaultOffOps, deleteLabelOps, deleteStateOps, newProjectOps, uuidv7, type Op } from "@rsva/protocol";
import { sortedStates } from "@rsva/query";
import { STATE_GROUPS, TILE_COLORS, type Project, type ProjectCreate, type StateGroup, type TileColor, type WorkflowState } from "@rsva/schema/models";
import { LABEL_COLORS, labelTree, positionAt } from "@rsva/schema/settings";
import { and, eq, sql as dsql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { labelIds, loadNames, NameError, stateId, type Names } from "./api-names.ts";
import { createInProject, needChange, okTx, projectOf, workspaceOf, writeAll, writeTx } from "./api-tx.ts";
import type { Access } from "./auth/access.ts";
import { db, schema } from "./db.ts";
import { readViews } from "./sync/views.ts";

type Ws = { ws: string };
type Named = Ws & { name: string };
type Body = Record<string, unknown> | null;
type InProject = { Querystring: { project?: string } };

const { workspace, user, member, issue } = schema;

/** A project or workspace tile color by name; null for none. */
function tileColor(v: unknown): TileColor | null {
  if (v === null) return null;
  const c = TILE_COLORS.find((x) => x === String(v).toLowerCase());
  if (!c) throw new NameError(`color: one of ${TILE_COLORS.join(", ")}, or null for none`);
  return c;
}

/** A label color: #rrggbb, or the name of one the app offers ("red"). */
function labelColor(v: unknown): string {
  const s = String(v);
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  const c = LABEL_COLORS.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!c) throw new NameError(`color: #rrggbb or one of ${LABEL_COLORS.map((x) => x.name.toLowerCase()).join(", ")}`);
  return c.value;
}

function stateGroup(v: unknown): StateGroup {
  const g = STATE_GROUPS.find((x) => x === String(v).toLowerCase());
  if (!g) throw new NameError(`group: one of ${STATE_GROUPS.join(", ")}`);
  return g;
}

const labelId = (n: Names, projectId: string, name: unknown) => labelIds(n, projectId, [String(name)])[0]!;

// ── What agents read ──────────────────────────────────────────────────────────────────────────────────────────

const projectView = (p: Project) => ({ key: p.key, name: p.name, color: p.color, formerKeys: p.formerKeys, archivedAt: p.archivedAt, rollover: p.cycleRollover });

const statesOf = (n: Names, projectId: string) => sortedStates([...n.states.values()].filter((s) => s.projectId === projectId));

/** The project's states in the app's order, with how many issues each holds, archived and deleted ones too: a state is deleted only once none is left. */
async function statesView(n: Names, p: Project) {
  const rows = await db.select({ id: issue.stateId, n: dsql<number>`count(*)::int` }).from(issue).where(eq(issue.projectId, p.id)).groupBy(issue.stateId);
  const counts = new Map(rows.map((r) => [r.id, r.n]));
  return statesOf(n, p.id).map((s) => ({ name: s.name, group: s.group, default: s.isDefault, onlyPeople: s.onlyPeople, issues: counts.get(s.id) ?? 0 }));
}

/** The labels the project's issues can use, its own and the workspace's, as a tree, with how many issues carry each (any project, archived and deleted too). */
async function labelsView(n: Names, w: Access, p: Project) {
  const rows = (await db.execute(
    dsql`select l.id, count(*)::int as n from ${issue}, unnest(${issue.labelIds}) as l(id) where ${issue.workspaceId} = ${w.workspaceId} group by l.id`,
  )) as unknown as { id: string; n: number }[];
  const counts = new Map(rows.map((r) => [r.id, r.n]));
  const usable = [...n.labels.values()].filter((l) => l.projectId === null || l.projectId === p.id);
  return labelTree(usable).map(({ label: l, depth }) => ({
    name: l.name,
    color: l.color,
    parent: l.parentId ? (n.labels.get(l.parentId)?.name ?? null) : null,
    depth,
    workspace: l.projectId === null,
    onlyPeople: l.onlyPeople,
    issues: counts.get(l.id) ?? 0,
  }));
}

/**
 * Where a state goes in `group`: before or after a state of that group, by name, else last in it. Halfway between its
 * new neighbours, as a drag in the app puts it (positionAt).
 */
function statePosition(n: Names, projectId: string, group: StateGroup, b: Record<string, unknown>, self?: string): number {
  if (b.before !== undefined && b.after !== undefined) throw new NameError("before or after, not both");
  const others = statesOf(n, projectId).filter((s) => s.group === group && s.id !== self);
  const positions = others.map((s) => s.position);
  const ref = b.before ?? b.after;
  if (ref === undefined) return positionAt(positions, positions.length);
  const at = others.findIndex((s) => s.id === stateId(n, projectId, String(ref)));
  if (at < 0) throw new NameError(`${String(ref)}: a state is placed next to another state of its group (${group})`);
  return positionAt(positions, b.before !== undefined ? at : at + 1);
}

/** The project of `?project=` and the state of the path. */
async function stateOf(req: FastifyRequest<{ Params: Named } & InProject>) {
  const found = await projectOf(req, req.query.project);
  return { ...found, s: found.n.states.get(stateId(found.n, found.p.id, req.params.name))! };
}

/** The project of `?project=` and the label of the path, one of those the project can use. */
async function labelOf(req: FastifyRequest<{ Params: Named } & InProject>) {
  const found = await projectOf(req, req.query.project);
  return { ...found, l: found.n.labels.get(labelId(found.n, found.p.id, req.params.name))! };
}

export function settingsRoutes(app: FastifyInstance): void {
  // ── Workspace, members, views ──────────────────────────────────────────────────────────────────────────────

  // The workspace and who asks: the token's person, their role, the token's scope and what it may change now (`grants`),
  // so it is clear whose token is in use and what it can do; `memberRights`, what the workspace opened to members (ADR 0037).
  app.get<{ Params: Ws }>("/api/v1/workspaces/:ws/workspace", async (req) => {
    const w = await workspaceOf(req);
    const [[ws], [me]] = await Promise.all([
      db.select({ slug: workspace.slug, name: workspace.name, color: workspace.color, memberRights: workspace.memberRights }).from(workspace).where(eq(workspace.id, w.workspaceId)),
      db.select({ email: user.email, name: user.name, kind: user.kind }).from(user).where(eq(user.id, req.actor!.userId)),
    ]);
    return { ...ws!, me: { ...me!, role: w.role, scope: req.actor!.token?.scope ?? null, grants: GRANTS.filter((g) => can(w.viewer, g)) } };
  });

  app.patch<{ Params: Ws; Body: Body }>("/api/v1/workspaces/:ws/workspace", async (req) => {
    const w = await workspaceOf(req);
    const b = req.body ?? {};
    const set = { ...(b.name !== undefined && { name: b.name }), ...(b.color !== undefined && { color: tileColor(b.color) }) };
    needChange(set, "name, color");
    // Alone in its transaction: the pipeline locks the workspace row early (sync/settings.ts).
    return okTx(await writeTx(req, w, [{ op: "update", m: "Workspace", id: w.workspaceId, set } as Op]));
  });

  // Members by role, then name: the emails assignees, delegates, leads and mentions take.
  app.get<{ Params: Ws }>("/api/v1/workspaces/:ws/members", async (req) => {
    const w = await workspaceOf(req);
    const rows = await db
      .select({ email: user.email, name: user.name, kind: user.kind, role: member.role })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.workspaceId, w.workspaceId));
    const rank = (role: string) => ROLES.indexOf(role as (typeof ROLES)[number]);
    return rows.sort((a, b) => rank(b.role) - rank(a.role) || a.name.localeCompare(b.name));
  });

  // Saved views the caller sees, shared ones and their own: the names `GET …/issues?view=` takes. Projects' homes are
  // kept as views (ADR 0053) and are not among them.
  app.get<{ Params: Ws }>("/api/v1/workspaces/:ws/views", async (req) => {
    const w = await workspaceOf(req);
    const me = req.actor!.userId;
    const { v } = await readViews(w.workspaceId, me);
    return v.filter((x) => x.layout !== "home").map((x) => ({ name: x.name, id: x.id, query: x.query, layout: x.layout, shared: x.shared, mine: x.ownerId === me }));
  });

  // ── Projects ───────────────────────────────────────────────────────────────────────────────────────────────

  app.get<{ Params: Ws }>("/api/v1/workspaces/:ws/projects", async (req) => {
    const w = await workspaceOf(req);
    const n = await loadNames(w.workspaceId);
    return [...n.projects.values()].sort((a, b) => a.key.localeCompare(b.key)).map(projectView);
  });

  // A project with its states and labels.
  app.get<{ Params: Ws & { key: string } }>("/api/v1/workspaces/:ws/projects/:key", async (req) => {
    const found = await projectOf(req, req.params.key);
    const { w, n, p } = found;
    const [states, labels] = await Promise.all([statesView(n, p), labelsView(n, w, p)]);
    return { ...projectView(p), states, labels };
  });

  // A new project with the app's default workflow: {"key": "WEB", "name": "Website", "color": "teal"}.
  app.post<{ Params: Ws; Body: Body }>("/api/v1/workspaces/:ws/projects", async (req, reply) => {
    const w = await workspaceOf(req);
    const b = req.body ?? {};
    if (typeof b.key !== "string" || typeof b.name !== "string") throw new NameError("key and name: text");
    const set = { key: b.key.toUpperCase(), name: b.name, color: b.color === undefined ? null : tileColor(b.color) } satisfies ProjectCreate;
    const id = uuidv7();
    const r = await writeTx(req, w, newProjectOps(id, set, uuidv7));
    return reply.code(201).send({ ok: true, key: set.key, id, lastSyncId: r.s });
  });

  // Name, key (the old one stays an alias: its links still lead here), color; `archived` true or false; `rollover` true or
  // false: its cycles complete themselves once over and move their open issues on (PLNR-64).
  app.patch<{ Params: Ws & { key: string }; Body: Body }>("/api/v1/workspaces/:ws/projects/:key", async (req) => {
    const found = await projectOf(req, req.params.key);
    const b = req.body ?? {};
    if (b.archived !== undefined && typeof b.archived !== "boolean") throw new NameError("archived: true or false");
    if (b.rollover !== undefined && typeof b.rollover !== "boolean") throw new NameError("rollover: true or false");
    const set = {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.key !== undefined && { key: String(b.key).toUpperCase() }),
      ...(b.color !== undefined && { color: tileColor(b.color) }),
      // The server sets the time.
      ...(b.archived !== undefined && { archivedAt: b.archived ? new Date().toISOString() : null }),
      ...(b.rollover !== undefined && { cycleRollover: b.rollover }),
    };
    needChange(set, "name, key, color, archived, rollover");
    return okTx(await writeTx(req, found.w, [{ op: "update", m: "Project", id: found.p.id, set } as Op]));
  });

  // ── Workflow states ────────────────────────────────────────────────────────────────────────────────────────

  app.get<{ Params: Ws } & InProject>("/api/v1/workspaces/:ws/states", async (req) => {
    const found = await projectOf(req, req.query.project);
    return statesView(found.n, found.p);
  });

  // {"project": "PLNR", "name": "In Review", "group": "started", "after": "In Progress"}: last in its group unless
  // `before` or `after` names a state of that group.
  app.post<{ Params: Ws; Body: Body }>("/api/v1/workspaces/:ws/states", async (req, reply) => {
    const made = await createInProject(req, "WorkflowState", (n, p, b) => {
      const group = stateGroup(b.group);
      return { name: b.name, group, position: statePosition(n, p.id, group, b) };
    });
    // The name as stored: cleaned of what cannot be seen (cleanName).
    return reply.code(201).send({ ok: true, name: made.row.name, lastSyncId: made.r.s });
  });

  // Name; group (last in it unless placed); `before` or `after` a state of its group; `default: true`. A default is
  // replaced by making another state the default, never switched off.
  app.patch<{ Params: Named; Body: Body } & InProject>("/api/v1/workspaces/:ws/states/:name", async (req) => {
    const { w, n, p, s } = await stateOf(req);
    const b = req.body ?? {};
    if (b.default !== undefined && b.default !== true) throw new NameError("default: true; a default is replaced by making another state the default");
    const group = b.group === undefined ? (s.group as StateGroup) : stateGroup(b.group);
    const moved = group !== s.group || b.before !== undefined || b.after !== undefined;
    const set: Partial<WorkflowState> = {
      ...(b.name !== undefined && { name: b.name as string }),
      ...(group !== s.group && { group }),
      ...(moved && { position: statePosition(n, p.id, group, b, s.id) }),
      ...(b.default === true && { isDefault: true }),
    };
    needChange(set, "name, group, before, after, default");
    const off = set.isDefault ? defaultOffOps(statesOf(n, p.id), s.id) : [];
    return okTx(await writeTx(req, w, [...off, { op: "update", m: "WorkflowState", id: s.id, set } as Op]));
  });

  // Deletes a state, moving its issues (archived and deleted ones too) to `moveTo` first, which also becomes the default
  // if this one was: `DELETE …/states/Review?project=PLNR&moveTo=In%20Progress`. An empty state needs no `moveTo`.
  app.delete<{ Params: Named; Querystring: { project?: string; moveTo?: string } }>("/api/v1/workspaces/:ws/states/:name", async (req) => {
    const { w, n, p, s } = await stateOf(req);
    const ids = (await db.select({ id: issue.id }).from(issue).where(eq(issue.stateId, s.id))).map((r) => r.id);
    const moveTo = req.query.moveTo;
    if (moveTo === undefined && (ids.length || s.isDefault)) throw new NameError(`moveTo: the state ${ids.length ? `its ${ids.length} issues go to` : "that becomes the default"}`);
    // Without moveTo nothing moves, and the target is unused.
    const target = moveTo === undefined ? s.id : stateId(n, p.id, moveTo);
    if (moveTo !== undefined && target === s.id) throw new NameError("moveTo: another state");
    const last = await writeAll(req, w, deleteStateOps(s, ids, target));
    return { ok: true, moved: ids.length, lastSyncId: last };
  });

  // ── Labels ─────────────────────────────────────────────────────────────────────────────────────────────────

  app.get<{ Params: Ws } & InProject>("/api/v1/workspaces/:ws/labels", async (req) => {
    const found = await projectOf(req, req.query.project);
    return labelsView(found.n, found.w, found.p);
  });

  // {"project": "PLNR", "name": "security", "color": "red", "parent": "area"}. Without a color, the next of the app's
  // after the labels the project can use, as its settings screen picks it; last in the list, as there.
  app.post<{ Params: Ws; Body: Body }>("/api/v1/workspaces/:ws/labels", async (req, reply) => {
    const made = await createInProject(req, "Label", (n, p, b) => {
      const usable = [...n.labels.values()].filter((l) => l.projectId === null || l.projectId === p.id);
      return {
        name: b.name,
        color: b.color === undefined ? LABEL_COLORS[usable.length % LABEL_COLORS.length]!.value : labelColor(b.color),
        parentId: b.parent === undefined || b.parent === null ? null : labelId(n, p.id, b.parent),
        position: Math.max(0, ...usable.map((l) => l.position)) + 1,
      };
    });
    return reply.code(201).send({ ok: true, name: made.row.name, color: made.row.color, lastSyncId: made.r.s });
  });

  // Name, color, parent (a label's name, or null for the top level).
  app.patch<{ Params: Named; Body: Body } & InProject>("/api/v1/workspaces/:ws/labels/:name", async (req) => {
    const { w, n, p, l } = await labelOf(req);
    const b = req.body ?? {};
    const set = {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.color !== undefined && { color: labelColor(b.color) }),
      ...(b.parent !== undefined && { parentId: b.parent === null ? null : labelId(n, p.id, b.parent) }),
    };
    needChange(set, "name, color, parent");
    return okTx(await writeTx(req, w, [{ op: "update", m: "Label", id: l.id, set } as Op]));
  });

  // Takes the label off every issue (any project, archived and deleted too), moves the labels inside it up a level and
  // deletes it, as the app's Delete does.
  app.delete<{ Params: Named } & InProject>("/api/v1/workspaces/:ws/labels/:name", async (req) => {
    const { w, n, l } = await labelOf(req);
    const issues = await db
      .select({ id: issue.id, labelIds: issue.labelIds })
      .from(issue)
      .where(and(eq(issue.workspaceId, w.workspaceId), dsql`${l.id}::uuid = any(${issue.labelIds})`));
    const last = await writeAll(req, w, deleteLabelOps(l, issues, n.labels.values()));
    return { ok: true, removedFrom: issues.length, lastSyncId: last };
  });
}
