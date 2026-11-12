import { OTHER_PERSON } from "@rsva/sync";
import { account } from "./account.ts";
import type { Project } from "@rsva/schema/models";
import { when } from "mobx";
import { observer } from "mobx-react-lite";
import { SaveNotice } from "./screens/save-notice.tsx";
import { Suspense, useEffect, type ReactNode } from "react";
import { signedIn } from "./lib/signed-in.ts";
import { afterPaint } from "./perf.ts";
import { uiChoice } from "./panes.ts";
import { isAccountRoute, paths, routeIssue, routePath, routeProject, router, type Route } from "./router.ts";
import { chunk, chunkWhen } from "./screens/load-edit-chunk.ts";
import { Overlays } from "./screens/overlays.tsx";
import { ProjectIssues } from "./screens/project-issues.tsx";
import { linkInUrl, SignIn } from "./screens/sign-in.tsx";
import { Sidebar } from "./screens/sidebar.tsx";
import { TabBar } from "./screens/tab-bar.tsx";
import { viewPanel } from "./screens/view-panel-state.ts";
import "./shortcuts.ts";
import { currentWs, NO_WS, store } from "./store.ts";
import { workspacePath, workspaces } from "./workspaces.ts";
import { Link } from "./link.tsx";

// Settings are opened rarely and share the edit chunk's popups: loaded with it, not at startup.
const ProjectSettings = chunk("ProjectSettings");
const ProjectArchive = chunk("ProjectArchive");
const ProjectHistory = chunk("ProjectHistory");
const ProjectHome = chunk("ProjectHome");
const ProjectCycles = chunk("ProjectCycles");
const CyclePage = chunk("CyclePage");
const AllProjects = chunk("AllProjects");
const WorkspaceSettings = chunk("WorkspaceSettings");
/** The routes under the settings' own navigation. */
const SETTINGS_PAGE: Partial<Record<Route["name"], "general" | "members" | "github" | "tokens" | "profile" | "preferences" | "appearance" | "notifications" | "email" | "telegram" | "security">> = {
  workspaceSettings: "general",
  workspaceMembers: "members",
  workspaceGithub: "github",
  workspaceTokens: "tokens",
  accountProfile: "profile",
  accountPreferences: "preferences",
  accountAppearance: "appearance",
  accountNotifications: "notifications",
  accountEmail: "email",
  accountTelegram: "telegram",
  accountSecurity: "security",
};
// Members, invites and new workspaces (ADR 0011) come with the same chunk.
const JoinScreen = chunk("JoinScreen");
// The link back from an email change (PLNR-197), read once at load: its screen takes it out of the address bar.
const EmailRevert = chunk("EmailRevert");
const revertSecret = new URLSearchParams(location.hash.slice(1)).get("email-revert");
const NoWorkspace = chunk("NoWorkspace");
const CreateWorkspace = chunk("CreateWorkspace");
const Inbox = chunk("Inbox");
const MyWork = chunk("MyWork");
// Saved views (PLNR-74): the views page and a view across projects.
const ViewsIndex = chunk("ViewsIndex");
const WorkspaceView = chunk("WorkspaceView");
// The issue's own page (PLNR-34): the same pane as beside the list, from the same chunk.
const IssuePage = chunk("IssuePage");

export const App = observer(function App() {
  const route = router.route;
  // So does the link back from an email change, whoever is signed in here.
  if (revertSecret)
    return (
      <Suspense fallback={null}>
        <EmailRevert secret={revertSecret} />
      </Suspense>
    );
  // An invite link works signed out too: its page signs in as the invited address.
  if (route.name === "join")
    return (
      <Suspense fallback={null}>
        <JoinScreen secret={route.secret} />
      </Suspense>
    );
  // No session hint, or the server said the session ended; or a sign-in link from the mail (sign-in.tsx).
  if (!signedIn() || store.errorCode === "unauthorized" || linkInUrl()) return <SignIn {...(store.pendingCount > 0 ? { intro: <WaitingForSignIn n={store.pendingCount} someoneElse={store.error === OTHER_PERSON} /> } : {})} />;
  // Signed in without a workspace: invited and not joined yet, or left the last one.
  if (route.name !== "newWorkspace" && (store.errorCode === "not_found" || store.errorCode === "forbidden") && workspaces.list?.length === 0)
    return (
      <Suspense fallback={null}>
        <NoWorkspace />
      </Suspense>
    );
  const ws = currentWs();
  if (ws === NO_WS && route.name !== "newWorkspace") return <FirstWorkspace route={route} />;
  // A workspace the server doesn't have, or won't show: no sidebar or tab bar around the answer, since there is no
  // workspace to show them for (RSVA-578). My work keeps a refused one's sidebar: it shows the other workspaces' work.
  if (route.name !== "newWorkspace") {
    if (store.status === "error" && store.errorCode === "not_found") return <WorkspaceNotFound ws={ws} />;
    if (store.errorCode === "forbidden" && route.name !== "myWork" && route.name !== "triage") return <NoAccess />;
  }
  const activeKey = routeProject(route);
  const settings = SETTINGS_PAGE[route.name];
  return (
    // Keyed by workspace: a switch remounts every screen on the new engine (store.ts).
    <div key={ws} className="flex h-dvh overflow-hidden md:gap-(--pane-gap) md:bg-(--pane-frame) md:p-(--pane-inset) max-md:h-[calc(100dvh-var(--keyboard))] max-md:flex-col max-md:bg-panel max-md:pt-(--safe-top) max-md:pr-(--safe-right) max-md:pl-(--safe-left)">
      <LoadWorkspaces ws={ws} />
      <AccountAddress route={route} />
      {/* The workspace's settings have their own navigation in the sidebar's place. */}
      {!settings && <Sidebar ws={ws} activeKey={activeKey} />}
      {/* The screen is a block of the window beside the sidebar; a split or the settings lay out blocks of their own. */}
      <div className="pane flex min-h-0 min-w-0 flex-1 max-md:flex-col">
        {route.name === "newWorkspace" ? (
          <Suspense fallback={<div className="flex-1" />}>
            <CreateWorkspace />
          </Suspense>
        ) : route.name === "myWork" || route.name === "triage" ? (
          // Every workspace's work: the one in the URL only keeps the sidebar, so its errors don't hide the others.
          <Suspense fallback={<div className="flex-1" />}>
            <MyWork ws={ws} triage={route.name === "triage"} />
          </Suspense>
        ) : settings || route.name === "inbox" ? (
          // Their own headers, as on the artboards, and for the settings their own navigation.
          (unavailable() ?? (
            <Suspense fallback={<div className="flex-1" />}>
              {settings ? <WorkspaceSettings ws={ws} page={settings} /> : <Inbox ws={ws} />}
            </Suspense>
          ))
        ) : (
          // Each screen beside the sidebar has its own header (PLNR-58): a project's names it and holds its tools.
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Screen ws={ws} />
          </main>
        )}
      </div>
      <ViewPanelSlot />
      <TabBar ws={ws} />
      <Rejection />
      <SaveNotice />
      <Overlays />
    </div>
  );
});

/** The View panel's place on a wide screen (PLNR-305): the screen narrows for it, and the panel, still fixed at the
 * right (view-panel.tsx), lies in it beside the list rather than over it. Narrower, the panel lies over the list. Taken
 * away at once on close: the list widens in one step under the panel's way out, never width by width. */
const ViewPanelSlot = observer(function ViewPanelSlot() {
  return viewPanel.open ? <div aria-hidden className="hidden w-(--view-panel-width) shrink-0 dock:block" /> : null;
});

/**
 * Not in the start path: the saved list shows at once; with none saved it is fetched after the first paint, and a saved
 * list without the open workspace is stale (one just created or joined elsewhere). The menus refresh it when opened.
 */
/**
 * No workspace in the address and none known on this device (its storage cleared, say): the server's list decides, and
 * its first workspace opens, with the person's own page, if that was asked for, beside it.
 */
const FirstWorkspace = observer(function FirstWorkspace({ route }: { route: Route }) {
  const first = workspaces.list?.[0]?.slug;
  useEffect(() => void workspaces.load(), []);
  useEffect(() => {
    if (first) router.replace(isAccountRoute(route) ? `/${first}${routePath(route)}` : workspacePath(first));
  }, [first, route]);
  return workspaces.list?.length === 0 ? (
    <Suspense fallback={null}>
      <NoWorkspace />
    </Suspense>
  ) : null;
});

function LoadWorkspaces({ ws }: { ws: string }) {
  useEffect(() => {
    if (!workspaces.list?.some((w) => w.slug === ws)) afterPaint(() => void workspaces.load());
  }, [ws]);
  // The person's settings, once on a device that has none saved and got none with the snapshot (account.ts): so it waits
  // for the workspace to load (a warm start loads from disk, with no snapshot).
  useEffect(() => when(() => store.status !== "loading", () => afterPaint(() => account.startup())), []);
  return null;
}

/**
 * The person's own page opened with a workspace in front (/atlas/settings/profile): that workspace is now the one beside
 * it (store.ts), and the address loses it, so it reads as the person's, the same in every workspace (PLNR-225).
 */
function AccountAddress({ route }: { route: Route }) {
  const legacy = isAccountRoute(route) && route.ws !== null ? routePath(route) : null;
  useEffect(() => {
    if (legacy) router.replace(legacy + location.search + location.hash);
  }, [legacy]);
  return null;
}

/** Why the workspace can't be shown, or null when it can; one not found or refused never gets here (App). */
function unavailable(): ReactNode {
  return store.status === "error" ? <Message>Could not load the workspace: {store.error}</Message> : null;
}

const Screen = observer(function Screen({ ws }: { ws: string }) {
  const route = router.route;
  const problem = unavailable();
  if (problem) return problem;
  if (route.name === "projects")
    return (
      <Suspense fallback={<div className="flex-1" />}>
        <AllProjects ws={ws} archived={route.archived} />
      </Suspense>
    );
  if (route.name === "views" || route.name === "view")
    return (
      <Suspense fallback={<div className="flex-1" />}>
        {route.name === "views" ? <ViewsIndex ws={ws} /> : <WorkspaceView key={route.viewId} ws={ws} viewId={route.viewId} />}
      </Suspense>
    );
  if (!("projectKey" in route)) return <Home ws={ws} />;
  const issueKey = routeIssue(route);
  const open = issueKey ? (store.issueByKey(issueKey) ?? null) : null;
  // An issue's page is in its project, whatever key the link has: a moved issue's old key (PLNR-448) opens it where it is.
  const project = (route.name === "browse" && open ? store.projects.get(open.projectId) : undefined) ?? store.projectByKey(route.projectKey);
  if (!project) return <Message>{store.status === "loading" ? "Loading…" : `No project ${route.projectKey}`}</Message>;
  return (
    <>
      <CanonicalKey ws={ws} project={project} />
      {route.name === "settings" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ProjectSettings key={project.id} ws={ws} project={project} />
        </Suspense>
      ) : route.name === "archive" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ProjectArchive key={project.id} ws={ws} project={project} />
        </Suspense>
      ) : route.name === "history" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ProjectHistory key={project.id} ws={ws} project={project} />
        </Suspense>
      ) : route.name === "projectHome" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ProjectHome key={project.id} ws={ws} project={project} />
        </Suspense>
      ) : route.name === "cycles" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ProjectCycles key={project.id} ws={ws} project={project} />
        </Suspense>
      ) : route.name === "cycle" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <CyclePage key={`${project.id}:${route.cycle}`} ws={ws} project={project} number={route.cycle} />
        </Suspense>
      ) : route.name === "browse" ? (
        open ? (
          <Suspense fallback={<div className="flex-1" />}>
            <IssuePage key={open.id} ws={ws} project={project} issue={open} />
          </Suspense>
        ) : (
          <Message>{store.status === "loading" ? "Loading…" : `No issue ${route.issueKey}`}</Message>
        )
      ) : (
        <ProjectIssues ws={ws} project={project} open={open} />
      )}
    </>
  );
});

/**
 * A link with a key the project had before a rename (or a project renamed while open), or with a key an issue had before
 * a move (PLNR-448, or an issue moved while open), opens it and puts the current key in the address bar, without a
 * history entry. A moved issue waits for its number.
 */
const CanonicalKey = observer(function CanonicalKey({ ws, project }: { ws: string; project: Project }) {
  const route = router.route;
  const issueKey = routeIssue(route);
  const open = issueKey ? store.issueByKey(issueKey) : undefined;
  const numbered = !!open && open.number > 0;
  const moved = numbered && issueKey!.toUpperCase() !== store.issueKey(open!);
  const target =
    !("projectKey" in route) || (route.projectKey === project.key && !moved)
      ? null
      : route.name === "settings" || route.name === "archive" || route.name === "history" || route.name === "cycles" || route.name === "projectHome"
        ? paths[route.name](ws, project.key)
        : route.name === "cycle"
          ? paths.cycle(ws, project.key, route.cycle)
        : route.name === "browse"
          ? numbered && paths.browse(ws, store.issueKey(open!))
          : route.name === "listIssue"
            ? numbered && paths.listIssue(ws, project.key, store.issueKey(open!))
            : paths.issues(ws, project.key);
  useEffect(() => {
    if (target) router.replace(target + location.search + location.hash);
  }, [target]);
  return null;
});

/**
 * "/" and "/:ws": where the person starts (Settings › Preferences › Navigation, RSVA-527): My work, the inbox, or the
 * first project's issues once the snapshot is here.
 */
const Home = observer(function Home({ ws }: { ws: string }) {
  const start = uiChoice().start;
  const first = store.projectList()[0];
  const target = start === "myWork" ? paths.myWork(ws) : start === "inbox" ? paths.inbox(ws) : first ? paths.issues(ws, first.key) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [target]);
  return <Message>{store.status === "loading" ? "Loading…" : "No projects yet"}</Message>;
});

/** The URL names a workspace the server doesn't have: say so and offer the ones that exist. */
const WorkspaceNotFound = observer(function WorkspaceNotFound({ ws }: { ws: string }) {
  useEffect(() => void workspaces.load(), []);
  const list = workspaces.list;
  // "/" opened the default workspace, which is not the viewer's: go to their first one instead. An account page keeps
  // its page and opens that workspace beside it.
  const first = router.route.ws === null ? list?.[0] : undefined;
  useEffect(() => {
    if (first) router.replace(isAccountRoute(router.route) ? paths.accountIn(first.slug, router.path) : workspacePath(first.slug));
  }, [first]);
  return (
    <Alone>
      <h1 className="text-title-md font-semibold">Workspace “{ws}” not found</h1>
      <p className="text-ink-2">It doesn't exist, or you are not a member.</p>
      {list && list.length > 0 && (
        <ul className="flex flex-col gap-1">
          {list.map((w) => {
            const href = workspacePath(w.slug);
            return (
              <li key={w.slug}>
                <Link className="link-plate" href={href}>
                  {w.name} <span className="font-mono text-meta text-ink-3">/{w.slug}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Alone>
  );
});

/**
 * Refused by the workspace: a role without access, or just removed. Removed from the last workspace, the session ended
 * too: asking for the list finds out, and its 401 brings the sign-in screen (workspaces.ts).
 */
function NoAccess() {
  useEffect(() => void workspaces.load(), []);
  return (
    <Alone>
      <p className="text-ink-2">You don't have access to this workspace. Ask its admin to change your role.</p>
    </Alone>
  );
}

/** A screen of its own in the middle of the window, with no workspace around it. */
function Alone({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-ground">
      <div className="m-auto flex max-w-sm flex-col gap-3 p-6">{children}</div>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="flex-1 p-6 text-ink-3">{children}</div>;
}

/**
 * The session ended with changes unsent: they are safe on this device, and only signing in as the same person sends them.
 * When someone else signed in in this browser, their sign-in deleted the copy on disk: the changes live in this tab alone.
 */
function WaitingForSignIn({ n, someoneElse }: { n: number; someoneElse: boolean }) {
  const waits = n === 1 ? "1 change waits" : `${n} changes wait`;
  return (
    <p className="mb-4 text-label text-ink-2">
      {someoneElse ? `${waits} in this tab only: someone else signed in in this browser. Sign in here as the same person to send them; closing this tab loses them.` : `${waits} on this device. Sign in as the same person to send them.`}
    </p>
  );
}

/** A transaction the server refused (rejection.tsx, in the edit chunk). */
const Rejection = chunkWhen("Rejection", () => store.lastRejection);
