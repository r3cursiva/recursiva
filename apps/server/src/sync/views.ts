// Saved views over the socket (PLNR-74): read and written outside the log, each viewer getting the shared views and
// their own (packages/protocol/src/views.ts). Like the inbox marks, a warm client asks only for what changed after the
// last change it has, so a warm start with nothing new receives nothing.
import {
  GROUP_NAME_MAX,
  GROUPS_MAX,
  HOME_DISPLAY_MAX,
  mayEditView,
  PIN_KINDS,
  PINS_MAX,
  PROJECT_ORDER_MAX,
  VIEW_DISPLAY_MAX,
  VIEW_ICONS,
  VIEW_LAYOUTS,
  VIEW_NAME_MAX,
  VIEW_QUERY_MAX,
  NO_GROUPS,
  type PinRef,
  type SavedView,
  type SidebarGroups,
  type ViewsFrame,
  type ViewWrite,
} from "@rsva/protocol";
import { isDefaultHome } from "@rsva/protocol/home";
import { mayManage, type Role } from "@rsva/policy";
import { cleanName, UUID_PATTERN } from "@rsva/schema/models";
import { and, count, eq, gt, isNull, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db.ts";

const { projectOrder, savedView } = schema;

/**
 * Live views one person keeps in a workspace, homes included (RSVA-607). Every member gets the shared ones in each answer
 * and their owner the private ones too, so without a cap one member could make that answer tens of MB.
 */
export const VIEWS_MAX = 500;

const viewColumns = {
  id: savedView.id,
  ownerId: savedView.ownerId,
  name: savedView.name,
  icon: savedView.icon,
  query: savedView.query,
  display: savedView.display,
  layout: savedView.layout,
  shared: savedView.shared,
  tab: savedView.tab,
  position: savedView.position,
  createdAt: savedView.createdAt,
  updatedAt: savedView.updatedAt,
  deletedAt: savedView.deletedAt,
};

type ViewRow = Omit<SavedView, "icon" | "layout" | "display"> & { icon: string; layout: string; display: unknown; deletedAt: string | null };

const visibleTo = (v: Pick<ViewRow, "ownerId" | "shared" | "deletedAt">, me: string) => v.deletedAt === null && (v.shared || v.ownerId === me);

function toView({ deletedAt: _, ...v }: ViewRow): SavedView {
  return { ...v, icon: v.icon as SavedView["icon"], layout: v.layout as SavedView["layout"], display: (v.display ?? {}) as Record<string, unknown> };
}

const latest = (times: (string | undefined)[], from: string | null): string | null =>
  times.reduce<string | null>((max, t) => (t !== undefined && (max === null || t > max) ? t : max), from);

const ownOrder = (workspaceId: string, me: string) => and(eq(projectOrder.userId, me), eq(projectOrder.workspaceId, workspaceId));
const sidebarColumns = { ids: projectOrder.ids, pins: projectOrder.pins, hidden: projectOrder.hidden, groups: projectOrder.groups, updatedAt: projectOrder.updatedAt };
type SidebarRow = { ids: string[]; pins: string[]; hidden: string[]; groups: unknown; updatedAt: string };

/**
 * The row's groups: `{}` until the viewer makes one. Only the fields this server knows go out: the client writes the
 * whole object back, and a field it kept from an older shape would make the strict write schema refuse it.
 */
function groupsOf(row: SidebarRow | undefined): SidebarGroups {
  const g = (row?.groups ?? {}) as Partial<SidebarGroups>;
  return { groups: g.groups ?? NO_GROUPS.groups, keep: g.keep ?? NO_GROUPS.keep, quiet: g.quiet ?? NO_GROUPS.quiet };
}

/** The viewer's sidebar as a frame carries it; `p` repeats the pinned views for a client before PLNR-292. */
const sidebarFields = (row: SidebarRow | undefined) => {
  const pins = (row?.pins ?? []) as PinRef[];
  return { p: viewPins(pins), o: row?.ids ?? [], s: pins, h: row?.hidden ?? [], g: groupsOf(row) };
};
const viewPins = (pins: string[]): [string, boolean][] => pins.filter((r) => r.startsWith("view:")).map((r) => [r.slice(5), true]);

/** The live views the viewer sees, oldest first: the shared ones and their own. */
const visibleViews = (workspaceId: string, me: string) =>
  db
    .select(viewColumns)
    .from(savedView)
    .where(and(eq(savedView.workspaceId, workspaceId), isNull(savedView.deletedAt), or(eq(savedView.shared, true), eq(savedView.ownerId, me))))
    .orderBy(savedView.createdAt);

/** Every view the viewer sees and their sidebar (order of projects, pins, hidden projects), with the latest change as the cursor. */
export async function readViews(workspaceId: string, me: string): Promise<ViewsFrame> {
  const [rows, [last], [order]] = await Promise.all([
    visibleViews(workspaceId, me),
    // Anyone's change counts: a client that starts from this cursor must not ask again for what it was just given.
    db
      .select({ at: dsql<string | null>`max(${savedView.updatedAt})` })
      .from(savedView)
      .where(eq(savedView.workspaceId, workspaceId)),
    db.select(sidebarColumns).from(projectOrder).where(ownOrder(workspaceId, me)),
  ]);
  return { t: "views", full: true, v: rows.map(toView), gone: [], ...sidebarFields(order), at: latest([order?.updatedAt], last?.at ?? null) };
}

/**
 * What changed after `at`: views the viewer sees now, and as gone the ones deleted or private to someone else (only
 * their ids). Null when nothing did.
 */
export async function viewsSince(workspaceId: string, me: string, at: string): Promise<ViewsFrame | null> {
  const [rows, [order]] = await Promise.all([
    db
      .select(viewColumns)
      .from(savedView)
      .where(and(eq(savedView.workspaceId, workspaceId), gt(savedView.updatedAt, at)))
      .orderBy(savedView.updatedAt),
    db.select(sidebarColumns).from(projectOrder).where(and(ownOrder(workspaceId, me), gt(projectOrder.updatedAt, at))),
  ]);
  if (!rows.length && !order) return null;
  return {
    t: "views",
    v: rows.filter((r) => visibleTo(r, me)).map(toView),
    gone: rows.filter((r) => !visibleTo(r, me)).map((r) => r.id),
    ...(order ? sidebarFields(order) : { p: [] }),
    at: latest([...rows.map((r) => r.updatedAt), order?.updatedAt], at),
  };
}

/** A view the viewer sees, by id or by name (case-insensitive), for the agent API's `view=`; or why there is none. */
export async function findView(workspaceId: string, me: string, ref: string): Promise<SavedView | { error: string }> {
  const rows = (await visibleViews(workspaceId, me)).filter((v) => v.layout !== "home");
  const want = ref.trim().toLowerCase();
  const hits = rows.filter((v) => v.id === want || v.name.toLowerCase() === want);
  // Two views of one name: the viewer's own wins over a shared one, as it is the one they mean.
  const hit = hits.find((v) => v.ownerId === me) ?? hits[0];
  if (hit) return toView(hit);
  return { error: `no view "${ref}"; views: ${rows.map((v) => `"${v.name}"`).join(", ") || "none"}` };
}

// A home's display holds its widgets (ADR 0053): the longer limit here, a view's own once the layout is known (`fits`).
const display = z
  .record(z.string(), z.unknown())
  .refine((d) => JSON.stringify(d).length <= HOME_DISPLAY_MAX, `display options are longer than ${HOME_DISPLAY_MAX} bytes`);
const fields = z
  .object({
    name: z.string().transform(cleanName).pipe(z.string().min(1, "a view needs a name").max(VIEW_NAME_MAX)),
    icon: z.enum(VIEW_ICONS),
    query: z.string().max(VIEW_QUERY_MAX),
    display,
    layout: z.enum(VIEW_LAYOUTS),
    shared: z.boolean(),
    tab: z.boolean(),
    position: z.number().finite(),
  })
  .strict();
const PIN_REF = new RegExp(`^(${PIN_KINDS.join("|")}):${UUID_PATTERN}$`);
const distinct = (xs: string[]) => new Set(xs).size === xs.length;
const projectIds = z.array(z.uuid()).max(PROJECT_ORDER_MAX).refine(distinct, "a project twice");
const groupsSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().transform(cleanName).pipe(z.string().min(1, "a group needs a name").max(GROUP_NAME_MAX)),
            ids: projectIds,
            folded: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(GROUPS_MAX)
      .refine((gs) => distinct(gs.map((g) => g.id)), "a group twice")
      .refine((gs) => distinct(gs.flatMap((g) => g.ids)), "a project in two groups"),
    keep: projectIds,
    quiet: z
      .array(z.tuple([z.uuid(), z.iso.datetime({ offset: true })]))
      .max(PROJECT_ORDER_MAX)
      .refine((q) => distinct(q.map(([id]) => id)), "a project twice"),
  })
  .strict();

const writeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("save"), id: z.uuid(), set: fields.partial() }).strict(),
  z.object({ op: z.literal("delete"), id: z.uuid() }).strict(),
  z.object({ op: z.literal("pin"), id: z.uuid(), pinned: z.boolean() }).strict(),
  // Not checked against the workspace's projects: an id of nothing sorts nowhere, and only its owner ever reads it back.
  z.object({ op: z.literal("order"), ids: z.array(z.uuid()).max(PROJECT_ORDER_MAX) }).strict(),
  z.object({ op: z.literal("pins"), refs: z.array(z.string().regex(PIN_REF)).max(PINS_MAX).refine(distinct, "a pin twice") }).strict(),
  z.object({ op: z.literal("hidden"), ids: projectIds }).strict(),
  z.object({ op: z.literal("groups"), groups: groupsSchema }).strict(),
]);

export class ViewError extends Error {}

/**
 * A view as it would be after a save: a list's or a board's display within a view's limit; a home never a tab and
 * always shared (RSVA-577: a project shows one page to all), the default home (every project's first page) an admin's.
 */
function fits(v: Pick<ViewRow, "layout" | "tab" | "query" | "shared"> & { display: unknown }, role: Role): void {
  if (v.layout === "home") {
    if (v.tab) throw new ViewError("a project's home is not a tab");
    if (!v.shared) throw new ViewError("a home is everyone's: it cannot be private");
    if (isDefaultHome(v) && !mayManage(role)) throw new ViewError("only an admin changes the workspace's default home");
  } else if (JSON.stringify(v.display ?? {}).length > VIEW_DISPLAY_MAX) throw new ViewError(`display options are longer than ${VIEW_DISPLAY_MAX} bytes`);
}

/** Replaces one list of the viewer's sidebar row, making the row when there is none. */
async function setSidebar(workspaceId: string, me: string, set: Partial<Pick<SidebarRow, "ids" | "pins" | "hidden" | "groups">>): Promise<SidebarRow> {
  const [row] = await db
    .insert(projectOrder)
    .values({ userId: me, workspaceId, ids: [], ...set })
    .onConflictDoUpdate({ target: [projectOrder.userId, projectOrder.workspaceId], set: { ...set, updatedAt: dsql`clock_timestamp()` } })
    .returning(sidebarColumns);
  return row!;
}

/**
 * The result of a write, for delivery: the view as it is now and whether it was shared before or after (then everyone
 * in the workspace hears of it), or the viewer's pin or order of projects (only their sockets).
 */
export type ViewChange = { view: ViewRow; wasShared: boolean } | { own: ViewsFrame };

/** Applies one write by `me`; refuses what their role may not do and anything outside the workspace. */
export async function writeView(workspaceId: string, me: string, role: Role, raw: unknown): Promise<ViewChange> {
  const parsed = writeSchema.safeParse(raw);
  if (!parsed.success) throw new ViewError(z.prettifyError(parsed.error));
  const w: ViewWrite = parsed.data as ViewWrite;
  // The viewer's sidebar: one row, each write replacing one list in it; the echo carries only that list.
  const own = async (set: Parameters<typeof setSidebar>[2], echo: (row: SidebarRow) => Partial<ViewsFrame>): Promise<ViewChange> => {
    const row = await setSidebar(workspaceId, me, set);
    return { own: { t: "views", v: [], gone: [], p: [], ...echo(row), at: row.updatedAt } };
  };
  if (w.op === "order") return own({ ids: w.ids }, (row) => ({ o: row.ids }));
  if (w.op === "pins") return own({ pins: w.refs }, (row) => ({ s: row.pins as PinRef[] }));
  if (w.op === "hidden") return own({ hidden: w.ids }, (row) => ({ h: row.hidden }));
  if (w.op === "groups") return own({ groups: w.groups }, (row) => ({ g: groupsOf(row) }));
  return db.transaction(async (tx) => {
    const [before] = await tx.select({ ...viewColumns, workspaceId: savedView.workspaceId }).from(savedView).where(eq(savedView.id, w.id)).for("update");
    if (before && before.workspaceId !== workspaceId) throw new ViewError("no such view");
    if (w.op === "pin") {
      if (!before || !visibleTo(before, me)) throw new ViewError("no such view");
      // A client before PLNR-292: the view goes to the end of the list, or out of it.
      const ref = `view:${w.id}`;
      const pins = w.pinned ? dsql`array_append(array_remove(${projectOrder.pins}, ${ref}), ${ref})` : dsql`array_remove(${projectOrder.pins}, ${ref})`;
      const [row] = await tx
        .insert(projectOrder)
        .values({ userId: me, workspaceId, ids: [], pins: w.pinned ? [ref] : [] })
        .onConflictDoUpdate({ target: [projectOrder.userId, projectOrder.workspaceId], set: { pins, updatedAt: dsql`clock_timestamp()` } })
        .returning(sidebarColumns);
      return { own: { t: "views", v: [], gone: [], p: [[w.id, w.pinned]], s: row!.pins as PinRef[], at: row!.updatedAt } };
    }
    // A deleted view comes back by saving it again (undo), for those who could have deleted it.
    const restoring = w.op === "save" && before?.deletedAt != null && mayEditView(before, me, role);
    if (before && !visibleTo(before, me) && !restoring) throw new ViewError("no such view");
    if (before && !mayEditView(before, me, role)) throw new ViewError("only its owner or an admin changes a shared view");
    if (w.op === "delete") {
      if (!before) throw new ViewError("no such view");
      const [row] = await tx
        .update(savedView)
        .set({ deletedAt: dsql`clock_timestamp()`, updatedAt: dsql`clock_timestamp()` })
        .where(eq(savedView.id, w.id))
        .returning(viewColumns);
      return { view: row!, wasShared: before.shared };
    }
    const set = w.set;
    // Someone else's shared view stays theirs when an admin edits it; only its owner makes it private.
    if (before && set.shared === false && before.ownerId !== me) throw new ViewError("only its owner makes a view private");
    // A new view, or a deleted one coming back, is one more live view of its owner.
    if (!before || before.deletedAt) {
      const owner = before?.ownerId ?? me;
      const [live] = await tx
        .select({ n: count() })
        .from(savedView)
        .where(and(eq(savedView.workspaceId, workspaceId), eq(savedView.ownerId, owner), isNull(savedView.deletedAt)));
      if (live!.n >= VIEWS_MAX) throw new ViewError(`at most ${VIEWS_MAX} saved views a person in a workspace`);
    }
    if (!before) {
      const full = fields.safeParse(set);
      if (!full.success) throw new ViewError(z.prettifyError(full.error));
      fits(full.data, role);
      const [row] = await tx
        .insert(savedView)
        .values({ id: w.id, workspaceId, ownerId: me, ...full.data })
        .returning(viewColumns);
      return { view: row!, wasShared: false };
    }
    fits({ ...before, ...set }, role);
    const [row] = await tx
      .update(savedView)
      .set({ ...set, deletedAt: null, updatedAt: dsql`clock_timestamp()` })
      .where(eq(savedView.id, w.id))
      .returning(viewColumns);
    return { view: row!, wasShared: before.shared };
  });
}

/**
 * The frame a change makes for one person: the view if they see it now, its id as gone if they saw it before, nothing
 * otherwise. Pins go to their owner only, so they are not here.
 */
export function viewFrameFor(change: Extract<ViewChange, { view: ViewRow }>, userId: string): ViewsFrame | null {
  const { view, wasShared } = change;
  const base = { t: "views" as const, p: [], at: view.updatedAt };
  if (visibleTo(view, userId)) return { ...base, v: [toView(view)], gone: [] };
  if (view.ownerId === userId || wasShared) return { ...base, v: [], gone: [view.id] };
  return null;
}
