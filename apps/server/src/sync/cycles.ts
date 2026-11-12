// Cycles in the write pipeline (PLNR-63) and their burn-up: GET /sync/cycle-progress/:cycleId.
//
// Rules, checked here inside the transaction: a cycle has both dates or none (a draft), ends on or after its start, and
// meets no other cycle of its project. Date changes of a project's cycles take turns on the project row, so two at once
// cannot both pass the overlap check. Numbers count up per project under the same lock. Completing a cycle freezes its
// summary (counts by state group, the open issues, the day-by-day series) from the issues as the completion finds them;
// the client moves the open ones on in the same transaction, after the completion op. A completed cycle keeps its dates
// and takes no new issues; issues may still leave it.
//
// The burn-up is read off the log: every U action stores its fields' values before, so an issue's cycle and state at the
// end of any day is the `prev` of its first change after that moment, or its value now when it has not changed since.
// Its points are the cycle's first moment, then the end of each day (RSVA-528), in the viewer's time zone: the client
// counts today in theirs, so a UTC day would leave yesterday out for hours. A summary is frozen in the zone of who
// completes the cycle, else of who made it, else UTC.
// Considered (2026-10-30, docs/research/cycles-2026-10-30.md): daily totals kept by the write pipeline in a table (a
// second record to keep in step, and every issue write pays for it), and the series counted in the browser from the
// issues' times (it has no history of cycle moves and state changes, only completedAt). Days that are over never change:
// an answer is cached per cycle and day, and the day in progress is the client's own count.
import { addDays, dayIn, dayStart } from "@rsva/schema/days";
import type { CycleProgress } from "@rsva/protocol";
import { CYCLE_DESCRIPTION_MAX, cyclesOverlap, isClosedGroup, type Cycle, type CycleCreate, type CyclePatch, type CycleSummary } from "@rsva/schema/models";
import { and, asc, eq, gte, inArray, ne, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "../db.ts";
import { name } from "../http.ts";
import { cycleColumns } from "./columns.ts";
import { metered } from "./history.ts";
import { created, diff, lockOwned, unusedBy } from "./rows.ts";
import { TxError, type Pending } from "./tx-error.ts";

const { project, cycle, issue, member, workflowState, syncAction, accountSettings } = schema;

const uuid = z.uuid();
const day = z.iso.date();
/** Longest cycle, days: a quarter-year box is already long; a year is a mistake in the dates. */
const CYCLE_DAYS_MAX = 366;
const description = z.string().max(CYCLE_DESCRIPTION_MAX).transform((s) => s.trim());
const fields = z.object({ name, description, startDate: day.nullable(), endDate: day.nullable(), leadId: uuid.nullable() });

const target = { id: uuid };
export const cycleOpSchemas = [
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("create"), m: z.literal("Cycle"), ...target, set: fields.partial().required({ name: true }).extend({ projectId: uuid }).strict() }).strict(),
    z.object({ op: z.literal("update"), m: z.literal("Cycle"), ...target, set: fields.extend({ completedAt: z.iso.datetime({ offset: true }) }).partial().strict() }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("Cycle"), ...target }).strict(),
  ]),
] as const;

/** Today as the server counts days: UTC. */
export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The project row, locked: date changes and numbers of its cycles take turns on it. */
async function lockProject(tx: Tx, workspaceId: string, projectId: string): Promise<void> {
  const [p] = await tx.select({ id: project.id }).from(project).where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId))).for("update");
  if (!p) throw new TxError("bad_ref", "project is not in the workspace");
}

/** Dates a cycle may take: both or none, in order, not too long, and clear of the project's other cycles. */
async function checkDates(tx: Tx, projectId: string, self: string, startDate: string | null, endDate: string | null): Promise<void> {
  if ((startDate === null) !== (endDate === null)) throw new TxError("invalid", "a cycle has both a start and an end date, or neither (a draft)");
  if (!startDate || !endDate) return;
  if (endDate < startDate) throw new TxError("invalid", "a cycle ends on or after its start");
  if (Date.parse(endDate) - Date.parse(startDate) >= CYCLE_DAYS_MAX * 86_400_000) throw new TxError("invalid", `a cycle is at most ${CYCLE_DAYS_MAX} days long`);
  const others = await tx
    .select({ name: cycle.name, startDate: cycle.startDate, endDate: cycle.endDate })
    .from(cycle)
    .where(and(eq(cycle.projectId, projectId), ne(cycle.id, self)));
  const hit = others.find((o) => cyclesOverlap(o, { startDate, endDate }));
  if (hit) throw new TxError("conflict", `the dates overlap ${hit.name} (${hit.startDate} – ${hit.endDate}): cycles of one project cannot overlap`);
}

async function checkLead(tx: Tx, workspaceId: string, leadId: string): Promise<void> {
  const [m] = await tx.select({ id: member.userId }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, leadId)));
  if (!m) throw new TxError("bad_ref", "the lead is not a workspace member");
}

export async function createCycle(tx: Tx, workspaceId: string, actorId: string, id: string, set: CycleCreate): Promise<Pending> {
  await lockProject(tx, workspaceId, set.projectId);
  await checkDates(tx, set.projectId, id, set.startDate ?? null, set.endDate ?? null);
  if (set.leadId) await checkLead(tx, workspaceId, set.leadId);
  const [{ n }] = (await tx.select({ n: dsql<number>`coalesce(max(${cycle.number}), 0)::int + 1` }).from(cycle).where(eq(cycle.projectId, set.projectId))) as [{ n: number }];
  const row = await created(tx.insert(cycle).values({ ...set, id, workspaceId, number: n, createdById: actorId }).onConflictDoNothing().returning(cycleColumns), `cycle ${id}`);
  return { m: "Cycle", mid: id, a: "I", d: row as Record<string, unknown> };
}

const cycleRow = (tx: Tx, workspaceId: string, id: string) => lockOwned(tx, cycle, workspaceId, id, "cycle");

export async function updateCycle(tx: Tx, workspaceId: string, actorId: string, id: string, set: CyclePatch): Promise<Pending | null> {
  const row = await cycleRow(tx, workspaceId, id);
  const { completedAt, ...rest } = set;
  const { changed, prev } = diff(row, rest);
  if ("startDate" in changed || "endDate" in changed) {
    if (row.completedAt) throw new TxError("invalid", "a completed cycle keeps its dates");
    await lockProject(tx, workspaceId, row.projectId);
    await checkDates(tx, row.projectId, id, "startDate" in changed ? (changed.startDate as string | null) : row.startDate, "endDate" in changed ? (changed.endDate as string | null) : row.endDate);
  }
  if (changed.leadId) await checkLead(tx, workspaceId, changed.leadId as string);
  const completing = completedAt !== undefined && !row.completedAt;
  if (completing) {
    if (!row.startDate || !row.endDate) throw new TxError("invalid", "a draft has no dates to complete: give it dates first");
    // A day of slack for the viewer's time zone: the cycle has started where they are.
    if (row.startDate > addDays(todayUtc(), 1)) throw new TxError("invalid", "a cycle that has not started cannot be completed");
    changed.summary = await summarize(tx, row, await zoneOf(tx, actorId, row.createdById));
    prev.summary = null;
  }
  if (!Object.keys(changed).length) return null;
  const [after] = await tx
    .update(cycle)
    .set({ ...changed, ...(completing ? { completedAt: dsql`now()` } : {}) } as unknown as Partial<typeof cycle.$inferInsert>)
    .where(eq(cycle.id, id))
    .returning({ completedAt: cycle.completedAt });
  if (completing) {
    changed.completedAt = after!.completedAt;
    prev.completedAt = null;
  }
  return { m: "Cycle", mid: id, a: "U", d: changed, p: prev };
}

/** Why a completed cycle is not deleted; the agent API says it before taking any issue out (api-cycles.ts). */
export const COMPLETED_KEPT = "a completed cycle is the record of its work and is kept";

export async function deleteCycle(tx: Tx, workspaceId: string, id: string): Promise<Pending> {
  const row = await cycleRow(tx, workspaceId, id);
  if (row.completedAt) throw new TxError("invalid", COMPLETED_KEPT);
  await unusedBy(tx, eq(issue.cycleId, id), (n) => `${row.name} still has ${n} issues: move them out first`);
  await tx.delete(cycle).where(eq(cycle.id, id));
  return { m: "Cycle", mid: id, a: "D", d: { projectId: row.projectId } };
}

/** An issue may go into a cycle of its own project that is not completed. */
export async function checkIssueCycle(tx: Tx, workspaceId: string, projectId: string, cycleId: string): Promise<void> {
  const [c] = await tx.select({ projectId: cycle.projectId, completedAt: cycle.completedAt, name: cycle.name }).from(cycle).where(and(eq(cycle.id, cycleId), eq(cycle.workspaceId, workspaceId)));
  if (!c || c.projectId !== projectId) throw new TxError("bad_ref", "cycle is not in the issue's project");
  if (c.completedAt) throw new TxError("invalid", `${c.name} is completed: it takes no new issues`);
}

// ── Summary and burn-up ───────────────────────────────────────────────────────────────────────────────────────

type Reader = Pick<Tx, "select" | "selectDistinct">;
type Dated = Pick<Cycle, "id" | "projectId" | "startDate" | "endDate"> & { workspaceId: string };

const ms = (col: Parameters<typeof dsql>[1]) => dsql<number>`(extract(epoch from ${col}) * 1000)::float8`;

/**
 * Counts at each moment of `ends` (epoch ms, in order): issues in the cycle, those started or done, and done. An issue's
 * cycle and state at a moment are the before-values of its first change after it, else its values now.
 */
async function countAt(q: Reader, c: Dated, ends: number[]): Promise<Pick<CycleSummary, "scope" | "started" | "done">> {
  const out = { scope: [] as number[], started: [] as number[], done: [] as number[] };
  if (!ends.length) return out;
  const groups = new Map((await q.select({ id: workflowState.id, group: workflowState.group }).from(workflowState).where(eq(workflowState.projectId, c.projectId))).map((s) => [s.id, s.group]));
  // The project's issue changes since the first moment asked, through the (model_id, id) index per issue.
  const since = and(
    eq(syncAction.workspaceId, c.workspaceId),
    eq(syncAction.model, "Issue"),
    eq(syncAction.action, "U"),
    inArray(syncAction.modelId, q.select({ id: issue.id }).from(issue).where(eq(issue.projectId, c.projectId))),
    gte(syncAction.createdAt, new Date(ends[0]!).toISOString()),
  );
  // Only issues that are in the cycle or moved in or out of it since its start leave the database: in a busy project
  // most changes are of issues the cycle never had (50 000 changes in the project: 266 → 44 ms cold, 128 ms with 24
  // issues in the cycle, 8 ms from the cache; docs/research/cycles-2026-10-30.md).
  const moved = q
    .selectDistinct({ id: syncAction.modelId })
    .from(syncAction)
    .where(and(since, dsql`${syncAction.data} ? 'cycleId'`, dsql`(${syncAction.data}->>'cycleId' = ${c.id} or ${syncAction.prev}->>'cycleId' = ${c.id})`));
  const issues = await q
    .select({ id: issue.id, cycleId: issue.cycleId, stateId: issue.stateId, createdAt: ms(issue.createdAt), deletedAt: ms(issue.deletedAt) })
    .from(issue)
    .where(and(eq(issue.projectId, c.projectId), or(eq(issue.cycleId, c.id), inArray(issue.id, moved))));
  if (!issues.length) return { scope: ends.map(() => 0), started: ends.map(() => 0), done: ends.map(() => 0) };
  const acts = await q
    .select({ mid: syncAction.modelId, at: ms(syncAction.createdAt), d: syncAction.data, p: syncAction.prev })
    .from(syncAction)
    .where(and(since, inArray(syncAction.modelId, issues.map((i) => i.id)), dsql`${syncAction.data} ?| array['cycleId', 'stateId']`))
    .orderBy(asc(syncAction.id));
  // Changes per issue and field, oldest first: [moment, value before].
  const changes = new Map<string, { cycleId: [number, unknown][]; stateId: [number, unknown][] }>();
  for (const a of acts) {
    const d = (a.d ?? {}) as Record<string, unknown>;
    const p = (a.p ?? {}) as Record<string, unknown>;
    let ch = changes.get(a.mid);
    if (!ch) changes.set(a.mid, (ch = { cycleId: [], stateId: [] }));
    for (const f of ["cycleId", "stateId"] as const) if (f in d && f in p) ch[f].push([a.at, p[f]]);
  }
  const at = (list: [number, unknown][] | undefined, now: unknown, t: number) => {
    const next = list?.find(([when]) => when > t);
    return next ? next[1] : now;
  };
  for (const t of ends) {
    let scope = 0;
    let started = 0;
    let done = 0;
    for (const i of issues) {
      if (i.createdAt >= t || (i.deletedAt && i.deletedAt < t)) continue;
      const ch = changes.get(i.id);
      if (at(ch?.cycleId, i.cycleId, t) !== c.id) continue;
      scope++;
      const g = groups.get(at(ch?.stateId, i.stateId, t) as string);
      if (g === "completed") done++;
      if (g === "started" || g === "completed") started++;
    }
    out.scope.push(scope);
    out.started.push(started);
    out.done.push(done);
  }
  return out;
}

/**
 * The moments of the series in `timeZone`: the cycle's first one, then the end of each day from its start through `last`
 * (none when `last` is before the start), the last cut at `lastAt` when given.
 */
function moments(start: string, last: string, timeZone: string, lastAt?: number): number[] {
  const out = [dayStart(start, timeZone).getTime()];
  for (let d = start; d <= last; d = addDays(d, 1)) out.push(dayStart(addDays(d, 1), timeZone).getTime());
  if (lastAt !== undefined) out[out.length - 1] = Math.min(out[out.length - 1]!, lastAt);
  return out;
}

/** The zone a summary is frozen in: of who completes the cycle, else of who made it, else UTC. */
async function zoneOf(tx: Tx, actorId: string, createdById: string | null): Promise<string> {
  const ids = createdById ? [actorId, createdById] : [actorId];
  const rows = await tx.select({ userId: accountSettings.userId, tz: accountSettings.timeZone }).from(accountSettings).where(inArray(accountSettings.userId, ids));
  const tz = (id: string) => rows.find((r) => r.userId === id)?.tz;
  return tz(actorId) ?? (createdById && tz(createdById)) ?? "UTC";
}

/** The cycle as it is being completed: its issues by group, the open ones, and the series through now. */
async function summarize(tx: Tx, c: typeof cycle.$inferSelect, timeZone: string): Promise<CycleSummary> {
  const rows = await tx.select({ id: issue.id, group: workflowState.group }).from(issue).innerJoin(workflowState, eq(workflowState.id, issue.stateId)).where(and(eq(issue.cycleId, c.id), dsql`${issue.deletedAt} is null`));
  const groups: Record<string, number> = {};
  for (const r of rows) groups[r.group] = (groups[r.group] ?? 0) + 1;
  const today = dayIn(new Date(), timeZone);
  const last = c.endDate! < today ? c.endDate! : today;
  const series = await countAt(tx, c, moments(c.startDate!, last, timeZone, Date.now()));
  return { groups, open: rows.filter((r) => !isClosedGroup(r.group)).map((r) => r.id), ...series };
}

/** Answers by cycle, dates and last day: a day that is over never changes. */
const cache = new Map<string, CycleProgress>();
const CACHE_MAX = 500;

/**
 * The cycle's first moment and the ends of its days that are over in `timeZone`, through its end: null when there is no
 * such cycle. A completed one answers from its summary; one that has not started has no points yet.
 */
async function progress(cycleId: string, timeZone: string): Promise<CycleProgress | null> {
  const [c] = await db.select().from(cycle).where(eq(cycle.id, cycleId));
  if (!c) return null;
  if (!c.startDate || !c.endDate) return { start: "", scope: [], started: [], done: [] };
  if (c.summary) return { start: c.startDate, scope: c.summary.scope, started: c.summary.started, done: c.summary.done };
  const today = dayIn(new Date(), timeZone);
  const yesterday = addDays(today, -1);
  const last = c.endDate < yesterday ? c.endDate : yesterday;
  const key = `${c.id}:${c.startDate}:${c.endDate}:${timeZone}:${last}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const counts = c.startDate > today ? { scope: [], started: [], done: [] } : await countAt(db, c, moments(c.startDate, last, timeZone));
  const out: CycleProgress = { start: c.startDate, ...counts };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

/** For a reader, counted against their read budget like a history page. */
export function readCycleProgress(userId: string, cycleId: string, timeZone: string): Promise<CycleProgress | null | "rate_limited"> {
  return metered(userId, 4096, () => progress(cycleId, timeZone));
}
