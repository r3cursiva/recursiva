// /my and /inbox in the person's chat (PLNR-205): a page of five, with buttons that turn the page and, in the inbox, mark
// lines read. Both read what the browser shows: My work's groups (@rsva/protocol, my-work.ts) over the workspace's
// issues and the inbox's lines (api-inbox.ts) over the log, across every workspace the person reads.
//
// A button carries no state but its page and the issue: the message is drawn again from the database each time. "Read"
// marks only what the message could have shown: events up to the time it was drawn (Telegram's `date`, or `edit_date`
// once a button redrew it), so a notification that arrived meanwhile stays unread.
import { blankMark, markRead, type InboxGroup } from "@rsva/protocol";
import { GROUPS, sortGroup, toTriage, type GroupId, type WorkItem } from "@rsva/protocol/my-work";
import { issuePath } from "@rsva/schema/models";
import { plural } from "@rsva/schema/util";
import { linesOf, writeLineMarks } from "../api-inbox.ts";
import { keyOf, loadIssues, type Names } from "../api-names.ts";
import { PUBLIC_ORIGIN } from "../auth/mail.ts";
import { headline } from "../notify/words.ts";
import { html, type Part } from "../mail/template.ts";
import { workIn } from "../my-work.ts";
import { INBOX_COST } from "../sync/inbox.ts";
import { reads } from "../sync/limits.ts";
import type { Buttons } from "./api.ts";
import { workspacesOf } from "../auth/access.ts";

/** Lines on one page of /my and /inbox. */
export const PAGE = 5;

/** A page as the bot sends or redraws it. */
export interface Page {
  text: string;
  buttons: Buttons;
}

/**
 * /my reads every live issue of a workspace besides its inbox: counted as a few inbox answers, so the read budget allows
 * about sixteen pages a minute in one workspace.
 */
export const MY_COST = 4 * INBOX_COST;

/** The person's inbox and names in each workspace; null when their read budget is spent (the API's 429). */
async function inboxes(userId: string, cost = INBOX_COST) {
  const list = await workspacesOf(userId, "read");
  if (!reads.take(userId, cost * Math.max(1, list.length))) return null;
  return Promise.all(list.map(async (w) => ({ ...w, ...(await linesOf(w.id, userId)) })));
}
type Inbox = NonNullable<Awaited<ReturnType<typeof inboxes>>>[number];

export const BUSY = "Too many requests. Try again in a minute.";
const link = (slug: string, key: string) => `${PUBLIC_ORIGIN ?? ""}${issuePath(slug, key)}`;
export const title = (key: string, slug: string, text: string) => html`<a href="${link(slug, key)}">${text}</a>`;
export const joined = (parts: Part[]) => html`${parts.map((p, i) => [i ? "\n" : "", p])}`.value;

/** " · 6–10 of 23" when there is more than a page. */
export const range = (offset: number, shown: number, total: number) => (total > PAGE ? ` · ${offset + 1}–${offset + shown} of ${total}` : "");

/** Previous and More for a list of `total` at `offset`; `data` makes a button's data from the offset it goes to. */
export function turns(offset: number, total: number, data: (offset: number) => string): Buttons[number] {
  return [
    ...(offset > 0 ? [{ text: "Previous", data: data(Math.max(0, offset - PAGE)) }] : []),
    ...(offset + PAGE < total ? [{ text: "More", data: data(offset + PAGE) }] : []),
  ];
}

/** A page's offset kept inside the list: a button pressed after the list got shorter shows its last page. */
export const pageAt = (offset: number, total: number) => {
  const last = Math.max(0, Math.ceil(total / PAGE) - 1) * PAGE;
  return Number.isSafeInteger(offset) && offset > 0 ? Math.min(offset - (offset % PAGE), last) : 0;
};

// ── /my ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * /my: My work's items in its groups' order, five from `offset`. Waiting on you is what asks the person, by the one
 * rule (RSVA-572); the proposals to triage are a line with their number, not rows: there can be hundreds, and the app
 * is where they are sorted.
 */
export async function myPage(userId: string, offset: number, now = Date.now()): Promise<Page> {
  const all = await inboxes(userId, MY_COST);
  if (!all) return { text: BUSY, buttons: [] };
  const names = new Map<string, Names>(all.map((w) => [w.slug, w.n]));
  const items: WorkItem[] = [];
  for (const w of all) items.push(...workIn(userId, w, await loadIssues(w.id), now));
  const triage = items.filter(toTriage).length;
  const pile: Part[] = triage ? [html`${plural(triage, "proposal")} to triage in the app`] : [];
  const sorted = GROUPS.flatMap((g) => sortGroup(g.id, items.filter((x) => x.group === g.id && !toTriage(x)), now));
  if (!sorted.length) return { text: joined([html`<b>My work</b>`, html`Nothing waits on you, and nothing is assigned to you.`, ...pile]), buttons: [] };
  const at = pageAt(offset, sorted.length);
  const shown = sorted.slice(at, at + PAGE);
  const lines: Part[] = [html`<b>My work</b>${range(at, shown.length, sorted.length)}`, ...pile];
  let group: GroupId | null = null;
  for (const x of shown) {
    if (x.group !== group) lines.push(html`\n<b>${GROUPS.find((g) => g.id === x.group)!.name}</b>`);
    group = x.group;
    const n = names.get(x.ws)!;
    const key = keyOf(n, x.issue);
    const state = n.states.get(x.issue.stateId)?.name ?? "";
    lines.push(html`<code>${key}</code> · ${state}`, title(key, x.ws, x.issue.title));
  }
  const buttons = turns(at, sorted.length, (o) => `my:${o}`);
  return { text: joined(lines), buttons: buttons.length ? [buttons] : [] };
}

// ── /inbox ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line {
  w: Inbox;
  g: InboxGroup;
  key: string;
}

/**
 * The inbox's tabs as the browser has them (inbox.tsx): Unread first, `prefix` starts a tab button's data. There was a
 * third, Waiting on you (lines that offer a move); it went with the browser's (RSVA-571, RSVA-572): what waits is /my.
 */
const TABS = [
  { id: "unread", name: "Unread", prefix: "i" },
  { id: "all", name: "All", prefix: "ia" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** The tab a button's data prefix (`i`, `ia`) opens; `iw`, on a message drawn before its tab went, opens All; undefined for another button. */
export const tabOf = (prefix: string | undefined): TabId | undefined => (prefix === "iw" ? "all" : TABS.find((t) => t.prefix === prefix)?.id);

/** Lines that are not snoozed, newest first across workspaces; those of a tab only. */
function tabLines(all: Inbox[], tab: TabId): Line[] {
  return all
    .flatMap((w) => w.groups.filter((g) => !g.snoozedUntil && (tab !== "unread" || g.unread)).map((g) => ({ w, g, key: w.key(g) })))
    .sort((a, b) => Date.parse(b.g.latest.at) - Date.parse(a.g.latest.at));
}

function inboxText(lines: Line[], at: number, tab: TabId = "unread"): Page {
  const current = TABS.find((t) => t.id === tab)!;
  const tabs = TABS.map((t) => ({ text: t.id === tab ? `• ${t.name}` : t.name, data: `${t.prefix}:0` }));
  const shown = lines.slice(at, at + PAGE);
  const count = tab === "unread" ? `${lines.length} unread` : `${current.name} · ${lines.length}`;
  const parts: Part[] = [html`<b>Inbox</b> · ${count}${lines.length > PAGE ? ` · ${at + 1}–${at + shown.length}` : ""}`];
  if (!lines.length) return { text: html`<b>Inbox</b> · ${current.name}\n${tab === "unread" ? "Nothing unread." : "The inbox is empty."}`.value, buttons: [tabs] };
  for (const { w, g, key } of shown) {
    const e = g.latest;
    const actor = w.n.users.get(e.by);
    const kind = e.kind;
    const { title: what } = headline({ kind, byAgent: kind === "review" && actor?.kind === "agent", actor: actor?.name ?? "Someone", issueKey: key, stateName: (e.stateId && w.n.states.get(e.stateId)?.name) || "" });
    parts.push(html`\n<b>${what}</b>`, title(key, w.slug, w.issues.get(g.issueId)!.title));
  }
  const rows: Buttons = [];
  if (tab === "unread") {
    const marks = shown.map(({ g, key }) => ({ text: `Read ${key}`, data: `r:${at}:${g.issueId}` }));
    for (let i = 0; i < marks.length; i += 2) rows.push(marks.slice(i, i + 2));
  }
  const turn = turns(at, lines.length, (o) => `${current.prefix}:${o}`);
  const more = [...(tab === "unread" ? [{ text: "Mark all read", data: "ra" }] : []), ...turn];
  rows.push(tabs);
  if (more.length) rows.push(more);
  return { text: joined(parts), buttons: rows };
}

/** /inbox: the lines of a tab, five from `offset`. */
export async function inboxPage(userId: string, offset: number, tab: TabId = "unread"): Promise<Page> {
  const all = await inboxes(userId);
  if (!all) return { text: BUSY, buttons: [] };
  const lines = tabLines(all, tab);
  return inboxText(lines, pageAt(offset, lines.length), tab);
}

/**
 * "Read PLNR-3" (`issueId`) or "Mark all read" (none): marks the line, or every unread one, read up to `drawnAt`, then
 * the page again. A line whose events all came after `drawnAt` was not on the message and stays as it is.
 */
export async function markInbox(userId: string, issueId: string | null, offset: number, drawnAt: Date): Promise<{ page: Page; marked: number }> {
  const all = await inboxes(userId);
  if (!all) return { page: { text: BUSY, buttons: [] }, marked: 0 };
  const lines = tabLines(all, "unread");
  // Telegram's times are whole seconds: everything within the second the message was drawn in was on it.
  const cut = Math.floor(drawnAt.getTime() / 1000) * 1000 + 999;
  const before = (e: { at: string }) => Date.parse(e.at) <= cut;
  const marked = new Set<string>();
  for (const w of all) {
    const next = lines
      .filter((l) => l.w === w && (issueId === null || l.g.issueId === issueId))
      .flatMap(({ g }) => {
        const upTo = g.events.findLast(before);
        if (!upTo) return [];
        marked.add(g.issueId);
        return [markRead(w.marks.get(g.issueId) ?? blankMark(g.issueId), upTo.id)];
      });
    if (next.length) await writeLineMarks(w.id, userId, next);
  }
  // What stays unread: a marked line only if something came after the cut.
  const left = lines.filter((l) => !marked.has(l.g.issueId) || !l.g.events.every(before));
  return { page: inboxText(left, pageAt(offset, left.length)), marked: marked.size };
}
