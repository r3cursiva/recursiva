// REST API for agents: issues by key (PLANE-60), states by name, descriptions and comments in Markdown (the dialect of
// packages/editor, the same the browser reads and writes). Every write goes through the same pipeline as the browser
// (applyTx), so it is validated, logged and broadcast the same way, and is checked against the same rights
// (packages/policy). Callers are API tokens (`Authorization: Bearer rsva_…`) or a signed-in browser.
import { DOC_MARKDOWN_MAX, emptyDoc, MENTION_ID, MENTION_SCHEME, mentionsInOrder, type DocNode } from "@rsva/editor/doc";
import { fromMarkdown, toMarkdown } from "@rsva/editor/markdown";
import { movedFrom, uuidv7, type Action, type Op, type SavedView } from "@rsva/protocol";
import { DEFAULT_DISPLAY, needsIssueIndex, ORDER_BYS, parseQuery, runQueryRows, type OrderBy } from "@rsva/query";
import { COMMENT_MAX, RELATION_TYPES, branchName, movedKeysOf, type Project, commitUrl, issueKey, parseIssueKey, pullUrl, relationPatches, UUID, type AttachmentCreate, type DocJSON, type GithubLink, type Issue, type RelationType } from "@rsva/schema/models";
import { and, eq, inArray, sql as dsql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { readSettings } from "./auth/account.ts";
import { cycleRoutes } from "./api-cycles.ts";
import { inboxRoutes } from "./api-inbox.ts";
import { settingsRoutes } from "./api-settings.ts";
import { tokenRoutes } from "./api-tokens.ts";
import {
  defaultStateId,
  issueIdByKey,
  issueIdsByKeys,
  cycleId,
  issueView,
  labelIds,
  loadIssueIndex,
  loadIssues,
  loadNames,
  NameError,
  parentKeys,
  priority,
  projectByKey,
  queryContext,
  relationsAndLinks,
  similarTo,
  stateId,
  userId,
  userIds,
  type Names,
} from "./api-names.ts";
import { needChange, okTx, projectOf, workspaceOf, writeAll, writeTx } from "./api-tx.ts";
import { RateLimited } from "./auth/limits.ts";
import type { Mailer } from "./auth/mail.ts";
import { requireActor } from "./auth/routes.ts";
import { db, issueKeySql, movedUnder, projectKeyIs, schema } from "./db.ts";
import { issueLinks } from "./github/pull.ts";
import { HttpError, MARKDOWN_PUNCTUATION } from "./http.ts";
import { COLUMNS } from "./sync/columns.ts";
import { readHistory } from "./sync/history.ts";
import { isServerTime } from "./sync/log.ts";
import { findView } from "./sync/views.ts";
import { TX_OPS_MAX } from "./sync/write.ts";

type IssueParams = { ws: string; key: string };

/**
 * Mentions in an agent's Markdown name a member by email, `me` or user id: `[@Ann](mention:ann@x.dev)`. An unknown one is
 * an error naming the members, as for assignees; an empty label gets the member's name.
 */
function mentions(n: Names, me: string): (target: string) => { id: string; label: string } {
  return (target) => {
    const id = MENTION_ID.test(target) && n.users.has(target.toLowerCase()) ? target.toLowerCase() : userId(n, me, target);
    return { id, label: n.users.get(id)!.name };
  };
}

/** The Markdown of a request's `description` as a document; undefined when not given, an empty one for "". */
export async function description(v: unknown, names: () => Promise<Names>, me: string): Promise<DocJSON | undefined> {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new NameError("description: Markdown text");
  if (v.length > DOC_MARKDOWN_MAX) throw new NameError(`the description is longer than ${DOC_MARKDOWN_MAX} characters`);
  if (!v.trim()) return emptyDoc() as DocJSON;
  return fromMarkdown(v, v.includes(MENTION_SCHEME) ? { mention: mentions(await names(), me) } : {}) as DocJSON;
}

/** An issue's pull requests and commits as agents read them. */
function githubView(rows: GithubLink[]) {
  return {
    pullRequests: rows
      .filter((r) => r.kind === "pull")
      .map(({ repo, number, title, state, head, base, review, checks, closing, ...r }) => ({ repo, number, title, state, head, base, review, checks, url: pullUrl({ repo, number }), closing, author: r.author, updatedAt: r.at })),
    commits: rows.filter((r) => r.kind === "commit").map(({ repo, sha, title, closing, author, at }) => ({ repo, sha, title, url: commitUrl({ repo, sha }), closing, author, at })),
  };
}

/** Most different people one comment may mention through the API. */
const COMMENT_MENTIONS_MAX = 50;
/** A mention's link destination in Markdown, `](mention:…)`; with `[` right before it, the label is empty. */
const MENTION_DEST = /(\[)?\]\(mention:([^()\s<>]{1,320})\)/g;

/**
 * A comment's Markdown with every mention's target as a user id: comments are stored as Markdown, as written. A body that
 * is not text or is over COMMENT_MAX goes on unparsed, for the write pipeline to refuse.
 */
async function commentBody(body: unknown, names: () => Promise<Names>, me: string): Promise<unknown> {
  if (typeof body !== "string" || body.length > COMMENT_MAX || !body.includes(MENTION_SCHEME)) return body;
  const resolve = mentions(await names(), me);
  const people = new Map<string, { id: string; label: string }>();
  const want = mentionsInOrder(
    fromMarkdown(body, {
      mention: (t) => {
        const person = people.get(t) ?? resolve(t);
        people.set(t, person);
        if (people.size > COMMENT_MENTIONS_MAX) throw new NameError(`a comment mentions at most ${COMMENT_MENTIONS_MAX} people`);
        return person;
      },
    }),
  );
  // One pass over the text: a target becomes the id, an empty label the name (as the composer writes it).
  let rewritten = 0;
  const out = body.replace(MENTION_DEST, (whole, empty: string | undefined, target: string) => {
    const p = people.get(target);
    if (!p) return whole;
    rewritten++;
    return `${empty ? `[@${p.label.replace(MARKDOWN_PUNCTUATION, "\\$&")}` : ""}](${MENTION_SCHEME}${p.id})`;
  });
  // The plain form only: another way to write the link (`<mention:…>`, a title, an escape, inside a code span) would be
  // stored unresolved and silently stop being a mention, so it is refused instead.
  const got = mentionsInOrder(fromMarkdown(out));
  if (rewritten !== want.length || got.join() !== want.join())
    throw new NameError("write a mention as [@Name](mention:<email, me or id>), outside code");
  return out;
}

/**
 * The issue fields of a request, by name, as the write pipeline takes them; only the fields given. The workspace's
 * lookups are read only if a field needs them: a title or a description alone (the common agent edit) costs no reads.
 */
async function issueFields(names: () => Promise<Names>, workspaceId: string, projectId: string, me: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = {};
  if (b.title !== undefined) set.title = b.title;
  if (b.priority !== undefined) set.priority = priority(b.priority);
  if (b.state !== undefined) set.stateId = stateId(await names(), projectId, String(b.state));
  if (b.labels !== undefined) set.labelIds = labelIds(await names(), projectId, b.labels);
  if (b.assignees !== undefined) set.assigneeIds = userIds(await names(), me, b.assignees);
  if (b.delegate !== undefined) set.delegateId = b.delegate === null ? null : userId(await names(), me, String(b.delegate));
  if (b.cycle !== undefined) set.cycleId = b.cycle === null ? null : cycleId(await names(), projectId, String(b.cycle));
  if (b.parent !== undefined) set.parentId = b.parent === null ? null : await issueIdByKey(await names(), workspaceId, String(b.parent));
  for (const k of ["startDate", "dueDate"] as const) if (b[k] !== undefined) set[k] = b[k];
  // true archives or deletes, false restores; the server sets the time.
  for (const [k, field] of [["archived", "archivedAt"], ["deleted", "deletedAt"]] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") throw new NameError(`${k}: true or false`);
    set[field] = b[k] ? new Date().toISOString() : null;
  }
  return set;
}

/** A change to an issue in the trash: it is restored first. */
const inTrash = (key: string) => new HttpError(400, "deleted", `${key} is deleted; PATCH {"deleted": false} restores it`);

/** Workspace and issue of an API path; a 404 when there is no such issue. */
async function issueByKey(req: FastifyRequest<{ Params: IssueParams }>) {
  const w = await workspaceOf(req);
  // Any case: an agent or a person may type "plnr-27". A number no issue can have is no issue, not a failed query.
  const k = parseIssueKey(req.params.key);
  const { project, issue } = schema;
  const columns = { id: issue.id, projectId: issue.projectId, deletedAt: issue.deletedAt, key: issueKeySql };
  const find = (where: SQL) => db.select(columns).from(issue).innerJoin(project, eq(project.id, issue.projectId)).where(and(eq(project.workspaceId, w.workspaceId), where));
  // A project's issue first; a key no project's issue answers to may be one an issue had before a move (PLNR-448).
  let row = k ? (await find(and(projectKeyIs(k.projectKey), eq(issue.number, k.number))!))[0] : undefined;
  if (k && !row) {
    const [p] = await db.select({ key: project.key, formerKeys: project.formerKeys }).from(project).where(and(eq(project.workspaceId, w.workspaceId), projectKeyIs(k.projectKey)));
    row = (await find(movedUnder(movedKeysOf(k.projectKey, k.number, p))))[0];
  }
  if (!row) throw new HttpError(404, "not_found", `no issue ${req.params.key}`);
  return { w, issue: row };
}

/** The moves among a write's actions: each issue's new key in `to` and the key it left. */
function movedKeys(actions: Action[], to: Project | undefined): { key: string; was: string }[] {
  if (!to) return [];
  return actions.flatMap((a) => (a.m === "Issue" && a.a === "U" && a.d?.projectId === to.id ? [{ key: issueKey(to.key, a.d.number as number), was: movedFrom(a.d).was! }] : []));
}

/** The issues with these ids as one bound parameter: sub-issues at any depth can be more than the 65k a statement binds. */
const idIn = (ids: Iterable<string>): SQL => dsql`${schema.issue.id} in (select value::uuid from jsonb_array_elements_text(${JSON.stringify([...ids])}::jsonb))`;

/** Sub-issues of these issues at any depth, deleted ones too (the caller decides), not the issues themselves. */
async function descendants(workspaceId: string, ids: string[]): Promise<string[]> {
  const rows = (await db.execute(dsql`
    with recursive down(id, depth) as (
      select i.id, 1 from issue i where i.workspace_id = ${workspaceId} and i.parent_id in (${dsql.join(ids.map((id) => dsql`${id}::uuid`), dsql`, `)})
      union
      select i.id, down.depth + 1 from issue i join down on i.parent_id = down.id where down.depth < 100
    )
    select distinct id from down`)) as unknown as { id: string }[];
  return rows.map((r) => r.id).filter((id) => !ids.includes(id));
}

export function registerAgentApi(root: FastifyInstance, mailer: Mailer): void {
  // Its own plugin scope: the hooks below apply to these routes only.
  void root.register(async (app) => {
    routes(app, mailer);
  });
}

function routes(app: FastifyInstance, mailer: Mailer): void {
  app.addHook("preHandler", requireActor());

  // Issues of a project (or the workspace) for agents. `q` is the browser's query language (packages/query):
  // state:"In Review" label:proposed -label:security assignee:me updated:last-7-days text; an error comes back with
  // suggestions. `view` (a saved view's name or id, PLNR-74) starts from that view's query and order; `q` narrows it.
  // `order:priority` in the query orders the list as ?order=priority does (PLNR-401); ?order= wins.
  app.get<{ Params: { ws: string }; Querystring: { project?: string; q?: string; view?: string; order?: string; limit?: string } }>(
    "/api/v1/workspaces/:ws/issues",
    async (req, reply) => {
      const w = await workspaceOf(req);
      const n = await loadNames(w.workspaceId);
      const p = req.query.project ? n.byKey.get(req.query.project.toUpperCase()) : undefined;
      if (req.query.project && !p) throw new NameError(`no project ${req.query.project}; projects: ${[...n.byKey.keys()].join(", ")}`);
      let view: SavedView | null = null;
      if (req.query.view) {
        const found = await findView(w.workspaceId, req.actor!.userId, req.query.view);
        if ("error" in found) throw new NameError(found.error);
        view = found;
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
      const query = [view?.query ?? "", req.query.q ?? ""].join(" ").trim();
      const ctx = queryContext(n, req.actor!.userId, p?.id, needsIssueIndex(query) ? await loadIssueIndex(n, w.workspaceId) : undefined, await readSettings(req.actor!.userId));
      const parsed = parseQuery(query, ctx);
      if (parsed.errors.length)
        return reply.code(400).send({ error: "invalid_query", message: parsed.errors.map((e) => e.message).join("; "), errors: parsed.errors.map(({ message, suggestions }) => ({ message, suggestions })) });
      // The order: ?order= as given, else the query's order: (q's after the view's, PLNR-401), else the view's display.
      const viewOrder = view && typeof view.display.orderBy === "string" && view.display.orderBy !== "manual" ? view.display.orderBy : null;
      const order = (req.query.order ?? parsed.order ?? viewOrder ?? "updatedAt") as OrderBy;
      if (!ORDER_BYS.includes(order)) throw new HttpError(400, "invalid", `order: one of ${ORDER_BYS.join(", ")}`);
      const rows = runQueryRows(await loadIssues(w.workspaceId, p?.id), parsed.filter, { ...DEFAULT_DISPLAY, orderBy: order }, ctx);
      const page = rows.slice(0, limit);
      const parents = await parentKeys(n, page);
      return { total: rows.length, issues: page.map((i) => issueView(n, i, parents)) };
    },
  );

  cycleRoutes(app);
  inboxRoutes(app);
  settingsRoutes(app);
  tokenRoutes(app, mailer);

  // An issue for agents: names instead of ids, the description as Markdown.
  app.get<{ Params: IssueParams }>("/api/v1/workspaces/:ws/issues/:key", async (req) => {
    const found = await issueByKey(req);
    const { issue, document } = schema;
    const [[row], [doc], n] = await Promise.all([
      db.select(COLUMNS.Issue).from(issue).where(eq(issue.id, found.issue.id)),
      db.select({ doc: document.doc }).from(document).where(eq(document.id, found.issue.id)),
      loadNames(found.w.workspaceId),
    ]);
    const i = row as Issue;
    const [parents, more, github] = await Promise.all([parentKeys(n, [i]), relationsAndLinks(n, found.w.workspaceId, i), issueLinks(db, [i.id])]);
    const view = issueView(n, i, parents);
    return { ...view, ...more, branch: branchName(view.key, i.title), ...githubView(github), description: doc?.doc ? toMarkdown(doc.doc as DocNode) : "" };
  });

  // Relations by key: {"type": "blocks", "issue": "PLNR-3"} relates the two (a pair has one relation, so an existing one
  // is replaced); DELETE …/relations/PLNR-3 removes it, whichever end stores it. The same ops as the browser's.
  app.post<{ Params: IssueParams; Body: { type?: unknown; issue?: unknown } | null }>("/api/v1/workspaces/:ws/issues/:key/relations", async (req) => {
    const type = req.body?.type as RelationType;
    if (!RELATION_TYPES.includes(type)) throw new HttpError(400, "invalid", `type: one of ${RELATION_TYPES.join(", ")}`);
    return relate(req, String(req.body?.issue ?? ""), type);
  });

  app.delete<{ Params: IssueParams & { other: string } }>("/api/v1/workspaces/:ws/issues/:key/relations/:other", async (req) => relate(req, req.params.other, null));

  const pick = ({ blockedByIds, relatedIds }: { blockedByIds: string[]; relatedIds: string[] }) => ({ blockedByIds, relatedIds });

  async function relate(req: FastifyRequest<{ Params: IssueParams }>, otherKey: string, type: RelationType | null) {
    const found = await issueByKey(req);
    const { issue } = schema;
    const otherId = await issueIdByKey(await loadNames(found.w.workspaceId), found.w.workspaceId, otherKey);
    const cols = { id: issue.id, blockedByIds: issue.blockedByIds, relatedIds: issue.relatedIds, duplicateOfId: issue.duplicateOfId };
    const rows = await db.select(cols).from(issue).where(inArray(issue.id, [found.issue.id, otherId]));
    const a = rows.find((r) => r.id === found.issue.id);
    const b = rows.find((r) => r.id === otherId);
    if (!a || !b || a.id === b.id) throw new NameError("an issue cannot be related to itself");
    // With what was read as the base: a relation added by someone else since stays (write.ts, mergeLists).
    const ops: Op[] = relationPatches(a, b, type).map(({ id, set }) => ({ op: "update", m: "Issue", id, set, base: pick(id === a.id ? a : b) }));
    if (!ops.length) return { ok: true };
    return okTx(await writeTx(req, found.w, ops));
  }

  // Links: {"url": "https://github.com/…/pull/12", "title": "…"}; a GitHub pull request or commit is recognised by its
  // address. Files: {"sha256": "…", "name": "report.pdf"} after PUT /files/:ws/:sha256 has uploaded the bytes (PLNR-50).
  type AttachBody = { url?: unknown; title?: unknown; sha256?: unknown; name?: unknown } | null;
  const attachRoutes: [string, (issueId: string, b: AttachBody) => AttachmentCreate][] = [
    ["links", (issueId, b) => ({ issueId, url: b?.url as string, title: (b?.title as string | undefined) ?? "" })],
    ["files", (issueId, b) => ({ issueId, sha256: b?.sha256 as string, title: b?.name as string })],
  ];
  for (const [path, setOf] of attachRoutes) {
    app.post<{ Params: IssueParams; Body: AttachBody }>(`/api/v1/workspaces/:ws/issues/:key/${path}`, async (req, reply) => {
      const found = await issueByKey(req);
      if (found.issue.deletedAt) throw inTrash(found.issue.key);
      const id = uuidv7();
      const r = await writeTx(req, found.w, [{ op: "create", m: "Attachment", id, set: setOf(found.issue.id, req.body) }]);
      return reply.code(201).send({ ok: true, id, lastSyncId: r.s });
    });
  }

  // DELETE …/links/:id and …/files/:id: an attachment of that kind on this issue. The file's bytes stay: an image in a
  // description or a comment may still show them.
  for (const [path, files] of [["links", false], ["files", true]] as const) {
    app.delete<{ Params: IssueParams & { id: string } }>(`/api/v1/workspaces/:ws/issues/:key/${path}/:id`, async (req) => {
      const found = await issueByKey(req);
      const { attachment } = schema;
      const [a] = UUID.test(req.params.id)
        ? await db.select({ id: attachment.id, kind: attachment.kind }).from(attachment).where(and(eq(attachment.id, req.params.id), eq(attachment.issueId, found.issue.id)))
        : [];
      if (!a || (a.kind === "file") !== files) throw new HttpError(404, "not_found", `no ${files ? "file" : "link"} ${req.params.id} on ${found.issue.key}`);
      return okTx(await writeTx(req, found.w, [{ op: "delete", m: "Attachment", id: a.id }]));
    });
  }

  // A new issue: project by key, state by name (the project's default when left out), labels by name, people by email.
  app.post<{ Params: { ws: string }; Body: Record<string, unknown> | null }>("/api/v1/workspaces/:ws/issues", async (req, reply) => {
    const w = await workspaceOf(req);
    const b = req.body ?? {};
    const n = await loadNames(w.workspaceId);
    const p = projectByKey(n, b.project);
    const id = uuidv7();
    const set = await issueFields(async () => n, w.workspaceId, p.id, req.actor!.userId, b);
    const ops: Op[] = [{ op: "create", m: "Issue", id, projectId: p.id, set: { ...set, title: b.title as string, stateId: (set.stateId as string | undefined) ?? defaultStateId(n, p.id) } } as Op];
    const doc = await description(b.description, async () => n, req.actor!.userId);
    if (doc) ops.push({ op: "update", m: "Document", id, set: { doc } });
    // Agents file issues in batches and duplicates reach triage (PLNR-295): the open issues that look like this one come
    // back with the answer, and a strong match refuses it unless the caller says `force: true`.
    const { similar, strong } = typeof b.title === "string" ? similarTo(n, await loadIssues(w.workspaceId), b.title, { projectId: p.id }) : { similar: [], strong: false };
    if (strong && b.force !== true) {
      const top = similar[0]!;
      return reply.code(409).send({
        error: "similar",
        message: `looks like ${top.key} "${top.title}" (${top.score})${similar.length > 1 ? ` and ${similar.length - 1} more` : ""}; send force: true to create it anyway`,
        similar,
      });
    }
    const r = await writeTx(req, w, ops);
    const created = r.actions.find((a) => a.m === "Issue" && a.a === "I");
    return reply.code(201).send({ ok: true, key: issueKey(p.key, created?.d?.number as number), id, lastSyncId: r.s, similar });
  });

  // Fields by name, only those given: title, state, priority, labels, assignees, delegate, parent, cycle; `description` is
  // Markdown and replaces the whole description ("" clears it); `archived` and `deleted` true or false.
  app.patch<{ Params: IssueParams; Body: Record<string, unknown> | null }>("/api/v1/workspaces/:ws/issues/:key", async (req) => {
    const found = await issueByKey(req);
    const b = req.body ?? {};
    // A deleted issue is in the trash: it is restored first, and only then changed.
    if (found.issue.deletedAt && b.deleted !== false) throw inTrash(found.issue.key);
    const ops: Op[] = [];
    let n: Promise<Names> | undefined;
    const names = () => (n ??= loadNames(found.w.workspaceId));
    // `project` moves the issue (PLNR-448): the state, labels and cycle given with it are the target's names, and those
    // left out are mapped by the server.
    const to = b.project !== undefined ? projectByKey(await names(), b.project) : undefined;
    const moving = !!to && to.id !== found.issue.projectId;
    const set = await issueFields(names, found.w.workspaceId, to?.id ?? found.issue.projectId, req.actor!.userId, b);
    if (moving) set.projectId = to.id;
    if (Object.keys(set).length) ops.push({ op: "update", m: "Issue", id: found.issue.id, set } as Op);
    const doc = await description(b.description, names, req.actor!.userId);
    if (doc) ops.push({ op: "update", m: "Document", id: found.issue.id, set: { doc } });
    needChange(ops, "title, state, priority, labels, assignees, delegate, cycle, parent, startDate, dueDate, project, description, archived, deleted");
    const r = await writeTx(req, found.w, ops);
    const moved = movedKeys(r.actions, to);
    return { ...okTx(r), ...(moved.length ? { key: moved[0]!.key, was: moved[0]!.was } : {}) };
  });

  // Many issues at once (RSVA-303): {"keys": ["RSVA-1", …], …} with the fields of one issue's PATCH but `project` (that is
  // POST …/issues/move), plus `addLabels`/`removeLabels` and `addAssignees`/`removeAssignees`, which change each issue's
  // own list instead of replacing it. State, labels and cycle are names in each issue's project. Rights are checked on
  // every op first; over TX_OPS_MAX the change goes in several transactions (writeAll), as deleting a label does.
  app.patch<{ Params: { ws: string }; Body: Record<string, unknown> | null }>("/api/v1/workspaces/:ws/issues", async (req) => {
    const { keys, project, addLabels, removeLabels, addAssignees, removeAssignees, ...b } = req.body ?? {};
    if (!Array.isArray(keys) || !keys.length || keys.some((k) => typeof k !== "string")) throw new HttpError(400, "invalid", "keys: a list of issue keys");
    if (keys.length > TX_OPS_MAX) throw new HttpError(400, "invalid", `at most ${TX_OPS_MAX} issues change at once`);
    if (project !== undefined) throw new HttpError(400, "invalid", "project: POST …/issues/move moves issues to another project");
    if (b.labels !== undefined && (addLabels !== undefined || removeLabels !== undefined)) throw new HttpError(400, "invalid", "labels replaces the list: not with addLabels or removeLabels");
    if (b.assignees !== undefined && (addAssignees !== undefined || removeAssignees !== undefined))
      throw new HttpError(400, "invalid", "assignees replaces the list: not with addAssignees or removeAssignees");
    const lists = Object.entries({ addLabels, removeLabels, addAssignees, removeAssignees }).filter(([, v]) => v !== undefined);
    needChange({ ...b, ...Object.fromEntries(lists) }, "title, state, priority, labels, addLabels, removeLabels, assignees, addAssignees, removeAssignees, delegate, cycle, parent, startDate, dueDate, description, archived, deleted");
    const w = await workspaceOf(req);
    const n = await loadNames(w.workspaceId);
    const names = async () => n;
    const me = req.actor!.userId;
    const ids = new Set(await issueIdsByKeys(n, w.workspaceId, keys as string[]));
    const { issue } = schema;
    const rows = await db
      .select({ id: issue.id, projectId: issue.projectId, deletedAt: issue.deletedAt, labelIds: issue.labelIds, assigneeIds: issue.assigneeIds, key: issueKeySql })
      .from(issue)
      .innerJoin(schema.project, eq(schema.project.id, issue.projectId))
      .where(inArray(issue.id, [...ids]));
    const trashed = b.deleted === false ? undefined : rows.find((r) => r.deletedAt);
    if (trashed) throw inTrash(trashed.key);
    const people = { add: addAssignees === undefined ? [] : userIds(n, me, addAssignees), remove: removeAssignees === undefined ? [] : userIds(n, me, removeAssignees) };
    const doc = await description(b.description, names, me);
    // Names resolve per project: "Done" is a different state in each.
    const byProject = new Map<string, { set: Record<string, unknown>; add: string[]; remove: string[] }>();
    for (const projectId of new Set(rows.map((r) => r.projectId))) {
      byProject.set(projectId, {
        set: await issueFields(names, w.workspaceId, projectId, me, b),
        add: addLabels === undefined ? [] : labelIds(n, projectId, addLabels),
        remove: removeLabels === undefined ? [] : labelIds(n, projectId, removeLabels),
      });
    }
    const first: Op[] = [];
    for (const r of rows) {
      const p = byProject.get(r.projectId)!;
      const set = { ...p.set };
      const base: Record<string, string[]> = {};
      // Each issue keeps the rest of its own list; the list as read is the base, so what someone adds meanwhile stays.
      for (const [field, change] of [["labelIds", p], ["assigneeIds", people]] as const) {
        const now = r[field];
        const list = [...now.filter((x) => !change.remove.includes(x)), ...change.add.filter((x) => !now.includes(x))];
        if (list.length === now.length && list.every((x, i) => x === now[i])) continue;
        set[field] = list;
        base[field] = [...now];
      }
      if (Object.keys(set).length) first.push({ op: "update", m: "Issue", id: r.id, set, ...(Object.keys(base).length ? { base } : {}) } as Op);
      if (doc) first.push({ op: "update", m: "Document", id: r.id, set: { doc } });
    }
    if (!first.length) return { ok: true, changed: 0 };
    return { ok: true, lastSyncId: await writeAll(req, w, { first, last: [] }), changed: new Set(first.map((o) => o.id)).size };
  });

  // Many issues to one project in one transaction (PLNR-448): {"issues": ["RSVA-1", …], "project": "DROMO"}; with
  // `"subIssues": true` their sub-issues at any depth go too (deleted ones stay). Issues already there are left alone.
  app.post<{ Params: { ws: string }; Body: { issues?: unknown; project?: unknown; subIssues?: unknown } | null }>("/api/v1/workspaces/:ws/issues/move", async (req) => {
    const b = req.body ?? {};
    const keys = b.issues;
    if (!Array.isArray(keys) || !keys.length || keys.some((k) => typeof k !== "string")) throw new HttpError(400, "invalid", "issues: a list of keys");
    if (keys.length > TX_OPS_MAX) throw new HttpError(400, "invalid", `at most ${TX_OPS_MAX} issues move at once`);
    if (b.subIssues !== undefined && typeof b.subIssues !== "boolean") throw new HttpError(400, "invalid", "subIssues: true or false");
    const { w, n, p } = await projectOf(req, b.project);
    const listed = new Set(await issueIdsByKeys(n, w.workspaceId, keys as string[]));
    const ids = new Set(listed);
    if (b.subIssues) for (const id of await descendants(w.workspaceId, [...listed])) ids.add(id);
    const { issue } = schema;
    const rows = await db.select({ id: issue.id, projectId: issue.projectId, deletedAt: issue.deletedAt, key: issueKeySql }).from(issue).innerJoin(schema.project, eq(schema.project.id, issue.projectId)).where(idIn(ids));
    const trashed = rows.find((r) => r.deletedAt && listed.has(r.id));
    if (trashed) throw inTrash(trashed.key);
    // A deleted sub-issue stays where it is: it is restored first, as a deleted issue is.
    const ops: Op[] = rows.filter((r) => r.projectId !== p.id && !r.deletedAt).map((r) => ({ op: "update", m: "Issue", id: r.id, set: { projectId: p.id } }));
    if (ops.length > TX_OPS_MAX) throw new HttpError(400, "invalid", `at most ${TX_OPS_MAX} issues move at once`);
    if (!ops.length) return { ok: true, moved: [] };
    const r = await writeTx(req, w, ops);
    return { ...okTx(r), moved: movedKeys(r.actions, p) };
  });

  // Into the project's trash, as the browser's Delete: PATCH {"deleted": false} restores it.
  app.delete<{ Params: IssueParams }>("/api/v1/workspaces/:ws/issues/:key", async (req) => {
    const found = await issueByKey(req);
    return okTx(await writeTx(req, found.w, [{ op: "update", m: "Issue", id: found.issue.id, set: { deletedAt: new Date().toISOString() } }]));
  });

  // A comment in Markdown, as the browser composer writes it; `parentId` makes it a reply.
  app.post<{ Params: IssueParams; Body: { body?: string; parentId?: string | null } | null }>(
    "/api/v1/workspaces/:ws/issues/:key/comments",
    async (req, reply) => {
      const found = await issueByKey(req);
      const id = uuidv7();
      const body = await commentBody(req.body?.body, () => loadNames(found.w.workspaceId), req.actor!.userId);
      const set = { issueId: found.issue.id, body: body as string, ...(req.body?.parentId ? { parentId: req.body.parentId } : {}) };
      const r = await writeTx(req, found.w, [{ op: "create", m: "Comment", id, set }]);
      return reply.code(201).send({ ok: true, id, lastSyncId: r.s });
    },
  );

  /** The issue of the path, which has the comment of the path; a 404 when it does not. */
  async function commentOn(req: FastifyRequest<{ Params: IssueParams & { id: string } }>) {
    const found = await issueByKey(req);
    const { comment } = schema;
    const [c] = UUID.test(req.params.id) ? await db.select({ id: comment.id }).from(comment).where(and(eq(comment.id, req.params.id), eq(comment.issueId, found.issue.id))) : [];
    if (!c) throw new HttpError(404, "not_found", `no comment ${req.params.id} on ${found.issue.key}`);
    return found;
  }

  // One's own comment: PATCH {"body": "…"} replaces its Markdown; DELETE leaves a tombstone, so its replies keep their
  // thread. Only the author may do either (write.ts, ownComment).
  app.patch<{ Params: IssueParams & { id: string }; Body: { body?: string } | null }>("/api/v1/workspaces/:ws/issues/:key/comments/:id", async (req) => {
    const found = await commentOn(req);
    const body = await commentBody(req.body?.body, () => loadNames(found.w.workspaceId), req.actor!.userId);
    return okTx(await writeTx(req, found.w, [{ op: "update", m: "Comment", id: req.params.id, set: { body: body as string } }]));
  });

  app.delete<{ Params: IssueParams & { id: string } }>("/api/v1/workspaces/:ws/issues/:key/comments/:id", async (req) => {
    const found = await commentOn(req);
    return okTx(await writeTx(req, found.w, [{ op: "delete", m: "Comment", id: req.params.id }]));
  });

  // The issue's comments for agents: Markdown bodies in order, authors by email, deleted ones left out. The newest page of
  // the issue's activity (sync/history.ts); `older`, when set, is the `until` of the page before.
  app.get<{ Params: IssueParams; Querystring: { until?: string } }>("/api/v1/workspaces/:ws/issues/:key/comments", async (req) => {
    const until = req.query.until;
    if (until !== undefined && !isServerTime(until)) throw new HttpError(400, "invalid", "until: the older value of an answer");
    const found = await issueByKey(req);
    const page = await readHistory(req.actor!.userId, found.issue.id, until);
    if (page === "rate_limited") throw new RateLimited(60, "too many comment requests");
    const comments = page!.comments.filter((c) => !c.deletedAt);
    const ids = [...new Set(comments.map((c) => c.authorId).filter((x) => x !== null))];
    const { user } = schema;
    const emails = new Map(ids.length ? (await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, ids))).map((u) => [u.id, u.email]) : []);
    return {
      comments: comments.map((c) => ({
        id: c.id,
        parentId: c.parentId,
        author: c.authorId ? (emails.get(c.authorId) ?? null) : null,
        body: c.body,
        createdAt: c.createdAt,
        editedAt: c.editedAt,
        // Where it was written when not in the app or the API: "telegram", "email" (PLNR-369).
        ...(c.via ? { via: c.via } : {}),
      })),
      older: page!.older,
    };
  });
}
