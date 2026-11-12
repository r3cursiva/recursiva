// The project's header, one row on every page of a project (the navigation artboards, PLNR-58): where you are, the
// project's pages, then the page's own tools. It takes the place of the top bar, the title with its counts and the tab row: the layouts of
// the issues, the settings and the archive are different kinds of pages, so they are no longer tabs side by side.
import { ArrowLeftIcon, ArrowsClockwiseIcon, CaretDownIcon, CaretLeftIcon, ClockCounterClockwiseIcon, DotsThreeIcon, HouseIcon, ListBulletsIcon } from "@phosphor-icons/react";
import { cycleStatus, type Cycle, type Project } from "@rsva/schema/models";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "@rsva/ui/components/breadcrumb";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { Kbd } from "@rsva/ui/components/kbd";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { type ReactNode } from "react";
import { localToday } from "@rsva/query";
import { daysLeft } from "../lib/cycles.ts";
import { navigateOnClick, paths, router } from "../router.ts";
import { backToProject } from "../return-to.ts";
import { store } from "../store.ts";
import { LazyMenu } from "./lazy-menu.tsx";
import { chunk, loadEditChunk } from "./load-edit-chunk.ts";
import { HEAD_FIT } from "./layout-switch.tsx";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { Link } from "../link.tsx";

const ProjectMenu = chunk("ProjectMenu");
const ProjectPagesMenu = chunk("ProjectPagesMenu");

/** A phone's tab under a header: the settings' pages. */
export const pageTab =
  "max-md:relative max-md:flex max-md:items-center max-md:gap-1.5 max-md:text-[14px] max-md:text-ink-3 max-md:outline-none max-md:aria-[current=page]:font-medium max-md:aria-[current=page]:text-ink max-md:aria-[current=page]:after:absolute max-md:aria-[current=page]:after:inset-x-0 max-md:aria-[current=page]:after:-bottom-px max-md:aria-[current=page]:after:h-0.5 max-md:aria-[current=page]:after:bg-ink max-md:focus-visible:underline";

/** A project's page beside the title, on a wide screen. */
const headerTab =
  "tab-plate relative flex h-[43px] shrink-0 whitespace-nowrap items-center gap-[7px] px-2.5 text-ink-2 outline-none transition-colors duration-120 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:font-medium aria-[current=page]:text-ink aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-2 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-[1px] aria-[current=page]:after:bg-ink [&_svg]:size-3.5";

/** The workspace's name and the slash after it, first in a breadcrumb; `className` says where they hide. */
export const WorkspaceCrumb = observer(function WorkspaceCrumb({ ws, className }: { ws: string; className: string }) {
  return (
    <>
      <BreadcrumbItem className={className}>
        <span className="truncate text-ink-3">{store.workspace?.name ?? ws}</span>
      </BreadcrumbItem>
      <BreadcrumbSeparator className={className} />
    </>
  );
});

/**
 * `page` names a page of the project other than its issues. Settings and the archive also get a way back to the page
 * they were opened from, as Esc does. The tabs follow the title (Collapsed A artboard) and the title stays the same on the pages they lead to,
 * so a tab does not move away from the pointer; `children` sit at the row's right end, so they stay put on every page
 * and project. Sticky: on the pages that scroll as a whole it stays on top.
 */
export const ProjectHeader = observer(function ProjectHeader({
  ws,
  project,
  page,
  favorite,
  children,
}: {
  ws: string;
  project: Project;
  page?: string;
  /** After the page's title on a wide screen: its star (favorite-button.tsx), for a page that can be a favorite. */
  favorite?: ReactNode;
  children?: ReactNode;
}) {
  const issues = paths.issues(ws, project.key);
  const route = router.route.name;
  const tabbed = route === "projectHome" || route === "issues" || route === "cycles" || route === "history";
  // Settings and the archive go back to the project's page they were opened from.
  const back = route === "settings" || route === "archive" ? backToProject(ws, project.key) : null;
  // On a phone the header's chevron goes one level up: from the project's tabs to the projects, from a cycle to the
  // cycles, from settings and the archive back, from another page without tabs to the issues.
  const up = tabbed ? paths.projects(ws) : route === "cycle" ? paths.cycles(ws, project.key) : back ?? issues;
  return (
    <>
    {/* One row on a wide screen, however narrow (a container, /head): as it narrows the tools give up their words, in
        the order of what is cheapest to lose (HEAD_FIT in layout-switch.tsx), never wrapping to a second row. */}
    <header className="@container/head sticky top-0 z-10 flex min-h-(--topbar) shrink-0 items-center gap-x-2.5 gap-y-1 border-b bg-panel py-1.5 pr-3.5 pl-[22px] max-md:flex-wrap max-md:min-h-13 max-md:gap-x-1 max-md:py-1 max-md:pr-1 max-md:pl-1">
      <Link href={up} aria-label={tabbed ? "All projects" : "Back"} className={buttonVariants({ variant: "ghost", size: "icon", className: "-mr-1 max-md:order-0 md:hidden" })}>
        <CaretLeftIcon />
      </Link>
      {tabbed ? (
        // The project's pages open from its title (PLNR-282): Issues is the page used nearly always, so the others
        // take no row of tabs on every page.
        <h1 className="flex min-w-0 flex-1 max-md:order-0 md:hidden">
          <LazyMenu
            menu={ProjectPagesMenu}
            props={{ project }}
            button={(props) => (
              <button
                type="button"
                aria-label={`${project.name}, ${pageName()}: project pages`}
                onPointerDown={loadEditChunk}
                {...props}
                className="flex h-11 min-w-0 items-center gap-2.5 rounded-md pr-2 text-[20px] leading-[1.2] font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ProjectIcon project={project} className="size-6 shrink-0 rounded-[7px] text-xs" />
                <span className="truncate">{project.name}</span>
                {/* The caret follows the page's name, not the project's: it changes the page, the project stays. */}
                {/* The look of the phone's view chips (view-tabs.tsx), unselected. */}
                <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-control-border pr-2.5 pl-3 text-[13px] font-medium tracking-normal text-ink-2">
                  {pageName()}
                  <CaretDownIcon weight="bold" className="size-3 text-ink-3" />
                </span>
              </button>
            )}
          />
        </h1>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 max-md:order-0 md:hidden">
          <ProjectIcon project={project} className="size-6 rounded-[7px] text-xs" />
          <h1 className="truncate text-[20px] leading-[1.2] font-semibold tracking-[-0.02em]">{page}</h1>
        </div>
      )}
      <Breadcrumb className="max-md:hidden md:max-w-[320px] md:shrink-0">
        <BreadcrumbList className="gap-2.5 text-ink">
          <BreadcrumbItem className="shrink-0">
            <ProjectIcon project={project} className="size-4 text-[9.5px]" />
          </BreadcrumbItem>
          {page && !tabbed ? (
            <>
              <BreadcrumbItem>
                <BreadcrumbLink href={issues} onClick={(e) => navigateOnClick(e, issues)} className="text-ink-2 outline-none transition-none focus-visible:underline">
                  {project.name}
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <h1 className="min-w-0 truncate text-[14px] font-semibold">{page}</h1>
              </BreadcrumbItem>
              {favorite && <BreadcrumbItem className="shrink-0">{favorite}</BreadcrumbItem>}
            </>
          ) : (
            <>
              <BreadcrumbItem>
                <h1 className="truncate text-[14px] font-semibold">{project.name}</h1>
              </BreadcrumbItem>
              <BreadcrumbItem className={cn("shrink-0", HEAD_FIT.key)}>
                <span className="font-mono text-meta text-ink-3">{project.key}</span>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <span aria-hidden className="mx-1 h-[18px] w-px bg-rule max-md:hidden" />
      {/* As tall as the header, whatever its padding: the current tab's line lies on the header's border. */}
      <PageTabs ws={ws} project={project} className="-my-1.5 flex items-center gap-0.5 max-md:hidden" />
      {/* After the tabs: they stay in one place on every page, so a tab does not move away from the pointer. */}
      {back && (
        <Link href={back} className={buttonVariants({ variant: "ghost", className: "ml-auto max-md:hidden" })}>
          <ArrowLeftIcon />
          Back to {project.key}
          <Kbd>Esc</Kbd>
        </Link>
      )}
      {/* Tools that do not fit beside the title (a cycle's) take a line of their own on a phone. */}
      {children && <div className={cn(!back && "ml-auto", "flex flex-wrap items-center gap-1 md:flex-nowrap md:gap-2.5 max-md:order-2 max-md:contents max-md:has-[[role=radiogroup]]:flex max-md:has-[[role=radiogroup]]:w-full max-md:has-[[role=radiogroup]]:flex-nowrap max-md:has-[[role=radiogroup]]:px-3 max-md:has-[[role=radiogroup]]:pb-1")}>{children}</div>}
      <span className="max-md:order-1 md:hidden">
        <LazyMenu
          menu={ProjectMenu}
          props={{ project }}
          button={(props) => (
            <Button type="button" variant="ghost" size="icon" aria-label={`${project.name} options`} onPointerDown={loadEditChunk} {...props}>
              <DotsThreeIcon weight="bold" />
            </Button>
          )}
        />
      </span>
    </header>
    </>
  );
});

/** The project's pages. */
export function projectPages(ws: string, project: Project) {
  const r = router.route.name;
  return [
    { href: paths.projectHome(ws, project.key), label: "Home", icon: <HouseIcon />, here: r === "projectHome", keys: "G O" },
    { href: paths.issues(ws, project.key), label: "Issues", icon: <ListBulletsIcon />, here: r === "issues" || r === "listIssue" || r === "browse", keys: "G I" },
    { href: paths.cycles(ws, project.key), label: "Cycles", icon: <ArrowsClockwiseIcon />, here: r === "cycles" || r === "cycle", keys: "G C" },
    { href: paths.history(ws, project.key), label: "History", icon: <ClockCounterClockwiseIcon />, here: r === "history", keys: "G H" },
  ];
}

/** The cycle in progress, or one past its end and not completed yet. Read from the store: the badge needs no request and no lazy code. */
function cycleInProgress(project: Project): Cycle | undefined {
  const now = localToday();
  return store.cyclesOf(project.id).find((c) => {
    const s = cycleStatus(c, now);
    return s === "active" || s === "ended";
  });
}

/** The cycle in progress as "C12", on a wide screen with the days left; one past its end and not completed yet in the signal color. */
function CycleBadge({ cycle, ended, className }: { cycle: Cycle; ended: boolean; className?: string | undefined }) {
  return (
    <span
      className={cn("font-mono text-meta font-normal tabular-nums md:text-[10.5px]", ended ? "text-signal-text" : "text-ink-3", className)}
      title={ended ? `${cycle.name} is past its end: complete it` : `${cycle.name} is in progress`}
    >
      C{cycle.number}
      {!ended && <span className={cn("max-md:hidden", HEAD_FIT.days)}> · {daysLeft(cycle)}</span>}
    </span>
  );
}

/** The title of the project's page on a phone: the one of its pages you are on. */
function pageName(): string {
  const r = router.route.name;
  return r === "projectHome" ? "Home" : r === "cycles" ? "Cycles" : r === "history" ? "History" : "Issues";
}

/** What a page's tab or menu item says beside its name: the open issues, the cycle in progress. */
export const PageBadge = observer(function PageBadge({ project, label, className }: { project: Project; label: string; className?: string }) {
  if (label === "Issues") {
    const active = store.activeCount(project.id);
    return active > 0 ? <span className={cn("font-mono text-[10.5px] font-normal text-ink-3 tabular-nums", className)}>{active}</span> : null;
  }
  if (label !== "Cycles") return null;
  const current = cycleInProgress(project);
  return current ? <CycleBadge cycle={current} ended={cycleStatus(current, localToday()) === "ended"} className={className} /> : null;
});

/** The way between a project's pages beside the title on a wide screen; a phone opens them from the title. */
const PageTabs = observer(function PageTabs({ ws, project, className }: { ws: string; project: Project; className: string }) {
  const pages = projectPages(ws, project);
  return (
    <nav aria-label="Project pages" className={className}>
      {pages.map((p) => (
        <Link key={p.label} href={p.href} aria-current={p.here ? "page" : undefined} title={`${p.label} (${p.keys})`} className={headerTab}>
          <span className="flex">{p.icon}</span>
          <span className={cn(!p.here && HEAD_FIT.tab)}>{p.label}</span>
          <PageBadge project={project} label={p.label} />
        </Link>
      ))}
    </nav>
  );
});
