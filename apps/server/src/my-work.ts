// My work on the server (RSVA-572): the rules the browser runs over its engine (@rsva/protocol/my-work), run over the
// database for one person in one workspace. The bot's /my and the daily digest both read it, so what they call
// "waiting on you" is what the app calls it.
import type { InboxGroup } from "@rsva/protocol";
import { collect, type WorkItem, type WorkSource } from "@rsva/protocol/my-work";
import type { Issue, WorkflowState } from "@rsva/schema/models";
import type { Names } from "./api-names.ts";

/** What My work reads of a workspace: its names, the person's inbox lines (api-inbox.ts linesOf) and their role. */
export interface WorkIn {
  slug: string;
  role: string | null;
  n: Names;
  groups: readonly InboxGroup[];
}

function source(userId: string, w: WorkIn, issues: readonly Issue[]): WorkSource {
  const statesOf = new Map<string, WorkflowState[]>();
  for (const s of w.n.states.values()) statesOf.set(s.projectId, [...(statesOf.get(s.projectId) ?? []), s]);
  return {
    me: { id: userId },
    role: w.role,
    issues: new Map(issues.map((i) => [i.id, i])),
    states: w.n.states,
    statesOf: (projectId) => statesOf.get(projectId) ?? [],
    projects: w.n.projects,
    labels: w.n.labels,
    users: w.n.users,
    inbox: { rows: w.groups.map((g) => ({ ...g, issue: { id: g.issueId } })) },
  };
}

/** The person's My work in the workspace, unsorted; `issues` are its live ones. */
export const workIn = (userId: string, w: WorkIn, issues: readonly Issue[], now: number): WorkItem[] => collect(w.slug, source(userId, w, issues), now, { others: true });
