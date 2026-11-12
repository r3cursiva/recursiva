// The queue of reviews (RSVA-597): an issue opened from a list of reviews walks them, and a decision on its review bar
// (review.tsx) opens the next. Apart from the bar, so a list that only opens the queue does not load the bar's editor.
import type { Issue } from "@rsva/schema/models";
import { collect } from "../lib/my-work.ts";
import { store } from "../store.ts";

/** Router.from of an issue opened from a list of reviews: "review:" and the project's id, or nothing for the workspace. */
const REVIEW_FROM = "review:";
export const reviewFrom = (projectId = ""): string => REVIEW_FROM + projectId;
export const isReviewFrom = (from: string | null): from is string => !!from?.startsWith(REVIEW_FROM);

/** The reviews that wait on the viewer, in the workspace or the project `from` names, the longest waiting first. */
export function reviewQueue(ws: string, from: string): Issue[] {
  const projectId = from.slice(REVIEW_FROM.length);
  return collect(ws, store, Date.now(), { others: true })
    .filter((x) => x.ask === "review" && (!projectId || x.issue.projectId === projectId))
    .sort((a, b) => (a.since < b.since ? -1 : 1))
    .map((x) => x.issue);
}
