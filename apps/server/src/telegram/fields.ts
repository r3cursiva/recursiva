// An issue's fields in one line, for /new (PLNR-359): the line is read as the TUI's `c` reads it (packages/query,
// issueFields); here are where the issue goes, the workspace's names, and what Telegram does not set.
import type { Role } from "@rsva/policy";
import { wallClock } from "@rsva/protocol";
import { errorSentence, issueFields, needsIssueIndex, parseQuery, type IssueFields } from "@rsva/query";
import type { Label, Project, WorkflowState } from "@rsva/schema/models";
import { loadIssueIndex, loadNames, queryContext, type Names } from "../api-names.ts";
import { workspacesOf } from "../auth/access.ts";
import { prefsOf } from "../notify/prefs.ts";

/** A project the person may create issues in, with its workspace's names. */
export interface Place {
  workspaceId: string;
  slug: string;
  role: Role;
  project: Project;
  n: Names;
}

/**
 * Whether Telegram may move an issue into this state: not one only people set (Todo, Approved). Approving is not done
 * from Telegram (owner 2026-11-05 for Approved, 2026-11-06 for Todo): it takes the whole description, and a message
 * shows its first lines at most.
 */
export const offeredState = (s: WorkflowState) => !s.onlyPeople;

/** Whether Telegram may put this label on or take it off: not one only people set (`proposed`, `security`, `owner`). */
export const offeredLabel = (l: Label) => !l.onlyPeople;

/** Today in the person's time zone: what due:tomorrow means to them. */
export async function todayOf(userId: string, now = new Date()): Promise<string> {
  const { timeZone } = (await prefsOf([userId])).get(userId)!;
  return wallClock(now, timeZone ?? "UTC").date;
}

/** "#INFRA", "project:INFRA" or "project:"Web App"" in the line, if any. */
export const projectToken = (text: string) => /(?:^|\s)(?:#|project:)(?:"([^"]+)"|([^\s",]+))/i.exec(text)?.slice(1).find(Boolean);

/** The workspaces the person may create issues in, the one of `first` first. */
export async function writable(userId: string, first?: string): Promise<{ workspaceId: string; slug: string; role: Role }[]> {
  const rows = await workspacesOf(userId, "issues.write");
  return rows.sort((a, b) => Number(b.id === first) - Number(a.id === first)).map((w) => ({ workspaceId: w.id, slug: w.slug, role: w.role }));
}

/**
 * Where /new puts the issue: the project the line names (`#INFRA`), else `fallback` (the project of the person's last
 * issue). A project they cannot write in, or none at all, is an error that lists the ones they can.
 */
export async function placeOf(userId: string, text: string, fallback: { workspaceId: string; projectId: string } | null): Promise<Place | { error: string }> {
  const asked = projectToken(text);
  const spaces = await writable(userId, fallback?.workspaceId);
  const keys: string[] = [];
  for (const w of spaces) {
    const n = await loadNames(w.workspaceId);
    const live = (p: Project | undefined) => (p && !p.archivedAt ? p : undefined);
    const project = asked
      ? live(n.byKey.get(asked.toUpperCase()) ?? [...n.projects.values()].find((p) => p.name.toLowerCase() === asked.toLowerCase()))
      : w.workspaceId === fallback?.workspaceId
        ? live(n.projects.get(fallback.projectId))
        : undefined;
    if (project) return { ...w, project, n };
    keys.push(...[...n.projects.values()].filter((p) => !p.archivedAt).map((p) => p.key));
  }
  if (!keys.length) return { error: "You cannot create issues in any project." };
  return { error: `${asked ? `No project "${asked}".` : "Which project?"} Name it with #: ${keys.map((k) => `#${k.toLowerCase()}`).join(", ")}.` };
}

/**
 * The fields a line sets on an issue of `projectId`; only those it names. `me` resolves @me. Free text is returned as the
 * title, its quotes taken off. @none and label:none leave the list empty.
 */
export async function readFields(text: string, place: Pick<Place, "workspaceId" | "n">, projectId: string, me: string, today: string): Promise<IssueFields | { error: string }> {
  const { n } = place;
  const issues = needsIssueIndex(text) ? await loadIssueIndex(n, place.workspaceId) : undefined;
  const ctx = { ...queryContext(n, me, projectId, issues), today };
  const { filter, errors } = parseQuery(text, ctx);
  if (errors.length) return { error: errorSentence(text, errors[0]!) };
  return issueFields(filter, ctx, projectId, {
    state: (s) => (offeredState(s) ? null : `${s.name} is set in recursiva, not from Telegram.`),
    label: (l) => (offeredLabel(l) ? null : `${l.name} is set in recursiva, not from Telegram.`),
  });
}
