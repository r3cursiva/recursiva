// A change made from Telegram (PLNR-203, PLNR-205) or a reply by email (PLNR-211): a reply's comment, a /new issue. It goes through the same write path
// and checks as the same change from the browser (sync/submit.ts): the person's role in the workspace now, their write budget, the
// pipeline's own refusals. What stops it comes back as the words the bot answers with.
import type { Role } from "@rsva/policy";
import { uuidv7, type Op, type Via } from "@rsva/protocol";
import { html } from "../mail/template.ts";
import { submitTx } from "../sync/submit.ts";
import type { TxResult } from "../sync/write.ts";

export type Written = { ok: true; r: TxResult } | { ok: false; why: string };

/**
 * Applies `ops` as the person. `what` names the change when the role forbids it ("You cannot comment on PLNR-3"), `failed`
 * leads the pipeline's refusal ("Not posted to PLNR-3: …"). A `txId` of the delivery makes its second delivery a replay.
 * `via` is where it was written: the history says "from Telegram" or "from Email" (PLNR-369).
 */
export async function writeAs(workspaceId: string, userId: string, role: Role, ops: Op[], what: string, failed: string, txId: string = uuidv7(), via: Via = "telegram"): Promise<Written> {
  // A linked chat writes like a token, not a signed-in browser: never the rules agents work under (packages/policy).
  const out = (await submitTx({ workspaceId, userId, txId, ops, viewer: () => ({ role, scope: "write" }), signedIn: false, via }))!;
  if (out.ok) return out;
  const no = out.refused;
  if (no.by === "budget") return { ok: false, why: "Too many changes at once. Try again in a minute." };
  return { ok: false, why: no.by === "rights" ? html`You cannot ${what}: ${no.msg}.`.value : html`${failed}: ${no.msg}`.value };
}
