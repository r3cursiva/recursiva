// Every saved view the viewer sees (PLNR-74, the ViewsIndex artboard): /:ws/views. For each: its projects (its Project
// filter; none means all), what else it shows, who sees it, the tab and sidebar switches, its count, and Edit.
import { CaretLeftIcon, LockSimpleIcon, PlusIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { pinRef, type SavedView } from "@rsva/protocol";
import { formatQuery, parseQuery } from "@rsva/query";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList } from "@rsva/ui/components/breadcrumb";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { Segmented } from "@rsva/ui/components/segmented";
import { Switch } from "@rsva/ui/components/switch";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { mayEdit, viewCount, viewPath, viewProjects } from "../lib/views.ts";
import { paths, router } from "../router.ts";
import { store } from "../store.ts";
import { blankList, queryContext, viewState, WS_SCOPE } from "../view-state.ts";
import { FAB } from "./layout-switch.tsx";
import { WorkspaceCrumb } from "./project-header.tsx";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { ViewIcon } from "./view-icon.tsx";
import { viewPanel } from "./view-panel-state.ts";
import { Link } from "../link.tsx";

type Which = "all" | "shared" | "mine";

export const ViewsIndex = observer(function ViewsIndex({ ws }: { ws: string }) {
  const [which, setWhich] = useState<Which>("all");
  const me = store.me?.id;
  const keep = (w: Which) => (v: SavedView) => w === "all" || (w === "shared" ? v.shared : !v.shared && v.ownerId === me);
  const all = store.views.list;
  const shown = all.filter(keep(which));
  return (
    <>
      <header className="sticky top-0 z-10 flex min-h-(--topbar) shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-panel py-1.5 pr-3.5 pl-5 max-md:gap-y-2 max-md:pt-1 max-md:pr-4 max-md:pb-3 max-md:pl-1">
        <Link href={paths.projects(ws)} aria-label="Back to projects" className={buttonVariants({ variant: "ghost", size: "icon", className: "-mr-2.5 md:hidden" })}>
          <CaretLeftIcon />
        </Link>
        <Breadcrumb className="max-md:flex-1">
          <BreadcrumbList className="gap-3 text-ink">
            <WorkspaceCrumb ws={ws} className="max-sm:hidden" />
            <BreadcrumbItem>
              <h1 className="text-[14px] font-semibold max-md:text-[20px] max-md:tracking-[-0.02em]">Views</h1>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Segmented<Which>
          className="max-md:order-last max-md:ml-3"
          label="Which views"
          variant="quiet"
          options={(["all", "shared", "mine"] as const).map((w) => ({ value: w, label: `${{ all: "All", shared: "Shared", mine: "Only me" }[w]} ${all.filter(keep(w)).length}` }))}
          value={which}
          onChange={setWhich}
        />
        <Button className={`ml-auto ${FAB}`} aria-label="New view" onClick={() => viewPanel.create(blankList(), null)}>
          <PlusIcon className="size-3.5 max-md:size-[22px]" />
          <span>New view</span>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Framed, the table is a card on the pane, as a list's group is (globals.css). */}
        <div className={shown.length ? "list-group" : undefined}>
        <div data-group-head className="sticky top-0 flex h-8 items-center gap-4 border-b bg-group px-6 eyebrow max-md:hidden">
          <span className="w-52 shrink-0">View</span>
          <span className="w-36 shrink-0 max-md:hidden">Projects</span>
          <span className="min-w-0 flex-1">Shows</span>
          <span className="w-24 shrink-0 max-md:hidden">Who sees it</span>
          <span className="w-12 shrink-0">Tab</span>
          <span className="w-14 shrink-0">Favorite</span>
          <span className="w-10 shrink-0 text-right">Issues</span>
          <span className="w-12 shrink-0" />
        </div>
        {shown.map((v) => (
          <Row key={v.id} ws={ws} view={v} />
        ))}
        </div>
        {!shown.length && (
          <p className="p-6 text-ink-3 max-md:px-4">
            {store.views.status === "loading" ? "Loading…" : "No views yet. Press + beside a project's tabs to save what is on screen as a view, or New view here."}
          </p>
        )}
        <p className="px-6 py-4 text-caption text-ink-3 max-md:px-4">A view is a saved filter over the whole workspace. Its Project filter decides which projects it can be a tab in.</p>
      </div>
    </>
  );
});

const Row = observer(function Row({ ws, view }: { ws: string; view: SavedView }) {
  const href = viewPath(ws, view);
  const pin = pinRef("view", view.id);
  const pinned = store.views.pinned(pin);
  const projects = viewProjects(view)
    .map((id) => store.projects.get(id))
    .filter((p) => !!p);
  // What it shows besides its projects: the projects have their own column.
  const ctx = queryContext(WS_SCOPE);
  const { project: _, ...rest } = parseQuery(view.query, ctx).filter;
  const shows = formatQuery(rest, ctx);
  const editable = mayEdit(view);
  return (
    <div className="list-row relative flex h-[calc(40px+2*var(--air))] items-center gap-4 px-6 hover:bg-row-hover max-md:h-auto max-md:min-h-[60px] max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-0.5 max-md:py-2.5 max-md:pr-14 max-md:pl-4 max-md:active:bg-row-hover">
      <Link href={href} className="flex w-52 min-w-0 shrink-0 items-center gap-2 outline-none focus-visible:underline max-md:w-full max-md:gap-2.5 max-md:after:absolute max-md:after:inset-0">
        <ViewIcon name={view.icon} />
        <span className="truncate font-medium max-md:text-[15px]">{view.name}</span>
      </Link>
      <span className="flex w-36 shrink-0 items-center gap-1 overflow-hidden max-md:hidden" title={projects.map((p) => p.name).join(", ") || "All projects"}>
        {projects.length ? projects.slice(0, 4).map((p) => <ProjectIcon key={p.id} project={p} />) : <span className="text-caption text-ink-3">All projects</span>}
        {projects.length > 4 && <span className="text-caption text-ink-3">+{projects.length - 4}</span>}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-id text-ink-3 max-md:ml-[26px]" title={shows}>
        {shows || "Every issue"}
      </span>
      <span className="flex w-24 shrink-0 items-center gap-1.5 text-caption text-ink-2 max-md:hidden">
        {view.shared ? <UsersThreeIcon className="size-3.5" /> : <LockSimpleIcon className="size-3.5" />}
        {view.shared ? "Everyone" : "Only you"}
      </span>
      <span className="w-12 shrink-0 max-md:hidden">
        <Switch
          size="sm"
          aria-label={`Show ${view.name} as a project tab`}
          title={projects.length ? `Tab in ${projects.map((p) => p.key).join(", ")}` : "Needs a Project filter"}
          checked={view.tab && projects.length > 0}
          disabled={!editable || !projects.length}
          onCheckedChange={() => store.views.save(view.id, { tab: !view.tab })}
          className="disabled:opacity-50"
        />
      </span>
      <span className="w-14 shrink-0 max-md:hidden">
        <Switch size="sm" aria-label={`${view.name} in your favorites`} checked={pinned} onCheckedChange={() => store.views.pin(pin, !pinned)} />
      </span>
      <span className="w-10 shrink-0 text-right font-mono text-meta text-ink-3 tabular-nums max-md:w-auto">{viewCount(view.id)}</span>
      <span className="w-12 shrink-0 max-md:absolute max-md:top-1/2 max-md:right-1 max-md:z-1 max-md:w-auto max-md:-translate-y-1/2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            router.push(href);
            viewPanel.edit(viewState(view.id), null);
          }}
        >
          Edit
        </Button>
      </span>
    </div>
  );
});
