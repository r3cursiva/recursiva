// What the agent API's routes share: the workspace of a path, a write as the caller, and the answer to an empty change.
// They throw their refusals (HttpError, a NameError for a name that resolves to nothing, the pipeline's TxError, a
// RateLimited write budget); the app's error handler answers them (app.ts, sendError).
import { deniedOps } from "@rsva/policy";
import { txChunks, uuidv7, type Op, type SplitOps } from "@rsva/protocol";
import type { Project } from "@rsva/schema/models";
import type { FastifyRequest } from "fastify";
import { loadNames, projectByKey, type Names } from "./api-names.ts";
import { accessBySlug, granted, type Access } from "./auth/access.ts";
import { RateLimited } from "./auth/limits.ts";
import { HttpError } from "./http.ts";
import { submitTx } from "./sync/submit.ts";
import { TxError } from "./sync/tx-error.ts";
import { TX_OPS_MAX } from "./sync/write.ts";

/** The actor's access to the workspace of an API path; a 404 or 403 when they cannot open it. */
export async function workspaceOf(req: FastifyRequest<{ Params: { ws: string } }>): Promise<Access> {
  return granted(await accessBySlug(req.actor!, req.params.ws));
}

/** Access, names and the project of a key; a 400 naming the projects when the key is none of them. */
export async function projectOf(req: FastifyRequest<{ Params: { ws: string } }>, key: unknown) {
  const w = await workspaceOf(req);
  const n = await loadNames(w.workspaceId);
  return { w, n, p: projectByKey(n, key) };
}

/**
 * A new cycle, state or label in the project the body names, {"project": "PLNR", …}: `build` makes its fields by name (a
 * NameError is a 400 naming what there is), then it is written as the caller. Its id, the row as stored and the write.
 */
export async function createInProject(
  req: FastifyRequest<{ Params: { ws: string }; Body: Record<string, unknown> | null }>,
  m: "Cycle" | "WorkflowState" | "Label",
  build: (n: Names, p: Project, b: Record<string, unknown>) => Record<string, unknown>,
) {
  const b = req.body ?? {};
  const { w, n, p } = await projectOf(req, b.project);
  const set = build(n, p, b);
  const id = uuidv7();
  const r = await writeTx(req, w, [{ op: "create", m, id, set: { ...set, projectId: p.id } } as Op]);
  return { id, r, row: r.actions.find((a) => a.m === m && a.a === "I")?.d ?? {} };
}

/** A change with nothing in it (no field, no op): 400 `invalid`, naming the fields the route takes. */
export function needChange(change: object, fields: string): void {
  if (!Object.keys(change).length) throw new HttpError(400, "invalid", `nothing to change: ${fields}`);
}

/** The answer to a write: its last log number, for the caller to wait for in a socket or a later read. */
export const okTx = (r: { s: number }) => ({ ok: true, lastSyncId: r.s });

/**
 * Applies ops as the caller, if their role, scope and write budget (sync/limits.ts, shared with their sockets) allow:
 * a 429 or 403 otherwise, and the pipeline's refusal (TxError) as its code says (http.ts, txStatus).
 */
export async function writeTx(req: FastifyRequest, w: Access, ops: Op[]) {
  const out = (await submitTx({ workspaceId: w.workspaceId, userId: req.actor!.userId, txId: uuidv7(), ops, viewer: () => w.viewer, signedIn: req.actor!.via === "session" }))!;
  if (out.ok) return out.r;
  const no = out.refused;
  if (no.by === "budget") throw new RateLimited(no.retryAfter, "too many changes");
  // A rights refusal answers as the pipeline's own "forbidden" does: 403 { error: "forbidden" } (txStatus).
  throw no.by === "rights" ? new TxError("forbidden", no.msg) : new TxError(no.code, no.msg);
}


/**
 * Applies split ops in as many transactions as they need, as the browser does: the last log number. Rights are checked
 * on all of them first, so a caller who may move issues but not delete the label does not get half of the change; a
 * refusal by the pipeline on the way leaves the transactions before it applied.
 */
export async function writeAll(req: FastifyRequest, w: Access, ops: SplitOps): Promise<number> {
  const denied = deniedOps(w.viewer, [...ops.first, ...ops.last]);
  if (denied) throw new HttpError(403, "forbidden", denied);
  let s = 0;
  for (const tx of txChunks(ops, TX_OPS_MAX)) s = (await writeTx(req, w, tx)).s;
  return s;
}
