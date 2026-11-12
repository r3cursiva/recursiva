// The one way a person's transaction goes in, whatever carried it: the browser's socket, the agent API, a Telegram
// button or command, an email reply. Each caller turns a refusal into its own answer (a rej frame, a 429/403/4xx, the
// bot's words); the checks and their order are the same everywhere.
//
// Order: write budget → access → rights → pipeline. The budget comes first because it is the only check that costs
// nothing: the socket re-reads the person's access from the database before the rights check (`viewer`), and a flood of
// frames must be counted before it can make the server read. A change the rights refuse has spent its budget, so a client
// that keeps sending what it may not do is slowed like any other. Until RSVA-428 Telegram and email replies checked the
// rights first: a forbidden change from a chat cost nothing, and with the budget used up a chat heard "You cannot …"
// where the browser and the API answered "too many changes". Both checks run before anything is written either way.
import { deniedOps, type Viewer } from "@rsva/policy";
import type { Op, Via } from "@rsva/protocol";
import { takeWrite, writeRetryAfter } from "./limits.ts";
import { TxError } from "./tx-error.ts";
import { applyTx, type TxResult } from "./write.ts";

type Refused =
  /** The person's write budget is used up: seconds until this transaction fits it again. */
  | { by: "budget"; retryAfter: number }
  /** Their role or the token's scope forbids an op (packages/policy, deniedOps): what it says. */
  | { by: "rights"; msg: string }
  /** The write pipeline refused it (TxError). */
  | { by: "pipeline"; code: string; msg: string };

export type Submitted = { ok: true; r: TxResult } | { ok: false; refused: Refused };

export interface Submit {
  workspaceId: string;
  userId: string;
  /** A replay of a known id gets the first answer (applyTx). */
  txId: string;
  /** As sent: the pipeline validates them. */
  ops: Op[];
  /** What the transaction weighs against the byte budget; the ops as JSON unless the caller has the frame's length. */
  bytes?: number;
  /** The person's role and scope now, read after the budget is taken; null stops the write (the socket closed itself). */
  viewer: () => Viewer | null | Promise<Viewer | null>;
  /** A signed-in browser, not a token or a linked chat (applyTx). */
  signedIn: boolean;
  via?: Via;
}

/**
 * Applies a person's transaction if their budget, access and rights allow it; null when `viewer` stopped it. Anything the
 * pipeline throws other than a TxError (the database down after its retries, a bug) is thrown on: each caller has its
 * own answer to that.
 */
export async function submitTx(t: Submit): Promise<Submitted | null> {
  const bytes = t.bytes ?? JSON.stringify(t.ops).length;
  if (!takeWrite(t.userId, t.ops.length, bytes)) return { ok: false, refused: { by: "budget", retryAfter: writeRetryAfter(t.userId, t.ops.length, bytes) } };
  const viewer = await t.viewer();
  if (!viewer) return null;
  const denied = deniedOps(viewer, t.ops);
  if (denied) return { ok: false, refused: { by: "rights", msg: denied } };
  try {
    return { ok: true, r: await applyTx(t.workspaceId, t.userId, t.txId, t.ops, t.signedIn, t.via) };
  } catch (e) {
    if (!(e instanceof TxError)) throw e;
    return { ok: false, refused: { by: "pipeline", code: e.code, msg: e.message } };
  }
}
