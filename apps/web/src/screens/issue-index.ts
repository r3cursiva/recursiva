// The workspace's live issues as a search index (@rsva/display search.ts), recently updated first: the command palette and the
// editor's "#" menu find issues the same way.
import { isLiveIssue, type Issue } from "@rsva/schema/models";
import { buildIndex, type SearchDoc } from "@rsva/display/search";
import { store } from "../store.ts";

export function liveIssueIndex(): SearchDoc<Issue>[] {
  const all = [...store.issues.values()].filter(isLiveIssue).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return buildIndex(all, (i) => store.issueKey(i), (i) => i.title);
}
