// /triage in the person's chat (PLNR-363): the open issues labelled `proposed` in projects the person may write in, oldest
// first, one card at a time with Cancel, Skip and Open. Approving is not done here (owner 2026-11-06): it takes the whole
// description, and the card shows its first lines. Open leads to the issue in recursiva, where it is read and approved;
// Cancel declines it to the project's Cancelled as the person. Under the excerpt, "Similar:" lists up to three other open
// issues whose titles look like the proposal's, so a duplicate is cancelled with its original at hand (PLNR-295).
//
// A button carries only its action and the issue ("t:c:<id>"): the queue is read again at each press and the next card is
// the first one after the pressed issue in (created, id) order. A project asked for (`/triage #infra`) rides in the
// header line, "Triage · #INFRA · 3 of 12", and is read back from the message being redrawn, as /find reads its query.
import { isProposalLabel } from "@rsva/policy";
import { isOpenIssue, type Issue } from "@rsva/schema/models";
import { toMarkdown } from "@rsva/editor/markdown";
import type { DocNode } from "@rsva/editor/doc";
import { eq } from "drizzle-orm";
import { loadIssues, loadNames, keyOf, similarTo } from "../api-names.ts";
import { db, schema } from "../db.ts";
import { html } from "../mail/template.ts";
import { reads } from "../sync/limits.ts";
import { card, findIssue, writeChange, type Found } from "./card.ts";
import { offeredState, projectToken, writable } from "./fields.ts";
import { BUSY, MY_COST, type Page } from "./lists.ts";

/** Lines of the description shown, and its length. */
const LINES = 4;
const EXCERPT = 400;
const GONE = "You cannot see this issue any more.";
const DONE = "Nothing left to triage.";
const APPROVE = "Approving is done in recursiva: open the issue.";

/** The project a /triage message was drawn for ("INFRA"), from its first line; null when none was asked for. */
export function projectOf(text: string | undefined): string | null {
  return /^Triage(?: · #(\S+))? · \d+ of \d+$/.exec((text ?? "").split("\n")[0]!)?.[1] ?? null;
}

const order = (a: Issue, b: Issue) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1);

/** The proposals the person may decide, oldest first; `none` is the reason there are none or the project is wrong. */
async function queue(userId: string, project: string | null): Promise<{ items: Found[] } | { none: string }> {
  const spaces = await writable(userId);
  if (!reads.take(userId, MY_COST * Math.max(1, spaces.length))) return { none: BUSY };
  const items: Found[] = [];
  let labelled = false;
  let known = !project;
  for (const w of spaces) {
    const n = await loadNames(w.workspaceId);
    const p = project ? n.byKey.get(project.toUpperCase()) : undefined;
    if (p) known = true;
    if (project && !p) continue;
    const proposals = new Set([...n.labels.values()].filter((l) => isProposalLabel(l.name) && (!p || l.projectId === null || l.projectId === p.id)).map((l) => l.id));
    if (proposals.size) labelled = true;
    for (const i of await loadIssues(w.workspaceId, p?.id)) {
      const live = n.projects.get(i.projectId);
      if (live && !live.archivedAt && i.labelIds.some((l) => proposals.has(l)) && isOpenIssue(i, n.states.get(i.stateId)?.group)) items.push({ ...w, n, issue: i, key: keyOf(n, i) });
    }
  }
  if (!known) return { none: `No project ${project} that you can write in.` };
  if (!labelled) return { none: "There is no proposed label in your projects." };
  return { items: items.sort((a, b) => order(a.issue, b.issue)) };
}

/** The first lines of the issue's description. */
async function excerpt(f: Found): Promise<string> {
  const [row] = await db.select({ doc: schema.document.doc }).from(schema.document).where(eq(schema.document.id, f.issue.id));
  const text = (row?.doc ? toMarkdown(row.doc as DocNode) : "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, LINES).join("\n");
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text;
}

/** Open issues of the workspace that look like the proposal, at most this many on its card (PLNR-295). */
const SIMILAR = 3;

/** "Similar: PLNR-12 Title, PLNR-9 Title", or nothing: what the proposal may duplicate, scored as the API and the panel score it. */
async function similar(f: Found): Promise<string> {
  const { similar: found } = similarTo(f.n, await loadIssues(f.workspaceId), f.issue.title, { limit: SIMILAR, exclude: f.issue.id, projectId: f.issue.projectId });
  return found.length ? html`Similar: ${found.flatMap((m, n) => [n ? ", " : "", m.key, " ", m.title])}`.value : "";
}

/** The card at `at` of the queue, headed with its place; `note` ends it, `undo` adds the Undo button. */
async function draw(items: Found[], at: number, project: string | null, note?: string, undo?: string): Promise<Page> {
  const f = items[at]!;
  const c = await card(f);
  const open = c.buttons.flat().find((b) => "url" in b);
  const body = await excerpt(f);
  const alike = await similar(f);
  const by = f.issue.createdById ? (f.n.users.get(f.issue.createdById)?.name ?? "someone") : "someone";
  const head = html`<b>Triage</b>${project ? html` · #${project}` : ""} · ${at + 1} of ${items.length}`.value;
  const text = [
    head,
    c.text,
    body ? html`<blockquote expandable>${body}</blockquote>`.value : "",
    alike,
    html`Proposed by ${by} on ${f.issue.createdAt.slice(0, 10)}`.value,
    note ? html`<i>${note}</i>`.value : "",
  ]
    .filter(Boolean)
    .join("\n");
  const id = f.issue.id;
  return {
    text,
    buttons: [
      ...(undo ? [[{ text: "Undo", data: `u:${undo}` }]] : []),
      [{ text: "Cancel", data: `t:c:${id}` }, { text: "Skip", data: `t:s:${id}` }, ...(open ? [open] : [])],
    ],
  };
}

const finished = (note: string): Page => ({ text: html`${note}`.value, buttons: [] });

/** /triage, with `#project` or `project:KEY` to narrow it: the oldest proposal. */
export async function triagePage(userId: string, args: string): Promise<Page> {
  const asked = projectToken(args) ?? null;
  const q = await queue(userId, asked);
  if ("none" in q) return finished(q.none);
  if (!q.items.length) return finished(DONE);
  return draw(q.items, 0, asked ? q.items[0]!.n.byKey.get(asked.toUpperCase())!.key : null);
}

/** The first card after `issue` in the queue, or the end. */
async function next(items: Found[], issue: Issue, project: string | null, note: string, undo?: string): Promise<Page> {
  const at = items.findIndex((x) => x.issue.id !== issue.id && order(x.issue, issue) > 0);
  return at < 0 ? { text: undo ? `${DONE} ${note}` : DONE, buttons: undo ? [[{ text: "Undo", data: `u:${undo}` }]] : [] } : draw(items, at, project, undefined, undo);
}

/** A pressed `t:c:` or `t:s:` button: `text` is the message's, which names the project asked for. An Approve (`t:a:`)
 * from a card drawn before 2026-11-06 is refused. */
export async function pressTriage(userId: string, data: string, text: string | undefined): Promise<{ page: Page; toast?: string }> {
  const [, action, id] = data.split(":");
  if (action !== "c" && action !== "s") return { page: finished(APPROVE), toast: APPROVE };
  const project = projectOf(text);
  const f = id ? await findIssue(userId, id) : null;
  const q = await queue(userId, project);
  if ("none" in q) return { page: finished(q.none), toast: q.none };
  if (!f) return { page: finished(GONE), toast: GONE };
  const queued = q.items.some((x) => x.issue.id === f.issue.id);
  if (action === "s") return { page: await next(q.items, f.issue, project, ""), toast: "Skipped" };
  if (!queued) return { page: await next(q.items, f.issue, project, ""), toast: `${f.key} is not proposed any more` };
  const states = [...f.n.states.values()].filter((s) => s.projectId === f.issue.projectId);
  const set = { stateId: states.find((s) => s.group === "cancelled" && offeredState(s))?.id };
  const at = q.items.findIndex((x) => x.issue.id === f.issue.id);
  if (!set.stateId) return { page: await draw(q.items, at, project, "The project has no such state."), toast: "The project has no such state" };
  const w = await writeChange(userId, f, set);
  if ("why" in w) return { page: await draw(q.items, at, project, w.why), toast: w.why };
  const said = `${f.key} cancelled`;
  return { page: await next(q.items.filter((x) => x.issue.id !== f.issue.id), f.issue, project, `${said}.`, "token" in w ? w.token : undefined), toast: said };
}
