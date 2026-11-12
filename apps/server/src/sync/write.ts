// The write pipeline is the only way data changes: browser transactions, agent edits through the API,
// later imports and webhooks. Order: validation → txId replay check → write → process rules → log numbers → commit →
// broadcast.
//
// Numbers come from the workspace row (`update workspace … returning`) at the very end of the transaction. The row
// stays locked until commit, so numbers are contiguous and in commit order, and the lock is held briefly.
//
// Every U action also stores what its fields held before (`sync_action.prev`): the row is read for update anyway, so
// the issue history gets "from → to" for free instead of walking the log backwards (docs/research/comments-history-2026-10-27.md).
import { randomUUID } from "node:crypto";
import { deniedGuardedChange, deniedState, deniedStateUpdate, isProposalLabel, isRole, mayDeleteIssue, mayManage, PEOPLE_LABELS, PEOPLE_STATES, readsAs, type GuardActor, type Guarded } from "@rsva/policy";
import { ISSUE_LISTS, type Action, type CommentCreate, type ListBase, type Op, type ReactionCreate, type Via } from "@rsva/protocol";
import { MENTION_SCHEME, mentionIds, sameDoc, type DocNode } from "@rsva/editor/doc";
import { fromMarkdown } from "@rsva/editor/markdown";
import { DocError, validateDoc } from "@rsva/editor/validate";
import { COMMENT_MAX, FILES_PER_ISSUE_MAX, ISSUE_EDITABLE, RELATIONS_MAX, SHA256, TITLE_MAX, URL_MAX, cleanName, cleanUrl, filePath, isClosedGroup, isFileCreate, issueKey, moveLabels, moveState, readLink, type AttachmentCreate, type AttachmentPatch, type DocJSON, type Equal, type FileCreate, type Issue, type IssuePatch, type IssueUpdate } from "@rsva/schema/models";
import { and, asc, desc, eq, inArray, isNull, or, sql as dsql, type SQL } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import { db, schema, type Tx } from "../db.ts";
import { title } from "../http.ts";
import { attachmentColumns, commentColumns, issueColumns, reactionColumns } from "./columns.ts";
import { broadcast, prime } from "./hub.ts";
import { memberOpSchemas, setMemberRole } from "./members.ts";
import { membershipChanged } from "./membership.ts";
import { checkIssueCycle, createCycle, cycleOpSchemas, deleteCycle, updateCycle } from "./cycles.ts";
import { purgeIssueAs } from "./purge.ts";
import { checkProjects, createLabel, createProject, createState, deleteLabel, deleteState, settingsOpSchemas, updateLabel, updateProject, updateState, updateWorkspace, type Touched } from "./settings.ts";
import { forgetText, readTx } from "./log.ts";
import { moment, momentChanges } from "./moments.ts";
import { retrying } from "./retry.ts";
import { created, diff, lockOwned, lockWorkspace } from "./rows.ts";
import { notifyChanged } from "../notify/run.ts";
import { TxError, type Pending } from "./tx-error.ts";

const { workspace, member, user, project, workflowState, label, issue, document, comment, reaction, attachment, blob, syncAction, appliedTx } = schema;

const uuid = z.uuid();
const day = z.iso.date();
/** Each issue once: a repeated id is refused here, since the pair checks run only for issues a change adds. */
const unique = (xs: readonly string[]) => new Set(xs).size === xs.length;
const relationIds = z.array(uuid).max(RELATIONS_MAX).refine(unique, "an issue is listed twice");
/**
 * A fractional index the library can place keys on both sides of. Any other string (`"!"`, `"zz"`, `"a10"`) makes
 * generateKeyBetween throw, and since it sorts first or last in the project it would break every later insert there.
 */
const sortKey = z
  .string()
  .min(1)
  .max(64)
  // The library's digits; it checks a key's head and length but would carry other characters into new keys.
  .regex(/^[0-9A-Za-z]+$/, "not a valid sort key")
  .refine((k) => {
    try {
      generateKeyBetween(null, k);
      generateKeyBetween(k, null);
      return true;
    } catch {
      return false;
    }
  }, "not a valid sort key");
const patch = z
  .object({
    title,
    stateId: uuid,
    priority: z.number().int().min(0).max(4),
    assigneeIds: z.array(uuid).max(20).refine(unique, "a person is listed twice"),
    delegateId: uuid.nullable(),
    labelIds: z.array(uuid).max(50).refine(unique, "a label is listed twice"),
    parentId: uuid.nullable(),
    blockedByIds: relationIds,
    relatedIds: relationIds,
    duplicateOfId: uuid.nullable(),
    startDate: day.nullable(),
    dueDate: day.nullable(),
    cycleId: uuid.nullable(),
    sortOrder: sortKey,
  } satisfies Record<(typeof ISSUE_EDITABLE)[number], z.ZodType>)
  .partial()
  .strict();
/** `projectId`: a move to another project of the workspace (PLNR-448, moveTo). */
const update = patch.extend({ archivedAt: moment, deletedAt: moment, projectId: uuid }).partial().strict();
/** Larger than any list: a base holds what a list held, and refusing it would refuse a change that fits. */
const BASE_MAX = 1000;
/** The lists as the sender saw them. */
const listBase = z.object(Object.fromEntries(ISSUE_LISTS.map((k) => [k, z.array(uuid).max(BASE_MAX)]))).partial().strict();

/** Markdown; trailing whitespace is dropped, an empty comment is not a comment. */
const body = z.string().max(COMMENT_MAX).transform((s) => s.trimEnd()).pipe(z.string().min(1, "the comment is empty"));
/** One emoji: a pictograph, flag or keycap with its modifiers and joiners. */
const emoji = z
  .string()
  .max(32)
  .regex(/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\d#*]️?⃣)[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]*$/u, "not an emoji");

/** A link's address as cleanUrl stores it, and its title cleaned like an issue title; an empty title shows the address. */
const linkUrl = z
  .string()
  .max(URL_MAX * 2)
  .transform((s, ctx) => cleanUrl(s) ?? (ctx.addIssue({ code: "custom", message: `a link is an http or https address of up to ${URL_MAX} characters` }), z.NEVER));
const linkTitle = z.string().transform(cleanName).pipe(z.string().max(TITLE_MAX, `a link title is at most ${TITLE_MAX} characters`));
/** A file's name: cleaned like a title, never empty. */
const fileName = linkTitle.pipe(z.string().min(1, "a file needs a name"));

const target = { id: uuid };
const opSchema = z.discriminatedUnion("m", [
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("update"), m: z.literal("Issue"), ...target, set: update, base: listBase.optional() }).strict(),
    z.object({ op: z.literal("create"), m: z.literal("Issue"), ...target, projectId: uuid, set: patch.required({ title: true, stateId: true }) }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("Issue"), ...target }).strict(),
  ]),
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("create"), m: z.literal("Comment"), ...target, set: z.object({ issueId: uuid, parentId: uuid.nullable().optional(), body }).strict() }).strict(),
    z.object({ op: z.literal("update"), m: z.literal("Comment"), ...target, set: z.object({ body }).strict() }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("Comment"), ...target }).strict(),
  ]),
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("create"), m: z.literal("Reaction"), ...target, set: z.object({ issueId: uuid, commentId: uuid.nullable().optional(), emoji }).strict() }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("Reaction"), ...target }).strict(),
  ]),
  z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("create"),
        m: z.literal("Attachment"),
        ...target,
        set: z.union([z.object({ issueId: uuid, url: linkUrl, title: linkTitle }).strict(), z.object({ issueId: uuid, sha256: z.string().regex(SHA256), title: fileName }).strict()]),
      })
      .strict(),
    z.object({ op: z.literal("update"), m: z.literal("Attachment"), ...target, set: z.object({ url: linkUrl, title: linkTitle }).partial().strict() }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("Attachment"), ...target }).strict(),
  ]),
  // The document's structure, size and links are checked by validateDoc (packages/editor) when the op is applied.
  z.discriminatedUnion("op", [z.object({ op: z.literal("update"), m: z.literal("Document"), ...target, set: z.object({ doc: z.looseObject({ type: z.literal("doc") }) }).strict(), base: uuid.nullable().optional() }).strict()]),
  ...settingsOpSchemas,
  ...cycleOpSchemas,
  ...memberOpSchemas,
]);
/** Each op's own fields and those of its `set`, by model and kind; `set` may be a union (a link or a file). */
type OpFields<T extends { m: string; op: string }> = {
  [O in T as `${O["m"]} ${O["op"]}`]: [keyof O, O extends { set: infer S } ? (S extends unknown ? keyof S : never) : never];
};
// The schemas take exactly the protocol's ops: a field added to one and not the other fails here, not as a refused write.
true satisfies Equal<OpFields<z.output<typeof opSchema>>, OpFields<Op>>;

/** Most ops in one transaction: a bigger change goes in several (packages/sync TX_OPS, the agent API's writeAll). */
export const TX_OPS_MAX = 500;
const opsSchema = z.array(opSchema).min(1).max(TX_OPS_MAX);

export { TxError };

export interface TxResult {
  /** Number of the last action; on a txId replay, the same as the first time. */
  s: number;
  actions: Action[];
  /** A replay's `actions` with each member's role as it is now, for those listening to membership changes. */
  roles?: Action[];
}

/**
 * `signedIn`: the actor writes from a signed-in browser, not with a token or a linked chat; the guards of states and
 * labels come off only for a signed-in admin (packages/policy, deniedGuardedChange). Unsaid, it is not: a new caller that
 * forgets it gets the narrower rules, never an admin's. `via`: the change was made in the Telegram bot's chat or by an email
 * reply (PLNR-369); the log and a new comment keep it, the history shows it.
 */
export async function applyTx(workspaceId: string, actorId: string, txId: string, rawOps: unknown, signedIn = false, via?: Via): Promise<TxResult> {
  const parsed = opsSchema.safeParse(rawOps);
  if (!parsed.success) throw new TxError("invalid", z.prettifyError(parsed.error));
  if (!uuid.safeParse(txId).success) throw new TxError("invalid", "transaction id must be a UUID");
  const ops = parsed.data as Op[];
  return committed(workspaceId, actorId, txId, async (tx) => {
    await lockRows(tx, workspaceId, ops);
    const who = await guardActor(tx, workspaceId, actorId, ops, signedIn);
    const pending: Pending[] = [];
    const touched: Touched = new Set();
    for (const op of ops) {
      const a = await applyOp(tx, workspaceId, actorId, txId, who, touched, op, via);
      if (Array.isArray(a)) pending.push(...a);
      else if (a) pending.push(a);
    }
    await checkProjects(tx, touched);
    if (who === "agent") await checkMoves(tx, ops);
    return logPending(tx, workspaceId, actorId, txId, pending, via);
  });
}

/**
 * The path of every write: runs `write` in a transaction that claims `txId` first, again if the database failed it
 * (retry.ts), then sends the result. `write` may run more than once, so anything it records outside the transaction has
 * to start over on each run.
 */
async function committed(workspaceId: string, actorId: string, txId: string, write: (tx: Tx) => Promise<TxResult>): Promise<TxResult> {
  await primed(workspaceId);
  const result = await retrying(() =>
    db.transaction(async (tx) => {
      // A replay that arrives while the original is still running waits here on the unique index until the original
      // commits, then gets its answer instead of applying the ops a second time.
      const claimed = await tx.insert(appliedTx).values({ txId, workspaceId, lastSyncId: 0 }).onConflictDoNothing().returning({ txId: appliedTx.txId });
      return claimed.length > 0 ? write(tx) : replayed(tx, workspaceId, actorId, txId);
    }),
  );
  await publish(workspaceId, result.actions, result.roles);
  return result;
}

const primed = (workspaceId: string) => prime(workspaceId, async () => (await db.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, workspaceId)))[0]?.s ?? 0);

/**
 * Locks the issues the transaction writes, then their documents, each in id order, before any op runs. Row by row in
 * the order of the ops, two bulk edits over the same issues sent in opposite orders each held a row the other waited
 * for; a parent or relation change, which takes the workspace row mid-transaction, held it while waiting for an issue
 * another transaction had locked on its way to the workspace row at commit; and a description save locks its document
 * before it writes the issue's updatedAt, the other way round from an issue edit. Postgres broke each deadlock by
 * aborting one of them. Now a client's transaction takes issues, then documents, then the workspace row. Other rows
 * (comments, attachments, settings), bulk updates of settings and foreign key locks do not follow this order, and neither
 * do server changes: a deadlock left there is retried (retry.ts).
 */
async function lockRows(tx: Tx, workspaceId: string, ops: Op[]): Promise<void> {
  const docs = [...new Set(ops.flatMap((op) => (op.m === "Document" ? [op.id] : [])))];
  const issues = new Set(ops.flatMap((op) => (op.m === "Issue" && op.op === "update" ? [op.id] : [])));
  // A lone issue edit is locked by its update, as before; a description save writes its issue too, so it needs the issue
  // first even alone.
  if (issues.size + docs.length >= 2 || docs.length) {
    for (const id of docs) issues.add(id);
    // FOR UPDATE takes the rows as the sort returns them: in id order.
    await tx.select({ id: issue.id }).from(issue).where(and(eq(issue.workspaceId, workspaceId), inArray(issue.id, [...issues]))).orderBy(asc(issue.id)).for("update");
  }
  if (docs.length >= 2)
    await tx.select({ id: document.id }).from(document).where(and(eq(document.workspaceId, workspaceId), inArray(document.id, docs))).orderBy(asc(document.id)).for("update");
}

/**
 * A txId seen before: the first answer again, so a client resending after a reconnect does not apply its ops twice. The
 * id must have been used in this workspace by this actor; anything else is refused instead of acking ops that were never
 * applied (and showing another workspace's log number). applied_tx has no actor column: the transaction's last action
 * names it. A transaction that changed nothing wrote no action and is acked for anyone: there was nothing to protect.
 *
 * The first run may have lost its connection right after the commit, with all that comes after it undone, so the answer
 * carries its actions: the caller reads them (a new issue's number), the hub sends those it has not sent yet and drops the
 * rest, and removed members lose their sockets. By the role they have now: someone invited back since keeps theirs.
 */
async function replayed(tx: Tx, workspaceId: string, actorId: string, txId: string): Promise<TxResult> {
  const [dup] = await tx.select({ s: appliedTx.lastSyncId, workspaceId: appliedTx.workspaceId }).from(appliedTx).where(eq(appliedTx.txId, txId));
  const ours = dup!.workspaceId === workspaceId;
  const actions = ours ? await readTx(tx, workspaceId, txId) : [];
  const last = actions.at(-1);
  if (!ours || (last && last.by !== actorId)) throw new TxError("conflict", "this transaction id is already used");
  return { s: dup!.s, actions, roles: await currentRoles(tx, workspaceId, actions) };
}

async function currentRoles(tx: Tx, workspaceId: string, actions: Action[]): Promise<Action[]> {
  const users = actions.filter((a) => a.m === "User").map((a) => a.mid);
  if (!users.length) return actions;
  const rows = await tx.select({ userId: member.userId, role: member.role }).from(member).where(and(eq(member.workspaceId, workspaceId), inArray(member.userId, users)));
  const roles = new Map(rows.map((r) => [r.userId, r.role]));
  return actions.map((a) => (a.m === "User" && a.d && "role" in a.d ? { ...a, d: { ...a.d, role: roles.get(a.mid) ?? null } } : a));
}

/**
 * A change the server makes on its own behalf (an accepted invite, a member leaving through the API) with the same
 * log, numbers and broadcast as a client transaction. `write` runs in the transaction, perhaps more than once (see
 * `committed`), and returns its actions; it gets the transaction's id, which a description's action carries.
 */
export async function applyServerChange(workspaceId: string, actorId: string, write: (tx: Tx, txId: string) => Promise<Pending[]>): Promise<TxResult> {
  const txId = randomUUID();
  return committed(workspaceId, actorId, txId, async (tx) => logPending(tx, workspaceId, actorId, txId, await write(tx, txId)));
}

/**
 * A server change that reaches several workspaces (a person's new name): one transaction for all of them, so none is
 * left without its action when another fails, then each workspace's broadcast. `write` returns each workspace's
 * actions; `workspaceIds` are primed beforehand. `write` may name a workspace beyond them (one joined meanwhile): the
 * path that wrote to it primed it. The workspace rows are taken in id order, after whatever `write` locks.
 */
export async function applyServerChangeIn(workspaceIds: string[], actorId: string, write: (tx: Tx) => Promise<Map<string, Pending[]>>): Promise<void> {
  await Promise.all(workspaceIds.map(primed));
  const results = await retrying(() =>
    db.transaction(async (tx) => {
      const pending = await write(tx);
      const out: [string, TxResult][] = [];
      for (const workspaceId of [...pending.keys()].sort()) {
        const p = pending.get(workspaceId)!;
        if (!p.length) continue;
        const txId = randomUUID();
        await tx.insert(appliedTx).values({ txId, workspaceId, lastSyncId: 0 });
        out.push([workspaceId, await logPending(tx, workspaceId, actorId, txId, p)]);
      }
      return out;
    }),
  );
  for (const [workspaceId, r] of results) await publish(workspaceId, r.actions);
}

// Deltas go out before the caller acks, so the writer sees its own delta first; then the role caches and sockets learn
// about membership changes.
async function publish(workspaceId: string, actions: Action[], roles = actions): Promise<void> {
  await broadcast(workspaceId, actions);
  membershipChanged(workspaceId, roles);
  if (actions.length) notifyChanged();
}

/** Numbers the actions from the workspace row, writes them to the log and records the transaction's last number. */
async function logPending(tx: Tx, workspaceId: string, actorId: string, txId: string, pending: Pending[], via?: Via): Promise<TxResult> {
  let s: number;
  if (pending.length === 0) {
    [{ s }] = await tx.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, workspaceId)) as [{ s: number }];
  } else {
    [{ s }] = await tx
      .update(workspace)
      .set({ lastSyncId: dsql`${workspace.lastSyncId} + ${pending.length}` })
      .where(eq(workspace.id, workspaceId))
      .returning({ s: workspace.lastSyncId }) as [{ s: number }];
  }
  const first = s - pending.length + 1;
  const actions = pending.map(({ p: _, ...a }, i) => ({ id: first + i, ...a, by: actorId, ...(via ? { via } : {}) }) as Action);
  if (actions.length) {
    await tx.insert(syncAction).values(
      actions.map((a, i) => ({ workspaceId, id: a.id, model: a.m, modelId: a.mid, action: a.a, data: a.d ?? null, prev: pending[i]!.p ?? null, txId, actorId, via: via ?? null })),
    );
  }
  await tx.update(appliedTx).set({ lastSyncId: s }).where(eq(appliedTx.txId, txId));
  return { s, actions };
}

/** What an op's handler is given besides the op. */
interface OpContext {
  tx: Tx;
  workspaceId: string;
  actorId: string;
  txId: string;
  agent: boolean;
  touched: Touched;
  via: Via | undefined;
}

/**
 * Each op's handler, by `op:model`. A mapped type over the protocol's ops: each handler gets its own op's type without a
 * cast, and an op added to the protocol without a handler fails to compile here.
 */
const HANDLERS: { [O in Op as `${O["op"]}:${O["m"]}`]: (c: OpContext, op: O) => Promise<Pending | Pending[] | null> } = {
  "update:Issue": (c, o) => updateIssue(c.tx, c.workspaceId, c.actorId, c.agent, o.id, o.set, o.base),
  "create:Issue": (c, o) => createIssue(c.tx, c.workspaceId, c.actorId, c.agent, o.id, o.projectId, o.set),
  "delete:Issue": (c, o) => purgeIssueAs(c.tx, c.workspaceId, c.actorId, o.id),
  "create:Comment": (c, o) => createComment(c.tx, c.workspaceId, c.actorId, o.id, o.set, c.via),
  "update:Comment": (c, o) => editComment(c.tx, c.workspaceId, c.actorId, o.id, o.set.body),
  "delete:Comment": (c, o) => deleteComment(c.tx, c.workspaceId, c.actorId, o.id),
  "create:Reaction": (c, o) => addReaction(c.tx, c.workspaceId, c.actorId, o.id, o.set),
  "delete:Reaction": (c, o) => removeReaction(c.tx, c.workspaceId, c.actorId, o.id),
  "create:Attachment": (c, o) => (isFileCreate(o.set) ? addFile(c.tx, c.workspaceId, c.actorId, o.id, o.set) : addLink(c.tx, c.workspaceId, c.actorId, o.id, o.set)),
  "update:Attachment": (c, o) => editLink(c.tx, c.workspaceId, o.id, o.set),
  "delete:Attachment": (c, o) => removeLink(c.tx, c.workspaceId, o.id),
  "update:Document": (c, o) => updateDocument(c.tx, c.workspaceId, c.txId, o),
  "update:Workspace": (c, o) => updateWorkspace(c.tx, c.workspaceId, o.id, o.set),
  "create:Project": (c, o) => createProject(c.tx, c.workspaceId, c.touched, o.id, o.set),
  "update:Project": (c, o) => updateProject(c.tx, c.workspaceId, o.id, o.set),
  "create:WorkflowState": (c, o) => createState(c.tx, c.workspaceId, c.touched, o.id, o.set),
  "update:WorkflowState": (c, o) => updateState(c.tx, c.workspaceId, c.touched, o.id, o.set),
  "delete:WorkflowState": (c, o) => deleteState(c.tx, c.workspaceId, c.touched, o.id),
  "create:Label": (c, o) => createLabel(c.tx, c.workspaceId, o.id, o.set),
  "update:Label": (c, o) => updateLabel(c.tx, c.workspaceId, o.id, o.set),
  "delete:Label": (c, o) => deleteLabel(c.tx, c.workspaceId, o.id),
  "create:Cycle": (c, o) => createCycle(c.tx, c.workspaceId, c.actorId, o.id, o.set),
  "update:Cycle": (c, o) => updateCycle(c.tx, c.workspaceId, c.actorId, o.id, o.set),
  "delete:Cycle": (c, o) => deleteCycle(c.tx, c.workspaceId, o.id),
  "update:User": (c, o) => setMemberRole(c.tx, c.workspaceId, c.actorId, o.id, o.set.role),
  "delete:User": (c, o) => setMemberRole(c.tx, c.workspaceId, c.actorId, o.id, null),
};

async function applyOp(tx: Tx, workspaceId: string, actorId: string, txId: string, who: GuardActor, touched: Touched, op: Op, via?: Via): Promise<Pending | Pending[] | null> {
  if (op.m === "WorkflowState" || op.m === "Label") op = await guardOp(tx, workspaceId, who, op);
  const key = `${op.op}:${op.m}`;
  // Validated ops always have a handler; the check keeps a prototype key from ever being called.
  if (!Object.hasOwn(HANDLERS, key)) throw new TxError("invalid", `unknown op ${op.op} ${op.m}`);
  const handle = HANDLERS[key as keyof typeof HANDLERS] as (c: OpContext, op: Op) => Promise<Pending | Pending[] | null>;
  return handle({ tx, workspaceId, actorId, txId, agent: who === "agent", touched, via }, op);
}

// ── Process rules ─────────────────────────────────────────────────────────────────────────────────────────────
//
// An agent cannot move an issue into a state only people set, nor rename or delete such a state or a label only people
// change (packages/policy, Guarded; ADR 0037). Nor can anyone but a signed-in admin take a guard off another way than
// the switch: rename or delete a guarded row, or give an unguarded one a guarded one's name. Checked here, inside the
// transaction, against the rows as the transaction's own ops leave them, so the browser socket, the REST API and any
// later path get the same answer. Three checks, each cheap and only when an op is one they look at: every move against
// its target at that moment (checkRefs, agents), the guarded states and labels (checkGuards, all but a signed-in admin),
// and the final state of every issue the transaction moved (checkMoves, agents). The switch itself is deniedOps'.
//
// The guard is on the row, not a list of names (before ADR 0037 it was: renaming Approved dropped its protection).
// Names still matter for one thing: an unguarded "Approved" would look like the one people set.

const movesState = (op: Op) => op.m === "Issue" && "set" in op && op.set.stateId !== undefined;
/** A move to another project maps the issue's state (moveTo), which the process rules look at too. */
const movesProject = (op: Op) => op.m === "Issue" && op.op === "update" && op.set.projectId !== undefined;

/** Who the process rules hold the actor to; read only when an op is one they look at (else "admin": nothing to hold). */
async function guardActor(tx: Tx, workspaceId: string, actorId: string, ops: Op[], signedIn: boolean): Promise<GuardActor> {
  if (!ops.some((op) => op.m === "WorkflowState" || op.m === "Label" || movesState(op) || movesProject(op))) return "admin";
  const [u] = await tx
    .select({ kind: user.kind, role: member.role })
    .from(user)
    .leftJoin(member, and(eq(member.userId, user.id), eq(member.workspaceId, workspaceId)))
    .where(eq(user.id, actorId));
  if (u?.kind === "agent") return "agent";
  return signedIn && isRole(u?.role) && mayManage(u.role) ? "admin" : "person";
}

/** A state or label of the workspace as the process rules read it; none when there is no such row. */
async function guardedRow(tx: Tx, workspaceId: string, m: "WorkflowState" | "Label", id: string): Promise<Guarded | undefined> {
  const [row] =
    m === "Label"
      ? await tx.select({ name: label.name, onlyPeople: label.onlyPeople }).from(label).where(and(eq(label.id, id), eq(label.workspaceId, workspaceId)))
      : await tx
          .select({ name: workflowState.name, onlyPeople: workflowState.onlyPeople })
          .from(workflowState)
          .innerJoin(project, eq(project.id, workflowState.projectId))
          .where(and(eq(workflowState.id, id), eq(project.workspaceId, workspaceId)));
  return row;
}

/** Names of the workspace's guarded states, or labels: a new name may not read as one of them without the guard. */
async function guardedNames(tx: Tx, workspaceId: string, m: "WorkflowState" | "Label"): Promise<string[]> {
  const rows =
    m === "Label"
      ? await tx.select({ name: label.name }).from(label).where(and(eq(label.workspaceId, workspaceId), eq(label.onlyPeople, true)))
      : await tx
          .select({ name: workflowState.name })
          .from(workflowState)
          .innerJoin(project, eq(project.id, workflowState.projectId))
          .where(and(eq(project.workspaceId, workspaceId), eq(workflowState.onlyPeople, true)));
  return rows.map((r) => r.name);
}

/**
 * The op with its guard as it will be stored, after the process rules allow it. A new state or label, or one a person
 * renames, comes guarded when nobody said otherwise and its name reads as a guarded one (the workspace's, or PEOPLE_STATES and
 * PEOPLE_LABELS): an "Approved" an admin adds to a new project is the people's, as the migration and imports make it.
 * Only a signed-in admin makes one unguarded on purpose (deniedOps: an explicit false).
 */
async function guardOp(tx: Tx, workspaceId: string, who: GuardActor, op: Extract<Op, { m: "WorkflowState" | "Label" }>): Promise<Op> {
  const before = op.op === "create" ? undefined : await guardedRow(tx, workspaceId, op.m, op.id);
  if (op.op !== "create" && !before) return op; // the op itself answers not_found
  const named = op.op !== "delete" && op.set.name !== undefined && op.set.name !== before?.name;
  const names = named ? [...(op.m === "Label" ? PEOPLE_LABELS : PEOPLE_STATES), ...(await guardedNames(tx, workspaceId, op.m))] : [];
  const current = before?.onlyPeople ?? false;
  // Not an agent's rename: a state it moved issues into, renamed "Todo" and guarded, would hold them as if people had.
  const auto = named && (op.op === "create" || who !== "agent");
  const guarded = op.op === "delete" ? current : (op.set.onlyPeople ?? (current || (auto && readsAs(op.set.name!, names) !== null)));
  const out = op.op !== "delete" && guarded !== (op.set.onlyPeople ?? current) ? ({ ...op, set: { ...op.set, onlyPeople: guarded } } as Op) : op;
  if (who === "admin") return out;
  // Made the default, a guarded state would take every issue made without a state (deleting a default with a move makes
  // the target the default by such an update too, packages/protocol deleteStateOps); moved to another group, it would
  // complete or reopen its issues. A new guarded state made the default would do the same.
  if (who === "agent" && op.m === "WorkflowState" && op.op !== "delete" && (op.set.isDefault === true || (op.op === "update" && op.set.group !== undefined))) {
    const denied = deniedStateUpdate("agent", { name: op.set.name ?? before!.name, onlyPeople: guarded });
    if (denied) throw new TxError("forbidden", denied);
  }
  if (op.op === "update" && !named) return out;
  const after = op.op === "delete" ? undefined : { name: op.set.name!, onlyPeople: guarded };
  const denied = deniedGuardedChange(who, op.m === "Label" ? "label" : "state", before, after, names);
  if (denied) throw new TxError("forbidden", denied);
  return out;
}

/** After the ops: no issue the agent moved sits in a state only people set. */
async function checkMoves(tx: Tx, ops: Op[]): Promise<void> {
  const ids = [...new Set(ops.filter(movesState).map((op) => op.id))];
  if (!ids.length) return;
  const rows = await tx
    .select({ name: workflowState.name, onlyPeople: workflowState.onlyPeople })
    .from(issue)
    .innerJoin(workflowState, eq(workflowState.id, issue.stateId))
    .where(inArray(issue.id, ids));
  for (const r of rows) {
    const denied = deniedState("agent", r);
    if (denied) throw new TxError("forbidden", denied);
  }
}

// ── Issues ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Most a merged list may hold: what a change could not set by itself either. */
const LIST_MAX: Record<(typeof ISSUE_LISTS)[number], number> = { assigneeIds: 20, labelIds: 50, blockedByIds: RELATIONS_MAX, relatedIds: RELATIONS_MAX };

/** `mine`, which replaced `base`, applied to the list as it is now: what the sender added and took off, and nothing else. */
function mergeList(now: string[], base: string[], mine: string[]): string[] {
  if (now.length === base.length && now.every((x, i) => x === base[i])) return mine;
  const off = new Set(base.filter((x) => !mine.includes(x)));
  return [...now.filter((x) => !off.has(x)), ...mine.filter((x) => !base.includes(x) && !now.includes(x))];
}

/**
 * The lists of a change that names what it saw (`base`), merged into the locked row. Before, a list was a field like any
 * other and the last write replaced it: two people adding a label each left one label, and neither was told.
 */
function mergeLists(row: typeof issue.$inferSelect, set: IssueUpdate, base: ListBase | undefined): IssueUpdate {
  if (!base) return set;
  const out = { ...set };
  for (const k of ISSUE_LISTS) {
    const mine = set[k];
    if (!mine || !base[k]) continue;
    const merged = mergeList(row[k], base[k], mine);
    if (merged.length > LIST_MAX[k]) throw new TxError("invalid", `${k} would hold more than ${LIST_MAX[k]} after someone else's change`);
    out[k] = merged;
  }
  return out;
}

/**
 * The change, without the proposal label if it takes the issue out of Backlog: accepted or declined, on the page or through
 * the API, it is a proposal no longer (PLNR-125). A label the same change adds goes too, and moving back does not restore it.
 */
async function endProposal(tx: Tx, row: typeof issue.$inferSelect, fields: IssueUpdate): Promise<IssueUpdate> {
  const labels = fields.labelIds ?? row.labelIds;
  if (!fields.stateId || fields.stateId === row.stateId || !labels.length) return fields;
  const states = await tx.select({ id: workflowState.id, group: workflowState.group }).from(workflowState).where(inArray(workflowState.id, [row.stateId, fields.stateId]));
  const inBacklog = (id: string) => states.find((s) => s.id === id)?.group === "backlog";
  if (!inBacklog(row.stateId) || inBacklog(fields.stateId)) return fields;
  const named = await tx.select({ id: schema.label.id, name: schema.label.name }).from(schema.label).where(inArray(schema.label.id, labels));
  const off = new Set(named.filter((l) => isProposalLabel(l.name)).map((l) => l.id));
  return off.size ? { ...fields, labelIds: labels.filter((l) => !off.has(l)) } : fields;
}

export async function updateIssue(tx: Tx, workspaceId: string, actorId: string, agent: boolean, id: string, set: IssueUpdate, base?: ListBase): Promise<Pending | null> {
  const row = await lockOwned(tx, issue, workspaceId, id, "issue");
  const { archivedAt, deletedAt, projectId: to, ...given } = mergeLists(row, set, base);
  const moving = to !== undefined && to !== row.projectId;
  if (moving && row.deletedAt && deletedAt !== null) throw new TxError("bad_ref", "the issue is deleted: restore it before moving it");
  // A move brings the fields it maps and the issue's new number and keys; a change made against a project the issue has
  // since left is carried over to the one it is in.
  const { fields, moved, mapped, dropped } = moving
    ? await moveTo(tx, workspaceId, row, to, given, agent)
    : { fields: row.formerKeys.length ? await carryOver(tx, workspaceId, row, given) : given, moved: {}, mapped: false, dropped: [] };
  const projectId = moving ? to : row.projectId;
  // Staying in a completed cycle is no move into it: only a cycle the change brings is checked. A state the move chose
  // was checked there.
  const { cycleId: _, ...rest } = fields;
  const refs: Fields = fields.cycleId === row.cycleId ? rest : { ...fields };
  if (mapped) delete refs.stateId;
  await checkRefs(tx, workspaceId, projectId, refs, agent);
  const added = addedRelations(row, fields);
  if (fields.parentId || added.size) {
    // Two moves at once (A under B, B under A) would each pass the check before the other commits: parent and relation
    // changes of a workspace take turns on its row, which the transaction locks at the end anyway.
    await lockWorkspace(tx, workspaceId);
    if (fields.parentId) await checkParent(tx, id, fields.parentId);
    await checkRelations(tx, workspaceId, { ...row, ...fields }, added);
  }

  const { changed, prev } = diff(row, await endProposal(tx, row, fields));
  // A move says its project, number and keys whole, even a number that happens to be the one it had.
  for (const [k, v] of Object.entries(moved)) {
    changed[k] = v;
    prev[k] = (row as Record<string, unknown>)[k];
  }
  const lifecycle = momentChanges(row, { archivedAt, deletedAt }, prev);
  if ("deletedAt" in lifecycle && !mayDeleteIssue(await roleOf(tx, workspaceId, actorId), row.createdById === actorId))
    throw new TxError("forbidden", "only the issue's creator or an admin can delete or restore it");
  if (lifecycle.archivedAt) {
    const [s] = await tx.select({ group: workflowState.group }).from(workflowState).where(eq(workflowState.id, fields.stateId ?? row.stateId));
    if (!isClosedGroup(s?.group)) throw new TxError("invalid", "only completed or cancelled issues can be archived");
  }
  if (Object.keys(changed).length === 0 && Object.keys(lifecycle).length === 0) return null;

  if (changed.stateId) {
    const closedAt = await completedAt(tx, changed.stateId as string, row.stateId, row.completedAt);
    if (closedAt !== row.completedAt) {
      changed.completedAt = closedAt;
      prev.completedAt = row.completedAt;
    }
  }
  // Server-set times come back from the database, so deltas carry them in the same format as the snapshot.
  const [after] = await tx
    .update(issue)
    .set({ ...changed, ...lifecycle, updatedAt: dsql`now()` })
    .where(eq(issue.id, id))
    .returning({ updatedAt: issue.updatedAt, completedAt: issue.completedAt, archivedAt: issue.archivedAt, deletedAt: issue.deletedAt });
  changed.updatedAt = after!.updatedAt;
  if ("completedAt" in changed) changed.completedAt = after!.completedAt;
  for (const k of ["archivedAt", "deletedAt"] as const) if (k in lifecycle) changed[k] = after![k];
  // The labels a move left behind, for its line in the history (movedFrom): no field of the row.
  if (dropped.length) changed.dropped = dropped;
  return { m: "Issue", mid: id, a: "U", d: changed, p: prev };
}

// ── Moves between projects (PLNR-448) ─────────────────────────────────────────────────────────────────────────
//
// A move is an update like any other: one action with the fields it changed and their values before, so the issue keeps
// its id and with it its history, comments, links, files, pull requests and relations; other clients apply it as any
// delta. Considered: a new issue in the target and the old one closed as a duplicate (Plane's "transfer"; two rows, the
// history split between them), a separate op kind (every path that takes issue updates would need a second case).

type IssueRow = typeof issue.$inferSelect;
type Fields = Omit<IssueUpdate, "projectId" | "archivedAt" | "deletedAt">;

/** The project's states as moveState reads them. */
const statesOf = (tx: Tx, projectId: string) =>
  tx.select({ id: workflowState.id, name: workflowState.name, group: workflowState.group, position: workflowState.position, isDefault: workflowState.isDefault, onlyPeople: workflowState.onlyPeople, projectId: workflowState.projectId }).from(workflowState).where(eq(workflowState.projectId, projectId));

async function stateOf(tx: Tx, workspaceId: string, id: string) {
  const [s] = await tx
    .select({ id: workflowState.id, name: workflowState.name, group: workflowState.group, onlyPeople: workflowState.onlyPeople, projectId: workflowState.projectId })
    .from(workflowState)
    .innerJoin(project, eq(project.id, workflowState.projectId))
    .where(and(eq(workflowState.id, id), eq(project.workspaceId, workspaceId)));
  return s;
}

/** The workspace's labels among `ids` and the project's own, as moveLabels reads them. */
async function labelsFor(tx: Tx, workspaceId: string, ids: readonly string[], projectId: string) {
  const rows = await tx
    .select({ id: label.id, name: label.name, projectId: label.projectId })
    .from(label)
    .where(and(eq(label.workspaceId, workspaceId), or(eq(label.projectId, projectId), ids.length ? inArray(label.id, [...ids]) : undefined)));
  return { byId: new Map(rows.map((l) => [l.id, l])), target: rows.filter((l) => l.projectId === projectId) };
}

/**
 * The fields of a move to `to`: what the change gave, with the state, labels and cycle the target can hold (a given one
 * that is the target's stays; the issue's own, or one of the project it leaves, is mapped by moveState and moveLabels; a
 * cycle of another project is cleared), and the issue's next number there and its former keys. The target's counter row
 * stays locked to the end of the transaction, as a new issue's does.
 */
async function moveTo(
  tx: Tx,
  workspaceId: string,
  row: IssueRow,
  to: string,
  given: Fields,
  agent: boolean,
): Promise<{ fields: Fields; moved: Record<string, unknown>; mapped: boolean; dropped: string[] }> {
  const [target] = await tx
    .update(project)
    .set({ issueCounter: dsql`${project.issueCounter} + 1` })
    .where(and(eq(project.id, to), eq(project.workspaceId, workspaceId)))
    .returning({ number: project.issueCounter, key: project.key, archivedAt: project.archivedAt });
  if (!target) throw new TxError("bad_ref", "the project to move to is not in the workspace");
  if (target.archivedAt) throw new TxError("invalid", `project ${target.key} is archived: restore it before moving issues into it`);
  const [from] = await tx.select({ key: project.key }).from(project).where(eq(project.id, row.projectId));
  const fields: Fields = { ...given };

  const current = await stateOf(tx, workspaceId, given.stateId ?? row.stateId);
  if (!current) throw new TxError("bad_ref", "state is not in the workspace");
  const mapped = current.projectId !== to;
  if (mapped) {
    const states = await statesOf(tx, to);
    fields.stateId = moveState(current, states);
    // The state the move chose, not one the agent named: a guarded state of the same name keeps a person's decision, but
    // a guarded one reached by group or default would be an agent's move into it.
    const chosen = states.find((s) => s.id === fields.stateId)!;
    if (agent && chosen.onlyPeople && !current.onlyPeople) throw new TxError("forbidden", deniedState("agent", chosen) ?? `only people move issues into ${chosen.name}`);
  }

  // The labels of the project it leaves are mapped; one of a third project stays in the list for checkRefs to refuse.
  const ids = given.labelIds ?? row.labelIds;
  const labels = await labelsFor(tx, workspaceId, ids, to);
  const foreign = ids.filter((id) => ![null, to, row.projectId].includes(labels.byId.get(id)?.projectId ?? null));
  const mappedLabels = moveLabels(ids, labels.byId, to, labels.target);
  fields.labelIds = [...mappedLabels.labelIds, ...foreign];

  const cycle = given.cycleId ?? null;
  fields.cycleId = cycle && (await cycleIn(tx, cycle, to)) ? cycle : null;

  const dropped = mappedLabels.dropped.filter((id) => !foreign.includes(id));
  return { fields, mapped, dropped, moved: { projectId: to, number: target.number, formerKeys: [...row.formerKeys, issueKey(from!.key, row.number)] } };
}

const cycleIn = async (tx: Tx, cycleId: string, projectId: string) =>
  (await tx.select({ id: schema.cycle.id }).from(schema.cycle).where(and(eq(schema.cycle.id, cycleId), eq(schema.cycle.projectId, projectId)))).length > 0;

/** Whether the issue was once in the project: one of its former keys is under the project's key, now or before. */
const wasIn = (row: IssueRow, p: { key: string; formerKeys: string[] }) => row.formerKeys.some((k) => [p.key, ...p.formerKeys].some((pk) => k.startsWith(`${pk}-`)));

/**
 * A change sent for a moved issue against a project it was in before (a tab that had not seen the move yet): its state and
 * labels are mapped to the issue's project as the move mapped them, and a cycle of the old project is no change. Anything
 * else keeps its usual check (checkRefs).
 */
async function carryOver(tx: Tx, workspaceId: string, row: IssueRow, given: Fields): Promise<Fields> {
  const fields: Fields = { ...given };
  const left = async (projectId: string | null) => {
    if (!projectId || projectId === row.projectId) return false;
    const [p] = await tx.select({ key: project.key, formerKeys: project.formerKeys }).from(project).where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)));
    return !!p && wasIn(row, p);
  };
  if (given.stateId) {
    const s = await stateOf(tx, workspaceId, given.stateId);
    if (s && (await left(s.projectId))) fields.stateId = moveState(s, await statesOf(tx, row.projectId));
  }
  if (given.labelIds?.length) {
    const labels = await labelsFor(tx, workspaceId, given.labelIds, row.projectId);
    const foreign = [...labels.byId.values()].filter((l) => l.projectId !== null && l.projectId !== row.projectId);
    if (foreign.length && (await Promise.all(foreign.map((l) => left(l.projectId)))).every(Boolean)) fields.labelIds = moveLabels(given.labelIds, labels.byId, row.projectId, labels.target).labelIds;
  }
  if (given.cycleId) {
    const [c] = await tx.select({ projectId: schema.cycle.projectId }).from(schema.cycle).where(eq(schema.cycle.id, given.cycleId));
    if (c && (await left(c.projectId))) delete fields.cycleId;
  }
  return fields;
}

/** A key above the project's first one. A key stored before sortKey checked them is refused by name, not as a 500. */
function topKey(first: string | null): string {
  try {
    return generateKeyBetween(null, first);
  } catch {
    throw new TxError("invalid", `the project's first sort key ${JSON.stringify(first)} is not valid; move that issue to fix it`);
  }
}

async function createIssue(
  tx: Tx,
  workspaceId: string,
  actorId: string,
  agent: boolean,
  id: string,
  projectId: string,
  set: IssuePatch & { title: string; stateId: string },
): Promise<Pending> {
  await checkRefs(tx, workspaceId, projectId, set, agent);
  const added = addedRelations(null, set);
  if (added.size) {
    await lockWorkspace(tx, workspaceId);
    await checkRelations(tx, workspaceId, { id, blockedByIds: set.blockedByIds ?? [], relatedIds: set.relatedIds ?? [], duplicateOfId: set.duplicateOfId ?? null }, added);
  }
  const [p] = await tx
    .update(project)
    .set({ issueCounter: dsql`${project.issueCounter} + 1` })
    .where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
    .returning({ number: project.issueCounter });
  if (!p) throw new TxError("not_found", `no project ${projectId}`);
  // A new issue goes to the top of the column unless the client chose a position.
  const [top] = await tx.select({ k: issue.sortOrder }).from(issue).where(eq(issue.projectId, projectId)).orderBy(asc(issue.sortOrder)).limit(1);
  const [row] = await tx
    .insert(issue)
    .values({
      ...set,
      id,
      workspaceId,
      projectId,
      number: p.number,
      sortOrder: set.sortOrder ?? topKey(top?.k ?? null),
      createdById: actorId,
      completedAt: await completedAt(tx, set.stateId, null, null),
    })
    .returning(issueColumns);
  await tx.insert(document).values({ id, workspaceId, html: "" });
  return { m: "Issue", mid: id, a: "I", d: row as Record<string, unknown> };
}

/** References in a change must stay inside the issue's workspace and project; an agent's move obeys the process rules. */
async function checkRefs(tx: Tx, workspaceId: string, projectId: string, set: IssuePatch, agent: boolean): Promise<void> {
  if (set.stateId) {
    const [s] = await tx
      .select({ name: workflowState.name, onlyPeople: workflowState.onlyPeople })
      .from(workflowState)
      .where(and(eq(workflowState.id, set.stateId), eq(workflowState.projectId, projectId)));
    if (!s) throw new TxError("bad_ref", "state is not in the issue's project");
    const denied = agent ? deniedState("agent", s) : null;
    if (denied) throw new TxError("forbidden", denied);
  }
  if (set.labelIds?.length) {
    // Workspace labels (no project) or the issue's own project's labels.
    const found = await tx
      .select({ id: label.id })
      .from(label)
      .where(and(eq(label.workspaceId, workspaceId), or(isNull(label.projectId), eq(label.projectId, projectId)), inArray(label.id, set.labelIds)));
    if (found.length !== new Set(set.labelIds).size) throw new TxError("bad_ref", "label is not in the issue's project or workspace");
  }
  const people = [...(set.assigneeIds ?? []), ...(set.delegateId ? [set.delegateId] : [])];
  if (people.length) {
    const found = await tx.select({ id: member.userId }).from(member).where(and(eq(member.workspaceId, workspaceId), inArray(member.userId, people)));
    if (found.length !== new Set(people).size) throw new TxError("bad_ref", "assignee is not a workspace member");
  }
  if (set.cycleId) await checkIssueCycle(tx, workspaceId, projectId, set.cycleId);
  if (set.parentId) {
    const [p] = await tx.select({ id: issue.id, deletedAt: issue.deletedAt }).from(issue).where(and(eq(issue.id, set.parentId), eq(issue.workspaceId, workspaceId)));
    if (!p) throw new TxError("bad_ref", "parent is not in the workspace");
    if (p.deletedAt) throw new TxError("bad_ref", "the parent is deleted");
  }
}

type Relations = Pick<Issue, "id" | "blockedByIds" | "relatedIds" | "duplicateOfId">;

/** Issues a change adds to the relation fields (ones already there are not checked again: a blocker deleted later stays). */
function addedRelations(row: Partial<Relations> | null, set: IssuePatch): Set<string> {
  const out = new Set<string>();
  for (const k of ["blockedByIds", "relatedIds"] as const) for (const x of set[k] ?? []) if (!row?.[k]?.includes(x)) out.add(x);
  if (set.duplicateOfId && set.duplicateOfId !== row?.duplicateOfId) out.add(set.duplicateOfId);
  return out;
}

/**
 * A pair of issues has one relation at most, whichever end stores it: A blocked by B and B blocked by A, or A related to
 * B and B duplicating A, would read as two answers to one question. The added issues must be live issues of the workspace,
 * and not the issue itself.
 */
async function checkRelations(tx: Tx, workspaceId: string, next: Relations, added: Set<string>): Promise<void> {
  if (added.has(next.id)) throw new TxError("bad_ref", "an issue cannot be related to itself");
  const own = [...next.blockedByIds, ...next.relatedIds, ...(next.duplicateOfId ? [next.duplicateOfId] : [])];
  if (new Set(own).size !== own.length) throw new TxError("bad_ref", "two issues have one relation at most");
  const ids = [...added];
  const others = await tx
    .select({ id: issue.id, deletedAt: issue.deletedAt, blockedByIds: issue.blockedByIds, relatedIds: issue.relatedIds, duplicateOfId: issue.duplicateOfId })
    .from(issue)
    .where(and(eq(issue.workspaceId, workspaceId), inArray(issue.id, ids)));
  if (others.length !== ids.length) throw new TxError("bad_ref", "related issue is not in the workspace");
  for (const o of others) {
    if (o.deletedAt) throw new TxError("bad_ref", "the related issue is deleted");
    if (o.blockedByIds.includes(next.id) || o.relatedIds.includes(next.id) || o.duplicateOfId === next.id)
      throw new TxError("bad_ref", "the issues are related already, the other way round");
  }
}

/** A parent must not be the issue itself or one of its sub-issues, at any depth: the tree stays a tree. */
async function checkParent(tx: Tx, id: string, parentId: string): Promise<void> {
  if (parentId === id) throw new TxError("bad_ref", "an issue cannot be its own parent");
  const r = (await tx.execute(dsql`
    with recursive up(id, parent_id, depth) as (
      select id, parent_id, 0 from issue where id = ${parentId}
      union all
      select i.id, i.parent_id, up.depth + 1 from issue i join up on i.id = up.parent_id where up.depth < 100
    )
    select id from up where id = ${id} limit 1`)) as unknown as { id: string }[];
  if (r.length) throw new TxError("bad_ref", "the parent is one of the issue's sub-issues");
}

export async function roleOf(tx: Tx, workspaceId: string, userId: string) {
  const [m] = await tx.select({ role: member.role }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, userId)));
  return isRole(m?.role) ? m.role : null;
}

/**
 * Completion time for an issue entering `stateId` from `fromStateId` (null for a new issue): set when it closes, cleared
 * when it reopens, kept as it is when it goes from one closed state to another, null included. An issue imported
 * closed without a time stays without one: a move or a Cancelled → Done does not close it again today.
 */
async function completedAt(tx: Tx, stateId: string, fromStateId: string | null, current: string | null): Promise<string | SQL | null> {
  const states = await tx
    .select({ id: workflowState.id, group: workflowState.group })
    .from(workflowState)
    .where(inArray(workflowState.id, fromStateId ? [stateId, fromStateId] : [stateId]));
  const closed = (id: string) => isClosedGroup(states.find((s) => s.id === id)?.group);
  if (!closed(stateId)) return null;
  if (fromStateId && closed(fromStateId)) return current;
  return current ?? dsql`now()`;
}

// ── Comments ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The issue a comment, reaction or description belongs to: in the workspace and not deleted. */
async function issueInWorkspace(tx: Tx, workspaceId: string, issueId: string): Promise<void> {
  const [i] = await tx.select({ deletedAt: issue.deletedAt }).from(issue).where(and(eq(issue.id, issueId), eq(issue.workspaceId, workspaceId)));
  if (!i) throw new TxError("bad_ref", "issue is not in the workspace");
  if (i.deletedAt) throw new TxError("bad_ref", "the issue is deleted");
}

async function liveComment(tx: Tx, workspaceId: string, id: string, lock = false) {
  const q = tx.select().from(comment).where(and(eq(comment.id, id), eq(comment.workspaceId, workspaceId)));
  const [c] = await (lock ? q.for("update") : q);
  return c;
}

async function createComment(tx: Tx, workspaceId: string, actorId: string, id: string, set: CommentCreate, via?: Via): Promise<Pending> {
  await issueInWorkspace(tx, workspaceId, set.issueId);
  if (set.parentId) {
    const p = await liveComment(tx, workspaceId, set.parentId);
    if (!p || p.issueId !== set.issueId) throw new TxError("bad_ref", "the parent comment is not on this issue");
    if (p.parentId) throw new TxError("bad_ref", "replies are one level deep: reply to the thread's first comment");
    if (p.deletedAt) throw new TxError("bad_ref", "the parent comment is deleted");
  }
  const row = await created(
    tx
      .insert(comment)
      .values({ id, workspaceId, issueId: set.issueId, parentId: set.parentId ?? null, authorId: actorId, body: set.body, via: via ?? null })
      .onConflictDoNothing()
      .returning(commentColumns),
    `comment ${id}`,
  );
  return { m: "Comment", mid: id, a: "I", d: { ...row, ...(await newMentions(tx, workspaceId, commentDoc(set.body), null)) } };
}

/** The author's own, not deleted comment, locked for the change. */
async function ownComment(tx: Tx, workspaceId: string, actorId: string, id: string) {
  const c = await liveComment(tx, workspaceId, id, true);
  if (!c) throw new TxError("not_found", `no comment ${id}`);
  if (c.authorId !== actorId) throw new TxError("forbidden", "only the author can change a comment");
  return c;
}

async function editComment(tx: Tx, workspaceId: string, actorId: string, id: string, text: string): Promise<Pending | null> {
  const c = await ownComment(tx, workspaceId, actorId, id);
  if (c.deletedAt) throw new TxError("not_found", "the comment is deleted");
  return writeCommentBody(tx, workspaceId, c, text);
}

/** A comment's new text, whoever changes it: the author's edit, or the server's rewrite of old addresses (rehost.ts). */
export async function writeCommentBody(tx: Tx, workspaceId: string, c: { id: string; issueId: string; body: string }, text: string): Promise<Pending | null> {
  if (c.body === text) return null;
  const [row] = await tx.update(comment).set({ body: text, editedAt: dsql`now()` }).where(eq(comment.id, c.id)).returning({ editedAt: comment.editedAt });
  await scrubCommentText(tx, workspaceId, c.id);
  const mentions = await newMentions(tx, workspaceId, commentDoc(text), commentDoc(c.body));
  return { m: "Comment", mid: c.id, a: "U", d: { issueId: c.issueId, body: text, editedAt: row!.editedAt, ...mentions } };
}

/** A tombstone, not a removal: replies keep their thread. The text is gone from the row and from the log. */
async function deleteComment(tx: Tx, workspaceId: string, actorId: string, id: string): Promise<Pending | null> {
  const c = await ownComment(tx, workspaceId, actorId, id);
  if (c.deletedAt) return null;
  const [row] = await tx.update(comment).set({ body: "", deletedAt: dsql`now()` }).where(eq(comment.id, id)).returning({ deletedAt: comment.deletedAt });
  await scrubCommentText(tx, workspaceId, id);
  return { m: "Comment", mid: id, a: "U", d: { issueId: c.issueId, body: "", deletedAt: row!.deletedAt } };
}

/**
 * The comment's earlier actions forget its text, as a description's do (updateDocument): an edit or a deletion leaves one
 * copy in the log, the new action's, so catch-up neither sends the old words to members who joined later nor carries
 * every version of a 64 KB comment. Edits no longer store the old text in `prev`; rows written before that lose it here.
 */
const scrubCommentText = (tx: Tx, workspaceId: string, id: string) => forgetText(tx, workspaceId, dsql`values ('Comment', ${id}::uuid)`);

// ── Descriptions ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The whole description replaces the stored one. The action carries the new document so open windows show it at once;
 * older actions of the same document drop their copy in the same transaction, so the log holds one copy per document
 * however often it is saved. The issue's updatedAt moves too (the list sorts by it); the Document action carries it and
 * clients apply it to the issue.
 *
 * A save that says which text it was edited from (`base`, a transaction) is refused if the text has moved on: two people
 * editing at once would otherwise lose one's text without a word. The action carries its transaction as `tx`, so the next
 * save can name it. A save with no `base` (the agent API) replaces what is there. Until Yjs merges texts, the refused
 * person keeps theirs in the refusal (client.ts, lastRejection).
 */
export async function updateDocument(tx: Tx, workspaceId: string, txId: string, op: Extract<Op, { m: "Document" }>): Promise<Pending | null> {
  const { id, base } = op;
  const raw = op.set.doc;
  let doc: DocNode;
  try {
    doc = validateDoc(raw);
  } catch (e) {
    if (e instanceof DocError) throw new TxError("invalid", e.message);
    throw e;
  }
  const [row] = await tx.select({ doc: document.doc }).from(document).where(and(eq(document.id, id), eq(document.workspaceId, workspaceId))).for("update");
  if (!row) await issueInWorkspace(tx, workspaceId, id); // an issue without a row yet gets one below
  else if (sameDoc(row.doc as DocNode | null, doc)) return null;
  if (base !== undefined) {
    const [last] = await tx.select({ id: syncAction.id, tx: syncAction.txId }).from(syncAction).where(and(eq(syncAction.workspaceId, workspaceId), eq(syncAction.modelId, id), eq(syncAction.model, "Document"))).orderBy(desc(syncAction.id)).limit(1);
    if ((last?.tx ?? null) !== base) {
      // A save of the same text writes no action, and the next one names it: no conflict if the text has stood since.
      const [named] = base ? await tx.select({ s: appliedTx.lastSyncId }).from(appliedTx).where(and(eq(appliedTx.txId, base), eq(appliedTx.workspaceId, workspaceId))) : [];
      if (!named || named.s < (last?.id ?? 0)) throw new TxError("conflict", "someone else changed the description meanwhile");
    }
  }
  const [after] = await tx
    .insert(document)
    .values({ id, workspaceId, html: "", doc: doc as DocJSON })
    .onConflictDoUpdate({ target: document.id, set: { doc: doc as DocJSON, updatedAt: dsql`now()` } })
    .returning({ updatedAt: document.updatedAt });
  await tx.update(issue).set({ updatedAt: after!.updatedAt }).where(eq(issue.id, id));
  await forgetText(tx, workspaceId, dsql`values ('Document', ${id}::uuid)`);
  const mentions = await newMentions(tx, workspaceId, doc, (row?.doc as DocNode | null | undefined) ?? null);
  return { m: "Document", mid: id, a: "U", d: { issueId: id, doc, updatedAt: after!.updatedAt, tx: txId, ...mentions } };
}

// ── Mentions ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Most people one save can newly mention: a notification each, so a pasted roster does not page everyone. */
const MENTIONS_MAX = 50;

/** A comment's Markdown as a document, parsed only when it has a mention in it at all. */
const commentDoc = (body: string): DocNode | null => (body.includes(MENTION_SCHEME) ? fromMarkdown(body) : null);

/**
 * `{ mentionIds }` for the action: members of the workspace the new text mentions and the old one did not (PLNR-27).
 * The inbox reads them off the log (protocol/inbox.ts) and never the text, which the log forgets on the next save.
 * Mentions of people who are not members stay in the text and notify nobody.
 */
async function newMentions(tx: Tx, workspaceId: string, after: DocNode | null, before: DocNode | null): Promise<{ mentionIds?: string[] }> {
  if (!after) return {};
  const had = new Set(before ? mentionIds(before) : []);
  // At most what a document can hold (DOC_JSON_MAX), and only ids: the lookup is one indexed query.
  const ids = mentionIds(after).filter((id) => !had.has(id));
  if (!ids.length) return {};
  const found = await tx.select({ id: member.userId }).from(member).where(and(eq(member.workspaceId, workspaceId), inArray(member.userId, ids)));
  const ok = new Set(found.map((r) => r.id));
  // Members first, then the cap: ids of nobody in front cannot push a member out.
  const mentioned = ids.filter((id) => ok.has(id)).slice(0, MENTIONS_MAX);
  return mentioned.length ? { mentionIds: mentioned } : {};
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The stored fields of a link change (already cleaned by opSchema): the kind follows the address. */
const linkFields = (set: AttachmentPatch): AttachmentPatch & { kind?: string } => (set.url === undefined ? set : { ...set, kind: readLink(set.url).kind });

/** A new attachment row and its I action; an id that exists is a conflict. */
async function insertAttachment(tx: Tx, values: typeof attachment.$inferInsert): Promise<Pending> {
  const row = await created(tx.insert(attachment).values(values).onConflictDoNothing().returning(attachmentColumns), `attachment ${values.id}`);
  return { m: "Attachment", mid: values.id!, a: "I", d: row as Record<string, unknown> };
}

async function addLink(tx: Tx, workspaceId: string, actorId: string, id: string, set: Exclude<AttachmentCreate, FileCreate>): Promise<Pending> {
  await issueInWorkspace(tx, workspaceId, set.issueId);
  const f = linkFields(set);
  return insertAttachment(tx, { id, workspaceId, issueId: set.issueId, kind: f.kind!, url: f.url!, title: f.title ?? "", createdById: actorId });
}

/**
 * A file on an issue (PLNR-50): the blob must be the workspace's (uploaded through PUT /files first); its size and type
 * come from the blob row, not from the client. The same file may be on an issue twice under two names.
 */
async function addFile(tx: Tx, workspaceId: string, actorId: string, id: string, set: FileCreate): Promise<Pending> {
  await issueInWorkspace(tx, workspaceId, set.issueId);
  const [b] = await tx.select({ size: blob.size, mime: blob.mime, slug: workspace.slug }).from(blob).innerJoin(workspace, eq(workspace.id, blob.workspaceId)).where(and(eq(blob.workspaceId, workspaceId), eq(blob.sha256, set.sha256)));
  if (!b) throw new TxError("bad_ref", `no file ${set.sha256} in this workspace: upload it first (PUT /files/<workspace>/<sha256>)`);
  const [{ n }] = (await tx.select({ n: dsql<number>`count(*)::int` }).from(attachment).where(and(eq(attachment.issueId, set.issueId), eq(attachment.kind, "file")))) as [{ n: number }];
  if (n >= FILES_PER_ISSUE_MAX) throw new TxError("invalid", `an issue has at most ${FILES_PER_ISSUE_MAX} files`);
  const url = filePath(b.slug, set.sha256);
  return insertAttachment(tx, { id, workspaceId, issueId: set.issueId, kind: "file", url, title: set.title, sha256: set.sha256, size: b.size, mime: b.mime, createdById: actorId });
}

export async function editLink(tx: Tx, workspaceId: string, id: string, set: AttachmentPatch): Promise<Pending | null> {
  const row = await lockOwned(tx, attachment, workspaceId, id, "attachment");
  await issueInWorkspace(tx, workspaceId, row.issueId);
  // A file's address is its content: only its name changes, and a file is never nameless.
  if (row.kind === "file" && set.url !== undefined) throw new TxError("invalid", "a file's address cannot change; upload another file");
  if (row.kind === "file" && set.title === "") throw new TxError("invalid", "a file needs a name");
  const f = linkFields(set);
  const { changed, prev } = diff(row, f);
  if (!Object.keys(changed).length) return null;
  await tx.update(attachment).set(changed).where(eq(attachment.id, id));
  return { m: "Attachment", mid: id, a: "U", d: changed, p: prev };
}

/** Removing a link that is already gone is a no-op, as for reactions. */
export async function removeLink(tx: Tx, workspaceId: string, id: string): Promise<Pending | null> {
  const [row] = await tx.select().from(attachment).where(and(eq(attachment.id, id), eq(attachment.workspaceId, workspaceId))).for("update");
  if (!row) return null;
  await tx.delete(attachment).where(eq(attachment.id, id));
  return { m: "Attachment", mid: id, a: "D", d: { issueId: row.issueId } };
}

// ── Reactions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Adding a reaction the user already has is a no-op, so two tabs toggling at once do not fail. */
async function addReaction(tx: Tx, workspaceId: string, actorId: string, id: string, set: ReactionCreate): Promise<Pending | null> {
  await issueInWorkspace(tx, workspaceId, set.issueId);
  if (set.commentId) {
    const c = await liveComment(tx, workspaceId, set.commentId);
    if (!c || c.issueId !== set.issueId) throw new TxError("bad_ref", "the comment is not on this issue");
    if (c.deletedAt) throw new TxError("bad_ref", "the comment is deleted");
  }
  const [row] = await tx
    .insert(reaction)
    .values({ id, workspaceId, issueId: set.issueId, commentId: set.commentId ?? null, userId: actorId, emoji: set.emoji })
    .onConflictDoNothing()
    .returning(reactionColumns);
  return row ? { m: "Reaction", mid: id, a: "I", d: row as Record<string, unknown> } : null;
}

/** Removing a reaction that is already gone is a no-op for the same reason. */
async function removeReaction(tx: Tx, workspaceId: string, actorId: string, id: string): Promise<Pending | null> {
  const [r] = await tx.select().from(reaction).where(and(eq(reaction.id, id), eq(reaction.workspaceId, workspaceId))).for("update");
  if (!r) return null;
  if (r.userId !== actorId) throw new TxError("forbidden", "only the user who reacted can remove the reaction");
  await tx.delete(reaction).where(eq(reaction.id, id));
  return { m: "Reaction", mid: id, a: "D", d: { issueId: r.issueId } };
}
