// Agent runs over REST (RSVA-636): an agent claims an issue's stage with a lease, renews it, and ends it done or failed.
// The rules are runs.ts; this is their rows and their answers. Runs are server-only, outside the log and the snapshot,
// except what a stop writes: the move to review and the comment go through the write pipeline as the caller, so the
// issue's history, the inboxes and open tabs see them as any other change.
//
// One live run per issue: a partial unique index (run_live_index) holds it, so two claims racing end with one run and a
// 409 for the other, whatever they read first. An expired lease is found, not timed: the next claim, renew, complete or
// fail of the issue closes the run as `expired` in its transaction, and that counts as a failed attempt.
//
// Completion needs evidence: a `work` or `verify` run of an issue whose description has a "Done when" list (done-when.ts)
// ends done only with one text per criterion; the run keeps them with the criteria as they read then, and the issue gets
// one comment of them as the caller.
//
// The reset after a stop (the simplest signal that is a person's act): the log has a change of the issue's state made
// by a person (a human user, in the app or with their own token) after the stop was written (`stopSyncId`). Moving the
// issue out of review is that change; an agent's own move is not. Nothing is written for it: the claim reads the log.
import type { DocNode } from "@rsva/editor/doc";
import { toMarkdown } from "@rsva/editor/markdown";
import { can, refusal } from "@rsva/policy";
import { uuidv7 } from "@rsva/protocol";
import { RUN_STAGES, startedStage, type RunOutcome, type RunStage } from "@rsva/schema/models";
import { and, asc, desc, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadNames } from "./api-names.ts";
import { inTrash, issueByKey, writeTx, type IssueParams } from "./api-tx.ts";
import type { Access } from "./auth/access.ts";
import { RateLimited } from "./auth/limits.ts";
import { db, schema, type Tx } from "./db.ts";
import { doneWhen, proofOf, type Proof } from "./done-when.ts";
import { HttpError } from "./http.ts";
import { ERROR_MAX, NOTE_MAX, attemptsOf, evidenceComment, fingerprint, leaseSeconds, LEASE_MAX, LEASE_MIN, stopComment, stopReason } from "./runs.ts";
import { takeWrite, writeRetryAfter } from "./sync/limits.ts";
import { retrying, uniqueViolation } from "./sync/retry.ts";
import { TxError } from "./sync/tx-error.ts";

const { run, user, issue, workspace, syncAction, document } = schema;

type Row = typeof run.$inferSelect;
type Found = Awaited<ReturnType<typeof issueByKey>>;
type Req = FastifyRequest<{ Params: IssueParams; Body: Record<string, unknown> | null }>;

/** A run as agents read it: the issue by key, the agent by email; `live` while its lease holds and it has not ended. */
function runView(r: Row, key: string, email: string | undefined) {
  return {
    id: r.id,
    issue: key,
    stage: r.stage,
    attempt: r.attempt,
    agent: email ?? null,
    leaseUntil: r.leaseUntil,
    live: r.outcome === null && Date.parse(r.leaseUntil) > Date.now(),
    outcome: r.outcome,
    note: r.note,
    error: r.error,
    errorFingerprint: r.errorFingerprint,
    evidence: r.evidence,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
  };
}

async function emailOf(id: string): Promise<string | undefined> {
  return (await db.select({ email: user.email }).from(user).where(eq(user.id, id)))[0]?.email;
}

const view = async (r: Row, found: Found) => runView(r, found.issue.key, await emailOf(r.agentId));

/** The caller may change issues (a run is work on one), and has write budget left; the run's write is one op. */
function mayRun(req: FastifyRequest, w: Access, body: unknown): void {
  if (!can(w.viewer, "issues.write")) throw new HttpError(403, "forbidden", refusal(w.viewer, "issues.write", "claim work on an issue"));
  const me = req.actor!.userId;
  const bytes = JSON.stringify(body ?? {}).length;
  if (!takeWrite(me, 1, bytes)) throw new RateLimited(writeRetryAfter(me, 1, bytes), "too many changes");
}

/** Optional text of a body, cut to `max`; a 400 when it is there and not text. */
function textOf(b: Record<string, unknown>, field: string, max: number): string | null {
  const v = b[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "invalid", `${field}: text`);
  return v.trim().slice(0, max) || null;
}

function leaseOf(b: Record<string, unknown>): number {
  const s = leaseSeconds(b.lease);
  if (s === null) throw new HttpError(400, "invalid", `lease: whole seconds, held to ${LEASE_MIN}…${LEASE_MAX}`);
  return s;
}

const until = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/** The issue's live row, locked: its lease may have passed (the caller closes it then). */
async function liveRow(tx: Tx, issueId: string): Promise<Row | undefined> {
  return (await tx.select().from(run).where(and(eq(run.issueId, issueId), isNull(run.outcome))).for("update"))[0];
}

const leaseHolds = (r: Row) => Date.parse(r.leaseUntil) > Date.now();

/** The runs of an issue's stage, oldest first. */
const stageRuns = (tx: Tx, issueId: string, stage: RunStage) => tx.select().from(run).where(and(eq(run.issueId, issueId), eq(run.stage, stage))).orderBy(asc(run.createdAt), asc(run.id));

/** A run that ended the loop: what the stop then writes on the issue (writeStop). */
interface Stop {
  run: Row;
  reason: string;
  /** The attempts, the last with the outcome it ended with before it became `stopped`. */
  tried: { outcome: RunOutcome; note: string | null; error: string | null }[];
}

/**
 * Ends a run as `outcome` with these fields, then applies the stop rules to its stage: a stopping run becomes `stopped`,
 * with the log's number now as a provisional `stopSyncId` until the stop is written. In the caller's transaction.
 */
async function endRun(tx: Tx, r: Row, outcome: RunOutcome, fields: Partial<Row> = {}): Promise<{ row: Row; stop: Stop | null }> {
  const endedAt = new Date().toISOString();
  const [ended] = await tx.update(run).set({ ...fields, outcome, endedAt }).where(eq(run.id, r.id)).returning();
  if (outcome === "done") return { row: ended!, stop: null };
  const attempts = attemptsOf(await stageRuns(tx, r.issueId, r.stage));
  const reason = stopReason(attempts);
  if (!reason) return { row: ended!, stop: null };
  const [{ s }] = (await tx.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, r.workspaceId))) as [{ s: number }];
  const [stopped] = await tx.update(run).set({ outcome: "stopped", stopSyncId: s }).where(eq(run.id, r.id)).returning();
  return { row: stopped!, stop: { run: stopped!, reason, tried: attempts.map((a) => ({ outcome: a.outcome!, note: a.note, error: a.error })) } };
}

/** The issue's "Done when" criteria now, from its description as the API gives it. */
async function criteriaOf(issueId: string): Promise<string[]> {
  const [doc] = await db.select({ doc: document.doc }).from(document).where(eq(document.id, issueId));
  return doc?.doc ? doneWhen(toMarkdown(doc.doc as DocNode)) : [];
}

type Op = Parameters<typeof writeTx>[2][number];

/**
 * Ops through the write pipeline as the caller, after the run's own transaction: the log's number, or the pipeline's
 * refusal (the caller's token may not comment, the state is for people only), which leaves the run as it ended.
 */
async function writeAfter(req: FastifyRequest, w: Access, ops: Op[]): Promise<{ s: number } | { refused: string }> {
  try {
    return { s: (await writeTx(req, w, ops)).s };
  } catch (e) {
    if (!(e instanceof TxError || e instanceof HttpError || e instanceof RateLimited)) throw e;
    return { refused: e.message };
  }
}

const commentOp = (issueId: string, body: string): Op => ({ op: "create", m: "Comment", id: uuidv7(), set: { issueId, body } });

/** What a stop did on the issue, for the answer: the state it moved to (null: none to move to), and whether it was written. */
interface StopView {
  reason: string;
  movedTo: string | null;
  written: boolean;
  /** The pipeline's refusal when it was not written: the run stays stopped all the same. */
  refused?: string;
}

/**
 * The stop on the issue, as the caller (the agent whose failure stopped it, or whoever's claim found the lease passed): to the project's review state (the started group's second state, startedStage)
 * and one comment listing what was tried, in one transaction of the pipeline. Then the run's `stopSyncId` becomes that
 * transaction's number, so a person's change after it is what resets the loop. A refusal (the caller's token may not
 * comment, the state is for people only) leaves the run stopped and says so.
 */
async function writeStop(req: FastifyRequest, found: Found, stop: Stop): Promise<StopView> {
  const w = found.w;
  const n = await loadNames(w.workspaceId);
  const states = [...n.states.values()].filter((s) => s.projectId === found.issue.projectId);
  const review = states.find((s) => startedStage(states, s.id) === "review");
  const [now] = await db.select({ stateId: issue.stateId }).from(issue).where(eq(issue.id, found.issue.id));
  const body = stopComment(stop.run.stage, stop.reason, stop.tried, !!review);
  const ops: Op[] = [...(review && now?.stateId !== review.id ? [{ op: "update" as const, m: "Issue" as const, id: found.issue.id, set: { stateId: review.id } }] : []), commentOp(found.issue.id, body)];
  const out: StopView = { reason: stop.reason, movedTo: review?.name ?? null, written: true };
  const r = await writeAfter(req, w, ops);
  if ("refused" in r) return { ...out, written: false, refused: r.refused };
  await db.update(run).set({ stopSyncId: r.s }).where(eq(run.id, stop.run.id));
  return out;
}

/** A person changed the issue's state after the log number `after`: the reset of a stopped loop. */
async function resetSince(workspaceId: string, issueId: string, after: number): Promise<boolean> {
  const [hit] = await db
    .select({ id: syncAction.id })
    .from(syncAction)
    .innerJoin(user, eq(user.id, syncAction.actorId))
    .where(and(eq(syncAction.modelId, issueId), eq(syncAction.workspaceId, workspaceId), eq(syncAction.model, "Issue"), gt(syncAction.id, after), dsql`${syncAction.data} ? 'stateId'`, eq(user.kind, "human")))
    .limit(1);
  return !!hit;
}

/** The answer to a claim's transaction: the new run, or why there is none; a stop it caused on the way either way. */
type Claimed = { row: Row; stop: Stop | null } | { held: Row; stop: Stop | null } | { stopped: Row; stop: Stop | null };

async function claim(req: Req): Promise<{ status: number; body: unknown }> {
  const found = await issueByKey(req);
  const b = req.body ?? {};
  mayRun(req, found.w, b);
  if (found.issue.deletedAt) throw inTrash(found.issue.key);
  const stage = (b.stage ?? "work") as RunStage;
  if (!RUN_STAGES.includes(stage)) throw new HttpError(400, "invalid", `stage: one of ${RUN_STAGES.join(", ")}`);
  const lease = leaseOf(b);
  const me = req.actor!.userId;
  let got: Claimed;
  try {
    got = await retrying(() =>
      db.transaction(async (tx): Promise<Claimed> => {
        let stop: Stop | null = null;
        const live = await liveRow(tx, found.issue.id);
        if (live && leaseHolds(live)) return { held: live, stop };
        if (live) stop = (await endRun(tx, live, "expired")).stop;
        const runs = await stageRuns(tx, found.issue.id, stage);
        const last = runs.at(-1);
        // Only the newest run can hold the stage stopped: a claim after a stop is refused until a reset, so a run after
        // one means it was reset. The stop written a moment ago in this transaction is not in the log yet: still stopped.
        if (last?.outcome === "stopped" && (last.stopSyncId === null || last.id === stop?.run.id || !(await resetSince(found.w.workspaceId, found.issue.id, last.stopSyncId))))
          return { stopped: last, stop };
        const [row] = await tx
          .insert(run)
          .values({ workspaceId: found.w.workspaceId, issueId: found.issue.id, agentId: me, stage, attempt: attemptsOf(runs).length + 1, leaseUntil: until(lease) })
          .returning();
        return { row: row!, stop };
      }),
    );
  } catch (e) {
    // Another claim took the issue between this one's read and its insert: the index refused the second live run.
    if (!uniqueViolation(e)) throw e;
    const [held] = await db.select().from(run).where(and(eq(run.issueId, found.issue.id), isNull(run.outcome)));
    if (!held) throw e;
    got = { held, stop: null };
  }
  const stopped = got.stop ? await writeStop(req, found, got.stop) : undefined;
  const extra = stopped ? { stop: stopped } : {};
  if ("held" in got) {
    const h = got.held;
    throw new HttpError(409, "conflict", `${found.issue.key} is claimed by ${(await emailOf(h.agentId)) ?? "someone"} until ${h.leaseUntil} (${h.stage}, attempt ${h.attempt})`);
  }
  if ("stopped" in got)
    return {
      status: 409,
      body: {
        error: "stopped",
        message: `the ${stage} loop on ${found.issue.key} stopped at ${got.stopped.endedAt}; agents claim it again after a person moves the issue out of review`,
        run: await view(got.stopped, found),
        ...extra,
      },
    };
  return { status: 201, body: { run: await view(got.row, found), ...extra } };
}

type Ending = { kind: "renew"; lease: number } | { kind: "done"; note: string | null; evidence: unknown } | { kind: "failed"; note: string | null; error: string };

/** The stages whose completion needs evidence for the issue's criteria: triage decides what the work is, it proves nothing. */
const PROVING: readonly RunStage[] = ["work", "verify"];

/**
 * Renew, complete or fail: the caller's own live run of the issue. Someone else's is a 403; none, or a lease that has
 * passed (closed as expired here, which may stop the loop), a 409; a completion without the evidence its stage needs, a
 * 400 that leaves the run live.
 */
async function endOwn(req: Req, ending: (b: Record<string, unknown>) => Ending) {
  const found = await issueByKey(req);
  const b = req.body ?? {};
  mayRun(req, found.w, b);
  const what = ending(b);
  const me = req.actor!.userId;
  const criteria = what.kind === "done" ? await criteriaOf(found.issue.id) : [];
  let proof: Proof[] = [];
  const got = await retrying(() =>
    db.transaction(async (tx) => {
      const live = await liveRow(tx, found.issue.id);
      if (!live) return { none: true as const };
      if (live.agentId !== me) return { other: live };
      if (!leaseHolds(live)) return { expired: await endRun(tx, live, "expired") };
      if (what.kind === "renew") return { row: (await tx.update(run).set({ leaseUntil: until(what.lease) }).where(eq(run.id, live.id)).returning())[0]!, stop: null };
      if (what.kind === "done") {
        const checked = PROVING.includes(live.stage) ? proofOf(criteria, what.evidence) : { proof: [] };
        if ("refused" in checked) return { refused: checked.refused };
        proof = checked.proof;
        return endRun(tx, live, "done", { note: what.note, evidence: proof.length ? proof : null });
      }
      return endRun(tx, live, "failed", { note: what.note, error: what.error, errorFingerprint: fingerprint(what.error) });
    }),
  );
  if ("none" in got) throw new HttpError(409, "conflict", `no live run on ${found.issue.key}; claim it first`);
  if ("refused" in got) throw new HttpError(400, "invalid", `${found.issue.key}: ${got.refused}; \`rsva run criteria ${found.issue.key}\` lists them`);
  if ("other" in got) throw new HttpError(403, "forbidden", `the run on ${found.issue.key} is held by ${(await emailOf(got.other.agentId)) ?? "someone else"}`);
  if ("expired" in got) {
    if (got.expired.stop) await writeStop(req, found, got.expired.stop);
    throw new HttpError(409, "conflict", `the lease on ${found.issue.key} ended at ${got.expired.row.leaseUntil}: the run expired; claim it again`);
  }
  const stop = got.stop ? await writeStop(req, found, got.stop) : undefined;
  const proved = proof.length ? await writeAfter(req, found.w, [commentOp(found.issue.id, evidenceComment(got.row.stage, proof, got.row.note))]) : undefined;
  const comment = proved && ("refused" in proved ? { written: false, refused: proved.refused } : { written: true });
  return { run: await view(got.row, found), ...(stop ? { stop } : {}), ...(comment ? { comment } : {}) };
}

export function runRoutes(app: FastifyInstance): void {
  const path = "/api/v1/workspaces/:ws/issues/:key/runs";

  // {"stage": "work", "lease": 3600}: a new live run of the caller, 201; 409 when the issue has one, or the stage stopped.
  app.post<{ Params: IssueParams; Body: Record<string, unknown> | null }>(path, async (req, reply) => {
    const r = await claim(req);
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: IssueParams; Body: Record<string, unknown> | null }>(`${path}/renew`, (req) => endOwn(req, (b) => ({ kind: "renew", lease: leaseOf(b) })));
  app.post<{ Params: IssueParams; Body: Record<string, unknown> | null }>(`${path}/complete`, (req) => endOwn(req, (b) => ({ kind: "done", note: textOf(b, "note", NOTE_MAX), evidence: b.evidence })));
  app.post<{ Params: IssueParams; Body: Record<string, unknown> | null }>(`${path}/fail`, (req) =>
    endOwn(req, (b) => {
      const error = textOf(b, "error", ERROR_MAX);
      if (!error) throw new HttpError(400, "invalid", "error: what failed, as text");
      return { kind: "failed", note: textOf(b, "note", NOTE_MAX), error };
    }),
  );

  // The issue's runs, newest first, and its "Done when" criteria now: what a completion of work or verify must prove.
  app.get<{ Params: IssueParams }>(path, async (req) => {
    const found = await issueByKey(req);
    const [rows, criteria] = await Promise.all([
      db.select({ r: run, email: user.email }).from(run).innerJoin(user, eq(user.id, run.agentId)).where(eq(run.issueId, found.issue.id)).orderBy(desc(run.createdAt), desc(run.id)),
      criteriaOf(found.issue.id),
    ]);
    return { runs: rows.map(({ r, email }) => runView(r, found.issue.key, email)), criteria };
  });
}
