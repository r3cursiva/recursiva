// What a person or an agent reads: one line per thing, the fewest bytes that say it. An agent pays for every byte of
// its context, so a list is columns, not JSON; --json gives the server's answer. A person at a terminal gets the same
// things in colour (style.ts): the list grouped by state as in the app, lines cut to the window, keys that open the issue.
// Every renderer takes a Style; with PLAIN the text is what it was before colour came in.
//
// Everything here was written by someone else, comments and descriptions above all, and goes to a terminal: it is
// cleaned first (@rsva/terminal/text) and our sequences go in after.
import { byState, isClosedGroup, stateGlyph, type IssueRow } from "@rsva/terminal/issues";
import { blocks, spans } from "@rsva/terminal/markdown";
import { cut, PLAIN, type Style } from "./style.ts";
import { SHA_SHOWN } from "@rsva/schema/models";
import { plural } from "@rsva/schema/util";

/** A field that takes one line: a line break in it must not look like another row. */
const oneLine = (s: string) => s.replace(/\s+/g, " ");

/** Where things open: an issue by its key, and an address in the server's text. Without them keys and addresses are text. */
export interface Links {
  issue(key: string): string | undefined;
  /** `/files/…` on the server, an absolute address as it is; undefined for what a browser cannot open. */
  url(href: string): string | undefined;
}
const NO_LINKS: Links = { issue: () => undefined, url: () => undefined };

export interface IssueFull extends IssueRow {
  createdBy: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  description: string;
  relations: { blockedBy: string[]; blocks: string[]; related: string[]; duplicateOf: string | null; duplicates: string[] };
  links: { id: string; url: string; title: string }[];
  files: { id: string; name: string; size: number }[];
  branch?: string;
  pullRequests?: PullRow[];
  commits?: CommitRow[];
}

interface PullRow {
  repo: string;
  number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  review: string | null;
  checks: string | null;
  url: string;
  closing: boolean;
}

interface CommitRow {
  repo: string;
  sha: string;
  title: string;
  url: string;
  closing: boolean;
}

export interface CycleRow {
  name: string;
  short: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  description: string;
  lead: string | null;
  issues: number;
  done: number;
  open: number;
}

export interface CommentRow {
  id: string;
  parentId?: string | null;
  author: string | null;
  body: string;
  createdAt: string;
  editedAt?: string | null;
  /** "telegram" or "email": where it was written when not in the app (PLNR-369). */
  via?: string;
}

/** Colours a cell after it is padded, so that the padding is counted on the text alone. */
type Painter = ((cell: string, row: number) => string) | undefined;

const widthsOf = (cells: readonly string[][], s: Style) => {
  const widths: number[] = [];
  for (const r of cells) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, s.width(cell))));
  return widths;
};

/** Columns padded to their widest cell; the last one runs free. */
function lines(rows: string[][], s: Style = PLAIN, paint: readonly Painter[] = []): string[] {
  const cells = rows.map((r) => r.map(oneLine));
  const widths = widthsOf(cells, s);
  return cells.map((r, row) =>
    r
      .map((cell, i) => (paint[i]?.(cell, row) ?? cell) + (i === r.length - 1 ? "" : " ".repeat(widths[i]! - s.width(cell))))
      .join("  ")
      .trimEnd(),
  );
}

const table = (rows: string[][], s?: Style, paint?: readonly Painter[]) => lines(rows, s, paint).join("\n");

const none = (v: string) => (v === "none" ? "" : v);
/** A word in the colour its table gives it; a word the table does not know stays as it is, or becomes `other`. */
const word = (s: Style, colours: Record<string, Colour>, w: string, other = w) => (Object.hasOwn(colours, w) ? s[colours[w]!](w) : other);
/** What a reference does: merging one that only links leaves the issue's state. */
const linked = (x: { closing: boolean }) => (x.closing ? "" : " (linked)");

/** A colour of the style, by name. */
type Colour = Exclude<keyof Style, "on" | "columns" | "link" | "width">;

// A state's colour by its group, beside its glyph (stateGlyph); a group the app does not know reads as unstarted.
const TONE: Record<string, Colour> = { backlog: "gray", unstarted: "bold", started: "yellow", completed: "green", cancelled: "red" };

const tone = (s: Style, group: string | null | undefined) => s[Object.hasOwn(TONE, group ?? "") ? TONE[group!]! : "bold"];
const glyph = (s: Style, group: string | null | undefined) => tone(s, group)(stateGlyph(group));
/** A state that is not found reads as "?", as an unknown author does. */
const stateName = (i: { state: string | null }) => i.state ?? "?";
const stateOf = (s: Style, i: { state: string | null; stateGroup?: string | null }) => `${glyph(s, i.stateGroup)} ${tone(s, i.stateGroup)(stateName(i))}`;

const PRIORITY: Record<string, Colour> = { high: "red", medium: "yellow", low: "blue" };
const priority = (s: Style, p: string) => (p === "urgent" ? s.bold(s.red(p)) : word(s, PRIORITY, p, ""));

/** How many were shown of how many; `more`, for a person, says how to see the rest. */
const count = (total: number, shown: number, s: Style, more?: string) =>
  total > shown ? `${shown} of ${total}${s.on && more ? ` · ${more}` : ""}` : plural(total, "issue");

/** The cells a window leaves the last column after fixed columns this wide, `lead` cells before them; Infinity without one. */
const roomAfter = (s: Style, widths: readonly number[], lead: number) => (s.columns ? s.columns - lead - widths.reduce((a, w) => a + w + 2, 0) : Infinity);

/** In colour: a block per state, the columns no row fills left out, the title cut to the window. */
function issueGroups(issues: readonly IssueRow[], s: Style, links: Links): string[] {
  const head = issues.map((i) => [i.key, none(i.priority), i.cycle ?? ""]);
  const used = [0, 1, 2].filter((c) => head.some((r) => r[c]));
  const fixed = head.map((r) => used.map((c) => r[c]!));
  const room = roomAfter(s, widthsOf(fixed, s), 2);
  const titles = issues.map((i) => {
    const labels = i.labels.join(", ");
    const title = oneLine(i.title);
    if (room === Infinity) return [title, labels];
    const t = cut(title, labels ? Math.max(room - s.width(labels) - 2, Math.ceil(room * 0.6)) : room);
    return [t, cut(labels, room - s.width(t) - 2)];
  });
  const rows = fixed.map((r, n) => [...r, titles[n]!.filter(Boolean).join("  ")]);
  const closed = (n: number) => isClosedGroup(issues[n]!.stateGroup);
  const painters: Painter[] = used.map((c) =>
    c === 0 ? (cell) => s.link(links.issue(cell) ?? "", s.gray(cell)) : c === 1 ? (cell) => priority(s, cell) : (cell) => s.gray(cell),
  );
  painters.push((_, n) => {
    const [t, labels] = titles[n]!;
    return (closed(n) ? s.dim(t!) : t!) + (labels ? `  ${s.gray(labels)}` : "");
  });
  const body = lines(rows, s, painters);
  const at = new Map(issues.map((i, n) => [i, n]));
  return byState(issues).flatMap((g, n) => [
    ...(n ? [""] : []),
    `${stateOf(s, g[0]!)} ${s.gray(String(g.length))}`,
    ...g.map((i) => `  ${body[at.get(i)!]}`),
  ]);
}

/** An open issue that looks like the one being created (PLNR-295): the server's `similar` list, `score` from 0 to 1. */
export interface SimilarRow {
  key: string;
  title: string;
  state: string;
  score: number;
}

/** One similar issue as a line of stderr: `similar: PLNR-12  Title  (0.71)`. */
export const similarLine = (r: SimilarRow): string => `similar: ${r.key}  ${oneLine(r.title)}  (${r.score.toFixed(2)})`;

export function issueList(issues: readonly IssueRow[], total: number, s: Style = PLAIN, links: Links = NO_LINKS, more?: string): string {
  if (s.on) return [...issueGroups(issues, s, links), ...(issues.length ? [""] : []), s.gray(count(total, issues.length, s, more))].join("\n");
  const rows = issues.map((i) => [i.key, stateName(i), none(i.priority), i.cycle ?? "", i.title + (i.labels.length ? ` [${i.labels.join(", ")}]` : "")]);
  return [table(rows), count(total, issues.length, s)].filter(Boolean).join("\n");
}

/**
 * A line's inline Markdown: a mention reads as the name it carries, an image and a file as their caption, the words of
 * a link and an address open it; what a browser cannot open stays words.
 */
const inline = (line: string, s: Style, links: Links) =>
  spans(line)
    .map((x) => {
      if (x.kind === "text") return x.text;
      if (x.kind === "mention") return s.magenta(x.text || "@?");
      if (x.kind === "code") return s.cyan(x.text);
      if (x.kind === "emphasis") return s[x.style](x.text);
      const href = x.kind === "image" ? x.src : x.href;
      const shown = x.kind === "image" ? `image${x.alt ? ` ${x.alt}` : ""}` : x.kind === "link" ? x.text || href : href;
      const url = links.url(href);
      return url ? s.link(url, s.blue(shown)) : shown;
    })
    .join("");

/**
 * Markdown as a terminal can show it: headings bold, code in its colour, task boxes as boxes, links that open. Plain
 * text gets it as written: an agent reads the mentions' ids and writes the text back.
 */
function markdown(text: string, s: Style, links: Links = NO_LINKS): string {
  if (!s.on) return text;
  return blocks(text)
    .map((b) => {
      if (b.kind === "fence" || b.kind === "rule") return s.gray(b.line);
      if (b.kind === "code") return s.cyan(b.line);
      if (b.kind === "heading") return s.bold(inline(b.text, s, links));
      if (b.kind === "task") return `${b.indent}${b.done ? s.green("☑") : "☐"} ${inline(b.text, s, links)}`;
      if (b.kind === "quote") return `${b.indent}${s.gray("│")} ${inline(b.text, s, links)}`;
      return `${b.indent}${inline(b.line.slice(b.indent.length), s, links)}`;
    })
    .join("\n");
}

const PR_STATE: Record<string, Colour> = { open: "green", merged: "magenta", closed: "red", draft: "gray" };
const VERDICT: Record<string, Colour> = { approved: "green", pass: "green", success: "green", changes_requested: "red", fail: "red", failure: "red", pending: "yellow" };
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

/**
 * A line of the card: the plain text is "label: value" as before; in colour the labels line up and the value is painted,
 * to the room the window leaves when it is a function.
 */
type Field = [label: string, value: string, painted?: string | ((room: number) => string)];

/**
 * A line of a head, a title and an optional tail in `room` cells: the tail goes first, then the title is cut. The parts
 * are drawn twice, plain to be measured and in colour to be shown.
 */
function fit(s: Style, room: number, parts: (t: Style) => [head: string, title: string, tail?: string]): string {
  const [head, title, tail] = parts(s);
  const [h = 0, , t = 0] = parts(PLAIN).map((x) => (x ? s.width(x) : 0));
  if (h + 2 + s.width(title) + (t && t + 2) <= room) return [head, title, tail].filter(Boolean).join("  ");
  return `${head}  ${cut(title, Math.max(room - h - 2, 1))}`;
}

/** Out of the lists: in the trash or the archive, since that day. */
const gone = (i: IssueFull) => (i.deletedAt ? `deleted ${i.deletedAt.slice(0, 10)}` : i.archivedAt ? `archived ${i.archivedAt.slice(0, 10)}` : "");

export function issueCard(i: IssueFull, s: Style = PLAIN, links: Links = NO_LINKS): string {
  const keys = (v: readonly string[]) => v.map((k) => s.link(links.issue(k) ?? "", k)).join(", ");
  const r = i.relations;
  const all: Field[] = [
    ["labels", i.labels.join(", ")],
    ["assignees", i.assignees.join(", ")],
    ["delegate", i.delegate ?? ""],
    ["parent", i.parent ?? "", i.parent ? keys([i.parent]) : ""],
    ["start", i.startDate ?? ""],
    ["due", i.dueDate ?? ""],
    ["created by", i.createdBy ?? ""],
    ["blocked by", r.blockedBy.join(", "), keys(r.blockedBy)],
    ["blocks", r.blocks.join(", "), keys(r.blocks)],
    ["related", r.related.join(", "), keys(r.related)],
    ["duplicate of", r.duplicateOf ?? "", r.duplicateOf ? keys([r.duplicateOf]) : ""],
    ["duplicates", r.duplicates.join(", "), keys(r.duplicates)],
    ...i.links.map((l): Field => ["link", `${l.url}${l.title ? ` (${l.title})` : ""}`, l.title ? `${s.link(l.url, oneLine(l.title))}  ${s.gray(l.url)}` : s.link(l.url, l.url)]),
    ...i.files.map((f): Field => ["file", `${f.name} (${f.size} B)`, `${oneLine(f.name)}  ${s.gray(size(f.size))}`]),
    ["branch", i.branch ?? "", i.branch ? s.cyan(i.branch) : ""],
    ...(i.pullRequests ?? []).map((p): Field => {
      // Once merged or closed, review and checks say nothing: the state does.
      const live = p.state !== "merged" && p.state !== "closed";
      const review = live ? p.review : null;
      const checks = live ? p.checks : null;
      return [
      "pr",
      `${p.repo}#${p.number} ${p.state}${linked(p)} ${p.head} → ${p.base}${review ? ` review ${review}` : ""}${checks ? ` checks ${checks}` : ""} ${p.title}`,
      (room) =>
        fit(s, room, (t) => [
          `${t.link(p.url, `${p.repo}#${p.number}`)} ${word(t, PR_STATE, p.state)}${t.gray(linked(p))}${review ? ` review ${word(t, VERDICT, review)}` : ""}${checks ? ` checks ${word(t, VERDICT, checks)}` : ""}`,
          oneLine(p.title),
          t.gray(`${p.head} → ${p.base}`),
        ]),
      ];
    }),
    ...(i.commits ?? []).map((c): Field => ["commit", `${c.repo}@${c.sha.slice(0, SHA_SHOWN)}${linked(c)} ${c.title}`, (room) => fit(s, room, (t) => [`${t.link(c.url, `${c.repo}@${t.yellow(c.sha.slice(0, SHA_SHOWN))}`)}${t.gray(linked(c))}`, oneLine(c.title)])]),
  ];
  const fields = all.filter(([, v]) => v !== "");
  const out = gone(i);
  const status = [s.on ? stateOf(s, i) : stateName(i), priority(s, i.priority) || none(i.priority), s.on ? s.gray(i.cycle ?? "") : i.cycle, i.deletedAt ? s.red(out) : s.yellow(out)].filter(Boolean).join(s.on ? s.gray(" · ") : " · ");
  const one = new Set(["link", "file", "pr", "commit"]);
  const labelWidth = Math.max(0, ...fields.map(([label]) => s.width(label)));
  const room = s.columns ? s.columns - labelWidth - 2 : Infinity;
  const body = s.on
    ? fields.map(([label, v, painted]) => `${s.gray(label)}${" ".repeat(labelWidth - s.width(label))}  ${typeof painted === "function" ? painted(room) : (painted ?? v)}`)
    : fields.map(([label, v]) => (one.has(label) ? oneLine(`${label}: ${v}`) : `${label}: ${v}`));
  return [
    s.on ? `${s.link(links.issue(i.key) ?? "", s.gray(i.key))}  ${s.bold(oneLine(i.title))}` : `${i.key}  ${oneLine(i.title)}`,
    status,
    ...(s.on && body.length ? ["", ...body] : body),
    ...(i.description ? ["", markdown(i.description, s, links)] : []),
  ].join("\n");
}

const dates = (c: CycleRow) => (c.startDate ? `${c.startDate} – ${c.endDate}` : "no dates");
const progress = (c: CycleRow) => `${c.done}/${c.issues} done`;

const CYCLE: Record<string, Colour> = { active: "green", upcoming: "blue", ended: "yellow", draft: "gray", completed: "gray" };
/** A bar of eight cells for the share of the cycle that is done. */
const bar = (s: Style, c: CycleRow) => {
  const full = c.issues ? Math.round((c.done / c.issues) * 8) : 0;
  return `${s.green("█".repeat(full))}${s.gray("░".repeat(8 - full))} ${progress(c)}`;
};

/** The bar is as wide in every row, so the column pads on the count alone. */
const CYCLE_PAINT = (s: Style, cycles: readonly CycleRow[]): Painter[] => [s.bold, (cell) => word(s, CYCLE, cell), s.gray, (_, n) => bar(s, cycles[n]!)];

export const cycleList = (cycles: readonly CycleRow[], s: Style = PLAIN): string =>
  cycles.length ? table(cycles.map((c) => [c.short, c.status, dates(c), progress(c), c.name]), s, s.on ? CYCLE_PAINT(s, cycles) : []) : s.gray("no cycles");

export function cycleCard(c: CycleRow, issues: string, s: Style = PLAIN, links: Links = NO_LINKS): string {
  if (!s.on) return [`${c.short}  ${oneLine(c.name)}`, [c.status, dates(c), progress(c), `${c.open} open`, c.lead].filter(Boolean).join(" · "), c.description, "", issues].filter((l, i) => l || i === 3).join("\n");
  const status = [word(s, CYCLE, c.status), s.gray(dates(c)), bar(s, c), `${c.open} open`, c.lead ?? ""].filter(Boolean).join(s.gray(" · "));
  return [`${s.bold(c.short)}  ${s.bold(oneLine(c.name))}`, status, c.description ? markdown(c.description, s, links) : "", "", issues].filter((l, i) => l || i === 3).join("\n");
}

export interface InboxLine {
  key: string;
  title: string;
  state: string | null;
  stateGroup: string | null;
  kind: string;
  by: string | null;
  at: string;
  unread: boolean;
  snoozedUntil: string | null;
}

const KIND: Record<string, Colour> = { mention: "magenta", reply: "magenta", review: "yellow", assigned: "blue", approved: "green", state: "gray" };

/** A moment to the minute: the server's UTC in plain text, a person's own clock in colour. */
function minute(at: string, s: Style): string {
  const d = new Date(at);
  if (!s.on || Number.isNaN(d.getTime())) return at.slice(0, 16).replace("T", " ");
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The inbox, newest first: one line per issue, as in the app. Unread lines carry a dot, or "unread" in plain text. */
export function inboxList(items: readonly InboxLine[], unread: number, s: Style = PLAIN, links: Links = NO_LINKS): string {
  const footer = `${unread} unread`;
  if (!items.length) return s.gray(`nothing in the inbox · ${footer}`);
  const when = (l: InboxLine) => `${minute(l.at, s)}${l.snoozedUntil ? ` snoozed to ${minute(l.snoozedUntil, s)}` : ""}`;
  if (!s.on) return [table(items.map((l) => [l.key, l.unread ? "unread" : "", l.kind, l.by ?? "?", when(l), l.title])), footer].join("\n");
  const rows = items.map((l) => [l.key, l.kind, l.by ?? "?", when(l), l.title]);
  // Two cells for the unread dot and its space.
  const room = roomAfter(s, widthsOf(rows.map((r) => r.slice(0, 4)), s), 2);
  const paint: Painter[] = [
    (cell) => s.link(links.issue(cell) ?? "", s.gray(cell)),
    (cell) => word(s, KIND, cell),
    s.gray,
    s.gray,
    (cell, n) => (items[n]!.unread ? s.bold : s.dim)(room === Infinity ? cell : cut(cell, room)),
  ];
  return [...lines(rows, s, paint).map((l, n) => `${items[n]!.unread ? s.blue("●") : " "} ${l}`), "", s.gray(footer)].join("\n");
}

/** A comment's handle: the end of its id, which is random (uuidv7 starts with the time); `comment --reply-to` takes it. */
export const handle = (id: string) => id.slice(-6);

/**
 * The comments as threads: a reply under the comment it answers, a step further in, a reply to a comment that is not on
 * the page marked with ↳. The bodies are indented: a line of a comment cannot pass for the next comment's author.
 * `older`, when the page has one before it, is how to read that page.
 */
export function commentList(comments: readonly CommentRow[], older: string | undefined, s: Style = PLAIN, links: Links = NO_LINKS): string {
  const ids = new Set(comments.map((c) => c.id));
  const replies = new Map<string, CommentRow[]>();
  for (const c of comments) {
    if (!c.parentId || !ids.has(c.parentId)) continue;
    const thread = replies.get(c.parentId);
    if (thread) thread.push(c);
    else replies.set(c.parentId, [c]);
  }
  const head = (c: CommentRow) => {
    const when = [minute(c.createdAt, s), handle(c.id), ...(c.via === "telegram" ? ["from Telegram"] : c.via === "email" ? ["from Email"] : []), ...(c.editedAt ? ["edited"] : [])].join(" · ");
    return s.on ? `${s.bold(c.author ?? "?")} ${s.gray(when)}` : `${c.author ?? "?"}, ${when}`;
  };
  const draw = (c: CommentRow, depth: number): string => {
    const pad = "  ".repeat(depth);
    const mark = depth || c.parentId ? "↳ " : "";
    const body = markdown(c.body, s, links).replaceAll("\n", `\n${pad}  `);
    return [`${pad}${mark}${head(c)}\n${pad}  ${body}`, ...(replies.get(c.id) ?? []).map((r) => draw(r, depth + 1))].join("\n\n");
  };
  const list = comments.filter((c) => !c.parentId || !ids.has(c.parentId)).map((c) => draw(c, 0));
  return [list.join("\n\n") || s.gray("no comments"), older ? s.gray(`older: ${older}`) : ""].filter(Boolean).join("\n\n");
}

// ── The workspace's settings (PLNR-239) ─────────────────────────────────────────────────────────────────────────

export interface ProjectRow {
  key: string;
  name: string;
  color: string | null;
  formerKeys: string[];
  archivedAt: string | null;
  /** Its cycles complete themselves once over (PLNR-64); missing from a server before it. */
  rollover?: boolean;
}

export interface StateRow {
  name: string;
  group: string;
  default: boolean;
  /** Only people move issues here (ADR 0037); an older server sends nothing. */
  onlyPeople?: boolean;
  issues: number;
}

export interface LabelRow {
  name: string;
  color: string;
  parent: string | null;
  depth: number;
  workspace: boolean;
  /** Only people rename or delete it (ADR 0037); an older server sends nothing. */
  onlyPeople?: boolean;
  issues: number;
}

export interface ProjectFull extends ProjectRow {
  states: StateRow[];
  labels: LabelRow[];
}

export interface MemberRow {
  email: string;
  name: string;
  kind: string;
  role: string;
}

export interface ViewRow {
  name: string;
  query: string;
  shared: boolean;
  mine: boolean;
}

export interface WorkspaceInfo {
  slug: string;
  name: string;
  color: string | null;
  /** What the workspace opened to members (ADR 0037); an older server sends nothing. */
  memberRights?: string[];
  me: { email: string; name: string; kind: string; role: string; scope: string | null; grants?: string[] };
}

const issueCount = (n: number) => plural(n, "issue");
const projectNote = (p: ProjectRow) =>
  [p.archivedAt ? "archived" : "", p.formerKeys.length ? `was ${p.formerKeys.join(", ")}` : "", p.rollover ? "cycle rollover" : ""].filter(Boolean).join(" · ");

export const projectList = (projects: readonly ProjectRow[], s: Style = PLAIN): string =>
  projects.length ? table(projects.map((p) => [p.key, p.name, projectNote(p)]), s, [s.bold, undefined, s.gray]) : s.gray("no projects");

/** States in the app's order, each with its group's glyph. */
export const stateList = (states: readonly StateRow[], s: Style = PLAIN): string =>
  table(
    states.map((x) => [stateGlyph(x.group), x.name, x.group, [x.default ? "default" : "", x.onlyPeople ? "only people" : ""].filter(Boolean).join(" · "), issueCount(x.issues)]),
    s,
    [(cell, n) => tone(s, states[n]!.group)(cell), undefined, s.gray, s.green, s.gray],
  );

/** Labels as a tree: a label inside another follows it, a dot deeper. */
export const labelList = (labels: readonly LabelRow[], s: Style = PLAIN): string =>
  labels.length
    ? table(
        labels.map((l) => [`${"· ".repeat(l.depth)}${l.name}`, l.color, [l.workspace ? "workspace" : "", l.onlyPeople ? "only people" : ""].filter(Boolean).join(" · "), issueCount(l.issues)]),
        s,
        [undefined, s.gray, s.gray, s.gray],
      )
    : s.gray("no labels");

export function projectCard(p: ProjectFull, s: Style = PLAIN): string {
  const head = `${s.bold(p.key)}  ${s.bold(oneLine(p.name))}`;
  const meta = [p.color ?? "", projectNote(p)].filter(Boolean).join(" · ");
  return [head, meta ? s.gray(meta) : "", "", s.bold("States"), stateList(p.states, s), "", s.bold("Labels"), labelList(p.labels, s)].filter((l, i) => l || i > 1).join("\n");
}

export const memberList = (members: readonly MemberRow[], s: Style = PLAIN): string =>
  table(members.map((m) => [m.email, m.name, m.role, m.kind === "agent" ? "agent" : ""]), s, [undefined, undefined, s.gray, s.gray]);

export const viewList = (views: readonly ViewRow[], s: Style = PLAIN): string =>
  views.length ? table(views.map((v) => [v.name, v.shared ? "shared" : "mine", v.query]), s, [s.bold, s.gray]) : s.gray("no saved views");

/** The workspace and whose token this is: a person's or the agent's, its role and scope, what it may change, and what members may beyond issues. */
export function workspaceCard(w: WorkspaceInfo, s: Style = PLAIN): string {
  const token = [w.me.role, w.me.kind === "agent" ? "agent" : "", w.me.scope ? `${w.me.scope} token` : ""].filter(Boolean).join(" · ");
  const lines = [`${s.bold(oneLine(w.name))}  ${s.gray(w.slug)}`, `${w.me.email}  ${s.gray(token)}`];
  // An older server sends no grants: say nothing rather than "reads only".
  if (w.me.grants) lines.push(`${s.gray("may change")}  ${w.me.grants.length ? w.me.grants.join(", ") : "nothing, reads only"}`);
  if (w.memberRights) lines.push(`${s.gray("members may also change")}  ${w.memberRights.length ? w.memberRights.join(", ") : "nothing beyond issues, comments, cycles and views"}`);
  return lines.join("\n");
}
