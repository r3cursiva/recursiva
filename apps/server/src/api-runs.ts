// Agent runs over REST (RSVA-636): an agent claims an issue's stage with a lease, renews it, and ends it done or failed.
// The rules are runs.ts; this is their rows and their answers. Runs are server-only, outside the log and the snapshot,
// except what a stop or a finished work run writes: the move to review and the comment go through the write pipeline as
// the caller, so the issue's history, the inboxes and open tabs see them as any other change.
//
// One open run per issue: a partial unique index (run_live_index) holds it, so two claims racing end with one run and a
// 409 for the other, whatever they read first. A lapsed lease frees the issue for others but stays its holder's: renew,
// complete and fail by the holder work while the row is still the issue's open run, so finished work is not recorded as
// a failure because the Mac that renewed it slept. Expiry is found, not timed: the next claim by anyone finds the lapsed
// lease, closes the run as `expired` in its transaction, and that counts as a failed attempt.
//
// Completion needs evidence: a `work` or `verify` run of an issue whose description has a "Done when" list (done-when.ts)
// ends done only with one text per criterion; the run keeps them with the criteria as they read then, and the issue gets
// one comment of them as the caller. A done `work` run also moves the issue to review (writeDone): a finished work stage
// waits for a person there, as a stopped one does.
//
// The reset after a stop (the simplest signal that is a person's act): the log has a change of the issue's state made
// by a person (a human user, in the app or with their own token) after the log's number when the run stopped
// (`stopSyncId`), in a transaction other than the stop's own (`stopTxId`, chosen when it stopped and given to the
// pipeline). Moving the issue out of review is that change; an agent's own move is not, and neither is the stop's move
// made by a person whose claim found the lapsed lease. A done work run's move cannot reset its own stage: a run exists
// only after the stop was reset, and a later stop's number is past it. Nothing is written for it: the claim reads the log.
import type { DocNode } from "@rsva/editor/doc";
import { toMarkdown } from "@rsva/editor/markdown";
import { can, refusal } from "@rsva/policy";
import { uuidv7 } from "@rsva/protocol";
import { COMMENT_MAX, isClosedGroup, RUN_STAGES, startedStage, type RunOutcome, type RunStage } from "@rsva/schema/models";
import { and, asc, desc, eq, gt, isNull, ne, or, sql as dsql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadNames } from "./api-names.ts";
import { inTrash, issueByKey, writeTx, type IssueParams } from "./api-tx.ts";
import type { Access } from "./auth/access.ts";
import { RateLimited } from "./auth/limits.ts";
import { db, schema, type Tx } from "./db.ts";
import { CRITERIA_MAX, doneWhen, proofOf, type Proof } from "./done-when.ts";
import { HttpError } from "./http.ts";
import { ERROR_MAX, NOTE_MAX, attemptsOf, evidenceComment, fingerprint, leaseSeconds, LEASE_MAX, LEASE_MIN, stopComment, stopReason, type StopMove } from "./runs.ts";
import { metered } from "./sync/history.ts";
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

/** The issue's open row, locked: its lease may have passed (a claim closes it then; its holder may still end it). */
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
 * with the log's number now (`stopSyncId`) and the id its move to review will be written under (`stopTxId`). In the
 * caller's transaction, so the stop and what tells it from a reset are one write.
 */
async function endRun(tx: Tx, r: Row, outcome: RunOutcome, fields: Partial<Row> = {}): Promise<{ row: Row; stop: Stop | null }> {
  const endedAt = new Date().toISOString();
  const [ended] = await tx.update(run).set({ ...fields, outcome, endedAt }).where(eq(run.id, r.id)).returning();
  if (outcome === "done") return { row: ended!, stop: null };
  const attempts = attemptsOf(await stageRuns(tx, r.issueId, r.stage));
  const reason = stopReason(attempts);
  if (!reason) return { row: ended!, stop: null };
  const [{ s }] = (await tx.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, r.workspaceId))) as [{ s: number }];
  const [stopped] = await tx.update(run).set({ outcome: "stopped", stopSyncId: s, stopTxId: uuidv7() }).where(eq(run.id, r.id)).returning();
  return { row: stopped!, stop: { run: stopped!, reason, tried: attempts.map((a) => ({ outcome: a.outcome!, note: a.note, error: a.error })) } };
}

/** The issue's "Done when" criteria now, from its description as the API gives it: all of them, past CRITERIA_MAX too. */
async function criteriaOf(issueId: string): Promise<string[]> {
  const [doc] = await db.select({ doc: document.doc }).from(document).where(eq(document.id, issueId));
  return doc?.doc ? doneWhen(toMarkdown(doc.doc as DocNode)) : [];
}

type Op = Parameters<typeof writeTx>[2][number];

/**
 * Ops through the write pipeline as the caller, after the run's own transaction: the log's number, or the pipeline's
 * refusal (the caller's token may not comment, the state is for people only), which leaves the run as it ended.
 */
async function writeAfter(req: FastifyRequest, w: Access, ops: Op[], txId?: string): Promise<{ s: number } | { refused: string }> {
  try {
    return { s: (await writeTx(req, w, ops, txId)).s };
  } catch (e) {
    if (!(e instanceof TxError || e instanceof HttpError || e instanceof RateLimited)) throw e;
    return { refused: e.message };
  }
}

const commentOp = (issueId: string, body: string): Op => ({ op: "create", m: "Comment", id: uuidv7(), set: { issueId, body } });

/**
 * What a move to review with its comment did on the issue, for the answer: the review state (null: none to move to),
 * whether the issue is there now, and whether the comment was written.
 */
interface ReviewView {
  movedTo: string | null;
  moved: boolean;
  written: boolean;
  /** The pipeline's refusal of the move, or of the comment when it was not written. */
  refused?: string;
}

/**
 * The issue to the project's review state (the started group's second state, startedStage) with one comment, as the
 * caller, in one transaction of the pipeline (under `txId` when given). `moves` says whether the issue's state now
 * should move at all; when not, or the project has no review state, the comment goes alone. When the pipeline refuses
 * the two (the review state is for people only, say), the comment goes alone in a second, told of the refusal, so what
 * it says is not lost with the move. A refusal of the comment too is said in the answer.
 */
async function writeReview(req: FastifyRequest, found: Found, comment: ((move: StopMove) => string) | null, moves: (group: string) => boolean, txId?: string): Promise<ReviewView> {
  const w = found.w;
  const n = await loadNames(w.workspaceId);
  const states = [...n.states.values()].filter((s) => s.projectId === found.issue.projectId);
  const [now] = await db.select({ stateId: issue.stateId }).from(issue).where(eq(issue.id, found.issue.id));
  const target = now && moves(n.states.get(now.stateId)?.group ?? "") ? states.find((s) => startedStage(states, s.id) === "review") : undefined;
  const comments = (move: StopMove) => (comment ? [commentOp(found.issue.id, comment(move))] : []);
  const out = { movedTo: target?.name ?? null };
  const move: Op[] = target && now?.stateId !== target.id ? [{ op: "update", m: "Issue", id: found.issue.id, set: { stateId: target.id } }] : [];
  const ops = [...move, ...comments(target ? { moved: true } : { moved: false })];
  if (!ops.length) return { ...out, moved: !!target, written: false };
  const both = await writeAfter(req, w, ops, txId);
  if (!("refused" in both)) return { ...out, moved: !!target, written: !!comment };
  if (!move.length) return { ...out, moved: !!target, written: false, refused: both.refused };
  const alone = comment ? await writeAfter(req, w, comments({ moved: false, refused: both.refused })) : both;
  return { ...out, moved: false, written: !("refused" in alone), refused: both.refused };
}

/**
 * The stop on the issue, as the caller (the agent whose failure stopped it, or whoever's claim found the lease passed):
 * to review with one comment listing what was tried, under the run's `stopTxId`, from whatever state the issue is in.
 * The run stays stopped whatever the pipeline refuses.
 */
const writeStop = async (req: FastifyRequest, found: Found, stop: Stop) => ({
  reason: stop.reason,
  ...(await writeReview(req, found, (move) => stopComment(stop.run.stage, stop.reason, stop.tried, move), () => true, stop.run.stopTxId ?? undefined)),
});

/** A person changed the issue's state after the stop, in a transaction other than the stop's own: the reset of a stopped loop. */
async function resetSince(workspaceId: string, issueId: string, stopped: Row): Promise<boolean> {
  const own = stopped.stopTxId ? or(isNull(syncAction.txId), ne(syncAction.txId, stopped.stopTxId)) : undefined;
  const [hit] = await db
    .select({ id: syncAction.id })
    .from(syncAction)
    .innerJoin(user, eq(user.id, syncAction.actorId))
    .where(and(eq(syncAction.modelId, issueId), eq(syncAction.workspaceId, workspaceId), eq(syncAction.model, "Issue"), gt(syncAction.id, stopped.stopSyncId ?? 0), own, dsql`${syncAction.data} ? 'stateId'`, eq(user.kind, "human")))
    .limit(1);
  return !!hit;
}

/** An issue agents may not work on: in the trash, archived, or in an archived project. */
function workable(found: Found): void {
  if (found.issue.deletedAt) throw inTrash(found.issue.key);
  if (found.issue.archived) throw new HttpError(400, "archived", `${found.issue.key} is archived, or its project is; agents claim and renew runs only on open work`);
}

/** The answer to a claim's transaction: the new run, or why there is none; a stop it caused on the way either way. */
type Claimed = { row: Row; stop: Stop | null } | { held: Row; stop: Stop | null } | { stopped: Row; stop: Stop | null };

async function claim(req: Req): Promise<{ status: number; body: unknown }> {
  const found = await issueByKey(req);
  const b = req.body ?? {};
  mayRun(req, found.w, b);
  workable(found);
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
        // one means it was reset.
        if (last?.outcome === "stopped" && !(await resetSince(found.w.workspaceId, found.issue.id, last))) return { stopped: last, stop };
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

/** The newest runs a list answers with, and what such an answer is reserved as against the read budget: each run's evidence fits a comment. */
const RUNS_PAGE = 50;
const RUNS_READ_BYTES = RUNS_PAGE * (COMMENT_MAX + 8192);

/** The stages whose completion needs evidence for the issue's criteria: triage decides what the work is, it proves nothing. */
const PROVING: readonly RunStage[] = ["work", "verify"];

/**
 * Renew, complete or fail: the caller's own open run of the issue, its lease held or lapsed (renew extends it from now).
 * Someone else's is a 403; none (it ended, or another claim closed the lapsed lease) a 409; a completion without the
 * evidence its stage needs, or with more than one comment holds, a 400 that leaves the run open.
 */
async function endOwn(req: Req, ending: (b: Record<string, unknown>) => Ending) {
  const found = await issueByKey(req);
  const b = req.body ?? {};
  mayRun(req, found.w, b);
  const what = ending(b);
  if (what.kind === "renew") workable(found);
  const me = req.actor!.userId;
  const criteria = what.kind === "done" ? await criteriaOf(found.issue.id) : [];
  let proof: Proof[] = [];
  const got = await retrying(() =>
    db.transaction(async (tx) => {
      const live = await liveRow(tx, found.issue.id);
      if (!live) return { none: true as const };
      if (live.agentId !== me) return { other: live };
      if (what.kind === "renew") return { row: (await tx.update(run).set({ leaseUntil: until(what.lease) }).where(eq(run.id, live.id)).returning())[0]!, stop: null };
      if (what.kind === "done") {
        const checked = PROVING.includes(live.stage) ? proofOf(criteria, what.evidence) : { proof: [] };
        if ("refused" in checked) return { refused: `${found.issue.key}: ${checked.refused}; \`rsva run criteria ${found.issue.key}\` lists them` };
        const length = checked.proof.length ? evidenceComment(live.stage, checked.proof, what.note).length : 0;
        if (length > COMMENT_MAX) return { refused: `${found.issue.key}: the evidence makes a comment of ${length} characters, over ${COMMENT_MAX}; shorten it` };
        proof = checked.proof;
        return endRun(tx, live, "done", { note: what.note, evidence: proof.length ? proof : null });
      }
      return endRun(tx, live, "failed", { note: what.note, error: what.error, errorFingerprint: fingerprint(what.error) });
    }),
  );
  if ("none" in got) throw new HttpError(409, "conflict", `no open run on ${found.issue.key}: it ended, or another claim found its lease lapsed and closed it; claim it again`);
  if ("refused" in got) throw new HttpError(400, "invalid", got.refused);
  if ("other" in got) throw new HttpError(403, "forbidden", `the run on ${found.issue.key} is held by ${(await emailOf(got.other.agentId)) ?? "someone else"}`);
  const stop = got.stop ? await writeStop(req, found, got.stop) : undefined;
  return { run: await view(got.row, found), ...(stop ? { stop } : {}), ...(what.kind === "done" ? await writeDone(req, found, got.row, proof) : {}) };
}

/**
 * What a done run writes on the issue, as the caller: a work run moves it to review (from an open state other than
 * review: a closed issue stays closed), with the evidence comment when there is evidence, in one transaction; a refused
 * move leaves the comment alone, saying so. Another stage writes the comment only.
 */
async function writeDone(req: FastifyRequest, found: Found, row: Row, proof: Proof[]) {
  const work = row.stage === "work";
  if (!work && !proof.length) return {};
  const r = await writeReview(req, found, proof.length ? (move) => evidenceComment(row.stage, proof, row.note, move) : null, (group) => work && !isClosedGroup(group));
  const comment = proof.length ? { comment: r.written ? { written: true } : { written: false, refused: r.refused } } : {};
  const review = r.movedTo ? { review: { movedTo: r.movedTo, moved: r.moved, ...(r.moved ? {} : { refused: r.refused }) } } : {};
  return { ...comment, ...review };
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

  // The issue's newest RUNS_PAGE runs (`more` when there are older ones) and its "Done when" criteria now, CRITERIA_MAX
  // at most (`moreCriteria`, how many past them): what a completion of work or verify must prove. Counted against the
  // reader's read budget, as the history is.
  app.get<{ Params: IssueParams }>(path, async (req, reply) => {
    const found = await issueByKey(req);
    const answer = await metered(req.actor!.userId, RUNS_READ_BYTES, async () => {
      const [rows, criteria] = await Promise.all([
        db.select({ r: run, email: user.email }).from(run).innerJoin(user, eq(user.id, run.agentId)).where(eq(run.issueId, found.issue.id)).orderBy(desc(run.createdAt), desc(run.id)).limit(RUNS_PAGE + 1),
        criteriaOf(found.issue.id),
      ]);
      return {
        runs: rows.slice(0, RUNS_PAGE).map(({ r, email }) => runView(r, found.issue.key, email)),
        more: rows.length > RUNS_PAGE,
        criteria: criteria.slice(0, CRITERIA_MAX),
        ...(criteria.length > CRITERIA_MAX ? { moreCriteria: criteria.length - CRITERIA_MAX } : {}),
      };
    });
    if (answer === "rate_limited") return reply.code(429).header("retry-after", "60").send({ error: "rate_limited", message: "too many run requests" });
    return answer;
  });
}
