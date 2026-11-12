// Imports a bundle (packages/schema/src/bundle.ts) into a workspace. Objects are matched by externalSource + externalId
// within the workspace, so a repeated import updates instead of duplicating, and the same bundle imported under another
// slug makes an independent copy.
//
// Writes are batched: one query reads what the workspace already has for each model, ids are assigned up front
// (existing or new UUIDv7), and rows go in as multi-row upserts. Knowing every id in advance also resolves parents
// (sub-issues, nested labels) in the same insert instead of a second pass.
//
// Prototype: writes the tables directly in one transaction and advances the log by a single "replaced" action so open
// windows take a new snapshot. Dry run, approval and rollback by importId come in the "Agents and import" stage.
//
// A bundle is another system's data, so it does not get to say who people here are (PLNR-32): users are global, and an
// existing user keeps their name and kind (a bundle that called someone an agent, or renamed them, changed them in every
// workspace); an agent is never more than a member; existing memberships keep their role unless the caller asks for
// the bundle's (`updateRoles`); and the slug obeys the rules a new workspace's does.
import { isEmptyDoc, type DocNode } from "@rsva/editor/doc";
import { fromHtml } from "@rsva/editor/html";
import { fromMarkdown, toMarkdown, type MentionResolver } from "@rsva/editor/markdown";
import { capRole, isRole, PEOPLE_LABELS, PEOPLE_STATES, readsAs } from "@rsva/policy";
import { uuidv7 } from "@rsva/protocol";
import type { BundleFile, BundleHeader, BundleIssue, BundleLine, BundleUser } from "@rsva/schema/bundle";
import { FILE_MAX, RESERVED_SLUGS, TITLE_MAX, WORKSPACE_SLUG, cleanName, cleanUrl, filePath, readLink, type DocJSON } from "@rsva/schema/models";
import { and, eq, inArray, sql as dsql, type SQL } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { generateNKeysBetween } from "fractional-indexing";
import type { Readable } from "node:stream";
import { db, schema, type Tx } from "./db.ts";
import { fileType } from "./files/sniff.ts";
import type { BlobStore } from "./files/store.ts";
import { narrowGrants } from "./sync/members.ts";
import { groupBy } from "@rsva/schema/util";

const { workspace, user, member, project, workflowState, label, issue, document, comment, reaction, attachment, blob, inboxMark, syncAction } = schema;

/** Rows per insert statement: ~20 parameters per issue row stays far below Postgres' 65,535. */
const CHUNK = 1000;

export interface ImportOptions {
  /** Roles the bundle states change existing memberships too (still capped as for new ones; the owner's stays). */
  updateRoles?: boolean;
  /** Where the bytes of the bundle's File lines come from, by SHA-256, and the store they go to. */
  files?: { read: (sha256: string) => Readable; store: BlobStore };
  /** The log position the caller decided at: anything written to the workspace since stops the import (`plane:sync`). */
  expectSyncId?: number;
}

export interface ImportResult {
  workspaceId: string;
  counts: Record<string, number>;
  ms: number;
}

export async function importBundle(lines: (BundleHeader | BundleLine)[], opts: ImportOptions = {}): Promise<ImportResult> {
  const started = performance.now();
  const header = lines[0];
  if (header?.m !== "Bundle") throw new Error("the first bundle line must be the header { m: \"Bundle\" }");
  const slug = header.workspace?.slug;
  if (typeof slug !== "string" || !WORKSPACE_SLUG.test(slug)) throw new Error(`workspace slug ${JSON.stringify(slug)}: 3 to 32 lower-case letters, digits and hyphens`);
  if (RESERVED_SLUGS.has(slug)) throw new Error(`workspace slug "${slug}" is reserved`);
  const src = header.source;
  const of = <M extends BundleLine["m"]>(m: M) => lines.filter((l): l is Extract<BundleLine, { m: M }> => l.m === m);

  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspace)
      .values({ slug: header.workspace.slug, name: header.workspace.name })
      .onConflictDoUpdate({ target: workspace.slug, set: { name: header.workspace.name } })
      .returning({ id: workspace.id, lastSyncId: workspace.lastSyncId });
    const wsId = ws!.id;
    // The upsert above holds the row: every write to the workspace takes its log position from it, so none slips in now.
    if (opts.expectSyncId !== undefined && ws!.lastSyncId !== opts.expectSyncId) throw new Error(`"${slug}" changed while importing: log at ${ws!.lastSyncId}, expected ${opts.expectSyncId}`);

    const bundleUsers = of("User");
    const { ids: users, kinds } = await upsertUsers(tx, src, bundleUsers);
    const owner = users.get(header.owner.ext);
    // A mention in the text names a bundle user by ext, like every other reference here.
    const mention: MentionResolver = (ext) => {
      const id = users.get(ext);
      return id ? { id } : null;
    };
    if (owner && kinds.get(owner) !== "human") throw new Error(`the owner ${header.owner.ext} is an agent: a workspace's owner is a person`);
    // Memberships. A new one gets the role the bundle states, else "member"; "owner" goes only to the header's owner and
    // only in a workspace this import creates (anyone else stated as owner becomes an admin), and an agent becomes at most
    // a member. An existing membership is left alone unless updateRoles asks for the stated roles, and even then an owner
    // stays the owner. role: null imports the user only.
    const existing = new Map(
      (await tx.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.workspaceId, wsId))).map((m) => [m.userId, m.role]),
    );
    const rows: { workspaceId: string; userId: string; role: string }[] = [];
    for (const u of bundleUsers) {
      const userId = users.get(u.ext)!;
      if (u.role === null && userId !== owner) continue;
      const before = existing.get(userId);
      if (before !== undefined && (!opts.updateRoles || u.role === undefined || before === "owner")) continue;
      const wanted = userId === owner && existing.size === 0 ? "owner" : u.role === "owner" ? "admin" : (u.role ?? "member");
      rows.push({ workspaceId: wsId, userId, role: capRole(wanted, kinds.get(userId)!) });
    }
    if (rows.length) await tx.insert(member).values(rows).onConflictDoUpdate({ target: [member.workspaceId, member.userId], set: { role: dsql`excluded.role` } });
    // A member whose role the bundle changes: their tokens' grants follow the role, as in the write pipeline.
    for (const r of rows) if (existing.has(r.userId) && existing.get(r.userId) !== r.role && isRole(r.role)) await narrowGrants(tx, wsId, r.userId, r.role);

    const bundleProjects = of("Project");
    const projects = await idsFor(tx, project, eq(project.workspaceId, wsId), src, bundleProjects);
    await upsert(tx, project, bundleProjects.map((p) => ({
      id: projects.get(p.ext)!,
      workspaceId: wsId,
      externalSource: src,
      externalId: p.ext,
      key: p.key,
      name: p.name,
      archivedAt: p.archivedAt ?? null,
      ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    })));

    const bundleStates = of("State");
    // A state or label the import creates is guarded as the migration guarded them (packages/policy, PEOPLE_STATES); one
    // it updates keeps the switch an admin set.
    const newStates = new Set<string>();
    const states = await idsFor(tx, workflowState, inArray(workflowState.projectId, tx.select({ id: project.id }).from(project).where(eq(project.workspaceId, wsId))), src, bundleStates, newStates);
    await upsert(tx, workflowState, bundleStates.map((s) => ({
      id: states.get(s.ext)!,
      projectId: need(projects, s.project.ext, "project"),
      externalSource: src,
      externalId: s.ext,
      name: s.name,
      group: s.group,
      color: s.color,
      position: s.position,
      isDefault: s.isDefault ?? false,
      ...(newStates.has(s.ext) ? { onlyPeople: readsAs(s.name, PEOPLE_STATES) !== null } : {}),
    })));

    const bundleLabels = of("Label");
    const newLabels = new Set<string>();
    const labels = await idsFor(tx, label, eq(label.workspaceId, wsId), src, bundleLabels, newLabels);
    await upsert(tx, label, bundleLabels.map((l) => ({
      id: labels.get(l.ext)!,
      workspaceId: wsId,
      projectId: l.project ? need(projects, l.project.ext, "project") : null,
      parentId: l.parent ? (labels.get(l.parent.ext) ?? null) : null,
      externalSource: src,
      externalId: l.ext,
      name: l.name,
      color: l.color,
      position: l.position ?? 0,
      ...(newLabels.has(l.ext) ? { onlyPeople: readsAs(l.name, PEOPLE_LABELS) !== null } : {}),
    })));

    const bundleIssues = of("Issue");
    const issues = await idsFor(tx, issue, eq(issue.workspaceId, wsId), src, bundleIssues);
    // Column order: fractional indexes by ascending source position within a project.
    const sortKeys = new Map<string, string>();
    for (const list of groupBy(bundleIssues, (i) => i.project.ext).values()) {
      list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const keys = generateNKeysBetween(null, null, list.length);
      list.forEach((i, n) => sortKeys.set(i.ext, keys[n]!));
    }
    await upsert(tx, issue, bundleIssues.map((i) => issueRow(i, wsId, src, {
      id: issues.get(i.ext)!,
      projectId: need(projects, i.project.ext, "project"),
      stateId: need(states, i.state.ext, "state"),
      assigneeIds: [...new Set((i.assignees ?? []).map((r) => users.get(r.ext)).filter(isString))],
      labelIds: [...new Set((i.labels ?? []).map((r) => labels.get(r.ext)).filter(isString))],
      parentId: i.parent ? (issues.get(i.parent.ext) ?? null) : null,
      createdById: i.createdBy ? (users.get(i.createdBy.ext) ?? null) : null,
      sortOrder: sortKeys.get(i.ext)!,
      ...relationRefs(i, issues),
    })));
    await upsert(tx, document, bundleIssues.map((i) => ({ id: issues.get(i.ext)!, workspaceId: wsId, html: "", doc: descriptionOf(i, mention) as DocJSON | null })));

    // Comments: issues and authors are resolved above, parents within the same set (ids are known up front).
    const bundleComments = of("Comment");
    const comments = await idsFor(tx, comment, eq(comment.workspaceId, wsId), src, bundleComments);
    await upsert(tx, comment, bundleComments.map((c) => ({
      id: comments.get(c.ext)!,
      workspaceId: wsId,
      issueId: need(issues, c.issue.ext, "issue"),
      parentId: c.parent ? (comments.get(c.parent.ext) ?? null) : null,
      authorId: c.author ? (users.get(c.author.ext) ?? null) : null,
      externalSource: src,
      externalId: c.ext,
      body: bodyOf(c.body, mention),
      editedAt: c.editedAt ?? null,
      ...(c.createdAt ? { createdAt: c.createdAt } : {}),
      ...(c.deletedAt !== undefined ? { deletedAt: c.deletedAt } : {}),
    })));

    // Reactions have nothing to update; one the user already made here under another id is kept as it is.
    const bundleReactions = of("Reaction");
    const reactions = await idsFor(tx, reaction, eq(reaction.workspaceId, wsId), src, bundleReactions);
    for (const part of chunks(bundleReactions)) {
      await tx
        .insert(reaction)
        .values(part.map((r) => ({
          id: reactions.get(r.ext)!,
          workspaceId: wsId,
          issueId: need(issues, r.issue.ext, "issue"),
          commentId: r.comment ? need(comments, r.comment.ext, "comment") : null,
          userId: need(users, r.user.ext, "user"),
          emoji: r.emoji,
          externalSource: src,
          externalId: r.ext,
          ...(r.createdAt ? { createdAt: r.createdAt } : {}),
        })))
        .onConflictDoNothing();
    }

    // Links: an address that is not http(s) is skipped (counted), the kind follows the address as in the write pipeline.
    const bundleLinks = of("Link");
    const links = await idsFor(tx, attachment, eq(attachment.workspaceId, wsId), src, bundleLinks);
    const linkRows = bundleLinks.flatMap((l) => {
      const url = cleanUrl(l.url);
      if (!url) return [];
      return [{
        id: links.get(l.ext)!,
        workspaceId: wsId,
        issueId: need(issues, l.issue.ext, "issue"),
        kind: readLink(url).kind,
        url,
        title: cleanName(cleanName(l.title ?? "").slice(0, TITLE_MAX)),
        createdById: l.createdBy ? (users.get(l.createdBy.ext) ?? null) : null,
        externalSource: src,
        externalId: l.ext,
        ...(l.createdAt ? { createdAt: l.createdAt } : {}),
      }];
    });
    await upsert(tx, attachment, linkRows);

    // Files: bytes first, through the store's hash check and the upload's type rule, then the attachments on issues.
    const bundleFiles = of("File");
    const blobs = await storeFiles(tx, wsId, bundleFiles, users, opts.files);
    const onIssues = bundleFiles.filter((f) => f.issue);
    const files = await idsFor(tx, attachment, eq(attachment.workspaceId, wsId), src, onIssues);
    await upsert(tx, attachment, onIssues.map((f) => ({
      id: files.get(f.ext)!,
      workspaceId: wsId,
      issueId: need(issues, f.issue!.ext, "issue"),
      kind: "file",
      url: filePath(slug, f.sha256),
      title: cleanName(cleanName(f.name).slice(0, TITLE_MAX)) || "file",
      sha256: f.sha256,
      ...blobs.get(f.sha256)!,
      createdById: f.createdBy ? (users.get(f.createdBy.ext) ?? null) : null,
      externalSource: src,
      externalId: f.ext,
      ...(f.createdAt ? { createdAt: f.createdAt } : {}),
    })));

    // Subscriptions are the person's Subscribe from the start of the log (PLNR-28); a choice they made here stays.
    const bundleSubscriptions = of("Subscription");
    // One upsert cannot touch a row twice: a person's second subscription to an issue is the same one.
    const subscriptionRows = [
      ...new Map(
        bundleSubscriptions.map((x) => {
          const row = { userId: need(users, x.user.ext, "user"), issueId: need(issues, x.issue.ext, "issue"), workspaceId: wsId, subscribed: true };
          return [`${row.userId} ${row.issueId}`, row] as const;
        }),
      ).values(),
    ];
    for (const part of chunks(subscriptionRows)) {
      await tx
        .insert(inboxMark)
        .values(part)
        .onConflictDoUpdate({
          target: [inboxMark.userId, inboxMark.issueId],
          set: { subscribed: true, subscribedId: 0, updatedAt: dsql`clock_timestamp()` },
          setWhere: dsql`${inboxMark.subscribed} is null`,
        });
    }

    // The project's number counter is at least the largest imported number.
    await tx.execute(dsql`
      update project p set issue_counter = greatest(p.issue_counter, coalesce((select max(number) from issue where project_id = p.id), 0))
      where p.workspace_id = ${wsId}`);

    // One log action: open windows reload the snapshot instead of receiving hundreds of deltas.
    const [{ s }] = (await tx.execute(dsql`
      update workspace set last_sync_id = last_sync_id + 1 where id = ${wsId} returning last_sync_id as s`)) as unknown as [{ s: number }];
    await tx.insert(syncAction).values({ workspaceId: wsId, id: Number(s), model: "Workspace", modelId: wsId, action: "R" });

    return {
      workspaceId: wsId,
      counts: {
        users: users.size,
        projects: projects.size,
        states: states.size,
        labels: labels.size,
        issues: issues.size,
        comments: comments.size,
        replies: bundleComments.filter((c) => c.parent && comments.has(c.parent.ext)).length,
        reactions: bundleReactions.length,
        links: linkRows.length,
        skippedLinks: bundleLinks.length - linkRows.length,
        subscriptions: subscriptionRows.length,
        files: blobs.size,
        fileAttachments: onIssues.length,
      },
      ms: Math.round(performance.now() - started),
    };
  });
}

/**
 * Users are global (unique by email); the bundle's external ID maps to whichever row holds the email. A new user takes
 * the bundle's name and kind; an existing one keeps theirs, here and in every other workspace.
 */
async function upsertUsers(tx: Tx, src: string, list: BundleUser[]): Promise<{ ids: Map<string, string>; kinds: Map<string, string> }> {
  const byEmail = new Map(list.map((u) => [u.email, u]));
  const out = new Map<string, { id: string; kind: string }>();
  for (const part of chunks([...byEmail.values()])) {
    await tx
      .insert(user)
      .values(part.map((u) => ({ email: u.email, name: u.name, kind: u.kind ?? "human", externalSource: src, externalId: u.ext })))
      .onConflictDoNothing({ target: user.email });
    const rows = await tx.select({ id: user.id, email: user.email, kind: user.kind }).from(user).where(inArray(user.email, part.map((u) => u.email)));
    for (const r of rows) out.set(r.email, r);
  }
  const ids = new Map(list.map((u) => [u.ext, out.get(u.email)!.id]));
  return { ids, kinds: new Map([...out.values()].map((r) => [r.id, r.kind])) };
}

/**
 * The files of the bundle the workspace does not have yet go through the blob store, which checks each against its name.
 * A rollback leaves bytes in the store, nothing else: orphans in a workspace this import made, found by name in any other.
 */
async function storeFiles(tx: Tx, workspaceId: string, list: BundleFile[], users: Map<string, string>, files: ImportOptions["files"]): Promise<Map<string, { size: number; mime: string }>> {
  if (list.length && !files) throw new Error("the bundle has files: pass where their bytes are (import --files <dir>)");
  const have = await tx.select({ sha256: blob.sha256, size: blob.size, mime: blob.mime }).from(blob).where(eq(blob.workspaceId, workspaceId));
  const out = new Map(have.map((b) => [b.sha256, { size: b.size, mime: b.mime }]));
  for (const f of list) {
    if (out.has(f.sha256)) continue;
    const { size, head } = await files!.store.put(workspaceId, f.sha256, files!.read(f.sha256), FILE_MAX);
    const mime = fileType(head, f.mime);
    await tx.insert(blob).values({ workspaceId, sha256: f.sha256, size, mime, createdById: f.createdBy ? (users.get(f.createdBy.ext) ?? null) : null }).onConflictDoNothing();
    out.set(f.sha256, { size, mime });
  }
  const used = new Set(list.map((f) => f.sha256));
  return new Map([...out].filter(([sha]) => used.has(sha)));
}

/** ext → id for every bundle object: the id the workspace already has for it, or a new one. */
async function idsFor(
  tx: Tx,
  table: typeof project | typeof workflowState | typeof label | typeof issue | typeof comment | typeof reaction | typeof attachment,
  scope: SQL | undefined,
  src: string,
  list: { ext: string }[],
  /** Filled with the external ids not seen before: rows this import creates. */
  fresh?: Set<string>,
): Promise<Map<string, string>> {
  const existing = await tx
    .select({ id: table.id, ext: table.externalId })
    .from(table)
    .where(and(scope, eq(table.externalSource, src)));
  const known = new Map(existing.map((r) => [r.ext!, r.id]));
  for (const x of list) if (!known.has(x.ext)) fresh?.add(x.ext);
  return new Map(list.map((x) => [x.ext, known.get(x.ext) ?? uuidv7()]));
}

/**
 * Multi-row insert by id; a row that exists gets the columns it carries overwritten. Rows that omit a column (createdAt
 * without a source value) keep the stored value, so rows are grouped by their set of columns, one SET clause per group.
 */
async function upsert<T extends PgTable & { id: PgColumn }>(tx: Tx, table: T, rows: Record<string, unknown>[]): Promise<void> {
  for (const group of groupBy(rows, (r) => Object.keys(r).join()).values()) {
    const set = Object.fromEntries(
      Object.keys(group[0]!)
        .filter((k) => k !== "id")
        .map((k) => [k, dsql.raw(`excluded.${toSnakeCase(k)}`)]),
    );
    for (const part of chunks(group)) {
      await tx.insert(table).values(part as never).onConflictDoUpdate({ target: table.id, set: set as never });
    }
  }
}

function issueRow(
  i: BundleIssue,
  workspaceId: string,
  src: string,
  refs: { id: string; projectId: string; stateId: string; assigneeIds: string[]; labelIds: string[]; parentId: string | null; createdById: string | null; sortOrder: string },
) {
  return {
    ...refs,
    workspaceId,
    externalSource: src,
    externalId: i.ext,
    number: i.number,
    title: i.title,
    priority: i.priority,
    startDate: i.startDate ?? null,
    dueDate: i.dueDate ?? null,
    completedAt: i.completedAt ?? null,
    archivedAt: i.archivedAt ?? null,
    ...(i.createdAt ? { createdAt: i.createdAt } : {}),
    ...(i.updatedAt ? { updatedAt: i.updatedAt } : {}),
  };
}

/**
 * An issue's relations as row fields, only those the bundle gives. A self-relation, an issue outside the bundle, or a
 * second relation to the same issue on this end is dropped. The other end is the connector's to keep apart: a pair given
 * on both ends imports as given (connectors/plane-db keeps one per pair).
 */
function relationRefs(i: BundleIssue, issues: Map<string, string>): { blockedByIds?: string[]; relatedIds?: string[]; duplicateOfId?: string | null } {
  const self = issues.get(i.ext);
  const ids = (refs: { ext: string }[]) => [...new Set(refs.map((r) => issues.get(r.ext)).filter((x): x is string => !!x && x !== self))];
  const out: { blockedByIds?: string[]; relatedIds?: string[]; duplicateOfId?: string | null } = {};
  if (i.blockedBy) out.blockedByIds = ids(i.blockedBy);
  if (i.related) out.relatedIds = ids(i.related).filter((x) => !out.blockedByIds?.includes(x));
  if (i.duplicateOf !== undefined) {
    const d = i.duplicateOf ? issues.get(i.duplicateOf.ext) : undefined;
    out.duplicateOfId = d && d !== self && !out.blockedByIds?.includes(d) && !out.relatedIds?.includes(d) ? d : null;
  }
  return out;
}

/**
 * The bundle's description as a document: Markdown (preferred) or HTML, both through packages/editor, mentions mapped from
 * bundle users to ours. Empty is null.
 */
function descriptionOf(i: Pick<BundleIssue, "description" | "descriptionHtml">, mention: MentionResolver): DocNode | null {
  const doc = i.description !== undefined ? fromMarkdown(i.description, { mention }) : i.descriptionHtml ? fromHtml(i.descriptionHtml, { mention }) : null;
  return doc && !isEmptyDoc(doc) ? doc : null;
}

/**
 * A comment's Markdown with its mentions pointing at our users: `mention:<ext>` becomes `mention:<user id>`, an ext the
 * bundle does not have becomes the name as text. A body without a mention is stored exactly as the bundle has it.
 */
function bodyOf(body: string, mention: MentionResolver): string {
  return body.includes("](mention:") ? toMarkdown(fromMarkdown(body, { mention })).trimEnd() : body;
}

function need(map: Map<string, string>, ext: string, what: string): string {
  const id = map.get(ext);
  if (!id) throw new Error(`the bundle has no ${what} with ext=${ext}`);
  return id;
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

function isString(x: string | undefined): x is string {
  return typeof x === "string";
}
