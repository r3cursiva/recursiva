// Reads one workspace from a copy of Plane's database: the rows map.ts needs and counts of what is not migrated yet.
//
// Read-only twice over: the session is opened with default_transaction_read_only, and everything runs in one
// REPEATABLE READ READ ONLY transaction, so all tables come from the same snapshot. Users are read column by column:
// passwords, tokens and session data never leave the database.
//
// Soft-deleted rows are read on purpose (map.ts filters them): the tests exercise exactly that filtering, and a deleted
// top comment is needed as the tombstone of its live replies.
import postgres from "postgres";
import type { PlaneRows } from "./map.ts";

export function connect(url: string): postgres.Sql {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { default_transaction_read_only: true, application_name: "rsva-plane-db-export", TimeZone: "UTC" },
  });
}

/** Dates as YYYY-MM-DD and timestamps as ISO strings, whatever the driver returns. */
function plain<T>(rows: readonly Record<string, unknown>[]): T[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])) as T);
}

export async function readWorkspace(sql: postgres.Sql, slug: string): Promise<PlaneRows> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [ws] = await tx`
      select id, slug, name, owner_id as "ownerId" from workspaces where slug = ${slug} and deleted_at is null`;
    if (!ws) throw new Error(`no workspace "${slug}" in this database`);
    const w = ws.id as string;
    const q = async <T>(rows: Promise<readonly Record<string, unknown>[]>) => plain<T>(await rows);

    const [members, projects, states, labels, issues, assignees, issueLabels, comments, reactions, archiveEvents] = [
      await q<PlaneRows["members"][number]>(tx`
        select member_id as "userId", role, is_active as "isActive", deleted_at as "deletedAt"
        from workspace_members where workspace_id = ${w}`),
      await q<PlaneRows["projects"][number]>(tx`
        select id, identifier, name, created_at as "createdAt", archived_at as "archivedAt", deleted_at as "deletedAt"
        from projects where workspace_id = ${w} order by created_at`),
      await q<PlaneRows["states"][number]>(tx`
        select id, project_id as "projectId", name, "group", color, sequence, "default" as "isDefault", is_triage as "isTriage",
          deleted_at as "deletedAt"
        from states where workspace_id = ${w} order by project_id, sequence`),
      await q<PlaneRows["labels"][number]>(tx`
        select id, project_id as "projectId", parent_id as "parentId", name, color, sort_order as "sortOrder", deleted_at as "deletedAt"
        from labels where workspace_id = ${w} order by sort_order`),
      await q<PlaneRows["issues"][number]>(tx`
        select id, project_id as "projectId", sequence_id as "sequenceId", name, state_id as "stateId", priority,
          parent_id as "parentId", start_date::text as "startDate", target_date::text as "targetDate", sort_order as "sortOrder",
          created_by_id as "createdById", created_at as "createdAt", updated_at as "updatedAt", completed_at as "completedAt",
          archived_at::text as "archivedAt", coalesce(is_draft, false) as "isDraft", description_html as "descriptionHtml",
          deleted_at as "deletedAt"
        from issues where workspace_id = ${w} order by project_id, sequence_id`),
      await q<PlaneRows["assignees"][number]>(tx`
        select issue_id as "issueId", assignee_id as "targetId", created_at as "createdAt", deleted_at as "deletedAt"
        from issue_assignees where workspace_id = ${w}`),
      await q<PlaneRows["issueLabels"][number]>(tx`
        select issue_id as "issueId", label_id as "targetId", created_at as "createdAt", deleted_at as "deletedAt"
        from issue_labels where workspace_id = ${w}`),
      await q<PlaneRows["comments"][number]>(tx`
        select id, issue_id as "issueId", parent_id as "parentId", actor_id as "actorId", created_by_id as "createdById",
          case when deleted_at is null then comment_html end as "commentHtml",
          created_at as "createdAt", edited_at as "editedAt", deleted_at as "deletedAt"
        from issue_comments where workspace_id = ${w}`),
      await q<PlaneRows["reactions"][number]>(tx`
        select id, issue_id as "issueId", null::uuid as "commentId", actor_id as "actorId", reaction, created_at as "createdAt",
          deleted_at as "deletedAt"
        from issue_reactions where workspace_id = ${w}
        union all
        select r.id, c.issue_id, r.comment_id, r.actor_id, r.reaction, r.created_at, r.deleted_at
        from comment_reactions r left join issue_comments c on c.id = r.comment_id where r.workspace_id = ${w}`),
      await q<PlaneRows["archiveEvents"][number]>(tx`
        select a.issue_id as "issueId", a.created_at as "at"
        from issue_activities a join issues i on i.id = a.issue_id
        where a.workspace_id = ${w} and a.field = 'archived_at' and a.deleted_at is null and i.archived_at is not null
          and coalesce(a.new_value, '') <> ''`),
    ];

    const relations = await q<PlaneRows["relations"][number]>(tx`
      select id, issue_id as "issueId", related_issue_id as "relatedId", relation_type as "type", deleted_at as "deletedAt"
      from issue_relations where workspace_id = ${w}`);
    const issueLinks = await q<PlaneRows["links"][number]>(tx`
      select id, issue_id as "issueId", url, title, created_by_id as "createdById", created_at as "createdAt", deleted_at as "deletedAt",
        'link' as source
      from issue_links where workspace_id = ${w}`);
    const subscriptions = await q<PlaneRows["subscriptions"][number]>(tx`
      select id, issue_id as "issueId", subscriber_id as "subscriberId", created_at as "createdAt", deleted_at as "deletedAt"
      from issue_subscribers where workspace_id = ${w}`);
    // Uploads finished and not removed. Pages and project covers have no place here yet: no entity of theirs refers to them.
    const assets = await q<PlaneRows["assets"][number]>(tx`
      select id, entity_type as "entityType", issue_id as "issueId", coalesce(nullif(attributes->>'name', ''), 'file') as name,
        attributes->>'type' as type, created_by_id as "createdById", created_at as "createdAt",
        coalesce(deleted_at, case when is_deleted then updated_at end) as "deletedAt"
      from file_assets where workspace_id = ${w} and is_uploaded`);
    // The fork's GitHub tables (Plane CE has none): pull requests and direct commits that name an issue.
    const [{ fork }] = (await tx`select to_regclass('lsrd_github_pull_request_issues') is not null as fork`) as unknown as [{ fork: boolean }];
    const githubLinks = fork
      ? await q<PlaneRows["links"][number]>(tx`
          select l.id, l.issue_id as "issueId", pr.url, nullif(pr.title, '') as title, null::uuid as "createdById", l.created_at as "createdAt",
            -- A pull request link removed in Plane is its mirror in issue_links, deleted: it stays removed.
            mirror.deleted_at as "deletedAt", 'github' as source
          from lsrd_github_pull_request_issues l join lsrd_github_pull_requests pr on pr.id = l.pull_request_id
          left join issue_links mirror on mirror.id = l.issue_link_id
          join issues i on i.id = l.issue_id where i.workspace_id = ${w}
          union all
          select l.id, l.issue_id, c.url, nullif(c.message, ''), null::uuid, l.created_at, null::timestamptz, 'github'
          from lsrd_github_commit_issues l join lsrd_github_commits c on c.id = l.commit_id
          join issues i on i.id = l.issue_id where i.workspace_id = ${w}`)
      : [];

    // Members and everyone the moved rows point at (creators, assignees, authors, reactors), even if no longer members.
    const ids = new Set<string>(members.map((m) => m.userId));
    for (const i of issues) if (i.createdById) ids.add(i.createdById);
    for (const a of assignees) ids.add(a.targetId);
    for (const c of comments) for (const id of [c.actorId, c.createdById]) if (id) ids.add(id);
    for (const r of reactions) ids.add(r.actorId);
    for (const l of issueLinks) if (l.createdById) ids.add(l.createdById);
    for (const a of assets) if (a.createdById) ids.add(a.createdById);
    const users = await q<PlaneRows["users"][number]>(tx`
      select id, email, display_name as "displayName", first_name as "firstName", last_name as "lastName", coalesce(is_bot, false) as "isBot"
      from users where id = any(${[...ids]}::uuid[]) order by date_joined`);

    return {
      workspace: { id: w, slug: ws.slug as string, name: ws.name as string, ownerId: (ws.ownerId as string | null) ?? null },
      users, members, projects, states, labels, issues, assignees, issueLabels, comments, reactions, archiveEvents,
      relations, links: [...issueLinks, ...githubLinks], subscriptions, assets,
    };
  });
}

/**
 * What the bundle format has no place for yet, counted (live rows of live issues only). The connector reports it; the
 * research note proposes the models.
 */
export async function notMigrated(sql: postgres.Sql, slug: string): Promise<Record<string, number | string>> {
  const [r] = await sql.begin("isolation level repeatable read read only", (tx) => tx`
    with ws as (select id from workspaces where slug = ${slug} and deleted_at is null),
    li as (select id from issues where workspace_id = (select id from ws) and deleted_at is null and not coalesce(is_draft, false))
    select
      (select count(*) from issue_relations r where r.workspace_id = (select id from ws) and r.deleted_at is null
         and r.issue_id in (select id from li) and r.related_issue_id in (select id from li))::int as relations,
      (select coalesce(string_agg(t || ' ' || n, ', '), '') from (select relation_type t, count(*) n from issue_relations r
         where r.workspace_id = (select id from ws) and r.deleted_at is null group by 1 order by 1) x) as "relationTypes",
      (select count(*) from issue_links l where l.issue_id in (select id from li) and l.deleted_at is null)::int as links,
      (select count(*) from file_assets f where f.workspace_id = (select id from ws) and f.deleted_at is null and not f.is_deleted)::int as assets,
      (select coalesce(string_agg(t || ' ' || n, ', '), '') from (select entity_type t, count(*) n from file_assets f
         where f.workspace_id = (select id from ws) and f.deleted_at is null and not f.is_deleted group by 1 order by 1) x) as "assetTypes",
      (select coalesce(round((sum(size) / 1048576)::numeric, 1), 0)::text from file_assets f
         where f.workspace_id = (select id from ws) and f.deleted_at is null and not f.is_deleted) as "assetMiB",
      (select count(*) from issue_attachments a where a.issue_id in (select id from li) and a.deleted_at is null)::int as "legacyAttachments",
      (select count(*) from issue_activities a where a.issue_id in (select id from li) and a.deleted_at is null)::int as activity,
      (select count(*) from issue_mentions m where m.issue_id in (select id from li) and m.deleted_at is null)::int as "mentionRows",
      (select count(*) from lsrd_github_pull_request_issues p where p.issue_id in (select id from li))::int as "githubPrLinks",
      (select count(distinct p.pull_request_id) from lsrd_github_pull_request_issues p where p.issue_id in (select id from li))::int as "githubPrs",
      (select count(*) from lsrd_github_commit_issues c where c.issue_id in (select id from li))::int as "githubCommitLinks",
      (select count(*) from cycles c where c.workspace_id = (select id from ws) and c.deleted_at is null)::int as cycles,
      (select count(*) from cycle_issues c where c.workspace_id = (select id from ws) and c.deleted_at is null)::int as "cycleIssues",
      (select count(*) from modules m where m.workspace_id = (select id from ws) and m.deleted_at is null)::int as modules,
      (select count(*) from pages p where p.workspace_id = (select id from ws) and p.deleted_at is null)::int as pages,
      (select count(*) from issue_views v where v.workspace_id = (select id from ws) and v.deleted_at is null)::int as views,
      (select count(*) from draft_issues d where d.workspace_id = (select id from ws) and d.deleted_at is null)::int as "draftIssues",
      (select count(*) from intake_issues i where i.workspace_id = (select id from ws) and i.deleted_at is null)::int as "intakeIssues",
      (select count(*) from project_members m join projects p on p.id = m.project_id
         where m.workspace_id = (select id from ws) and m.deleted_at is null and m.is_active and p.deleted_at is null)::int as "projectMembers",
      (select count(*) from issue_votes v where v.issue_id in (select id from li) and v.deleted_at is null)::int as votes
  `);
  return r as Record<string, number | string>;
}
