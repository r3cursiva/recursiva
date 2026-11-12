// What the issue's GitHub block shows of its rows: the order and the words. No drawing here, so tests reach it. The
// feed's GitHub words, which the TUI shares, are in packages/display github.ts.
import { observable, runInAction } from "mobx";
import type { GithubLink, PullReview, PullState } from "@rsva/schema/models";

const STATE_ORDER: Record<PullState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

const newest = (a: GithubLink, b: GithubLink) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/** Pull requests by state (open, draft, merged, closed), the latest first within one; commits newest first. */
export function githubRows(links: readonly GithubLink[]): { pulls: GithubLink[]; commits: GithubLink[] } {
  const pulls = links.filter((l) => l.kind === "pull").sort((a, b) => STATE_ORDER[a.state ?? "closed"] - STATE_ORDER[b.state ?? "closed"] || newest(a, b));
  return { pulls, commits: links.filter((l) => l.kind === "commit").sort(newest) };
}

/** "infra#412": a row's reference; the owner is in the link. */
export const pullRef = (l: Pick<GithubLink, "repo" | "number">): string => `${l.repo.split("/").pop()}#${l.number}`;

/** A number is a repository's own: its name is said only when the pull requests shown span more than one repository. */
export const pullLabel = (l: Pick<GithubLink, "repo" | "number">, among: readonly Pick<GithubLink, "repo">[]): string =>
  new Set(among.map((p) => p.repo)).size > 1 ? pullRef(l) : `#${l.number}`;

export const STATE_NAME: Record<PullState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

export const REVIEW_NAME: Record<PullReview, string> = { approved: "Approved", changes: "Changes requested", required: "Review required" };

// ── A project's open pull requests ─────────────────────────────────────────────────────────────────────────────
//
// The pool holds an issue's links only once the issue was opened, so a project's home asks the server for the open
// ones (GET /sync/project-pulls/:id, RSVA-572). Asked each time the widget comes on screen and when the page comes back to the front (watchPulls), kept meanwhile: a pull
// request merged while the page stays in front stays listed until it leaves it and returns. Following it live would mean the
// links riding in the snapshot, a larger change.

const loaded = observable.map<string, GithubLink[]>(undefined, { deep: false });

/** Asks for the project's open pull requests again; what was known stays until the answer. */
function loadPulls(projectId: string): void {
  fetch(`/sync/project-pulls/${projectId}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ pulls: GithubLink[] }>) : null))
    .then((p) => p && runInAction(() => loaded.set(projectId, p.pulls)))
    .catch(() => undefined);
}

/** Asks now and again whenever the page comes back to the front: a pull request merged meanwhile leaves the list. Returns the stop. */
export function watchPulls(projectId: string): () => void {
  loadPulls(projectId);
  const again = () => document.visibilityState === "visible" && loadPulls(projectId);
  document.addEventListener("visibilitychange", again);
  return () => document.removeEventListener("visibilitychange", again);
}

/**
 * The project's open pull requests, each once (one may be linked to several issues: the first link's issue stands for
 * it), the latest change first; undefined until the first answer.
 */
export function openPulls(projectId: string): GithubLink[] | undefined {
  const all = loaded.get(projectId);
  if (!all) return undefined;
  const seen = new Set<string>();
  return all.filter((p) => !seen.has(pullRef(p)) && !!seen.add(pullRef(p)));
}

