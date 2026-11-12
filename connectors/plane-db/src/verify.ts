// Checks an import against the Plane database copy it came from. Prints counts only (no titles, bodies or emails).
//
//   node connectors/plane-db/src/verify.ts --plane postgres://…/plane_copy --planner postgres://…/planner --workspace atlas
//
// Plane's side is counted with its own SQL, not through map.ts, so a mapping mistake shows up as a difference.
// The planner's side counts rows of the workspace that carry a Plane id ("matched") and all rows ("total": rows made
// locally or by a later import from the API are extra, never duplicates: (workspace, source, id) is unique).
//
// Formatting: every description and comment is counted twice, in Plane's HTML (regular expressions over the raw HTML)
// and in what the planner stores (the description's document, the comment's Markdown parsed by packages/editor), for
// headings, lists, list and task items, code blocks, inline code, quotes, rules and links. Differences are reported per
// kind as a number of documents.
//
// Exits non-zero as verdict.ts decides. A row deleted in Plane stays here (the import never deletes): it is left out of the
// comparison and reported.
import { parseArgs } from "node:util";
import { PRIORITY } from "@rsva/connector-plane/plane";
import type { DocNode } from "@rsva/editor/doc";
import { fromMarkdown } from "@rsva/editor/markdown";
import { IMAGE_TYPES, readFilePath } from "@rsva/schema/models";
import postgres from "postgres";
import { connect } from "./read.ts";
import { failures } from "./verdict.ts";

const { values } = parseArgs({ options: { plane: { type: "string" }, rsva: { type: "string" }, workspace: { type: "string" } } });
if (!values.plane || !values.rsva || !values.workspace) throw new Error("usage: verify.ts --plane <url> --rsva <url> --workspace <slug>");
const slug = values.workspace;

const KINDS = ["headings", "bulletLists", "orderedLists", "taskLists", "listItems", "taskItems", "codeBlocks", "inlineCode", "quotes", "rules", "links", "images"] as const;
type Kind = (typeof KINDS)[number];
type Counts = Record<Kind, number>;
const zero = (): Counts => Object.fromEntries(KINDS.map((k) => [k, 0])) as Counts;

/** Structure of Plane's HTML, counted on the raw markup. */
function htmlCounts(html: string | null): Counts {
  const c = zero();
  if (!html) return c;
  const n = (re: RegExp) => html.match(re)?.length ?? 0;
  c.headings = n(/<h[1-6]\b/gi);
  c.taskLists = n(/<ul\b[^>]*data-type="taskList"/gi);
  c.bulletLists = n(/<ul\b/gi) - c.taskLists;
  c.orderedLists = n(/<ol\b/gi);
  c.taskItems = n(/<li\b[^>]*data-type="taskItem"/gi);
  c.listItems = n(/<li\b/gi) - c.taskItems;
  c.codeBlocks = n(/<pre\b/gi);
  c.inlineCode = n(/<code\b/gi) - n(/<pre\b[^>]*>\s*<code\b/gi);
  c.quotes = n(/<blockquote\b/gi);
  c.rules = n(/<hr\b/gi) + n(/data-type="horizontalRule"/gi);
  c.links = n(/<a\b[^>]*\bhref="(https?:|mailto:)/gi) + n(/<img\b[^>]*\bsrc="https?:/gi);
  c.images = n(/<image-component\b[^>]*\bsrc="[^"]+"/gi);
  return c;
}

/** The same structure in a stored document. A link or inline code is one run of text carrying the mark. */
function docCounts(doc: DocNode | null): Counts {
  const c = zero();
  const NODE: Partial<Record<DocNode["type"], Kind>> = {
    heading: "headings", bullet_list: "bulletLists", ordered_list: "orderedLists", task_list: "taskLists", list_item: "listItems",
    task_item: "taskItems", code_block: "codeBlocks", blockquote: "quotes", horizontal_rule: "rules", image: "images",
  };
  const walk = (n: DocNode) => {
    const k = NODE[n.type];
    if (k) c[k]++;
    if (n.type === "image") shown.add(readFilePath(String(n.attrs?.src))?.sha256 ?? "");
    let href: string | null = null;
    let code = false;
    for (const ch of n.content ?? []) {
      if (ch.type === "text") {
        const h = ch.marks?.find((m) => m.type === "link")?.attrs?.href ?? null;
        const isCode = !!ch.marks?.some((m) => m.type === "code");
        if (h && h !== href) c.links++;
        if (isCode && !code) c.inlineCode++;
        href = h;
        code = isCode;
      } else {
        href = null;
        code = false;
        walk(ch);
      }
    }
  };
  if (doc) walk(doc);
  return c;
}

/** The files images in the planner's text show. */
const shown = new Set<string>();

const plane = connect(values.plane);
const rsva = postgres(values.rsva, { max: 1, onnotice: () => {} });

try {
  const [ws] = await rsva`select id from workspace where slug = ${slug}`;
  if (!ws) throw new Error(`no workspace "${slug}" in the recursiva database`);
  const w = ws.id as string;

  // Plane: live rows, the way the planner should hold them.
  const [p] = await plane`
    with ws as (select id from workspaces where slug = ${slug} and deleted_at is null),
    pr as (select id, archived_at from projects where workspace_id = (select id from ws) and deleted_at is null),
    st as (select id from states where project_id in (select id from pr) and deleted_at is null and not is_triage and "group" <> 'triage'),
    li as (select id, archived_at from issues where workspace_id = (select id from ws) and deleted_at is null and not coalesce(is_draft, false)
             and project_id in (select id from pr) and state_id in (select id from st)),
    co as (select id, parent_id from issue_comments where issue_id in (select id from li) and deleted_at is null),
    mem as (select member_id from workspace_members where workspace_id = (select id from ws) and deleted_at is null)
    select
      (select count(*) from pr)::int as projects,
      (select count(*) from pr where archived_at is not null)::int as "projectsArchived",
      (select count(*) from st)::int as states,
      (select count(*) from labels where workspace_id = (select id from ws) and deleted_at is null)::int as labels,
      (select count(*) from labels where workspace_id = (select id from ws) and deleted_at is null and parent_id is not null)::int as "labelsNested",
      (select count(*) from li where archived_at is null)::int as "issuesLive",
      (select count(*) from li where archived_at is not null)::int as "issuesArchived",
      (select count(distinct (a.issue_id, a.assignee_id)) from issue_assignees a where a.issue_id in (select id from li) and a.deleted_at is null)::int as "assigneeLinks",
      (select count(distinct (l.issue_id, l.label_id)) from issue_labels l join labels lb on lb.id = l.label_id and lb.deleted_at is null
         where l.issue_id in (select id from li) and l.deleted_at is null)::int as "labelLinks",
      (select count(*) from co where parent_id is null)::int as "commentsTop",
      (select count(*) from co where parent_id is not null)::int as replies,
      (select count(distinct c.parent_id) from co c join issue_comments pc on pc.id = c.parent_id where pc.deleted_at is not null)::int as "commentTombstones",
      (select count(*) from issue_reactions r where r.issue_id in (select id from li) and r.deleted_at is null)::int as "issueReactions",
      (select count(*) from comment_reactions r where r.comment_id in (select id from co) and r.deleted_at is null)::int as "commentReactions",
      (select count(*) from file_assets f where f.entity_type = 'ISSUE_ATTACHMENT' and f.is_uploaded and f.deleted_at is null and not f.is_deleted
         and f.issue_id in (select id from li))::int as "fileAttachments",
      (select count(*) from mem)::int as members`;

  // The planner: rows carrying an id the Plane copy has (a later API import or local work adds others, counted below).
  const known = (
    await plane`
      with ws as (select id from workspaces where slug = ${slug})
      select id::text from projects where workspace_id = (select id from ws) and deleted_at is null
      union all select id::text from states where workspace_id = (select id from ws) and deleted_at is null
      union all select id::text from labels where workspace_id = (select id from ws) and deleted_at is null
      union all select id::text from issues where workspace_id = (select id from ws) and deleted_at is null
      union all select id::text from issue_comments c where workspace_id = (select id from ws)
        and (deleted_at is null or exists (select 1 from issue_comments r where r.parent_id = c.id and r.deleted_at is null))
      union all select id::text from issue_reactions where workspace_id = (select id from ws) and deleted_at is null
      union all select id::text from comment_reactions where workspace_id = (select id from ws) and deleted_at is null
      union all select id::text from file_assets where workspace_id = (select id from ws) and deleted_at is null and not is_deleted`
  ).map((r) => r.id as string);
  const [q] = await rsva`
    select
      (select count(*) from project where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}))::int as projects,
      (select count(*) from project where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and archived_at is not null)::int as "projectsArchived",
      (select count(*) from workflow_state s join project p on p.id = s.project_id where p.workspace_id = ${w} and s.external_source = 'plane' and s.external_id = any(${known}))::int as states,
      (select count(*) from label where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}))::int as labels,
      (select count(*) from label where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and parent_id is not null)::int as "labelsNested",
      (select count(*) from issue where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and archived_at is null)::int as "issuesLive",
      (select count(*) from issue where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and archived_at is not null)::int as "issuesArchived",
      (select coalesce(sum(cardinality(assignee_ids)), 0) from issue where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}))::int as "assigneeLinks",
      (select coalesce(sum(cardinality(label_ids)), 0) from issue where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}))::int as "labelLinks",
      (select count(*) from comment where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and parent_id is null and deleted_at is null)::int as "commentsTop",
      (select count(*) from comment where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and parent_id is not null and deleted_at is null)::int as replies,
      (select count(*) from comment where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and deleted_at is not null)::int as "commentTombstones",
      (select count(*) from reaction where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and comment_id is null)::int as "issueReactions",
      (select count(*) from reaction where workspace_id = ${w} and external_source = 'plane' and external_id = any(${known}) and comment_id is not null)::int as "commentReactions",
      (select count(*) from attachment where workspace_id = ${w} and kind = 'file' and external_source = 'plane' and external_id = any(${known}))::int as "fileAttachments",
      (select count(*) from member where workspace_id = ${w})::int as members`;

  // Moved earlier and deleted in Plane since.
  const [gone] = await rsva`
    select (select count(*) from issue where workspace_id = ${w} and external_source = 'plane' and not external_id = any(${known}))::int as issues,
      (select count(*) from comment where workspace_id = ${w} and external_source = 'plane' and deleted_at is null and not external_id = any(${known}))::int as comments,
      (select count(*) from attachment where workspace_id = ${w} and kind = 'file' and external_source = 'plane' and not external_id = any(${known}))::int as files`;

  // Everything in the workspace, for a workspace where a later API import and local work added rows.
  const [all] = await rsva`
    select (select count(*) from issue where workspace_id = ${w})::int as issues,
      (select count(*) from comment where workspace_id = ${w} and deleted_at is null)::int as comments,
      (select count(*) from project where workspace_id = ${w})::int as projects`;

  // What the connector moves, as `li` above says.
  const moved = plane`i.deleted_at is null and not coalesce(i.is_draft, false)
    and i.project_id in (select id from projects where deleted_at is null)
    and i.state_id in (select id from states where deleted_at is null and not is_triage and "group" <> 'triage')`;
  // Per issue: assignee and label sets, comment counts, fields.
  const planeIssues = await plane`
    select i.id::text, i.sequence_id as number, md5(i.name) as title, i.state_id::text as state, i.priority, i.parent_id::text as parent,
      i.archived_at is not null as archived, i.description_html as html,
      (select coalesce(array_agg(distinct u.email order by u.email), '{}') from issue_assignees a join users u on u.id = a.assignee_id
         where a.issue_id = i.id and a.deleted_at is null) as assignees,
      (select coalesce(array_agg(distinct l.label_id::text order by l.label_id::text), '{}') from issue_labels l join labels lb on lb.id = l.label_id
         and lb.deleted_at is null where l.issue_id = i.id and l.deleted_at is null) as labels,
      (select count(*) from issue_comments c where c.issue_id = i.id and c.deleted_at is null)::int as comments
    from issues i join workspaces w on w.id = i.workspace_id where w.slug = ${slug} and ${moved}`;
  const ourIssues = await rsva`
    select i.external_id as id, i.number, md5(i.title) as title, s.external_id as state, i.priority, pi.external_id as parent,
      i.archived_at is not null as archived, d.doc,
      (select coalesce(array_agg(distinct u.email order by u.email), '{}') from "user" u where u.id = any(i.assignee_ids)) as assignees,
      (select coalesce(array_agg(distinct l.external_id order by l.external_id), '{}') from label l where l.id = any(i.label_ids)) as labels,
      (select count(*) from comment c where c.issue_id = i.id and c.deleted_at is null and c.external_source = 'plane' and c.external_id = any(${known}))::int as comments
    from issue i join workflow_state s on s.id = i.state_id left join issue pi on pi.id = i.parent_id left join document d on d.id = i.id
    where i.workspace_id = ${w} and i.external_source = 'plane'`;
  const byId = new Map(ourIssues.map((r) => [r.id as string, r]));
  const fieldDiffs: Record<string, number> = { missing: 0, number: 0, title: 0, state: 0, priority: 0, parent: 0, archived: 0, assignees: 0, labels: 0, comments: 0 };
  const fmt = { plane: zero(), rsva: zero(), docsWithDiff: zero() };
  const add = (a: Counts, b: Counts) => KINDS.forEach((k) => (a[k] += b[k]));
  const compare = (html: string | null, doc: DocNode | null) => {
    const h = htmlCounts(html);
    const d = docCounts(doc);
    add(fmt.plane, h);
    add(fmt.rsva, d);
    KINDS.forEach((k) => h[k] !== d[k] && fmt.docsWithDiff[k]++);
  };
  for (const pi of planeIssues) {
    const o = byId.get(pi.id);
    if (!o) {
      fieldDiffs.missing!++;
      continue;
    }
    if (o.number !== pi.number) fieldDiffs.number!++;
    if (o.title !== pi.title) fieldDiffs.title!++;
    if (o.state !== pi.state) fieldDiffs.state!++;
    if (o.priority !== (PRIORITY[pi.priority] ?? 0)) fieldDiffs.priority!++;
    if ((o.parent ?? null) !== (pi.parent ?? null)) fieldDiffs.parent!++;
    if (o.archived !== pi.archived) fieldDiffs.archived!++;
    if (String(o.assignees) !== String(pi.assignees)) fieldDiffs.assignees!++;
    if (String(o.labels) !== String(pi.labels)) fieldDiffs.labels!++;
    if (o.comments !== pi.comments) fieldDiffs.comments!++;
    compare(pi.html, o.doc as DocNode | null);
  }
  const descriptionFormat = structuredClone(fmt);

  fmt.plane = zero();
  fmt.rsva = zero();
  fmt.docsWithDiff = zero();
  const planeComments = await plane`
    select c.id::text, c.comment_html as html from issue_comments c join workspaces w on w.id = c.workspace_id join issues i on i.id = c.issue_id
    where w.slug = ${slug} and c.deleted_at is null and ${moved}`;
  const ourComments = new Map(
    (await rsva`select external_id as id, body from comment where workspace_id = ${w} and external_source = 'plane' and deleted_at is null`).map((r) => [
      r.id as string,
      r.body as string,
    ]),
  );
  let commentsMissing = 0;
  for (const c of planeComments) {
    const body = ourComments.get(c.id);
    if (body === undefined) commentsMissing++;
    else compare(c.html, fromMarkdown(body));
  }

  // Every file the text shows has its blob row; nothing is left pointing at Plane.
  const blobs = new Map((await rsva`select sha256, mime from blob where workspace_id = ${w}`).map((r) => [r.sha256 as string, r.mime as string]));
  const imagesWithoutFile = [...shown].filter((sha) => !IMAGE_TYPES.has(blobs.get(sha) ?? "")).length;
  const [{ planeLinks }] = (await rsva`
    select (select count(*) from document where workspace_id = ${w} and doc::text like '%/api/assets/v2/%')::int
      + (select count(*) from comment where workspace_id = ${w} and body like '%/api/assets/v2/%')::int as "planeLinks"`) as unknown as [{ planeLinks: number }];

  const rows = Object.keys(p!).map((k) => ({ model: k, plane: p![k], rsva: q![k], ok: p![k] === q![k] ? "" : "≠" }));
  console.log(`\n${slug}: Plane copy vs recursiva (rows with an id from the copy)`);
  console.table(rows);
  console.log("whole workspace in recursiva:", all);
  console.log("per-issue differences (issues):", fieldDiffs, " comments missing:", commentsMissing);
  const table = (f: typeof fmt) => console.table(KINDS.map((k) => ({ kind: k, plane: f.plane[k], rsva: f.rsva[k], docsWithDiff: f.docsWithDiff[k] })));
  console.log("formatting, descriptions:");
  table(descriptionFormat);
  console.log("formatting, comments:");
  table(fmt);
  console.log("images without an image file:", imagesWithoutFile, " text still linking to Plane's assets:", planeLinks);
  console.log("deleted in Plane, still here:", gone);
  const failed = failures({ rows, fieldDiffs, commentsMissing, imagesWithoutFile, planeLinks, formatDiffs: [descriptionFormat, fmt].flatMap((f) => KINDS.map((k) => f.docsWithDiff[k])) });
  if (failed.length) {
    console.error("verify failed:", failed.join("; "));
    process.exitCode = 1;
  }
} finally {
  await plane.end();
  await rsva.end();
}
