// A router on the History API: the path is one MobX observable, the route is computed from it, and screens are
// observers. TanStack Router was planned (docs/plan.html) but is not needed for a handful of fixed URLs.
import { action, computed, makeObservable, observable } from "mobx";
import { cyclePath, issueKey, issuePath, parseIssueKey } from "@rsva/schema/models";
import type { MouseEvent } from "react";

export type Route =
  /** /:ws/projects/KEY: the project's home, its widgets (RSVA-508, ADR 0053). */
  | { name: "projectHome"; ws: string; projectKey: string }
  | { name: "issues"; ws: string; projectKey: string }
  | { name: "settings"; ws: string; projectKey: string }
  /**
   * /:ws/projects/KEY/history: everything that happened in the project (PLNR-71); Timeline at /timeline from 2026-10-30
   * to 2026-11-08 (RSVA-498), that address no longer opens it.
   */
  | { name: "history"; ws: string; projectKey: string }
  /** /:ws/projects/KEY/cycles: the project's cycles; /:ws/projects/KEY/cycles/N one of them (PLNR-63). */
  | { name: "cycles"; ws: string; projectKey: string }
  | { name: "cycle"; ws: string; projectKey: string; cycle: number }
  /** /:ws/projects: every project of the workspace; /:ws/projects/archived the archived ones. */
  | { name: "projects"; ws: string; archived: boolean }
  /** /:ws/projects/KEY/archive: the project's archived issues and its trash. */
  | { name: "archive"; ws: string; projectKey: string }
  /** /:ws/browse/KEY-N: the issue's own page, the link to share. */
  | { name: "browse"; ws: string; projectKey: string; issueKey: string }
  /** /:ws/projects/KEY/issues/KEY-N: opened from the list, beside it (PLNR-34). */
  | { name: "listIssue"; ws: string; projectKey: string; issueKey: string }
  /** /:ws/settings: the workspace's own settings; /:ws/settings/members its members and invites. */
  | { name: "workspaceSettings"; ws: string }
  | { name: "workspaceMembers"; ws: string }
  | { name: "workspaceGithub"; ws: string }
  | { name: "workspaceTokens"; ws: string }
  /**
   * The person's own pages, under the same settings navigation (ADR 0025): the same in every workspace, so /settings/…
   * names none (PLNR-225). /:ws/settings/… opens the page with that workspace beside it and is rewritten to /settings/…
   * (App.tsx): a link that means one workspace, a Telegram group's, still opens it.
   */
  | { name: AccountPage; ws: string | null }
  /** /join/<secret>: an invite link, signed in or not. `join` and `new` are reserved, no workspace takes them. */
  | { name: "join"; ws: null; secret: string }
  /** /new: create a workspace or join one you were invited to. */
  | { name: "newWorkspace"; ws: null }
  /** /:ws/inbox: the viewer's notifications (PLNR-26). */
  | { name: "inbox"; ws: string }
  /** /:ws/my-work: the viewer's work across every workspace (PLNR-41); the workspace is only where the sidebar stays. */
  | { name: "myWork"; ws: string }
  /** /:ws/triage: what waits on the viewer's decision but is not theirs: proposals, agents' reviews (owner 2026-11-11). */
  | { name: "triage"; ws: string }
  /** /:ws/views: every saved view the viewer sees (PLNR-74); /:ws/views/:id a workspace view across projects. */
  | { name: "views"; ws: string }
  | { name: "view"; ws: string; viewId: string }
  | { name: "home"; ws: string | null };

/** The routes of the person's own settings pages. */
const ACCOUNT_PAGES = ["accountProfile", "accountPreferences", "accountAppearance", "accountNotifications", "accountEmail", "accountTelegram", "accountSecurity"] as const;
export type AccountPage = (typeof ACCOUNT_PAGES)[number];

export const isAccountRoute = (r: Route): r is Extract<Route, { name: AccountPage }> => (ACCOUNT_PAGES as readonly string[]).includes(r.name);

export const paths = {
  projectHome: (ws: string, projectKey: string) => `/${ws}/projects/${projectKey}`,
  issues: (ws: string, projectKey: string) => `/${ws}/projects/${projectKey}/issues`,
  listIssue: (ws: string, projectKey: string, issueKey: string) => `/${ws}/projects/${projectKey}/issues/${issueKey}`,
  projects: (ws: string, archived = false) => `/${ws}/projects${archived ? "/archived" : ""}`,
  settings: (ws: string, projectKey: string) => `/${ws}/projects/${projectKey}/settings`,
  archive: (ws: string, projectKey: string) => `/${ws}/projects/${projectKey}/archive`,
  history: (ws: string, projectKey: string) => `/${ws}/projects/${projectKey}/history`,
  cycles: (ws: string, projectKey: string) => `/${ws}/projects/${projectKey}/cycles`,
  cycle: cyclePath,
  browse: issuePath,
  workspaceSettings: (ws: string) => `/${ws}/settings`,
  workspaceMembers: (ws: string) => `/${ws}/settings/members`,
  workspaceGithub: (ws: string) => `/${ws}/settings/github`,
  workspaceTokens: (ws: string) => `/${ws}/settings/tokens`,
  accountProfile: () => "/settings/profile",
  accountPreferences: () => "/settings/preferences",
  accountAppearance: () => "/settings/appearance",
  accountNotifications: () => "/settings/notifications",
  accountEmail: () => "/settings/notifications/email",
  accountTelegram: () => "/settings/notifications/telegram",
  accountSecurity: () => "/settings/security",
  /** An account page with a workspace open beside it: rewritten to the page's own address once open. */
  accountIn: (ws: string, accountPath: string) => `/${ws}${accountPath}`,
  newWorkspace: () => "/new",
  join: (secret: string) => `/join/${secret}`,
  inbox: (ws: string) => `/${ws}/inbox`,
  myWork: (ws: string) => `/${ws}/my-work`,
  triage: (ws: string) => `/${ws}/triage`,
  views: (ws: string) => `/${ws}/views`,
  view: (ws: string, viewId: string) => `/${ws}/views/${viewId}`,
};

const seg = encodeURIComponent;

/**
 * A route's path, built from its parts: what to open after a sign-in instead of the raw location, where a path like
 * "//3405803781/x" would take the browser to another host.
 */
export function routePath(r: Route): string {
  switch (r.name) {
    case "projectHome":
      return paths.projectHome(seg(r.ws), seg(r.projectKey));
    case "issues":
      return paths.issues(seg(r.ws), seg(r.projectKey));
    case "projects":
      return paths.projects(seg(r.ws), r.archived);
    case "settings":
      return paths.settings(seg(r.ws), seg(r.projectKey));
    case "archive":
      return paths.archive(seg(r.ws), seg(r.projectKey));
    case "history":
      return paths.history(seg(r.ws), seg(r.projectKey));
    case "cycles":
      return paths.cycles(seg(r.ws), seg(r.projectKey));
    case "cycle":
      return paths.cycle(seg(r.ws), seg(r.projectKey), r.cycle);
    case "browse":
      return paths.browse(seg(r.ws), seg(r.issueKey));
    case "listIssue":
      return paths.listIssue(seg(r.ws), seg(r.projectKey), seg(r.issueKey));
    case "workspaceSettings":
      return paths.workspaceSettings(seg(r.ws));
    case "workspaceMembers":
      return paths.workspaceMembers(seg(r.ws));
    case "workspaceGithub":
      return paths.workspaceGithub(seg(r.ws));
    case "workspaceTokens":
      return paths.workspaceTokens(seg(r.ws));
    case "accountProfile":
    case "accountPreferences":
    case "accountAppearance":
    case "accountNotifications":
    case "accountEmail":
    case "accountTelegram":
    case "accountSecurity":
      return paths[r.name]();
    case "join":
      return paths.join(seg(r.secret));
    case "newWorkspace":
      return paths.newWorkspace();
    case "inbox":
      return paths.inbox(seg(r.ws));
    case "myWork":
      return paths.myWork(seg(r.ws));
    case "triage":
      return paths.triage(seg(r.ws));
    case "views":
      return paths.views(seg(r.ws));
    case "view":
      return paths.view(seg(r.ws), seg(r.viewId));
    case "home":
      return r.ws ? `/${seg(r.ws)}/` : "/";
  }
}

/** The project a route shows, if any. */
export const routeProject = (r: Route): string | null => ("projectKey" in r ? r.projectKey : null);

/** A path segment decoded; a malformed escape (`/%E0`) stays as written, so it matches no route and names no workspace. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The issue a route has open, on its page or beside the list. */
export const routeIssue = (r: Route): string | null => ("issueKey" in r ? r.issueKey : null);

/** The account page named by the segments after "settings", if any. */
function accountPage(page: string | undefined, sub: string | undefined, rest: string | undefined): AccountPage | null {
  if (rest) return null;
  if (page === "notifications") return !sub ? "accountNotifications" : sub === "email" ? "accountEmail" : sub === "telegram" ? "accountTelegram" : null;
  if (sub) return null;
  const pages: Record<string, AccountPage> = { profile: "accountProfile", preferences: "accountPreferences", appearance: "accountAppearance", security: "accountSecurity" };
  return (page && Object.hasOwn(pages, page) && pages[page]) || null;
}

/** `path` may carry a query or a hash (the palette opens the members page with "?invite"): the route is the path alone. */
export function parseRoute(path: string): Route {
  const [ws, section, a, b, c] = path.split(/[?#]/, 1)[0]!.split("/").filter(Boolean).map(decode);
  if (ws === "join" && section && !a) return { name: "join", ws: null, secret: section };
  if (ws === "new" && !section) return { name: "newWorkspace", ws: null };
  const listed = section === "projects" && b === "issues" && c ? parseIssueKey(c) : null;
  if (ws && a && listed) return { name: "listIssue", ws, projectKey: a.toUpperCase(), issueKey: issueKey(listed.projectKey, listed.number) };
  if (ws && section === "projects" && a && (b === "issues" || b === "settings" || b === "archive" || b === "cycles") && !c)
    return { name: b, ws, projectKey: a.toUpperCase() };
  if (ws && section === "projects" && a && b === "history" && !c) return { name: "history", ws, projectKey: a.toUpperCase() };
  if (ws && section === "projects" && a && b === "cycles" && c && /^[1-9]\d{0,8}$/.test(c)) return { name: "cycle", ws, projectKey: a.toUpperCase(), cycle: Number(c) };
  // "archived" alone is the archived projects, not a project: a key is upper case.
  if (ws && section === "projects" && (!a || (a === "archived" && !b))) return { name: "projects", ws, archived: !!a };
  if (ws && section === "projects" && a && !b) return { name: "projectHome", ws, projectKey: a.toUpperCase() };
  if (ws && section === "settings" && !a) return { name: "workspaceSettings", ws };
  if (ws && section === "settings" && a === "members" && !b) return { name: "workspaceMembers", ws };
  if (ws && section === "settings" && a === "github" && !b) return { name: "workspaceGithub", ws };
  if (ws && section === "settings" && a === "tokens" && !b) return { name: "workspaceTokens", ws };
  const account = ws === "settings" ? accountPage(section ?? "profile", a, b) : ws && section === "settings" ? accountPage(a, b, c) : null;
  if (account) return { name: account, ws: ws === "settings" ? null : ws! };
  if (ws && section === "inbox" && !a) return { name: "inbox", ws };
  if (ws && section === "my-work" && !a) return { name: "myWork", ws };
  if (ws && section === "triage" && !a) return { name: "triage", ws };
  if (ws && section === "views" && !b) return a ? { name: "view", ws, viewId: a } : { name: "views", ws };
  const key = section === "browse" && a ? parseIssueKey(a) : null;
  if (ws && key) return { name: "browse", ws, projectKey: key.projectKey, issueKey: issueKey(key.projectKey, key.number) };
  return { name: "home", ws: ws ?? null };
}

class Router {
  path = location.pathname;
  /** History entries this tab made inside the app before the current one: 0 when it was opened by a link. */
  depth = 0;
  /**
   * The project whose list an issue page was opened from (⤢ beside the list): the page walks that list's order. Kept in
   * the history entry, so a reload or back/forward keeps it, and out of the URL, so the link to share stays clean.
   */
  from: string | null = null;
  /** Where `back` should land once the browser has gone back, when the entry there is out of date. */
  private landOn: string | null = null;
  /**
   * Plays a move the person sees (push, back and forward; not replace, which walks a list): set by the app to animate
   * some of them (PLNR-56). `apply` may run a frame later; a newer change by then wins.
   */
  animate: ((from: Route, to: Route, apply: () => void) => void) | null = null;
  private changes = 0;
  /** The path a move is about to show: a second click on the same link meanwhile adds no history entry. */
  private pending: string | null = null;

  constructor() {
    this.from = this.read();
    makeObservable(this, { path: observable, from: observable, route: computed, set: action });
    addEventListener("popstate", () => {
      const to = this.landOn;
      this.landOn = null;
      if (to && to !== location.pathname) {
        this.set(location.pathname, this.read());
        this.replace(to);
      } else this.move(location.pathname, this.read());
    });
  }

  get route(): Route {
    return parseRoute(this.path);
  }

  /** `from`: the list a page follows, see above. */
  push(path: string, from: string | null = null): void {
    if (path === (this.pending ?? this.path) && from === this.from) return;
    history.pushState({ depth: this.depth + 1, from }, "", path);
    this.move(path, this.read());
  }

  /** Replaces the entry, keeping the list it follows. */
  replace(path: string): void {
    history.replaceState({ depth: this.depth, from: this.from }, "", path);
    this.set(path, this.from);
  }

  /**
   * Back to the screen this one was opened from, or to `fallback` when the tab was opened on it. `landOn` replaces the
   * entry it goes back to: a page that walked its list returns to the issue it ended on, not the one it started from.
   */
  back(fallback: string, landOn: string | null = null): void {
    if (this.depth > 0) {
      this.landOn = landOn;
      history.back();
    } else this.replace(landOn ?? fallback);
  }

  set(path: string, from: string | null): void {
    this.changes++;
    this.pending = null;
    this.path = path;
    this.from = from;
  }

  private move(path: string, from: string | null): void {
    if (!this.animate || path === this.path) return this.set(path, from);
    const at = this.changes;
    this.pending = path;
    this.animate(this.route, parseRoute(path), () => {
      if (this.changes === at) this.set(path, from);
    });
  }

  private read(): string | null {
    const state = history.state as { depth?: number; from?: string | null } | null;
    this.depth = state?.depth ?? 0;
    return state?.from ?? null;
  }
}

export const router = new Router();

/**
 * Click handler for links: plain left clicks navigate in place, modified clicks keep the browser's behaviour. `from`:
 * the list an issue page follows (Router.from).
 */
export function navigateOnClick(
  e: Pick<MouseEvent<HTMLAnchorElement>, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault">,
  path: string, before?: () => void, from: string | null = null): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  before?.();
  router.push(path, from);
}
