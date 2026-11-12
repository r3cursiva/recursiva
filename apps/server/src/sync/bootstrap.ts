// Workspace snapshot for a new client: GET /sync/bootstrap?ws=<slug>&project=<KEY>.
//
// Read in one REPEATABLE READ transaction together with last_sync_id: the cut is consistent and writes to the workspace
// are not paused. The open project's data comes first, then a ready frame, then the rest, so the client draws the screen
// without waiting for the whole workspace. Issue descriptions are not in the snapshot (GET /sync/doc/:id).
import { PROTOCOL_VERSION, type SnapshotLine } from "@rsva/protocol";
import { BOTS, projectsByKey, type ModelName } from "@rsva/schema/models";
import { and, asc, eq, exists, inArray, ne, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { COLUMNS } from "./columns.ts";

const { workspace, member, user, project, workflowState, label, cycle, issue, attachment, syncAction } = schema;

/** The same for every member: who is asking travels in the answer's headers (VIEWER_HEADERS), so the body is cached once. */
export async function* snapshot(slug: string, projectKey: string | undefined): AsyncGenerator<SnapshotLine> {
  const lines: SnapshotLine[] = await db.transaction(
    async (tx) => {
      const [ws] = await tx.select().from(workspace).where(eq(workspace.slug, slug));
      if (!ws) throw Object.assign(new Error(`no workspace ${slug}`), { statusCode: 404 });

      const batch = async (m: ModelName, rows: Promise<Record<string, unknown>[]>): Promise<SnapshotLine> => {
        const c = Object.keys(COLUMNS[m]);
        return { t: "b", m, c, r: (await rows).map((row) => c.map((k) => row[k])) };
      };
      const projects = await tx.select({ id: project.id, key: project.key, formerKeys: project.formerKeys }).from(project).where(eq(project.workspaceId, ws.id));
      // An old link (a key before a rename) opens the same project first.
      const first = projectKey ? projectsByKey(projects).get(projectKey) : undefined;
      const issuesWhere = (extra?: SQL) => (extra ? and(eq(issue.workspaceId, ws.id), extra) : eq(issue.workspaceId, ws.id));

      const out: SnapshotLine[] = [
        { t: "meta", v: PROTOCOL_VERSION, s: ws.lastSyncId, ws: { id: ws.id, slug: ws.slug, name: ws.name, color: ws.color, memberRights: ws.memberRights, triagers: ws.triagers } },
        await batch(
          "User",
          tx
            .select(COLUMNS.User)
            .from(user)
            .innerJoin(member, eq(member.userId, user.id))
            .where(eq(member.workspaceId, ws.id))
            // Bots sign GitHub's changes and the app's own without being members: a workspace whose log has one knows its name.
            .unionAll(
              tx
                .select({ ...COLUMNS.User, role: dsql<string>`null`.as("role") })
                .from(user)
                .where(and(inArray(user.email, BOTS.map((b) => b.email)), exists(tx.select({ x: syncAction.id }).from(syncAction).where(and(eq(syncAction.modelId, user.id), eq(syncAction.workspaceId, ws.id), eq(syncAction.model, "User")))))),
            ),
        ),
        await batch("Project", tx.select(COLUMNS.Project).from(project).where(eq(project.workspaceId, ws.id)).orderBy(asc(project.key))),
        await batch("WorkflowState", tx.select(COLUMNS.WorkflowState).from(workflowState).innerJoin(project, eq(project.id, workflowState.projectId)).where(eq(project.workspaceId, ws.id)).orderBy(asc(workflowState.id))),
        await batch("Label", tx.select(COLUMNS.Label).from(label).where(eq(label.workspaceId, ws.id))),
        await batch("Cycle", tx.select(COLUMNS.Cycle).from(cycle).where(eq(cycle.workspaceId, ws.id))),
      ];
      if (first) out.push(await batch("Issue", tx.select(COLUMNS.Issue).from(issue).where(issuesWhere(eq(issue.projectId, first.id)))));
      out.push({ t: "ready" });
      out.push(await batch("Issue", tx.select(COLUMNS.Issue).from(issue).where(issuesWhere(first ? ne(issue.projectId, first.id) : undefined))));
      // Links are drawn only in an opened issue: after the lists, in one batch for the workspace.
      out.push(await batch("Attachment", tx.select(COLUMNS.Attachment).from(attachment).where(eq(attachment.workspaceId, ws.id))));
      out.push({ t: "end" });
      return out;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  yield* lines;
}
