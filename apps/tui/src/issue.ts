// The issue screen (↵ on a row, an issue chosen in the palette, a card in the queue): the whole issue on the whole
// screen, as Rex's swipe shows a ticket. The head says where it was opened from and its place there; under it the card's
// border with the key, the title and the line of state, then what scrolls: the fields, the description in full, the
// activity. It is how a small window reads an issue at all, and how a large one reads the description past the card.
import { mark, paintKeys, paintStatus, paintStatusNarrow } from "./bars.ts";
import { layoutDescription, MEASURE, READING_LOOK, type DescLine } from "./description.ts";
import { widthOf } from "@rsva/terminal/width";
import type { Colour, Grid } from "./grid.ts";
import type { Card, HomeView } from "./home.ts";
import { briefLine, paintProperties, panelWidth } from "./properties.ts";
import { chip, clicking, cutSegs, fieldLines, fieldText, panel, prioritySegs, segs, type Seg, type StateMark } from "./widgets.ts";
import type { Placement } from "./images.ts";
import type { Field } from "./terminal.ts";
import { tintOf, type Token } from "./theme.ts";
import type { NameTone } from "@rsva/display/avatar";
import { priorityName } from "@rsva/schema/models";
import { plural } from "@rsva/schema/util";

/** A comment as the conversation draws it (PLNR-337): the avatar, the name in its colour, the time; the text under it. */
export interface CommentView {
  /** Who wrote it, for grouping: their id, or "" without an author. */
  author: string;
  /** Their name ("Arsen"), their email when the workspace has none, "Imported" without an author. */
  name: string;
  /** Their avatar without a picture (packages/display avatar.ts): their initials on the tone of their creature on the web. */
  initials: string;
  tone: NameTone;
  agent: boolean;
  /** When, for grouping; and its time at the right ("12:01"), the day being in the day mark above it. */
  at: string;
  time: string;
  edited: boolean;
  /** "from Telegram", "from Email": where it was written when not in the app (PLNR-369); null otherwise. */
  via: string | null;
  deleted: boolean;
  /** Markdown, cleaned. */
  body: string;
  /** Each emoji with how many reacted. */
  reactions: { emoji: string; count: number }[];
}

/**
 * A row of the issue's activity, as the web's feed has them (home-view.ts activityOf): a day's mark; a line of history
 * (one-cell mark, who, the sentence, when; a folded run of state changes is one); a comment thread.
 */
export type ActivityRow =
  | { kind: "day"; label: string }
  | { kind: "event"; mark: Seg; who: string | null; text: Seg[]; when: string }
  | { kind: "thread"; thread: CommentView & { replies: CommentView[] } };

export interface IssueView {
  /** What it was opened from, as the head names it: "Open issues", "Queue", a query. */
  source: string;
  /** Its place in the list j/k step through; null where they do not step (opened from the queue). */
  place: { at: number; of: number; prev?: string; next?: string } | null;
  card: Card;
  /** `comments`: how many, as the web counts them; `older`: earlier pages are not loaded, so the issue's creation is not in the rows. */
  activity: { status: "loading" | "ready" | "error"; comments: number; older: boolean; rows: ActivityRow[] };
  /** The first body line asked for; the painter keeps it in range. */
  top: number;
  status: HomeView["status"];
  keys: HomeView["keys"];
  /**
   * An image's size in cells in `room` columns, once it can be drawn (images.ts); null draws its caption: while it
   * loads, when it failed, in a terminal without images.
   */
  picture?: (src: string, room: number) => { cols: number; rows: number } | null;
  /** The properties: in a panel on the right from 120 columns, under the title as a line and on `i` below that. */
  details?: IssueDetails;
  /** Below 120 columns, the properties opened above the text (`i`). */
  properties?: boolean;
  /** A reply being written (`r`, PLNR-334): its text and cursor, in a box under the activity, which scrolls above it. */
  reply?: Field;
}

/** What the properties panel shows (the TuiIssue artboards' PROPERTIES, RELATIONS, PULL REQUEST, LINKS), and the title rows. */
export interface IssueDetails {
  project: { key: string; name: string; tile: [fg: Colour, bg: Colour] } | null;
  parent: { key: string; title: string } | null;
  assignees: { email: string; initials: string; tone: NameTone }[];
  delegate: { email: string; agent: boolean } | null;
  cycle: { name: string; dates: string; done: number; total: number } | null;
  relations: { kind: string; key: string; mark: StateMark }[];
  pulls: { number: number; title: string; state: string; checks: "pass" | "fail" | "run" | null; failing: number; url: string }[];
  links: { site: string; title: string; url: string }[];
  /** Its sub-issues, as the TuiIssue artboard lists them: state, key, title, who works on it, when it last moved. */
  children: { key: string; title: string; mark: StateMark; done: boolean; who: { initials: string; tone: NameTone } | "agent" | null; when: string }[];
  created: { day: string; by: string | null };
  /** "2m ago". */
  updated: string;
  /** A new issue's, before it is created (PLNR-438): no dates, and d is a letter of its line, not a dispatch. */
  draft?: boolean;
}

/** An image's rows in what scrolls: one object for all of them, so two images of one source stay two. */
interface Picture {
  src: string;
  at: number;
  cols: number;
  rows: number;
}

/** A line of what scrolls: text at offsets in the card, a code line's ground, a soft rule with a name in it, an image's row. */
interface BodyLine {
  cols: [at: number, segs: Seg[]][];
  code?: boolean;
  rule?: boolean;
  picture?: { of: Picture; row: number };
  /** A code or diff line's ground, to the column's end. */
  ground?: Token;
  /** The key a click on the line presses: a sub-issue's row opens it (RSVA-479). */
  click?: string;
}

/** Where a field's value starts, as on the card. */
const FIELD = 15;

const text = (segs: Seg[], at = 0): BodyLine => ({ cols: [[at, segs]] });
const BLANK: BodyLine = { cols: [] };

/** A section's head in what scrolls: its name, its count, a rule to the end; `tail` sits at the end over the rule. */
const sectionHead = (name: string, count: string, room: number, tail: Seg[] = []): BodyLine => {
  const tailWidth = widthOf(tail.map(([t]) => t).join(""));
  return { cols: [[0, [[`${name} `, { fg: "ink-3", at: "B" }], ...(count ? [[` ${count} `, { fg: "ink-2" }] as Seg] : [])]], ...(tail.length ? [[room - tailWidth - 1, [[" ", { fg: "ink" }], ...tail]] as [number, Seg[]]] : [])], rule: true };
};

/**
 * Texts laid out for the issue screen, by width and text: it repaints on every key, every change the sync brings and every
 * poll of the agents, and laying a long comment out again each time cost more than painting it (RSVA-621). A changed text
 * or width is another key; the whole map goes past a million characters of keys, so a feed longer than that costs what
 * it did before.
 */
const laidOut = new Map<string, DescLine[]>();
let laidChars = 0;
function reading(md: string, room: number): DescLine[] {
  const key = `${room} ${md}`;
  let lines = laidOut.get(key);
  if (!lines) {
    if ((laidChars += key.length) > 1_000_000) {
      laidOut.clear();
      laidChars = key.length;
    }
    laidOut.set(key, (lines = layoutDescription(md, room, READING_LOOK)));
  }
  return lines;
}

/**
 * What scrolls, as one feed (owner, 2026-11-06: no tabs, nothing hidden): the description, the sub-issues, the activity.
 * Returns its lines and where each heading starts, for Tab and Shift+Tab.
 */
function bodyOf(v: IssueView, room: number, fields: boolean): { lines: BodyLine[]; heads: number[] } {
  const c = v.card;
  const out: BodyLine[] = [];
  const heads: number[] = [];
  const head = (line: BodyLine) => {
    heads.push(out.length);
    out.push(line);
  };
  // The properties above the text where no panel shows them, once `i` asked for them.
  if (fields) {
    for (const f of c.fields) f.lines.forEach((l, i) => out.push({ cols: i ? [[FIELD, l]] : [[0, [[f.label, { fg: "ink-3" }]]], [FIELD, l]] }));
    out.push({ cols: [], rule: true });
  }
  // A line of text, or an image's rows where it can be drawn.
  const line = (d: DescLine, at: number) => {
    const size = d.image && v.picture?.(d.image.src, room - at);
    if (!d.image || !size) return void out.push({ cols: [[at, d.segs]], ...(d.ground ? { ground: d.ground } : {}) });
    const of: Picture = { src: d.image.src, at, ...size };
    for (let row = 0; row < size.rows; row++) out.push({ cols: [], picture: { of, row } });
  };
  const desc = reading(c.description, room);
  if (desc.length) for (const d of desc) line(d, 0);
  else out.push(text([["No description.", { fg: "faint" }]]));
  // The sub-issues: how many are done, a bar of it, a row each (TuiIssue).
  const children = v.details?.children ?? [];
  if (children.length) {
    out.push(BLANK);
    const done = children.filter((x) => x.done).length;
    const filled = Math.round((10 * done) / children.length);
    head(sectionHead("SUB-ISSUES", `${done} of ${children.length}`, room, [["█".repeat(filled), { fg: "status-done" }], ["█".repeat(10 - filled), { fg: "rule-strong" }]]));
    for (const x of children) {
      const who: Seg[] = x.who === "agent" ? [["◈", { fg: "status-done", bg: "tint-done", at: "B" }]] : x.who ? [[x.who.initials || "?", { fg: "ink", bg: `avatar-${x.who.tone}`, at: "B" }]] : [];
      out.push({ cols: [[1, [[x.mark.glyph, { fg: x.mark.tone }]]], [3, [[x.key, { fg: "ink-3" }]]], [14, [[x.title, { fg: x.done ? "ink-3" : "ink" }]]], [room - 12, [[" ", { fg: "ink" }], ...who]], [room - widthOf(x.when), [[x.when, { fg: "ink-3" }]]]], click: `issue:${x.key}` });
    }
  }
  out.push(BLANK);
  const { status, comments, older, rows } = v.activity;
  head(sectionHead("ACTIVITY", comments ? plural(comments, "comment") : "", room));
  if (older) out.push(text([["Earlier activity is in the browser: o opens it.", { fg: "faint" }]]));
  if (status === "loading") out.push(text([["loading…", { fg: "faint" }]]));
  else if (status === "error") out.push(text([["the activity did not load", { fg: "warning" }]]));
  else if (!rows.length) out.push(text([["No activity yet.", { fg: "faint" }]]));
  // The conversation (PLNR-337): a day mark where the day changes; the avatar and the name in the person's colour, the
  // time at the right; the text under the name; the next comments of the same person within GROUP_MS under the same
  // head, each with its time at the right; a reply indented under its comment's text; reactions under a comment; the
  // history between them as quiet lines (the web's words), each with its time at the right.
  const quiet = { fg: "ink-3" } as const;
  // Times and "edited" are the faintest the theme has: they place a line, they are not read (owner, 2026-11-06).
  const faint = { fg: "faint" } as const;
  const right = (line: BodyLine, time: string, at: number): BodyLine => ({ ...line, cols: [...line.cols, [Math.max(at, room - widthOf(time)), [[time, faint]]]] });
  const comment = (cm: CommentView, at: number, headed: boolean) => {
    const chip = avatarOf(cm);
    const name = at + widthOf(chip.map(([t]) => t).join("")) + 2;
    if (headed) {
      const who: Seg[] = cm.deleted ? [[`Comment deleted by ${cm.name}`, quiet]] : [[cm.name, { fg: cm.agent ? "status-done" : NAME_TONE[cm.tone], at: "B" }], ...(cm.agent ? [[" agent", quiet] as Seg] : []), ...(cm.via ? [[` · ${cm.via}`, faint] as Seg] : []), ...(cm.edited ? [[" · edited", faint] as Seg] : [])];
      out.push(right({ cols: [[at, chip], [name, who]] }, cm.time, name));
    }
    if (cm.deleted) return name;
    // The text keeps clear of the time at the right on a grouped comment's first line.
    const first = out.length;
    for (const d of reading(cm.body, Math.max(1, room - name - (headed ? 0 : widthOf(cm.time) + 2)))) line(d, name);
    if (!headed && out.length > first) out[first] = right(out[first]!, `${cm.edited ? "edited · " : ""}${cm.time}`, name);
    if (cm.reactions.length) out.push({ cols: [[name, cm.reactions.flatMap(({ emoji, count }, i): Seg[] => [...(i ? [[" ", quiet] as Seg] : []), [` ${emoji} ${count} `, { fg: "ink-2", bg: "nav-current" }]])]] });
    return name;
  };
  let last: ActivityRow | null = null;
  for (const r of rows) {
    if (r.kind === "day") {
      out.push(BLANK, { cols: [[0, [["── ", { fg: "rule-soft" }], [r.label, quiet], [" ", quiet]]], [widthOf(r.label) + 4, [["─".repeat(Math.max(0, room - widthOf(r.label) - 4)), { fg: "rule-soft" }]]]] });
    } else if (r.kind === "event") {
      if (last?.kind === "thread") out.push(BLANK);
      // The sentence ends before the time: a long one is cut there with an ellipsis, the time stays whole.
      const said = cutSegs([...(r.who ? [[r.who, { fg: "ink-2" }], [" ", quiet]] as Seg[] : []), ...r.text], room - 3 - widthOf(r.when) - 2);
      out.push(right({ cols: [[1, [r.mark]], [3, said]] }, r.when, 3));
    } else {
      const t = r.thread;
      // The same person again within GROUP_MS, with nothing between: no head of its own.
      const prev = last?.kind === "thread" && !last.thread.replies.length ? last.thread : null;
      const grouped = !!prev && !prev.deleted && !t.deleted && t.author !== "" && prev.author === t.author && Date.parse(t.at) - Date.parse(prev.at) < GROUP_MS;
      // Comments follow each other without blank lines (owner, 2026-11-06: the conversation took too much room): the
      // avatar and the coloured name start each. A blank line stays under a day mark and between comments and history.
      if (!grouped && last?.kind !== "thread") out.push(BLANK);
      const text = comment(t, 0, !grouped);
      for (const reply of t.replies) comment(reply, text + 3, true);
    }
    last = r;
  }
  return { lines: out, heads };
}

/** A person's comments this close together read under one head. */
const GROUP_MS = 10 * 60_000;

/** A name's colour: the light variant of its avatar's tone, from the labels' palette. */
const NAME_TONE: Record<NameTone, Token> = { slate: "lb-slate", sage: "lb-moss", mauve: "lb-plum", sand: "lb-umber" };

/** The avatar: initials on the person's tone; an agent's diamond on its tint; a deleted comment's cross. */
function avatarOf(cm: CommentView): Seg[] {
  if (cm.deleted) return [["✕", { fg: "ink-3" }]];
  if (cm.agent) return [["◈", { fg: "status-done", bg: "tint-done", at: "B" }]];
  return [[cm.initials || "?", { fg: "ink", bg: `avatar-${cm.tone}`, at: "B" }]];
}

/** The title's rows: two at most, the second cut. */
const titleLines = (title: string, room: number) => fieldLines(title, room).slice(0, 2);

/** The reply's text rows: its lines, at least one, at most six and never more than a third of the window. */
const replyRows = (text: string, room: number, h: number) => Math.max(1, Math.min(fieldLines(text, room).length, 6, Math.floor(h / 3)));

/** The reply's box (TuiIssueComments): from the left edge to the scrollbar's column, its keys in the bottom border. */
function paintReply(g: Grid, reply: Field, end: number, y: number, h: number): void {
  const w = end;
  panel(g, 1, y, w, h, {
    title: "Reply",
    keys: [
      ["↵", "send"],
      ["⇧↵", "new line"],
      ["@", "mention"],
      ["⌃E", "editor"],
    ],
  });
  fieldText(g, 3, y + 1, w - 4, h - 2, reply.text, reply.at, "A comment on the issue, in Markdown. @ mentions a person.", "panel", end - 1);
}

/** From this width the properties sit in a panel on the right (TuiIssue); below it, a line under the title (TuiIssue80). */
const WIDE = 120;
/**
 * The text column: where it starts (at the left, as the artboards have it; centring it read as a column gone astray,
 * owner 2026-11-06), how wide it is, and its scrollbar's column (before the panel when there is one).
 */
function mainColumn(columns: number, panel: boolean): { left: number; room: number; end: number } {
  const end = panel ? columns - panelWidth(columns) - 2 : columns - 2;
  return { left: 2, room: Math.min(end - 3, MEASURE), end };
}

/** The title area's rows: the project's row at 2, the title, a blank, the chips; below 120, the properties' line. */
const chipsRow = (title: number) => 3 + title + 1;

/** Where a panel over the screen starts (the state picker): under the chips with the state. */
export function issueAnchor(size: { columns: number }, title: string): { x: number; y: number } {
  const { left, room } = mainColumn(size.columns, size.columns >= WIDE);
  return { x: left + 1, y: chipsRow(titleLines(title, room).length) + 1 };
}

/** The state, the priority, the cycle, the agent it is delegated to, the labels: the TuiIssue artboard's line of chips. */
function chipsOf(c: Card, d: IssueDetails | undefined, narrow: boolean): Seg[] {
  // Chips carry a cell of ground on each side: one more between them makes the artboard's three.
  const gap: Seg = [" ", { fg: "ink" }];
  // A click on a chip presses its key (RSVA-479): the state's picker, the priority's, the labels'.
  const out: Seg[] = [chip(`${c.state.glyph} ${c.state.name}`, { fg: c.state.tone, bg: tintOf(c.state.tone), at: "B", click: "s" })];
  if (c.priority) out.push(gap, ...clicking([[" ", { fg: "ink", bg: "row-selected" }], ...prioritySegs(c.priority, "row-selected"), [` ${priorityName(c.priority)} `, { fg: "ink", bg: "row-selected" }]], "p"));
  if (c.cycle) out.push(gap, chip(c.cycle.name, { fg: "ink", bg: "row-selected", at: "B" }));
  // At 80 columns the agent is its diamond alone, as TuiIssue80 has it.
  if (d?.delegate) out.push(gap, chip(narrow && d.delegate.agent ? "◈" : `${d.delegate.agent ? "◈ " : ""}${d.delegate.email}`, { fg: "status-done", bg: "tint-done", at: "B" }));
  c.brief.labels.forEach((l) => out.push(["  ", { fg: "ink" }], ...clicking([["▪", { fg: l.swatch }], [` ${l.name}`, { fg: "ink-2" }]], "l")));
  return out;
}

/**
 * Paints the screen; returns the first body line shown, how many lines a page is, and where the images in view go.
 * `allKeys` as paintHome's. As the TuiIssue artboards: no card around it; the head with the issues on either side, the
 * project's tile, the key and the parent, the title, its chips, the text with its scrollbar, and from 120 columns the
 * properties in a panel on the right.
 */
export function paintIssue(g: Grid, v: IssueView, allKeys?: string): { top: number; page: number; pictures: Placement[]; heads: number[] } {
  const c = v.card;
  const d = v.details;
  const narrow = g.w < WIDE;
  const panel = !narrow && !!d;
  // The head: its place at the right, between the issues [ and ] go to; then where it was opened from › the key, cut
  // before the place.
  const markEnd = mark(g);
  let placeAt = g.w - 1;
  if (v.place) {
    const p = v.place;
    const middle = `${p.at} of ${p.of}`;
    const near = !narrow && (p.prev || p.next) ? `${p.prev ?? ""}${p.prev ? "    " : ""}${middle}${p.next ? "    " : ""}${p.next ?? ""}` : middle;
    if (near === middle) placeAt = g.textRight(g.w - 1, 0, middle, { fg: "ink-3", bg: "sidebar" });
    else {
      const bracket = { fg: "ink-2", bg: "sidebar", at: "B" } as const;
      placeAt = g.w - 2 - widthOf(`[ ${near} ]`);
      let hx = g.text(placeAt, 0, "[ ", bracket);
      // A click on the issue before or after opens it, as [ and ] do.
      if (p.prev) g.zone(hx, 0, widthOf(p.prev), 1, ["["]);
      hx = g.text(hx, 0, near, { fg: "ink-3", bg: "sidebar" });
      if (p.next) g.zone(hx - widthOf(p.next), 0, widthOf(p.next), 1, ["]"]);
      g.text(hx, 0, " ]", bracket);
    }
  }
  const headEnd = placeAt - 2;
  // A click on where it was opened from goes back there, as Esc does (RSVA-479).
  let x = g.text(markEnd, 0, `  ${v.source}`, { fg: "ink", bg: "sidebar", click: "esc" }, Math.max(markEnd + 4, headEnd - widthOf(c.key) - 3));
  x = g.text(x, 0, " › ", { fg: "faint", bg: "sidebar" }, headEnd);
  g.text(x, 0, c.key, { fg: "ink", bg: "sidebar", at: "B" }, headEnd);
  const { left, room, end } = mainColumn(g.w, panel);
  const right = left + room;
  // The project's tile, the key, the parent.
  let px = left + 1;
  if (d?.project) px = g.text(px, 2, d.project.key, { fg: d.project.tile[0], bg: d.project.tile[1], at: "B" }) + 2;
  px = g.text(px, 2, c.key, { fg: "ink-3" }, right);
  if (d?.parent) segs(g, px + 2, 2, clicking([["in ", { fg: "ink-3" }], [d.parent.key, { fg: "ink-2" }], [` ${d.parent.title}`, { fg: "ink-3" }]], `issue:${d.parent.key}`), right);
  const title = titleLines(c.title, room);
  title.forEach((t, i) => g.text(left, 3 + i, t, { fg: "ink", at: "B" }, right));
  const chips = chipsRow(title.length);
  segs(g, left, chips, chipsOf(c, d, narrow), right);
  let from = chips + 2;
  if (narrow) {
    // The properties folded into a line, as TuiIssue80: `i` opens them above the text.
    const brief = briefLine(c);
    segs(g, left, chips + 1, [...clicking([["i", { fg: "ink-2", at: "B" }], [v.properties ? " hide properties" : " all properties", { fg: "ink-3" }]], "i"), ...(brief.length ? [[" · ", { fg: "faint" }] as Seg] : []), ...brief], right);
    from++;
  }
  const { lines: body, heads } = bodyOf(v, room, !!v.properties);
  // What scrolls, down to the status line or to the reply's box, with its scrollbar in the column after it.
  const box = v.reply === undefined ? 0 : replyRows(v.reply.text, end - 4, g.h) + 2;
  const bottom = g.h - 2 - box;
  const page = Math.max(1, bottom - from);
  const top = Math.max(0, Math.min(v.top, body.length - page));
  const pictures = new Map<Picture, Placement>();
  body.slice(top, top + page).forEach((l, i) => {
    const y = from + i;
    if (l.picture) {
      const { of, row } = l.picture;
      const p = pictures.get(of);
      if (p) p.shown++;
      else pictures.set(of, { src: of.src, x: left + of.at, y, cols: of.cols, rows: of.rows, skip: row, shown: 1 });
    }
    if (l.ground) g.fill(left, y, room, 1, l.ground);
    if (l.rule) g.run(left, y, "─", room, { fg: "rule-soft" });
    for (const [at, list] of l.cols) segs(g, left + at, y, list, right);
    if (l.click) g.zone(left, y, room, 1, [l.click]);
  });
  if (body.length > page) {
    const thumb = Math.max(1, Math.round((page * page) / body.length));
    const at = Math.round((top / (body.length - page)) * (page - thumb));
    for (let i = 0; i < page; i++) g.text(end, from + i, i >= at && i < at + thumb ? "┃" : "│", i >= at && i < at + thumb ? { fg: "ink-3" } : { fg: "rule" });
  }
  if (v.reply !== undefined) paintReply(g, v.reply, end, bottom, box);
  if (panel) paintProperties(g, c, d, { rule: g.w - panelWidth(g.w), from: 2, bottom: g.h - 2, end: g.w - 1 }, true, "i opens them all");
  if (narrow) paintStatusNarrow(g, g.h - 2, v.status);
  else paintStatus(g, g.h - 2, v.status);
  // Tab goes from heading to heading: said only where there is somewhere to go.
  paintKeys(g, g.h - 1, body.length > page ? v.keys : v.keys.filter(([k]) => k !== "Tab"), allKeys ?? (narrow ? "keys" : "all keys"));
  return { top, page, pictures: [...pictures.values()], heads };
}

