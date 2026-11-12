// An issue's properties as the issue screen's panel shows them (TuiIssue), on that screen and beside the home card
// (PLNR-398), and folded into a line below 120 columns. Moved out of home.ts (RSVA-458): both screens draw them.
import { priorityName } from "@rsva/schema/models";
import { plural } from "@rsva/schema/util";
import { checksName } from "@rsva/display/github";
import type { Grid } from "./grid.ts";
import type { Card } from "./home.ts";
import type { IssueDetails } from "./issue.ts";
import { chip, prioritySegs, segs, type Seg } from "./widgets.ts";

/** The properties panel's width with its rule (TuiIssue): 36 columns, 46 from 160, where an email or a title fits whole (owner, 2026-11-06). */
export const panelWidth = (columns: number) => (columns >= 160 ? 46 : 36);

/** A pull request in two lines, as the panel shows it: number and title, then its state and checks. */
function pullLines(p: IssueDetails["pulls"][number]): Seg[][] {
  const quiet = { fg: "ink-3" } as const;
  const checks: Seg[] = p.checks === "pass" ? [["  ✓", { fg: "success", at: "B" }], [` ${checksName("pass", 0).short}`, { fg: "success" }]] : p.checks === "fail" ? [["  ✗", { fg: "error", at: "B" }], [` ${checksName("fail", p.failing).short}`, { fg: "error" }]] : p.checks ? [["  ◌", { fg: "faint" }], [` ${checksName("run", 0).short}`, quiet]] : [];
  return [
    [[`#${p.number}`, { fg: "ink-2", at: "B" }], [` ${p.title}`, { fg: "ink" }]],
    [chip(p.state || "open", { fg: "ink-2", bg: "nav-current" }), ...checks],
  ];
}

/**
 * The properties panel (TuiIssue), on the issue screen and on the home card (PLNR-398): PROPERTIES, RELATIONS, PULL
 * REQUEST, LINKS, then when it was made and changed. A property with no value is left out, but the delegate: its empty
 * line says how to dispatch. Its rule at `rule`, rows `from` to `bottom` (not included), text up to `end`; `edit` puts
 * `e edit` by its head, `rest` says where the lines it leaves out are.
 */
export function paintProperties(g: Grid, c: Card, d: IssueDetails, at: { rule: number; from: number; bottom: number; end: number }, edit: boolean, rest: string): void {
  const { rule, from, bottom, end } = at;
  for (let y = from; y < bottom; y++) g.text(rule, y, "│", { fg: "rule" });
  const x = rule + 2;
  const quiet = { fg: "ink-3" } as const;
  // Lines first, painted after: a panel taller than its room ends on how many lines it left out. A click on a line
  // presses its key (RSVA-479): a property's picker, the issue or the address it names; none on a new issue's, where
  // keys are letters typed.
  const lines: { label?: string; head?: boolean; segs: Seg[]; click?: string | undefined }[] = [];
  const on = (key: string) => (d.draft ? undefined : key);
  const row = (label: string, segs: Seg[], click?: string) => lines.push({ label, segs, click: click && on(click) });
  const plainRow = (segs: Seg[], click?: string) => lines.push({ segs, click: click && on(click) });
  const head = (name: string) => {
    lines.push({ segs: [] });
    lines.push({ head: true, segs: [[name, { fg: "ink-3", at: "B" }]] });
  };
  row("State", [[`${c.state.glyph} `, { fg: c.state.tone }], [c.state.name, { fg: c.state.tone, at: "B" }]], "s");
  if (c.priority) row("Priority", [...prioritySegs(c.priority), [` ${priorityName(c.priority)}`, { fg: "ink" }]], "p");
  if (d.cycle) {
    row("Cycle", [[d.cycle.name, { fg: "ink", at: "B" }], [` ${d.cycle.dates}`, quiet]]);
    const filled = d.cycle.total ? Math.round((10 * d.cycle.done) / d.cycle.total) : 0;
    row("", [["█".repeat(filled), { fg: "status-progress" }], ["█".repeat(10 - filled), { fg: "rule-strong" }], [` ${d.cycle.done}/${d.cycle.total}`, quiet]]);
  }
  d.assignees.forEach((a, i) => row(i ? "" : "Assignee", [[a.initials || "?", { fg: "ink", bg: `avatar-${a.tone}`, at: "B" }], [` ${a.email}`, { fg: "ink" }]], "a"));
  row("Delegate", d.delegate ? [[d.delegate.agent ? "◈" : "·", { fg: "status-done", bg: "tint-done", at: "B" }], [` ${d.delegate.email}`, { fg: "ink" }]] : [["—", { fg: "faint" }], ...(d.draft ? [] : [["   d dispatches", quiet] as Seg])], d.delegate ? undefined : "d");
  c.brief.labels.forEach((l, i) => row(i ? "" : "Labels", [["▪", { fg: l.swatch }], [` ${l.name}`, { fg: "ink-2" }]], "l"));
  // The key once when the project is named by it.
  if (d.project) row("Project", [[d.project.key, { fg: d.project.tile[0], bg: d.project.tile[1], at: "B" }], ...(d.project.name !== d.project.key ? [[`  ${d.project.name}`, { fg: "ink-2" }] as Seg] : [])], "m");
  if (d.parent) {
    row("Parent", [[d.parent.key, { fg: "ink-2" }]], `issue:${d.parent.key}`);
    row("", [[d.parent.title, quiet]], `issue:${d.parent.key}`);
  }
  if (d.relations.length) {
    head("RELATIONS");
    for (const r of d.relations) row(r.kind, [[`${r.mark.glyph} `, { fg: r.mark.tone }], [r.key, { fg: "ink-2" }]], `issue:${r.key}`);
  }
  if (d.pulls.length) {
    head(d.pulls.length === 1 ? "PULL REQUEST" : "PULL REQUESTS");
    for (const p of d.pulls) for (const l of pullLines(p)) plainRow(l, `open:${p.url}`);
  }
  if (d.links.length) {
    head("LINKS");
    for (const l of d.links) plainRow([[l.site, { fg: "ink", at: "U" }], ...(l.title ? [[` ${l.title}`, quiet] as Seg] : [])], `open:${l.url}`);
  }
  if (!d.draft) {
    lines.push({ segs: [] });
    row("Created", [[`${d.created.day}${d.created.by ? ` · ${d.created.by}` : ""}`, quiet]]);
    row("Updated", [[d.updated, quiet]]);
  }

  g.text(x, from, "PROPERTIES", { fg: "ink-3", at: "B" });
  if (edit) g.textRight(end, from, "e edit", quiet);
  const room = bottom - (from + 2);
  // One property a line, with no blank lines between them (owner, 2026-11-06: the airy panel of PLNR-337 read too loose).
  const shown = lines.length > room ? lines.slice(0, Math.max(0, room - 1)) : lines;
  shown.forEach((l, i) => {
    const y = from + 2 + i;
    if (l.label) g.text(x, y, l.label, quiet);
    segs(g, l.label === undefined ? x : x + 11, y, l.segs, end);
    if (l.click) g.zone(x, y, end - x, 1, [l.click]);
  });
  const left = lines.length - shown.length;
  if (left) g.text(x, from + 2 + shown.length, `… ${plural(left, "more line")}: ${rest}`, { fg: "faint" }, end);
}

/** Who and what is linked, in one line: the assignee, the pull request and its checks, the parent, the relations. */
export function briefLine(card: Card): Seg[] {
  const dot: Seg = [" · ", { fg: "faint" }];
  const b = card.brief;
  const who: Seg[][] = [];
  if (b.assignee) who.push([[b.assignee, { fg: "ink-2" }]]);
  if (b.pr) {
    const mark: Seg[] = b.pr.checks === "pass" ? [["✓", { fg: "success" }]] : b.pr.checks === "fail" ? [["✗", { fg: "error" }]] : b.pr.checks ? [["◌", { fg: "faint" }]] : [];
    who.push([["PR ", { fg: "ink-3" }], [`#${b.pr.number}`, { fg: "ink-2" }], [` ${b.pr.state}${mark.length ? " " : ""}`, { fg: "ink-3" }], ...mark]);
  }
  const rest = [b.parent ? `parent ${b.parent}` : "", b.relations ? plural(b.relations, "relation") : ""].filter(Boolean).join(" · ");
  if (rest) who.push([[rest, { fg: "ink-3" }]]);
  return who.flatMap((w, i) => (i ? [dot, ...w] : w));
}
