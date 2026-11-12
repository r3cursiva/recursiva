// The parent tree of issues, for the pickers: which issues may become an issue's parent or its sub-issue. The server
// refuses a cycle anyway (sync/write.ts, checkParent); the pickers just don't offer one.

type Node = { id: string; parentId: string | null };

/** The issue and its sub-issues at any depth: none of them may become its parent. */
export function subtree(id: string, subIssuesOf: (id: string) => readonly Node[]): Set<string> {
  const out = new Set([id]);
  const walk = [id];
  for (let at = walk.pop(); at !== undefined; at = walk.pop()) {
    for (const c of subIssuesOf(at)) if (!out.has(c.id)) walk.push((out.add(c.id), c.id));
  }
  return out;
}

/** The issue and its parents up the tree: none of them may become its sub-issue. A broken loop stops the walk. */
export function lineage(id: string, get: (id: string) => Node | undefined): Set<string> {
  const out = new Set<string>();
  for (let at: string | null | undefined = id; at && !out.has(at); at = get(at)?.parentId) out.add(at);
  return out;
}
