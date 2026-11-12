// A view's own page (PLNR-74, the ViewsWorkspace artboard): /:ws/views/:id, the whole view across all its projects,
// where the sidebar and the views page open it. The key on each row names the project; issues open on their own page,
// as there is no one project's list to open them beside. A view of one project can show as that project's board too;
// across projects there is no board (owner's call, 2026-10-30): its columns are states, and each
// project has its own.
import { CaretLeftIcon, DotsThreeIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { pinRef } from "@rsva/protocol";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "@rsva/ui/components/breadcrumb";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { observer } from "mobx-react-lite";
import { Suspense } from "react";
import { mayEdit, viewProjects } from "../lib/views.ts";
import { navigateOnClick, paths } from "../router.ts";
import { store } from "../store.ts";
import { viewState } from "../view-state.ts";
import { IssueList } from "./issue-list.tsx";
import { Board } from "./layout-switch.tsx";
import { LazyMenu } from "./lazy-menu.tsx";
import { FavoriteButton } from "./favorite-button.tsx";
import { chunk, loadEditChunk } from "./load-edit-chunk.ts";
import { WorkspaceCrumb } from "./project-header.tsx";
import { useQueryUrl } from "./query-url.ts";
import { ViewIcon } from "./view-icon.tsx";
import { viewPanel } from "./view-panel-state.ts";
import { useViewKeys, ViewTools } from "./view-tabs.tsx";
import { Link } from "../link.tsx";

const ViewMenu = chunk("ViewMenu");

export const WorkspaceView = observer(function WorkspaceView({ ws, viewId }: { ws: string; viewId: string }) {
  const saved = store.views.get(viewId);
  const base = viewState(viewId);
  const list = viewPanel.shown(base);
  // A view of exactly one project has that project's board too.
  const only = saved && viewProjects(saved).length === 1 ? store.projects.get(viewProjects(saved)[0]!) : undefined;
  useViewKeys(base, null, null);
  useQueryUrl(base, paths.view(ws, viewId));
  if (!saved)
    return (
      <div className="grid flex-1 place-items-center p-6 text-ink-3">
        {store.views.status === "loading" ? "Loading…" : "This view was deleted, or it is someone else's."}
      </div>
    );
  const index = paths.views(ws);
  const projects = viewProjects(saved).map((id) => store.projects.get(id)?.name).filter(Boolean);
  const where = `${projects.length ? projects.join(", ") : `all ${store.projectList().length} projects`} · ${saved.shared ? "shared" : "only you"}`;
  return (
    <>
      {/* One line: the summary and the projects give way (truncated) before anything wraps. */}
      <header className="sticky top-0 z-10 flex min-h-(--topbar) shrink-0 items-center gap-x-2.5 border-b bg-panel py-1.5 pr-3.5 pl-5 max-md:min-h-13 max-md:gap-x-0.5 max-md:py-1 max-md:pr-1 max-md:pl-1">
        <Link href={index} aria-label="Back to views" className={buttonVariants({ variant: "ghost", size: "icon", className: "md:hidden" })}>
          <CaretLeftIcon />
        </Link>
        <Breadcrumb className="shrink">
          <BreadcrumbList className="text-ink">
            <WorkspaceCrumb ws={ws} className="max-md:hidden" />
            <BreadcrumbItem className="shrink-0 max-md:hidden">
              <BreadcrumbLink href={index} onClick={(e) => navigateOnClick(e, index)} className="text-ink-2 outline-none transition-none focus-visible:underline">
                Views
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-md:hidden" />
            <BreadcrumbItem className="shrink-0 gap-2 max-md:shrink">
              <ViewIcon name={saved.icon} className="size-4" />
              <h1 className="shrink-0 text-[14px] font-semibold max-md:min-w-0 max-md:shrink max-md:truncate max-md:text-[20px] max-md:tracking-[-0.02em]" onDoubleClick={() => mayEdit(saved) && viewPanel.edit(base, null)}>
                {saved.name}
              </h1>
              {!saved.shared && <LockSimpleIcon aria-label="Only you" className="size-3.5 shrink-0 text-ink-3" />}
            </BreadcrumbItem>
            <BreadcrumbItem className="max-xl:hidden">
              <span className="min-w-0 truncate text-caption text-ink-3">{where}</span>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <FavoriteButton pin={pinRef("view", saved.id)} name={saved.name} />
        <ViewTools list={base} project={null} />
        <LazyMenu
          menu={ViewMenu}
          props={{ saved, project: null }}
          button={(props) => (
            <Button type="button" variant="ghost" size="icon" aria-label="View options" onPointerEnter={loadEditChunk} {...props}>
              <DotsThreeIcon weight="bold" />
            </Button>
          )}
        />
      </header>
      {store.status !== "ready" ? (
        <div className="p-6 text-ink-3">Loading…</div>
      ) : only && list.layout === "board" ? (
        <Suspense fallback={<div className="flex-1" />}>
          <Board key={list.key} project={only} ws={ws} list={list} />
        </Suspense>
      ) : (
        <IssueList key={list.key} view={list} project={null} ws={ws} />
      )}
    </>
  );
});
