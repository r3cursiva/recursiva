// Where the ways back from a settings page lead: the page of work it was opened from (a project's home, its cycles,
// an issue, My work), not a fixed one. Remembered per workspace and per project as the person moves, in memory: after
// a reload the way back is the default again.
import { reaction } from "mobx";
import { isAccountRoute, paths, routePath, routeProject, router, type Route } from "./router.ts";
import { workspacePath } from "./workspaces.ts";

const NOT_WORK = new Set<Route["name"]>(["settings", "archive", "workspaceSettings", "workspaceMembers", "workspaceGithub", "workspaceTokens", "join", "newWorkspace", "home"]);

const last = new Map<string, string>();

reaction(
  () => router.route,
  (r) => {
    if (!r.ws || NOT_WORK.has(r.name) || isAccountRoute(r)) return;
    // Built from the route, not the address as typed: "//evil.example/projects/X" parses as a workspace, and kept raw it
    // would make the way back a link to another site.
    const path = routePath(r);
    last.set(r.ws, path);
    const key = routeProject(r);
    if (key) last.set(`${r.ws}/${key}`, path);
  },
  { fireImmediately: true },
);

/** Back from a project's settings or archive: the project's page it was opened from, else its issues. */
export const backToProject = (ws: string, key: string): string => last.get(`${ws}/${key}`) ?? paths.issues(ws, key);

/** Back from the workspace's or the person's settings: the page of work they were opened from, else where switching to the workspace lands. */
export const backToWork = (ws: string): string => last.get(ws) ?? workspacePath(ws);
