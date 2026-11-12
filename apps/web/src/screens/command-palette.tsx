// The command palette (⌘/Ctrl+K), Plane's "Power K": search issues of the whole workspace by key or title, jump to
// projects, and run actions on the open or selected issue. Built on Base UI's Autocomplete in a Dialog (ADR 0005:
// not cmdk, which brings Radix Dialog). Base UI's own filtering is off: @rsva/display search.ts ranks the issues, and the
// actions are filtered here, so the list never holds more than ~60 options.
import {
  ArchiveIcon,
  ArrowSquareRightIcon,
  ArrowsClockwiseIcon,
  BellIcon,
  CellSignalHighIcon,
  CheckIcon,
  CircleHalfIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  EnvelopeSimpleIcon,
  FunnelSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  KanbanIcon,
  KeyIcon,
  KeyboardIcon,
  LinkIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  PaintBrushIcon,
  PaletteIcon,
  PlusIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  StarIcon,
  SwapIcon,
  TelegramLogoIcon,
  TrashIcon,
  TreeStructureIcon,
  UserCircleIcon,
  UserPlusIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { pinRef, type PinRef } from "@rsva/protocol";
import { assignable, isLiveIssue, PRIORITIES, type Issue, type Project } from "@rsva/schema/models";
import { plural, toggled } from "@rsva/schema/util";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandInputRow,
  CommandItem,
  CommandList,
  CommandScope,
  CommandShortcut,
} from "@rsva/ui/components/command";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { observer } from "mobx-react-lite";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { keys } from "@rsva/ui/lib/keys";
import { DARK_THEME_INFO, LIGHT_THEME_INFO } from "@rsva/display/themes";
import { projectPath, setUi, uiChoice } from "../panes.ts";
import { theme, type ThemePreview } from "../theme.ts";
import { DENSITY, PANES } from "./layout-options.tsx";
import { THEME } from "./sidebar-foot.tsx";
import { ThemeSwatch } from "./theme-swatch.tsx";
import { buildIndex, byKey, search } from "@rsva/display/search";
import { liveIssueIndex } from "./issue-index.ts";
import { paths, routeIssue, routeProject, router } from "../router.ts";
import { viewerCan } from "../lib/roles.ts";
import { currentWs, store } from "../store.ts";
import { cycleShort } from "../lib/cycles.ts";
import { pinTarget, recentPins, routePin, type PinTarget } from "../lib/pins.ts";
import { currentList } from "../lib/views.ts";
import { viewPanel } from "./view-panel-state.ts";
import { toggleDisplay } from "./view-tabs.tsx";
import { createIssue } from "./create-state.ts";
import { canMove, copyBranchHint, copyIssueBranch, copyIssueKey, copyIssueLink, copyKeyHint, moveHint, moveIssues, openIssue, subIssuesLeft } from "./issue-actions.ts";
import { issueActions } from "./issue-menu.tsx";
import { toggleLayout } from "./layout-switch.tsx";
import { listView } from "./list-view.ts";
import { isPhone } from "../lib/phone.ts";
import { moveRequest, newProject, palette, shortcutSheet } from "./palette-state.ts";
import { sidebar } from "./sidebar-state.ts";
import { pinLabel, togglePin } from "./pin-actions.ts";
import { PinIcon } from "./sidebar.tsx";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { openWorkspace, workspaceDetails } from "./workspace-menu.tsx";
import { WorkspaceIcon } from "./workspace-switcher.tsx";
import { workspaces } from "../workspaces.ts";
import { StateGlyph } from "./state-glyph.tsx";

interface Item {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Right-aligned: a key, a shortcut. */
  hint?: string;
  run: () => void;
  /** Opens a sub-page instead of closing the palette. */
  stay?: boolean;
  /** A theme shown while the item is highlighted from the keyboard, put back when it is not. */
  preview?: ThemePreview;
  /** More words the search finds it by. */
  keywords?: string;
  /** In use now: a check on the right. */
  checked?: boolean;
}

interface Group {
  value: string;
  items: Item[];
}

type Page = "root" | "workspaces" | "state" | "priority" | "assignee" | "theme" | "move" | "move-subs";

// Every sub-page picks a value from one list. Its chip says what and, for an issue's field, whose, so the list has no
// heading; the field asks for it.
const SCOPE: Record<Exclude<Page, "root">, string> = {
  workspaces: "Workspace",
  state: "State",
  priority: "Priority",
  assignee: "Assignees",
  theme: "Theme",
  move: "Move to project",
  "move-subs": "Sub-issues",
};
const ISSUE_PAGES: ReadonlySet<Page> = new Set(["state", "priority", "assignee"]);
/** A page whose chip does not read as the thing to pick. */
const PLACEHOLDER: Partial<Record<Page, string>> = { move: "Select a project…", "move-subs": "Take the sub-issues along?" };


const saveLook = (p: Promise<void>): void => void p.catch((e: unknown) => console.warn("rsva appearance: not saved:", e));

/** The issue actions apply to: the open one, else the selected row. */
function targetIssue(): Issue | undefined {
  const r = router.route;
  const key = routeIssue(r);
  if (key) return store.issueByKey(key);
  return listView.selectedId ? store.issues.get(listView.selectedId) : undefined;
}

export const CommandPalette = observer(function CommandPalette() {
  return (
    <CommandDialog open onOpenChange={(open) => !open && palette.close()} aria-label="Command palette">
      <Body />
    </CommandDialog>
  );
});

const Body = observer(function Body() {
  const [query, setQuery] = useState("");
  // Opened to move issues (an issue's menu, ⌘⇧M, the bulk bar): straight on the project page (PLNR-448).
  const [moving, setMoving] = useState<string[]>(() => moveRequest.ids);
  const [moveTo, setMoveTo] = useState<Project | null>(null);
  const [page, setPage] = useState<Page>(moving.length ? "move" : "root");
  useEffect(() => () => moveRequest.clear(), []);
  // Built once per opening: the palette is short-lived, and edits made while it is open do not need to show up in it.
  const index = useMemo(() => {
    const t = performance.now();
    const idx = liveIssueIndex();
    performance.measure("rsva:palette-index", { start: t });
    return idx;
  }, []);
  const issue = targetIssue();
  const r = router.route;
  const ws = currentWs();
  const key = routeProject(r);
  const project = key ? store.projectByKey(key) : undefined;

  const go = (p: Page) => () => {
    setPage(p);
    setQuery("");
  };

  const groups = useMemo((): Group[] => {
    const t = performance.now();
    const q = query.trim().toLowerCase();
    const match = (label: string) => !q || label.toLowerCase().includes(q);
    const pick = (items: Item[]) => items.filter((i) => match(i.keywords ? `${i.label} ${i.keywords}` : i.label));
    const out: Group[] = [];
    const add = (value: string, items: Item[]) => items.length && out.push({ value, items });

    if (page === "state" && issue) {
      add(
        "Change state",
        pick(
          store.statesOf(issue.projectId).map((s) => ({
            id: `state:${s.id}`,
            label: s.name,
            icon: <StateGlyph state={s} />,
            run: () => store.updateIssue(issue.id, { stateId: s.id }),
          })),
        ),
      );
    } else if (page === "priority" && issue) {
      add(
        "Change priority",
        pick(PRIORITIES.map((p) => ({ id: `priority:${p.code}`, label: p.name, icon: <PriorityIcon priority={p.code} />, run: () => store.updateIssue(issue.id, { priority: p.code }) }))),
      );
    } else if (page === "assignee" && issue) {
      add(
        "Assign to",
        pick(
          assignable(store.users.values()).map((u) => {
            const has = issue.assigneeIds.includes(u.id);
            const item: Item = {
              id: `user:${u.id}`,
              label: u.name,
              icon: <UserAvatar {...face(u)} className="size-4" />,
              run: () => store.updateIssue(issue.id, { assigneeIds: toggled(issue.assigneeIds, u.id) }),
            };
            if (has) item.hint = "Assigned";
            return item;
          }),
        ),
      );
    } else if (page === "move") {
      const from = new Set(moving.map((id) => store.issues.get(id)?.projectId));
      add(
        "Move to project",
        pick(
          store
            .projectList()
            .filter((p) => !(from.size === 1 && from.has(p.id)))
            .map((p) => ({
              id: `move:${p.id}`,
              label: p.name,
              hint: p.key,
              keywords: p.key,
              icon: <ProjectIcon project={p} className="size-4" />,
              // A parent's sub-issues: the next page asks whether they go too.
              stay: subIssuesLeft(moving).length > 0,
              run: () => {
                if (!subIssuesLeft(moving).length) return moveIssues(moving, p.id, false);
                setMoveTo(p);
                go("move-subs")();
              },
            })),
        ),
      );
    } else if (page === "move-subs" && moveTo) {
      const n = subIssuesLeft(moving).length;
      add(
        `Sub-issues to ${moveTo.name}`,
        pick([
          { id: "subs:with", label: `Move with ${plural(n, "sub-issue")}`, icon: <TreeStructureIcon />, run: () => moveIssues(moving, moveTo.id, true) },
          { id: "subs:without", label: "Move without sub-issues", icon: <ArrowSquareRightIcon />, keywords: "only alone", run: () => moveIssues(moving, moveTo.id, false) },
        ]),
      );
    } else if (page === "workspaces") {
      add("Workspaces", pick(workspaceItems(ws)));
    } else if (page === "theme") {
      // The themes of the side on screen, light or dark, whatever the mode: a pick always shows. The arrow keys show
      // each one before it is picked, Enter saves it, Esc puts back the saved one; the pointer only highlights, as
      // passing over the list would flash the app. The other side's themes: switch the mode first, or Settings › Appearance.
      const dark = theme.dark;
      const now = dark ? theme.choice.dark : theme.choice.light;
      add(
        dark ? "Dark theme" : "Light theme",
        pick(
          (dark ? DARK_THEME_INFO : LIGHT_THEME_INFO).map((t) => ({
            id: `theme:${t.id}`,
            label: t.name,
            icon: <ThemeSwatch info={t} />,
            run: () => saveLook(theme.use(t.id, t.dark)),
            preview: { name: t.id, dark: t.dark },
            checked: t.id === now,
          })),
        ),
      );
    } else {
      // A typed key goes first, above the commands that only mention it (PLNR-437): a project's ("plnr"; from two letters
      // its start, "pl" → PLNR, PLANE) and an issue's ("plnr-435"). They are not repeated in the groups below.
      const projects = buildIndex(store.projectList(), (p) => p.key, (p) => p.name);
      const keyed = { projects: q ? byKey(projects, q, q.length >= 2) : [], issue: q ? byKey(index, q, false)[0] : undefined };
      const jumps = [...(keyed.issue ? [issueItem(keyed.issue)] : []), ...keyed.projects.map((p) => projectItem(ws, p))];
      add("Top hit", jumps);
      const jumped = new Set(jumps.map((i) => i.id));
      if (issue) {
        const key = store.issueKey(issue);
        add(
          `Issue ${key}`,
          pick([
            { id: "a:state", label: "Change state…", icon: <CircleHalfIcon />, hint: "S", run: go("state"), stay: true },
            { id: "a:priority", label: "Change priority…", icon: <CellSignalHighIcon />, hint: "P", run: go("priority"), stay: true },
            { id: "a:assignee", label: "Assign to…", icon: <UsersIcon />, hint: "A", run: go("assignee"), stay: true },
            { id: "a:link", label: "Copy link", icon: <LinkIcon />, run: () => copyIssueLink(issue) },
            { id: "a:branch", label: "Copy branch name", icon: <GitBranchIcon />, hint: copyBranchHint, run: () => copyIssueBranch(issue) },
            { id: "a:key", label: "Copy key", icon: <CopyIcon />, hint: copyKeyHint, run: () => copyIssueKey(issue) },
            ...(isLiveIssue(issue) && issue.number > 0 ? [pinItem(pinRef("issue", issue.id), key)] : []),
            ...(canMove(issue)
              ? [{ id: "a:move", label: "Move to project…", icon: <ArrowSquareRightIcon />, hint: moveHint, keywords: "transfer project", run: () => (setMoving([issue.id]), go("move")()), stay: true }]
              : []),
            ...issueActions(issue)
              .filter((a) => !a.disabled)
              .map(({ id, label, icon, hint, run }) => ({ id: `a:${id}`, label, icon, run, ...(hint ? { hint } : {}) })),
          ]),
        );
      }
      // The issues, views and cycles opened last on this device, for a jump back; the one open now is not among them.
      if (!q) add("Recent", recentItems(ws));
      const actions: Item[] = [{ id: "a:create", label: "Create new issue", icon: <PlusIcon />, hint: "C", run: () => createIssue.show() }];
      // A view's or a cycle's page pins itself; an issue's pin is with the issue's actions above.
      const page = !issue && routePin();
      const shown = page && pinTarget(ws, page);
      if (shown) actions.push(pinItem(shown.ref, shown.label));
      const openWorkspaces = () => {
        void workspaces.load();
        go("workspaces")();
      };
      actions.push({ id: "a:workspace", label: "Switch workspace…", icon: <SwapIcon />, run: openWorkspaces, stay: true });
      actions.push({ id: "a:ws-settings", label: "Workspace settings", icon: <GearSixIcon />, hint: "G ,", run: () => router.push(paths.workspaceSettings(ws)) });
      actions.push({ id: "a:projects", label: "All projects", icon: <SquaresFourIcon />, hint: "G P", run: () => router.push(paths.projects(ws)) });
      actions.push({ id: "a:projects-archived", label: "Archived projects", icon: <ArchiveIcon />, run: () => router.push(paths.projects(ws, true)) });
      if (viewerCan("projects.write")) actions.push({ id: "a:project-new", label: "Create new project", icon: <PlusIcon />, hint: "N P", run: () => newProject.show() });
      if (!isPhone()) actions.push({ id: "a:keys", label: "Keyboard shortcuts", icon: <KeyboardIcon />, keywords: "keys hotkeys help", hint: "?", run: () => shortcutSheet.show() });
      if (!isPhone()) actions.push({ id: "a:sidebar", label: sidebar.strip ? "Expand sidebar" : "Collapse sidebar", icon: <SidebarSimpleIcon />, hint: keys("mod", "\\"), run: () => sidebar.toggle() });
      actions.push({ id: "a:ws-members", label: "Workspace members", icon: <UsersIcon />, run: () => router.push(paths.workspaceMembers(ws)) });
      if (viewerCan("members.manage"))
        actions.push({ id: "a:invite", label: "Invite people", icon: <UserPlusIcon />, run: () => router.push(`${paths.workspaceMembers(ws)}?invite`) });
      actions.push({ id: "a:tokens", label: "API tokens", icon: <KeyIcon />, run: () => router.push(paths.workspaceTokens(ws)) });
      actions.push({ id: "a:email", label: "Email notification settings", icon: <EnvelopeSimpleIcon />, run: () => router.push(paths.accountEmail()) });
      actions.push({ id: "a:telegram", label: "Telegram notification settings", icon: <TelegramLogoIcon />, run: () => router.push(paths.accountTelegram()) });
      actions.push({ id: "a:notifications", label: "Notification settings", icon: <BellIcon />, run: () => router.push(paths.accountNotifications()) });
      actions.push({ id: "a:profile", label: "Profile", icon: <UserCircleIcon />, run: () => router.push(paths.accountProfile()) });
      actions.push({ id: "a:preferences", label: "Preferences", icon: <SlidersHorizontalIcon />, keywords: "time zone week", run: () => router.push(paths.accountPreferences()) });
      actions.push({ id: "a:appearance", label: "Appearance", icon: <PaintBrushIcon />, keywords: "panes density layout", run: () => router.push(paths.accountAppearance()) });
      actions.push({ id: "a:theme", label: "Change theme…", icon: <PaletteIcon />, keywords: "appearance color", run: go("theme"), stay: true });
      for (const [m, name] of [["system", "Auto"], ["light", "Light"], ["dark", "Dark"]] as const) {
        const Icon = THEME[m].icon;
        actions.push({
          id: `a:mode-${m}`,
          label: `${name} color scheme`,
          icon: <Icon />,
          keywords: `theme mode appearance${m === "system" ? " system" : ""}`,
          run: () => saveLook(theme.set({ mode: m })),
          checked: theme.mode === m,
        });
      }
      // The layout, as in Settings › Appearance › Layout: the pane style and the density.
      const ui = uiChoice();
      for (const o of PANES)
        actions.push({ id: `a:panes-${o.value}`, label: `${o.label} panes`, icon: o.icon, keywords: "layout appearance frame style", run: () => saveLook(setUi({ panes: o.value })), checked: ui.panes === o.value });
      for (const o of DENSITY)
        actions.push({ id: `a:density-${o.value}`, label: `${o.label} density`, icon: o.icon, keywords: "layout appearance rows spacing", run: () => saveLook(setUi({ density: o.value })), checked: ui.density === o.value });
      actions.push({ id: "a:security", label: "Security", icon: <ShieldCheckIcon />, keywords: "sessions passkeys", run: () => router.push(paths.accountSecurity()) });
      const join = workspaces.mayCreate ? "Create or join a workspace" : "Join a workspace";
      actions.push({ id: "a:ws-new", label: join, icon: <PlusIcon />, run: () => router.push(paths.newWorkspace()) });
      if (project) {
        // The project's pages, as its items in the sidebar (PLNR-63).
        actions.push({ id: "a:cycles", label: `${project.name} cycles`, icon: <ArrowsClockwiseIcon />, hint: "G C", run: () => router.push(paths.cycles(ws, project.key)) });
        actions.push({ id: "a:history", label: `${project.name} history`, icon: <ClockCounterClockwiseIcon />, hint: "G H", run: () => router.push(paths.history(ws, project.key)) });
        // The list's view is saved in the View panel (PLNR-74), Display has a popover (ADR 0045); list or board is the
        // viewer's own (PLNR-78).
        const list = currentList(project.id);
        actions.push({
          id: "a:layout",
          label: list.layout === "board" ? "Show as list" : "Show as board",
          hint: "V",
          icon: list.layout === "board" ? <ListBulletsIcon /> : <KanbanIcon />,
          run: () => toggleLayout(list, project),
        });
        actions.push({
          id: "a:view",
          label: "Edit view: filters",
          hint: "E",
          icon: <FunnelSimpleIcon />,
          run: () => viewPanel.edit(list, project),
        });
        actions.push({ id: "a:settings", label: "Project settings", icon: <GearSixIcon />, hint: ",", run: () => router.push(paths.settings(ws, project.key)) });
        actions.push({ id: "a:archive-page", label: "Archived issues and trash", icon: <TrashIcon />, run: () => router.push(paths.archive(ws, project.key)) });
      }
      // Where the list's tools are on screen: a project's issues and a view's own page.
      if (router.route.name === "issues" || router.route.name === "view")
        actions.push({ id: "a:display", label: "Display: group, order, properties", hint: keys("shift", "V"), icon: <SlidersHorizontalIcon />, run: toggleDisplay });
      add("Actions", pick(actions));
      // Matching commands first, then issues: "prio" means the command, and an issue key never matches a command.
      if (q) {
        add(
          "Issues",
          search(index, q, 50)
            .map(issueItem)
            .filter((i) => !jumped.has(i.id)),
        );
      }
      const listed = pick(store.projectList().map((p) => projectItem(ws, p))).filter((i) => !jumped.has(i.id));
      add("Projects", q ? listed : listed.slice(0, 5));
    }
    performance.measure("rsva:palette-search", { start: t });
    return out;
    // `issue` and `project` are read from MobX inside render; the memo only needs to follow what the user typed.
  }, [query, page, index, issue, project, ws, workspaces.list, workspaces.mayCreate, theme.choice, theme.dark, moving, moveTo]);

  // Closed while trying a theme: the saved one returns.
  useEffect(() => () => theme.preview(null), []);

  return (
    <Command
      items={groups}
      value={query}
      onValueChange={(v, details) => {
        if (details.reason !== "item-press") setQuery(v);
      }}
      onItemHighlighted={(item, { reason }) => theme.preview((reason === "keyboard" && (item as Item | undefined)?.preview) || null)}
    >
      <CommandInputRow>
        {page === "root" ? (
          <MagnifyingGlassIcon />
        ) : (
          <CommandScope aria-label="Back to all commands" onClick={go("root")}>
            {issue && ISSUE_PAGES.has(page) && <span className="font-mono font-normal text-muted-foreground">{store.issueKey(issue)}</span>}
            {(page === "move" || page === "move-subs") && <span className="font-mono font-normal text-muted-foreground">{movingLabel(moving)}</span>}
            {/* The theme page lists the themes of the side on screen: the chip says which. */}
            {page === "theme" ? (theme.dark ? "Dark theme" : "Light theme") : SCOPE[page]}
          </CommandScope>
        )}
        <CommandInput
          aria-label="Search issues and commands"
          placeholder={page === "root" ? "Type a command or search…" : (PLACEHOLDER[page] ?? `Select ${SCOPE[page].toLowerCase()}…`)}
          onKeyDown={(e) => {
            // Backspace on an empty field goes back, as in Plane.
            if (e.key === "Backspace" && !query && page !== "root") go("root")();
          }}
        />
      </CommandInputRow>
      <CommandEmpty>No results</CommandEmpty>
      <CommandList>
        {(group: Group) => (
          <CommandGroup key={group.value} items={group.items} heading={page === "root" ? group.value : undefined}>
            {(item: Item) => (
              <CommandItem
                key={item.id}
                value={item}
                onClick={() => {
                  item.run();
                  if (!item.stay) palette.close();
                }}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.checked && <CheckIcon aria-label="In use" className="ml-auto" />}
                {/* A shortcut means nothing on a touch screen; a key or a project's place does. */}
                {item.hint && <CommandShortcut className={/^(issue|project|workspace|recent):/.test(item.id) ? undefined : "pointer-coarse:hidden"}>{item.hint}</CommandShortcut>}
              </CommandItem>
            )}
          </CommandGroup>
        )}
      </CommandList>
      <CommandFooter>
        <span>↑↓ to move</span>
        <span>↵ to select</span>
        <span>esc to close</span>
        <span className="ml-auto">{keys("mod", "K")}</span>
      </CommandFooter>
    </Command>
  );
});

/** What is being moved, for the page's chip: its key, or how many. */
function movingLabel(ids: readonly string[]): string {
  const one = ids.length === 1 ? store.issues.get(ids[0]!) : undefined;
  return one ? store.issueKey(one) : plural(ids.length, "issue");
}

function workspaceItems(ws: string): Item[] {
  return (workspaces.list ?? []).map((w) => ({
    id: `workspace:${w.slug}`,
    label: w.name,
    hint: w.slug === ws ? "Current" : workspaceDetails(w),
    icon: <WorkspaceIcon workspace={w} current={w.slug === ws} className="size-4 rounded-xs text-[9px]" />,
    run: () => openWorkspace(w.slug),
  }));
}

function pinItem(ref: PinRef, name: string): Item {
  return { id: "a:pin", label: pinLabel(ref), icon: <StarIcon />, keywords: "favorite star pin sidebar", run: () => togglePin(ref, name) };
}

const RECENT_SHOWN = 5;

function recentItems(ws: string): Item[] {
  const open = routePin();
  return recentPins(ws)
    .filter((r) => r !== open)
    .flatMap((r) => pinTarget(ws, r) ?? [])
    .slice(0, RECENT_SHOWN)
    .map((t) => ({ id: `recent:${t.ref}`, label: t.label, icon: <PinIcon pin={t} />, hint: recentHint(t), run: () => (t.kind === "issue" ? openIssue(t.issue) : router.push(t.href)) }));
}

const recentHint = (t: PinTarget): string => (t.kind === "issue" ? t.key : t.kind === "cycle" ? `${t.project.key} · ${cycleShort(t.cycle)}` : "View");

function projectItem(ws: string, p: Project): Item {
  return {
    id: `project:${p.id}`,
    label: p.name,
    hint: p.key,
    keywords: p.key,
    icon: <ProjectIcon project={p} className="size-4" />,
    run: () => router.push(projectPath(ws, p.key)),
  };
}

function issueItem(i: Issue): Item {
  const s = store.states.get(i.stateId);
  return { id: `issue:${i.id}`, label: i.title, hint: store.issueKey(i), icon: s && <StateGlyph state={s} />, run: () => openIssue(i) };
}
