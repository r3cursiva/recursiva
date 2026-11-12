// Workspace settings, after the "A · Ledger — workspace settings (General)" artboard: its own navigation in place of the
// sidebar, a header with the path, then the sections. Changes save at once through the sync engine, like project
// settings, and are reverted with a toast if refused.
//
// Only what works is here (owner's rule, ADR 0010): the name, the tile's color and the address, read-only; Members is
// its own page (workspace-members.tsx, ADR 0011), GitHub too, for admins (workspace-github.tsx, PLNR-96), and so are API
// tokens and the person's own pages: Profile (PLNR-194), Preferences, Appearance (ADR 0031), Notifications and Security (ADR 0025). The artboard's other account pages, teams, logo upload,
// language, time zone, working days, access, plan, export, ownership transfer and delete wait for the features behind
// them; docs/features.md lists them.
import { ArrowLeftIcon, CaretDownIcon, CaretLeftIcon } from "@phosphor-icons/react";
import { can } from "@rsva/policy";
import type { WorkspaceInfo } from "@rsva/schema/models";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@rsva/ui/components/breadcrumb";
import { InputGroup } from "@rsva/ui/components/input-group";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import { TileColorPicker } from "@rsva/ui/components/tile-color-picker";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useRef } from "react";
import { viewerCan } from "../lib/roles.ts";
import { paths, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { useIsPhone } from "../lib/phone.ts";
import { workspaces } from "../workspaces.ts";
import { backToWork } from "../return-to.ts";
import { pageTab } from "./project-header.tsx";
import { SaveStatus } from "./save-status.tsx";
import { CommitInput, fieldClass } from "./settings-fields.tsx";
import { AccountEmail } from "./account-email.tsx";
import { AccountTelegram } from "./account-telegram.tsx";
import { AccountNotifications } from "./account-notifications.tsx";
import { AccountPreferences } from "./account-preferences.tsx";
import { AccountProfile } from "./account-profile.tsx";
import { AccountSecurity } from "./account-security.tsx";
import { ApiTokens } from "./workspace-tokens.tsx";
import { GithubSettings, GithubTags } from "./workspace-github.tsx";
import { Members, memberCount } from "./workspace-members.tsx";
import { refreshed, WorkspaceRadioItems } from "./workspace-menu.tsx";
import { Appearance } from "./theme-picker.tsx";
import { workspaceTileTone } from "./workspace-switcher.tsx";
import { Link } from "../link.tsx";

type Page = "general" | "members" | "github" | "tokens" | "profile" | "preferences" | "appearance" | "notifications" | "email" | "telegram" | "security";

const PAGES: Record<Page, { title: string; text: string; phoneText?: string; note: string }> = {
  general: { title: "General", text: "How the workspace looks to everyone in it.", note: "Only admins can change these settings" },
  members: {
    title: "Members",
    text: "People and agents who see every project here. Admins change settings and members; members edit issues.",
    note: "Only admins can invite and change roles",
  },
  github: {
    title: "GitHub",
    text: "Pull requests and commits that mention an issue key show on the issue, and a merge can close it. The integration is set up on the server; this page shows its state.",
    phoneText: "Set up on the server; this page shows its state.",
    note: "Only admins see this page",
  },
  tokens: {
    title: "API tokens",
    text: "A token lets a script, the CLI or an agent act in this workspace. It works as its member: read only, write, or only what you pick, until it runs out or is revoked.",
    note: "Admins see every token here and make them for agents",
  },
  profile: {
    title: "Profile",
    text: "Who you are to others, in every workspace.",
    note: "Your name shows to everyone in your workspaces",
  },
  preferences: {
    title: "Preferences",
    text: "How recursiva works for you, in every workspace.",
    note: "Only you see this page",
  },
  appearance: {
    title: "Appearance",
    text: "How recursiva looks to you. Saved to your account: every device and workspace looks the same.",
    note: "Only you see this page",
  },
  notifications: {
    title: "Notifications",
    text: "What reaches you by email and in Telegram, and when. The inbox gets everything.",
    note: "Only you see this page",
  },
  email: {
    title: "Email",
    text: "How notification email comes: one at a time or bundled, the morning digest and the weekly summary.",
    note: "Only you see this page",
  },
  telegram: {
    title: "Telegram",
    text: "Notifications in a chat with the bot: which chat, how the messages read, and quiet hours.",
    note: "Only you see this page",
  },
  security: {
    title: "Security",
    text: "How you sign in, and where you are signed in right now.",
    note: "Only you see this page",
  },
};

/** The person's own pages: stored per user, the same in every workspace, so they read as the person's, not the workspace's. */
function isAccountPage(page: Page): boolean {
  return page === "profile" || page === "preferences" || page === "appearance" || page === "notifications" || page === "email" || page === "telegram" || page === "security";
}

/** The workspace's small tile, in the tone the switcher gives it: the nav heading and the header path show it. */
const WorkspaceTile = observer(function WorkspaceTile({ name }: { name: string }) {
  return <LetterTile name={name} tone={workspaceTileTone(store.workspace ?? { name }, true)} className="size-3.5 rounded-[4px] text-[8px]" />;
});

export const WorkspaceSettings = observer(function WorkspaceSettings({ ws, page = "general" }: { ws: string; page?: Page }) {
  const info = store.workspace;
  const name = info?.name ?? ws;
  const p = PAGES[page];
  const account = isAccountPage(page);
  // Whose settings these are: the person on their own pages, the workspace on its pages.
  const owner = account ? (store.me?.name ?? "") : name;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-(--pane-gap) max-md:flex-col max-md:gap-0">
      <SettingsNav ws={ws} name={name} page={page} />
      <main className="pane flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-(--topbar) shrink-0 items-center gap-2 border-b bg-panel px-6 max-md:hidden">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="gap-1.5">
                {account ? <UserAvatar {...face(store.me, "")} className="size-5" /> : <WorkspaceTile name={name} />}
                <span className="truncate text-[13.5px] font-semibold text-ink">{owner}</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <span className="truncate">Settings</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{p.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <SaveStatus page={page} note={p.note} className="ml-auto max-sm:hidden" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex max-w-[900px] flex-col gap-10 px-10 pt-8 pb-16 max-md:gap-7 max-md:px-4 max-md:pt-4 max-md:pb-10">
            <div className="flex flex-col gap-1.5">
              <span className="truncate font-mono text-meta tracking-[0.06em] text-ink-3 uppercase max-md:hidden">{account ? "Account" : `Workspace · ${name}`}</span>
              <div className="flex items-center gap-2.5">
                <h1 className="m-0 text-[26px] leading-[1.15] font-semibold tracking-[-0.02em] max-md:hidden">{p.title}</h1>
                {page === "github" && <GithubTags />}
              </div>
              <p className={cn("m-0 max-w-[640px] text-[13.5px] text-ink-2 max-md:text-[14px]", p.phoneText && "max-md:hidden")}>{p.text}</p>
              {p.phoneText && <p className="m-0 text-[14px] text-ink-2 md:hidden">{p.phoneText}</p>}
            </div>
            {!info ? <p className="text-ink-3">Loading…</p> : <PageBody ws={ws} page={page} info={info} />}
          </div>
        </div>
      </main>
    </div>
  );
});

function PageBody({ ws, page, info }: { ws: string; page: Page; info: WorkspaceInfo }) {
  switch (page) {
    case "members":
      return <Members ws={ws} />;
    case "github":
      return <GithubSettings ws={ws} />;
    case "tokens":
      return <ApiTokens ws={ws} />;
    case "profile":
      return <AccountProfile />;
    case "preferences":
      return <AccountPreferences />;
    case "appearance":
      return <Appearance />;
    case "notifications":
      return <AccountNotifications />;
    case "email":
      return <AccountEmail />;
    case "telegram":
      return <AccountTelegram />;
    case "security":
      return <AccountSecurity />;
    default:
      return <Identity info={info} />;
  }
}

const navItem =
  "flex h-(--nav-item) shrink-0 items-center rounded-[5px] px-2 outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-nav-current aria-[current=page]:font-medium";

/** A page under Notifications: indented on a rule, as the artboard nests Email and Telegram. */
const subPage = "max-md:order-last md:ml-[15px] md:h-[26px] md:rounded-l-none md:border-l md:border-rule";

const navHeading = "truncate px-2 pb-1.5 eyebrow max-md:hidden";

/**
 * The settings' own navigation: back to the work, then the artboard's groups, the person's own pages first. On a phone
 * the groups melt into one row of tabs that scrolls sideways, with the workspace's pages first: they are what most come for.
 */
const SettingsNav = observer(function SettingsNav({ ws, name, page }: { ws: string; name: string; page: Page }) {
  const back = backToWork(ws);
  // The picker sits in the heading of the workspace's pages, and on a phone, where headings give way to tabs, in the top row.
  const phone = useIsPhone();
  // On a phone the open page's tab may start past the row's end.
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // In a block: browsers now return a promise here, and an effect's value is its cleanup.
    row.current?.querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [page]);
  const link = (i: { page: Page; href: string; label: string; count?: number | undefined; className?: string }) => (
    <Link key={i.page} href={i.href} aria-current={i.page === page ? "page" : undefined} className={cn(navItem, "max-md:h-auto max-md:shrink-0 max-md:rounded-none max-md:bg-transparent! max-md:px-0", pageTab, i.className)}>
      <span className="flex-1 truncate">{i.label}</span>
      {i.count !== undefined && <span className="ml-2 font-mono text-[11px] text-ink-3 max-md:ml-0">{i.count}</span>}
    </Link>
  );
  return (
    <nav
      aria-label="Settings"
      className="pane flex w-(--sidebar-width) shrink-0 flex-col gap-[18px] bg-sidebar px-2.5 py-3.5 text-sidebar-foreground max-md:w-full max-md:gap-0 max-md:border-b max-md:bg-panel max-md:p-0"
    >
      <div className="flex min-w-0 items-center max-md:pr-2.5">
        <Link href={back} className={cn(navItem, "h-[30px] min-w-0 flex-1 gap-2 text-ink-2 max-md:h-13 max-md:gap-1 max-md:px-2.5 max-md:text-ink")}>
          <ArrowLeftIcon className="size-3.5 max-md:hidden" />
          <CaretLeftIcon className="size-5 text-ink-2 md:hidden" />
          <span className="truncate max-md:hidden">Back to {name}</span>
          <span className="truncate text-[20px] font-semibold tracking-[-0.02em] md:hidden">Settings</span>
        </Link>
        {phone && <WorkspacePicker name={name} page={page} phone />}
      </div>
      {/* Sideways only: the current tab's underline hangs a pixel below the row, and overflow-x alone would let Safari drag the row up and down. */}
      <div ref={row} className="flex min-w-0 flex-col gap-[18px] max-md:h-10 max-md:flex-row max-md:gap-6 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:px-4 max-md:[scrollbar-width:none]">
        <div className="flex min-w-0 flex-col gap-px max-md:contents">
          <span className={navHeading}>Account</span>
          {link({ page: "profile", href: paths.accountProfile(), label: "Profile", className: "max-md:order-last" })}
          {link({ page: "preferences", href: paths.accountPreferences(), label: "Preferences", className: "max-md:order-last" })}
          {link({ page: "appearance", href: paths.accountAppearance(), label: "Appearance", className: "max-md:order-last" })}
          {link({ page: "notifications", href: paths.accountNotifications(), label: "Notifications", className: "max-md:order-last" })}
          {link({ page: "email", href: paths.accountEmail(), label: "Email", className: subPage })}
          {link({ page: "telegram", href: paths.accountTelegram(), label: "Telegram", className: subPage })}
          {link({ page: "security", href: paths.accountSecurity(), label: "Security", className: "max-md:order-last" })}
        </div>
        <div className="flex min-w-0 flex-col gap-px max-md:contents">
          {!phone && <WorkspacePicker name={name} page={page} />}
          {link({ page: "general", href: paths.workspaceSettings(ws), label: "General" })}
          {link({ page: "members", href: paths.workspaceMembers(ws), label: "Members", count: memberCount() })}
          {viewerCan("workspace.write") && link({ page: "github", href: paths.workspaceGithub(ws), label: "GitHub" })}
          {/* Tokens belong to the workspace (a token acts as its member there): under it, not a heading of their own. */}
          {link({ page: "tokens", href: paths.workspaceTokens(ws), label: "API tokens" })}
        </div>
      </div>
    </nav>
  );
});

/** Where picking a workspace in the settings leads: the same page there, General when it is the person's own or one they may not see. */
function pageIn(slug: string, page: Page): string {
  if (page === "members") return paths.workspaceMembers(slug);
  if (page === "tokens") return paths.workspaceTokens(slug);
  const w = workspaces.list?.find((x) => x.slug === slug);
  if (page === "github" && w && can({ role: w.role }, "workspace.write")) return paths.workspaceGithub(slug);
  return paths.workspaceSettings(slug);
}

/**
 * Whose workspace pages these are, and the way to another workspace's without leaving the settings (PLNR-225). Picking
 * one is an ordinary switch: the engine follows the address (store.ts), one workspace at a time. With one workspace it
 * is only the heading.
 */
const WorkspacePicker = observer(function WorkspacePicker({ name, page, phone = false }: { name: string; page: Page; phone?: boolean }) {
  const many = (workspaces.list?.length ?? 0) > 1;
  if (phone && !many) return null;
  const label = phone ? (
    <span className="min-w-0 truncate text-[14px] font-medium text-ink">{name}</span>
  ) : (
    <span className="min-w-0 truncate eyebrow">Workspace · {name}</span>
  );
  if (!many)
    return (
      <div className="flex items-center gap-2 px-2 pb-1.5">
        <WorkspaceTile name={name} />
        {label}
      </div>
    );
  return (
    <DropdownMenu onOpenChange={refreshed}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Workspace: ${name}. Pick another`}
            className={cn(
              "group flex min-w-0 items-center gap-2 rounded-[5px] text-left outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-row-hover",
              phone ? "h-11 max-w-[55%] shrink-0 px-2" : "mb-1.5 h-6 px-2",
            )}
          />
        }
      >
        <WorkspaceTile name={name} />
        {label}
        <CaretDownIcon className="size-3 shrink-0 text-ink-3 transition-transform group-data-popup-open:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align={phone ? "end" : "start"}>
        <WorkspaceRadioItems onPick={(slug) => slug !== currentWs() && router.push(pageIn(slug, page))} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const Identity = observer(function Identity({ info }: { info: WorkspaceInfo }) {
  // The server refuses anyone else; the fields say so before a change is tried.
  const editable = viewerCan("workspace.write");
  return (
    <SettingsSection id="identity" title="Identity">
      <SettingRow label="Color" hint="The workspace's tile in the sidebar and the workspace menu.">
        <div className="flex flex-wrap items-center gap-[18px]">
          {/* Keyed by tone: a new color replays the tile's pop, as the artboard does. */}
          <LetterTile
            key={workspaceTileTone(info, true)}
            name={info.name}
            tone={workspaceTileTone(info, true)}
            className="size-14 animate-in rounded-[14px] text-2xl duration-300 ease-spring zoom-in-90"
          />
          <TileColorPicker
            name={info.name}
            value={info.color}
            autoTone="ink"
            autoTitle="Automatic (ink while open, a tone from the name elsewhere)"
            label="Workspace color"
            disabled={!editable}
            onChange={(color) => store.updateWorkspace({ color })}
          />
        </div>
      </SettingRow>
      <SettingRow label="Name" htmlFor="workspace-name">
        <CommitInput
          id="workspace-name"
          value={info.name}
          disabled={!editable}
          className="max-w-[420px] disabled:opacity-60"
          onCommit={(name) => store.updateWorkspace({ name })}
        />
      </SettingRow>
      <SettingRow label="URL" hint="Links, local copies and agent tokens use it, so it stays." top>
        <InputGroup className={cn(fieldClass, "max-w-[420px] bg-transparent font-mono text-[13px] dark:bg-transparent")}>
          <span className="text-ink-3">{location.host}/</span>
          <span className="truncate">{info.slug}</span>
        </InputGroup>
      </SettingRow>
    </SettingsSection>
  );
});
