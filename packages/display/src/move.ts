// Moving issues to another project (PLNR-448), what the web's palette and the TUI's ask before they move: the sub-issues a
// move would leave behind. The move itself is the engine's (packages/sync, moveIssues).

/**
 * Sub-issues of these issues at any depth that are not among them, live ones (`subIssuesOf` leaves out the archived and
 * deleted): a move asks whether they go too. A sub-issue left behind keeps its parent across projects.
 */
export function subIssuesLeft<I extends { id: string }>(subIssuesOf: (id: string) => readonly I[], ids: readonly string[]): I[] {
  const taken = new Set(ids);
  const out: I[] = [];
  const walk = (id: string) => {
    for (const c of subIssuesOf(id)) {
      if (taken.has(c.id)) continue;
      taken.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  for (const id of ids) walk(id);
  return out;
}
