// The issue card (PLNR-360): what the bot answers an issue's key with, /new with, and "⋯" under a notification
// turns into. Its buttons change the state, the priority and the assignees in place: a picker redraws the same message's
// buttons with the choices, a choice applies and draws the card again with Undo for ten minutes (undo.ts).
//
// A button holds 64 bytes, so it names an issue by id and a state or a person by the last ten characters of theirs: the
// random end of a UUIDv7 (its start is a time, shared by rows made together). Nothing is trusted from the button but the
// choice: the chat's owner, their role and the issue are read again at the press, and the write goes as the person
// through telegram/write.ts. No state or label only people set is offered (Todo, Approved, `proposed`): approving is
// not done from Telegram (owner 2026-11-05, 2026-11-06), and No labels leaves those labels on.
import { can, isProposalLabel, type Role } from "@rsva/policy";
import type { Op } from "@rsva/protocol";
import { issueKey, issuePath, parseIssueKey, PRIORITIES, priorityName, type Issue } from "@rsva/schema/models";
import { and, desc, eq, isNull } from "drizzle-orm";
import { keyOf, loadNames, type Names } from "../api-names.ts";
import { workspacesOf } from "../auth/access.ts";
import { PUBLIC_ORIGIN } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { html, type Part } from "../mail/template.ts";
import { COLUMNS } from "../sync/columns.ts";
import { plain } from "./answer.ts";
import type { Buttons } from "./api.ts";
import { offeredLabel, offeredState } from "./fields.ts";
import type { Page } from "./lists.ts";
import { keepUndo, same, takeUndo } from "./undo.ts";
import { writeAs } from "./write.ts";

const { issue, comment } = schema;

/** An issue the person reads, with what its card needs. */
export interface Found {
  workspaceId: string;
  slug: string;
  role: Role;
  n: Names;
  issue: Issue;
  key: string;
}

const GONE = "You cannot see this issue any more.";
const tail = (id: string) => id.slice(-10);

/** An issue by key ("plnr-12" too) or id, in a workspace the person reads; null when there is none they may see. */
export async function findIssue(userId: string, ref: string): Promise<Found | null> {
  const k = parseIssueKey(ref);
  for (const w of await workspacesOf(userId, "read")) {
    const n = await loadNames(w.id);
    const p = k ? n.byKey.get(k.projectKey) : null;
    if (k && !p) continue;
    const where = p ? and(eq(issue.projectId, p.id), eq(issue.number, k!.number)) : and(eq(issue.workspaceId, w.id), eq(issue.id, ref));
    const [row] = (await db.select(COLUMNS.Issue).from(issue).where(and(where, isNull(issue.deletedAt)))) as Issue[];
    if (!row) continue;
    // w.role is the role as stored now, and workspacesOf let only readable ones through.
    return { workspaceId: w.id, slug: w.slug, role: w.role, n, issue: row, key: keyOf(n, row) };
  }
  return null;
}

const link = (f: Found) => `${PUBLIC_ORIGIN ?? ""}${issuePath(f.slug, f.key)}`;
const names = (f: Found, ids: string[]) => ids.map((id) => f.n.users.get(id)?.name ?? "someone");

/** The card's text: key, state and priority; the title; who, cycle, labels and dates; the last comment. */
async function cardText(f: Found, note?: string): Promise<string> {
  const i = f.issue;
  const [last] = await db
    .select({ body: comment.body, authorId: comment.authorId })
    .from(comment)
    .where(and(eq(comment.issueId, i.id), isNull(comment.deletedAt)))
    .orderBy(desc(comment.createdAt))
    .limit(1);
  const facts = [
    i.assigneeIds.length ? names(f, i.assigneeIds).join(", ") : "No assignee",
    i.delegateId ? `agent ${f.n.users.get(i.delegateId)?.name ?? ""}` : "",
    i.cycleId ? (f.n.cycles.get(i.cycleId)?.name ?? "") : "",
    i.labelIds.map((id) => f.n.labels.get(id)?.name ?? "").filter(Boolean).join(", "),
    i.dueDate ? `due ${i.dueDate}` : "",
  ].filter(Boolean);
  const body = last?.body.replace(/\s+/g, " ").trim() ?? "";
  // The key leads: a reply to the card finds its issue by it (reply.ts).
  const lines: (string | Part | null)[] = [
    html`<code>${f.key}</code> · ${f.n.states.get(i.stateId)?.name ?? ""} · ${priorityName(i.priority)}`,
    html`<b><a href="${link(f)}">${i.title}</a></b>`,
    facts.join(" · "),
    body ? html`<blockquote>${last!.authorId ? `${f.n.users.get(last!.authorId)?.name ?? "Someone"}: ` : ""}${body.length > 280 ? `${body.slice(0, 279)}…` : body}</blockquote>` : null,
    note ? html`<i>${note}</i>` : null,
  ].filter((l) => l !== null);
  return html`${lines.map((l, k) => [k ? "\n" : "", l])}`.value;
}

/** The card's buttons, with Undo first while there is one. */
function cardButtons(f: Found, undo?: string): Buttons {
  const id = f.issue.id;
  return [
    ...(undo ? [[{ text: "Undo", data: `u:${undo}` }]] : []),
    [
      { text: "State ▾", data: `c:s:${id}` },
      { text: "Priority ▾", data: `c:p:${id}` },
    ],
    [
      { text: "Assignee ▾", data: `c:a:${id}` },
      { text: "Labels ▾", data: `c:l:${id}` },
    ],
    [
      { text: "Snooze 2h", data: `sn:${id}` },
      { text: "Open", url: link(f) },
    ],
  ];
}

/** The card as a page; `note` ends it, `undo` adds the Undo button. */
export async function card(f: Found, note?: string, undo?: string): Promise<Page> {
  return { text: await cardText(f, note), buttons: cardButtons(f, undo) };
}

/** The issue's proposal labels, while it is a proposal: in Backlog with `proposed` on. */
const proposalLabels = (f: Found) =>
  f.n.states.get(f.issue.stateId)?.group === "backlog" ? f.issue.labelIds.filter((id) => isProposalLabel(f.n.labels.get(id)?.name ?? "")) : [];

/**
 * States offered in Telegram: the project's, but not one only people set (Todo, Approved). A proposal stays in Backlog or
 * is cancelled: any other move takes `proposed` off (PLNR-125), and that is approving it.
 */
const offeredStates = (f: Found) => {
  const proposal = proposalLabels(f).length > 0;
  return [...f.n.states.values()].filter((s) => s.projectId === f.issue.projectId && offeredState(s) && (!proposal || s.group === "backlog" || s.group === "cancelled"));
};

/** `per` choices to a row, and Back. */
function rows(choices: { text: string; data: string }[], id: string, per = 2): Buttons {
  const out: Buttons = [];
  for (let k = 0; k < choices.length; k += per) out.push(choices.slice(k, k + per));
  out.push([{ text: "Back", data: `c:x:${id}` }]);
  return out;
}

function picker(f: Found, field: string): Buttons {
  const i = f.issue;
  const mark = (on: boolean, text: string) => (on ? `• ${text}` : text);
  if (field === "s") return rows(offeredStates(f).map((s) => ({ text: mark(s.id === i.stateId, s.name), data: `cs:${tail(s.id)}:${i.id}` })), i.id);
  if (field === "p") return rows(PRIORITIES.map((p) => ({ text: mark(p.code === i.priority, p.name), data: `cp:${p.code}:${i.id}` })), i.id);
  const tick = (on: boolean, text: string) => (on ? `✓ ${text}` : text);
  if (field === "l") return rows([...usableLabels(f).map((l) => ({ text: tick(i.labelIds.includes(l.id), l.name), data: `cl:${tail(l.id)}:${i.id}` })), { text: "No labels", data: `cl:none:${i.id}` }], i.id, 3);
  const people = [...f.n.users.values()].sort((a, b) => Number(b.id === i.createdById) - Number(a.id === i.createdById)).slice(0, 10);
  return rows([...people.map((u) => ({ text: tick(i.assigneeIds.includes(u.id), u.name), data: `ca:${tail(u.id)}:${i.id}` })), { text: "Nobody", data: `ca:none:${i.id}` }], i.id);
}

/** Labels the issue may take or lose here: its project's and the workspace's, not one only people set; thirty at most. */
const usableLabels = (f: Found) => [...f.n.labels.values()].filter((l) => (l.projectId === null || l.projectId === f.issue.projectId) && offeredLabel(l)).slice(0, 30);

/** Writes `set` on the issue as the person and keeps its Undo: the token for its button, or why nothing was written. */
/**
 * An issue update as the person; a list (assignees, labels) names what it was changed from, so the pipeline merges it
 * with what others did meanwhile instead of writing over it.
 */
function update(id: string, set: Record<string, unknown>, from: Record<string, unknown>): Op {
  const base = Object.fromEntries(Object.keys(set).filter((k) => Array.isArray(set[k]) && Array.isArray(from[k])).map((k) => [k, from[k]]));
  return { op: "update", m: "Issue", id, set, ...(Object.keys(base).length ? { base } : {}) } as Op;
}

export async function writeChange(userId: string, f: Found, change: Record<string, unknown>): Promise<{ token: string } | { same: true } | { why: string }> {
  // A move out of Backlog ends a proposal and the pipeline takes `proposed` off; named here, Undo puts it back.
  const to = typeof change.stateId === "string" ? f.n.states.get(change.stateId) : undefined;
  const off = to && to.group !== "backlog" && !("labelIds" in change) ? proposalLabels(f) : [];
  const set = off.length ? { ...change, labelIds: f.issue.labelIds.filter((id) => !off.includes(id)) } : change;
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, (f.issue as unknown as Record<string, unknown>)[k]]));
  if (Object.keys(set).every((k) => same(set[k], before[k]))) return { same: true };
  const w = await writeAs(f.workspaceId, userId, f.role, [update(f.issue.id, set, before)], `change ${f.key}`, `${f.key} was not changed`);
  if (!w.ok) return { why: plain(w.why) };
  return { token: keepUndo({ userId, workspaceId: f.workspaceId, issueId: f.issue.id, before, after: set }) };
}

/** `writeChange` answered with the issue's card again, or why not. */
async function change(userId: string, f: Found, set: Record<string, unknown>, said: string): Promise<{ page: Page; toast: string }> {
  const w = await writeChange(userId, f, set);
  if ("same" in w) return { page: await card(f), toast: "Nothing changed" };
  if ("why" in w) return { page: await card(f), toast: w.why };
  return { page: await card((await findIssue(userId, f.issue.id)) ?? f, undefined, w.token), toast: said };
}

/**
 * A pressed card button: `c:<field>:<issueId>` opens a picker (s, p, a, l) or draws the card (x); `cs:`, `cp:`, `ca:`, `cl:`
 * apply a choice (a person or a label is switched on or off); `u:<token>` undoes. Null when the data is none of these.
 */
export async function pressCard(userId: string, data: string): Promise<{ page: Page; toast?: string } | { gone: string } | null> {
  const [kind, a, b] = data.split(":");
  if (kind === "u") return undo(userId, a ?? "");
  if (!["c", "cs", "cp", "ca", "cl"].includes(kind!) || !a || !b) return null;
  const f = await findIssue(userId, b);
  if (!f) return { gone: GONE };
  const i = f.issue;
  if (kind === "c") return a === "x" ? { page: await card(f) } : { page: { text: await cardText(f), buttons: picker(f, a) } };
  if (!can({ role: f.role }, "issues.write")) return { page: await card(f), toast: `You cannot change ${f.key}` };
  if (kind === "cp") {
    const p = PRIORITIES.find((x) => x.code === Number(a));
    return p ? change(userId, f, { priority: p.code }, `Priority ${p.name}`) : { page: await card(f) };
  }
  if (kind === "cs") {
    const s = offeredStates(f).find((x) => tail(x.id) === a);
    return s ? change(userId, f, { stateId: s.id }, `Moved to ${s.name}`) : { page: await card(f), toast: "That state is not offered here" };
  }
  // A person or a label switched on or off; none clears the list.
  const [field, list, all, gone] =
    kind === "ca" ? (["assigneeIds", i.assigneeIds, [...f.n.users.values()], "Not a member any more"] as const) : (["labelIds", i.labelIds, usableLabels(f), "No such label any more"] as const);
  // No labels keeps the labels only people set: taking `proposed` off is approving.
  if (a === "none") return change(userId, f, { [field]: kind === "ca" ? [] : i.labelIds.filter((id) => f.n.labels.get(id)?.onlyPeople) }, kind === "ca" ? "Unassigned" : "No labels");
  const x = all.find((y) => tail(y.id) === a);
  if (!x) return { page: await card(f), toast: gone };
  const on = list.includes(x.id);
  const said = kind === "ca" ? (on ? `${x.name} unassigned` : `Assigned to ${x.name}`) : on ? `${x.name} removed` : `${x.name} added`;
  return change(userId, f, { [field]: on ? list.filter((y) => y !== x.id) : [...list, x.id] }, said);
}

/** Undo: the fields back as they were, unless one changed since. */
async function undo(userId: string, token: string): Promise<{ page: Page; toast: string } | { gone: string }> {
  const c = takeUndo(token, userId);
  if (!c) return { gone: "Undo is no longer available." };
  const f = await findIssue(userId, c.issueId);
  if (!f) return { gone: GONE };
  const now = f.issue as unknown as Record<string, unknown>;
  if (Object.keys(c.after).some((k) => !same(now[k], c.after[k]))) return { page: await card(f), toast: "Changed since: open the issue" };
  // Back into Todo or Approved is still into it: that state is set in recursiva.
  const was = typeof c.before.stateId === "string" ? f.n.states.get(c.before.stateId) : undefined;
  if (was && !offeredState(was)) return { page: await card(f), toast: `It was ${was.name}: set that in recursiva` };
  const w = await writeAs(f.workspaceId, userId, f.role, [update(f.issue.id, c.before, c.after)], `change ${f.key}`, `${f.key} was not changed`);
  if (!w.ok) return { page: await card(f), toast: plain(w.why) };
  return { page: await card((await findIssue(userId, c.issueId)) ?? f), toast: "Undone" };
}

/** Up to five issue keys when a message is nothing else ("PLNR-12", "PLNR-12 INFRA-3"); null otherwise. */
export function onlyKeys(text: string | undefined): string[] | null {
  const words = (text ?? "").trim().split(/[\s,]+/).filter(Boolean);
  const keys = words.flatMap((w) => parseIssueKey(w) ?? []);
  if (!words.length || words.length > 5 || keys.length < words.length) return null;
  return [...new Set(keys.map((k) => issueKey(k.projectKey, k.number)))];
}

/** The cards for keys sent alone; a key the person cannot see says so. */
export async function cardsFor(userId: string, keys: string[]): Promise<Page[]> {
  return Promise.all(keys.map(async (k) => ((f) => (f ? card(f) : { text: html`No issue ${k} that you can see.`.value, buttons: [] }))(await findIssue(userId, k))));
}
