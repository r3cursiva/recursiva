// Links to the app's old addresses, rewritten to its address now (PLNR-324). The app moved from one address to
// another with no redirect, so a link people pasted into a comment, a description, a title
// or a link attachment leads nowhere. Run once per move from the server's shell (cli/rehost.ts); a dry run by default.
//
// Only links to the app's pages change: `https://plan.rsva.dev/arsen/browse/PLNR-1` becomes `https://app.rsva.dev/…`
// with the same path. The bare address (`https://plan.rsva.dev`, a name of the site in a sentence about the move), its
// server endpoints (`/api/…`, `/healthz`: what a webhook or a monitor was set to then) and the host written without a
// scheme stay as they are: they record what was true then, and rewritten they would say something false.
//
// Every change goes through the write path a person's edit takes (sync/write.ts) under one server transaction per
// workspace: it is logged and open windows get it; a comment's or a description's old text leaves the log as after any
// edit; history shows who changed the description or the title, and a comment is marked edited. No notification: none
// of these changes mentions anyone new.
//
// Considered: an SQL migration replacing the host in place (open windows and their cached rows would keep the old text,
// and the log would still hold it); the agent API with the bot's token (only a comment's author may edit it, and a
// description would pass through Markdown and lose what only its JSON keeps); rewriting links when they are shown (a
// list of old hosts in the client forever, and agents reading through the API would still get dead links).
import type { DocJSON } from "@rsva/schema/models";
import { and, eq, ilike, inArray, isNull, or, sql as dsql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable, SelectedFields } from "drizzle-orm/pg-core";
import { db, issueKeySql, schema, type Tx } from "./db.ts";
import { applyServerChange, editLink, updateDocument, updateIssue, writeCommentBody } from "./sync/write.ts";
import type { Pending } from "./sync/tx-error.ts";

const { workspace, member, user, project, issue, document, comment, attachment } = schema;

export interface Rule {
  re: RegExp;
  /** The origin links move to, `https://app.rsva.dev`. */
  to: string;
}

/** A link found: `to` is its new address, or null when it stays. */
export interface Hit {
  url: string;
  to: string | null;
}

type Where = "title" | "description" | "comment" | "link";

export interface Found {
  ws: string;
  key: string;
  where: Where;
  /** The row: the issue for a title and a description, else the comment or the attachment. */
  id: string;
  hits: Hit[];
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function rule(from: string[], to: string): Rule {
  if (!from.length) throw new Error("name the old host: --from plan.rsva.dev");
  for (const h of from) if (!HOST.test(h)) throw new Error(`not a host name: ${h}`);
  const origin = new URL(to);
  if (origin.protocol !== "https:" || origin.origin !== to.replace(/\/$/, "")) throw new Error(`not an https origin: ${to}`);
  if (from.some((h) => h.toLowerCase() === origin.host)) throw new Error(`${origin.host} is the address links move to, not an old one`);
  const hosts = from.map((h) => h.replace(/\./g, "\\.")).join("|");
  // The scheme and the host, not followed by more of a host name ("plan.rsva.dev.example.com", "plan.rsva.dev-x").
  return { re: new RegExp(`https?://(?:${hosts})(?![\\w.-])`, "gi"), to: origin.origin };
}

/** The path right after the host decides: none, or one of the server's own endpoints, keeps the link as it is. */
const KEPT = /^(?:$|[^/]|\/(?=$|[\s)\]>"'`.,;:!?])|\/(?:api|healthz)(?![\w-]))/;
/** What is shown of a link in the report: up to the first space or closing bracket. */
const SHOWN = /^[^\s)\]>"'`]*/;

export function rehostText(text: string, r: Rule): { text: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const out = text.replace(r.re, (origin, at: number) => {
    const rest = text.slice(at + origin.length);
    const path = SHOWN.exec(rest)![0].replace(/[.,;:!?]+$/, "");
    const keep = KEPT.test(rest);
    hits.push({ url: origin + path, to: keep ? null : r.to + path });
    return keep ? origin : r.to;
  });
  return { text: out, hits };
}

/**
 * Every string of a description: its text and its attributes (a link's href, an image's src), marks included. A link
 * written as its address is both a text and a href: it is one hit.
 */
export function rehostDoc(doc: DocJSON, r: Rule): { doc: DocJSON; hits: Hit[] } {
  const hits: Hit[] = [];
  const str = (s: string) => {
    const x = rehostText(s, r);
    hits.push(...x.hits);
    return x.text;
  };
  const attrs = <T extends Record<string, unknown>>(a: T): T => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? str(v) : v])) as T;
  const walk = (n: DocJSON): DocJSON => ({
    ...n,
    ...(n.attrs ? { attrs: attrs(n.attrs) } : {}),
    ...(n.marks ? { marks: n.marks.map((m) => (m.attrs ? { ...m, attrs: attrs(m.attrs) } : m)) } : {}),
    ...(n.text !== undefined ? { text: str(n.text) } : {}),
    ...(n.content ? { content: n.content.map(walk) } : {}),
  });
  const out = walk(doc);
  return { doc: out, hits: hits.filter((h, i) => hits.findIndex((x) => x.url === h.url) === i) };
}

const changes = (hits: Hit[]) => hits.some((h) => h.to !== null);

interface Row extends Found {
  workspaceId: string;
  /** The new value of each changed column; empty when every link stays. */
  set: { title?: string; doc?: DocJSON; url?: string; comment?: { issueId: string; was: string; body: string } };
}

/**
 * Rows that name an old host, live issues only; with `lock`, locked for the transaction that rewrites them. A row whose
 * every link stays is listed too, so the report shows what is kept.
 */
async function find(tx: Tx, r: Rule, from: string[], workspaceIds: string[] | null, lock: boolean): Promise<Row[]> {
  const named = (col: PgColumn | SQL) => or(...from.map((h) => ilike(col, `%${h}%`)))!;
  const live = and(isNull(issue.deletedAt), workspaceIds ? inArray(issue.workspaceId, workspaceIds) : undefined);
  const base = { workspaceId: issue.workspaceId, ws: workspace.slug, key: issueKeySql, issueId: issue.id };
  // Live issues with their key, joined to the rows of `table` that hang on them; locked are the rows of `table`.
  const scoped = <F extends SelectedFields>(fields: F, where: SQL, table?: PgTable, on?: SQL) => {
    const q = tx.select({ ...base, ...fields }).from(issue).innerJoin(project, eq(project.id, issue.projectId)).innerJoin(workspace, eq(workspace.id, issue.workspaceId)).$dynamic();
    // A join leaves a partial select's result as it is; only its type says otherwise.
    const joined = (table && on ? q.innerJoin(table, on) : q) as typeof q;
    const ordered = joined.where(and(live, where)).orderBy(issue.workspaceId, issue.number);
    return lock ? ordered.for("update", { of: table ?? issue }) : ordered;
  };
  const row = (t: { workspaceId: string; ws: string; key: string }, where: Where, id: string, hits: Hit[], set: Row["set"]): Row => ({
    workspaceId: t.workspaceId,
    ws: t.ws,
    key: t.key,
    where,
    id,
    hits,
    set: changes(hits) ? set : {},
  });
  const rows: Row[] = [];
  for (const t of await scoped({ title: issue.title }, named(issue.title))) {
    const x = rehostText(t.title, r);
    rows.push(row(t, "title", t.issueId, x.hits, { title: x.text }));
  }
  for (const d of await scoped({ doc: document.doc }, named(dsql`${document.doc}::text`), document, eq(document.id, issue.id))) {
    if (!d.doc) continue;
    const x = rehostDoc(d.doc, r);
    rows.push(row(d, "description", d.issueId, x.hits, { doc: x.doc }));
  }
  for (const c of await scoped({ id: comment.id, body: comment.body }, and(isNull(comment.deletedAt), named(comment.body))!, comment, eq(comment.issueId, issue.id))) {
    const x = rehostText(c.body, r);
    rows.push(row(c, "comment", c.id, x.hits, { comment: { issueId: c.issueId, was: c.body, body: x.text } }));
  }
  for (const l of await scoped({ id: attachment.id, url: attachment.url }, and(eq(attachment.kind, "link"), named(attachment.url))!, attachment, eq(attachment.issueId, issue.id))) {
    const x = rehostText(l.url, r);
    rows.push(row(l, "link", l.id, x.hits, { url: x.text }));
  }
  return rows;
}

/** One row's change through the path an edit takes; null when it stays. */
function write(tx: Tx, txId: string, actorId: string, row: Row): Promise<Pending | null> {
  const { set } = row;
  if (set.title !== undefined) return updateIssue(tx, row.workspaceId, actorId, false, row.id, { title: set.title });
  if (set.doc) return updateDocument(tx, row.workspaceId, txId, { op: "update", m: "Document", id: row.id, set: { doc: set.doc } });
  if (set.comment) return writeCommentBody(tx, row.workspaceId, { id: row.id, issueId: set.comment.issueId, body: set.comment.was }, set.comment.body);
  if (set.url !== undefined) return editLink(tx, row.workspaceId, row.id, { url: set.url });
  return Promise.resolve(null);
}

export interface RehostOptions {
  from: string[];
  to: string;
  /** A workspace's slug: only its rows. */
  ws?: string;
  /** Write as this member (an email); without it nothing is written. */
  as?: string;
}

/** Who writes: the member with this email, in every workspace the rows are in; else an error and nothing is written. */
export async function writer(email: string, rows: { workspaceId: string; ws: string }[]): Promise<{ actorId: string; touched: string[] }> {
  const [actor] = await db.select({ id: user.id }).from(user).where(eq(user.email, email.toLowerCase()));
  if (!actor) throw new Error(`no user ${email}`);
  const touched = [...new Set(rows.map((f) => f.workspaceId))];
  const members = touched.length ? await db.select({ workspaceId: member.workspaceId }).from(member).where(and(eq(member.userId, actor.id), inArray(member.workspaceId, touched))) : [];
  const outside = touched.filter((id) => !members.some((m) => m.workspaceId === id));
  if (outside.length) throw new Error(`${email} is not a member of ${[...new Set(rows.filter((f) => outside.includes(f.workspaceId)).map((f) => f.ws))].join(", ")}: nothing written`);
  return { actorId: actor.id, touched };
}

/**
 * Finds the links and, given `as`, rewrites them: each workspace in one transaction that reads its rows again under
 * lock, so an edit made since the report is neither lost nor overwritten. Returns what was found (and written).
 */
export async function rehost(o: RehostOptions): Promise<Found[]> {
  const r = rule(o.from, o.to);
  let workspaceIds: string[] | null = null;
  if (o.ws) {
    const [w] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.slug, o.ws));
    if (!w) throw new Error(`no workspace ${o.ws}`);
    workspaceIds = [w.id];
  }
  const found = await db.transaction((tx) => find(tx, r, o.from, workspaceIds, false));
  if (!o.as) return found.map(strip);
  const { actorId: actor, touched } = await writer(o.as, found.filter((f) => changes(f.hits)));
  const written: Found[] = [];
  for (const id of touched) {
    let rows: Row[] = [];
    await applyServerChange(id, actor, async (tx, txId) => {
      rows = await find(tx, r, o.from, [id], true);
      const out: Pending[] = [];
      for (const row of rows) {
        const p = await write(tx, txId, actor, row);
        if (p) out.push(p);
      }
      return out;
    });
    written.push(...rows.map(strip));
  }
  // Rows of workspaces with nothing to rewrite are reported as found.
  return [...written, ...found.filter((f) => !touched.includes(f.workspaceId)).map(strip)];
}

const strip = ({ workspaceId: _, set: __, ...f }: Row): Found => f;
