// Cycles for agents: planning by name (PLNR-63, PLNR-87). A cycle is named by its short form or its name ("C12",
// "Cycle 12"), its project by `?project=`, as in the list. Writes are the ones the browser makes (packages/sync,
// `completeCycle` and `deleteCycle`), so the rules stay in the write pipeline (sync/cycles.ts) and its refusals reach the
// caller word for word.
import { completeCycleOps, deleteCycleOps, type Op } from "@rsva/protocol";
import { cyclesAhead, sortedCycles } from "@rsva/query";
import { cycleStatus, isClosedGroup, type Cycle, type Issue } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { cycleId, issueOfKey, loadIssues, NameError, userId, type Names } from "./api-names.ts";
import { createInProject, needChange, okTx, projectOf, writeAll, writeTx } from "./api-tx.ts";
import { HttpError } from "./http.ts";
import { db, schema } from "./db.ts";
import { COMPLETED_KEPT, todayUtc } from "./sync/cycles.ts";

type Ws = { ws: string };
type CycleParams = Ws & { cycle: string };
type InProject = { Querystring: { project?: string } };
type Body = Record<string, unknown> | null;

/** A cycle as agents read it: where it is on the calendar and how far its issues are. */
function cycleView(n: Names, c: Cycle, issues: readonly Issue[]) {
  const own = issues.filter((i) => i.cycleId === c.id);
  const group = (i: Issue) => n.states.get(i.stateId)?.group;
  return {
    name: c.name,
    short: `C${c.number}`,
    status: cycleStatus(c, todayUtc()),
    startDate: c.startDate,
    endDate: c.endDate,
    description: c.description,
    lead: c.leadId ? (n.users.get(c.leadId)?.email ?? null) : null,
    issues: own.length,
    done: own.filter((i) => group(i) === "completed").length,
    open: own.filter((i) => !isClosedGroup(group(i))).length,
    completedAt: c.completedAt,
  };
}

/** The cycle fields of a request, by name, as the write pipeline takes them; only those given. */
function cycleFields(n: Names, me: string, b: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const k of ["name", "description", "startDate", "endDate"]) if (b[k] !== undefined) set[k] = b[k];
  if (b.lead !== undefined) set.leadId = b.lead === null ? null : userId(n, me, String(b.lead));
  return set;
}

/** The project of `?project=` and the cycle of the path. */
async function cycleOf(req: FastifyRequest<{ Params: CycleParams } & InProject>) {
  const found = await projectOf(req, req.query.project);
  return { ...found, c: found.n.cycles.get(cycleId(found.n, found.p.id, req.params.cycle))! };
}

/**
 * Where a completion moves the open issues: a cycle ahead by name, "next" (what the browser offers first), or null for
 * none. Only the cycles the browser's dialog offers: not completed and not over.
 */
function moveTarget(n: Names, c: Cycle, moveTo: unknown): string | null {
  if (moveTo === null) return null;
  if (typeof moveTo !== "string") throw new NameError('moveTo: a cycle, "next", or null for no cycle');
  const ahead = cyclesAhead([...n.cycles.values()].filter((x) => x.projectId === c.projectId), c.id, todayUtc());
  if (moveTo.toLowerCase() === "next") {
    const next = ahead.find((x) => x.startDate);
    if (!next) throw new NameError(`${c.name} has no next cycle: create one, or pass null for no cycle`);
    return next.id;
  }
  const id = cycleId(n, c.projectId, moveTo);
  if (id === c.id) throw new NameError(`${c.name} cannot take its own open issues`);
  if (!ahead.some((x) => x.id === id)) throw new NameError(`${n.cycles.get(id)!.name} is over: open issues move to a cycle ahead`);
  return id;
}

export function cycleRoutes(app: FastifyInstance): void {
  // A project's cycles in time order: an agent plans into one by name (`cycle` on an issue) and lists its issues with
  // `q=cycle:active`.
  app.get<{ Params: Ws } & InProject>("/api/v1/workspaces/:ws/cycles", async (req) => {
    const { w, n, p } = await projectOf(req, req.query.project);
    const issues = await loadIssues(w.workspaceId, p.id);
    return sortedCycles([...n.cycles.values()].filter((c) => c.projectId === p.id), true).map((c) => cycleView(n, c, issues));
  });

  app.get<{ Params: CycleParams } & InProject>("/api/v1/workspaces/:ws/cycles/:cycle", async (req) => {
    const found = await cycleOf(req);
    return cycleView(found.n, found.c, await loadIssues(found.w.workspaceId, found.p.id));
  });

  // A new cycle: {"project": "PLNR", "name": "…", "startDate": "2026-11-02", "endDate": "2026-11-08", "description": "…",
  // "lead": "me"}. No dates makes a draft.
  app.post<{ Params: Ws; Body: Body }>("/api/v1/workspaces/:ws/cycles", async (req, reply) => {
    const made = await createInProject(req, "Cycle", (n, _, b) => cycleFields(n, req.actor!.userId, b));
    return reply.code(201).send({ ok: true, short: `C${made.row.number as number}`, name: made.row.name, id: made.id, lastSyncId: made.r.s });
  });

  // Fields by name, only those given; null dates make a draft again, a null lead clears it.
  app.patch<{ Params: CycleParams; Body: Body } & InProject>("/api/v1/workspaces/:ws/cycles/:cycle", async (req) => {
    const found = await cycleOf(req);
    const set = cycleFields(found.n, req.actor!.userId, req.body ?? {});
    needChange(set, "name, description, startDate, endDate, lead");
    return okTx(await writeTx(req, found.w, [{ op: "update", m: "Cycle", id: found.c.id, set } as Op]));
  });

  // Completes the cycle and moves its open issues, as the browser's dialog: the completion in the first transaction, so
  // the summary is frozen from the issues as they are, the moves in as many as they take (writeAll). `moveTo` is
  // required: where the unfinished work goes is the point of completing a cycle, so leaving it out is a mistake, not a
  // default. `keep` lists issues left in the completed cycle.
  app.post<{ Params: CycleParams; Body: Body } & InProject>("/api/v1/workspaces/:ws/cycles/:cycle/complete", async (req) => {
    const { w, n, p, c } = await cycleOf(req);
    if (c.completedAt) throw new HttpError(400, "invalid", `${c.name} is already completed`);
    const b = req.body ?? {};
    const open = (await loadIssues(w.workspaceId, p.id)).filter((i) => i.cycleId === c.id && !isClosedGroup(n.states.get(i.stateId)?.group));
    // Checked against the open issues read above: a list of keys costs no query per key, however long it is.
    if (b.moveTo === undefined) throw new NameError('moveTo: a cycle, "next", or null for no cycle');
    if (b.keep !== undefined && !(Array.isArray(b.keep) && b.keep.every((k) => typeof k === "string"))) throw new NameError("keep: a list of issue keys");
    // By any key the issue answers to (a former project key, a key before a move), as an issue's own path does.
    const keep = new Set<string>();
    for (const k of (b.keep ?? []) as string[]) {
      const i = issueOfKey(n, open, k);
      if (!i) throw new NameError(`${k.toUpperCase()} is not an open issue of ${c.name}`);
      keep.add(i.id);
    }
    const moving = open.filter((i) => !keep.has(i.id)).map((i) => i.id);
    // Nothing to move: no target is needed, as in the browser, which then asks nothing.
    const moveTo = moving.length ? moveTarget(n, c, b.moveTo) : null;
    const s = await writeAll(req, w, completeCycleOps(c.id, moving, moveTo));
    return { ok: true, moved: moving.length, kept: open.length - moving.length, lastSyncId: s };
  });

  // Takes every issue out, archived and deleted ones too (the pipeline refuses while any is in), then deletes the cycle;
  // in as many transactions as that takes (writeAll). A completed cycle is kept: refused here, before any issue moves out.
  app.delete<{ Params: CycleParams } & InProject>("/api/v1/workspaces/:ws/cycles/:cycle", async (req) => {
    const found = await cycleOf(req);
    if (found.c.completedAt) throw new HttpError(400, "invalid", `${found.c.name}: ${COMPLETED_KEPT}`);
    const { issue } = schema;
    const rows = await db.select({ id: issue.id }).from(issue).where(and(eq(issue.workspaceId, found.w.workspaceId), eq(issue.cycleId, found.c.id)));
    const s = await writeAll(req, found.w, deleteCycleOps(found.c.id, rows.map((i) => i.id)));
    return { ok: true, moved: rows.length, lastSyncId: s };
  });
}
