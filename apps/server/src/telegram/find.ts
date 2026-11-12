// /find in the person's chat (PLNR-362): the app's query language, with its short forms (#project @who !priority +label),
// run over every workspace the person reads, as the agent API runs it (api.ts). The answer is a page of five like /my's.
//
// A button carries only its page ("f:5"): the query is read back from the message being redrawn, whose first line is the
// header "Find · <query> · 6–10 of 23". A query too long to keep there is not run.
import { DEFAULT_DISPLAY, errorSentence, needsIssueIndex, parseQuery, runQueryRows } from "@rsva/query";
import type { Issue } from "@rsva/schema/models";
import { keyOf, loadIssueIndex, loadIssues, loadNames, queryContext } from "../api-names.ts";
import { html, type Part } from "../mail/template.ts";
import { reads } from "../sync/limits.ts";
import { BUSY, joined, MY_COST, PAGE, pageAt, range, title, turns, type Page } from "./lists.ts";
import { workspacesOf } from "../auth/access.ts";
import { readSettings } from "../auth/account.ts";

/** Longest query: it must come back whole from the header. */
const QUERY_MAX = 200;

const HOWTO =
  "<b>Find</b>\nSearch issues with the app's query language:\n" +
  "<code>/find #INFRA @me</code> — mine in a project\n" +
  "<code>/find !urgent +bug</code> — urgent bugs\n" +
  "<code>/find PLNR-362</code> — by key\n" +
  "<code>/find state:\"In Review\" updated:last-7-days</code>\n" +
  "<code>/find login page</code> — words in the title";

/** The query a /find message was drawn for, from its text; null when it is not one. */
export function queryOf(text: string | undefined): string | null {
  const m = /^Find · (.+?)(?: · \d+–\d+ of \d+)?$/.exec((text ?? "").split("\n")[0]!);
  return m ? m[1]! : null;
}

/** /find: issues matching `query` in every readable workspace, newest update first, five from `offset`. */
export async function findPage(userId: string, query: string | null, offset: number): Promise<Page> {
  const q = (query ?? "").replace(/\s+/g, " ").trim();
  if (!q) return { text: HOWTO, buttons: [] };
  if (q.length > QUERY_MAX) return { text: `The query is longer than ${QUERY_MAX} characters.`, buttons: [] };
  const list = await workspacesOf(userId, "read");
  if (!reads.take(userId, MY_COST * Math.max(1, list.length))) return { text: BUSY, buttons: [] };
  const calendar = await readSettings(userId);
  const found = await Promise.all(
    list.map(async (w) => {
      const n = await loadNames(w.id);
      const ctx = queryContext(n, userId, undefined, needsIssueIndex(q) ? await loadIssueIndex(n, w.id) : undefined, calendar);
      const parsed = parseQuery(q, ctx);
      return { w, n, ctx, parsed };
    }),
  );
  // A name that one workspace lacks may exist in another: workspaces that read the query cleanly answer it. When none
  // does, the valid part of the query applies everywhere and the errors are shown.
  const clean = found.filter((f) => !f.parsed.errors.length);
  const errors = clean.length ? [] : [...new Map(found.flatMap((f) => f.parsed.errors).map((e) => [e.message, e])).values()];
  const rows: { issue: Issue; key: string; slug: string }[] = [];
  for (const f of clean.length ? clean : found) {
    const hits = runQueryRows(await loadIssues(f.w.id), f.parsed.filter, { ...DEFAULT_DISPLAY, orderBy: "updatedAt" }, f.ctx);
    for (const issue of hits) rows.push({ issue, key: keyOf(f.n, issue), slug: f.w.slug });
  }
  rows.sort((a, b) => Date.parse(b.issue.updatedAt) - Date.parse(a.issue.updatedAt));
  const at = pageAt(offset, rows.length);
  const shown = rows.slice(at, at + PAGE);
  const lines: Part[] = [html`<b>Find</b> · ${q}${range(at, shown.length, rows.length)}`];
  for (const e of errors) lines.push(html`${errorSentence(q, e)}`);
  if (!rows.length) lines.push("Nothing found.");
  const names = new Map(found.map((f) => [f.w.slug, f.n]));
  for (const { issue, key, slug } of shown) lines.push(html`<code>${key}</code> · ${names.get(slug)!.states.get(issue.stateId)?.name ?? ""}`, title(key, slug, issue.title));
  const buttons = turns(at, rows.length, (o) => `f:${o}`);
  return { text: joined(lines), buttons: buttons.length ? [buttons] : [] };
}
