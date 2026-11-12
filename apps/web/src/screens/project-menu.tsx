// A project's "⋯" menu in the sidebar (the navigation artboards, PLNR-58): its settings, its archived issues and
// trash, its link, its group and Quiet in the viewer's sidebar (RSVA-566), hiding it from there (PLNR-292), and archiving
// it. In the lazy edit chunk, opened through LazyMenu, or by a right click on its row.
import { ArchiveIcon, CheckIcon, EyeIcon, EyeSlashIcon, FolderSimpleDashedIcon, FolderSimpleIcon, FolderSimplePlusIcon, GearSixIcon, LinkIcon, MoonIcon, SunIcon, TrashIcon } from "@phosphor-icons/react";
import type { Project } from "@rsva/schema/models";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { viewerCan } from "../lib/roles.ts";
import { paths, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import type { MenuOrAnchor } from "./lazy-menu.tsx";
import { groupOf } from "../lib/project-groups.ts";
import { archiveProject, copyProjectLink, hideProject, keepProjectVisible, markProjectQuiet, moveProjectToGroup } from "./project-actions.ts";
import { sidebar } from "./sidebar-state.ts";
import { quietNow } from "./sidebar-projects.tsx";

export const ProjectMenu = observer(function ProjectMenu({ open, onOpenChange, trigger, anchor, project }: MenuOrAnchor & { project: Project }) {
  const ws = currentWs();
  const hidden = store.views.hiddenProjects.includes(project.id);
  const groups = store.views.groups;
  const kept = groups.keep.includes(project.id);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {trigger && <DropdownMenuTrigger render={trigger} />}
      <DropdownMenuContent className="w-56" align="start" {...(anchor ? { anchor } : {})}>
        <DropdownMenuItem onClick={() => router.push(paths.settings(ws, project.key))}>
          <GearSixIcon />
          Project settings
          <DropdownMenuShortcut>,</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push(paths.archive(ws, project.key))}>
          <TrashIcon />
          Archived issues and trash
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => copyProjectLink(project)}>
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderSimpleIcon />
            Move to group
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            {groups.groups.map((g) => (
              <DropdownMenuItem key={g.id} onClick={() => moveProjectToGroup(project, g)}>
                {groupOf(groups, project.id) === g ? <CheckIcon /> : <span className="size-3.5" />}
                <span className="truncate">{g.name}</span>
              </DropdownMenuItem>
            ))}
            {groups.groups.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => sidebar.newGroup()}>
              <FolderSimplePlusIcon />
              New group…
            </DropdownMenuItem>
            {groupOf(groups, project.id) && (
              <DropdownMenuItem onClick={() => moveProjectToGroup(project, null)}>
                <FolderSimpleDashedIcon />
                No group
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Quiet folds projects nothing happens in by itself; Keep visible exempts one, Mark as quiet folds one now. */}
        <DropdownMenuItem onClick={() => keepProjectVisible(project, !kept)}>
          <SunIcon />
          {kept ? "Allow quiet" : "Keep visible"}
          {!kept && <DropdownMenuShortcut className="tracking-normal">never quiet</DropdownMenuShortcut>}
        </DropdownMenuItem>
        {!quietNow(project.id) && (
          <DropdownMenuItem onClick={() => markProjectQuiet(project)}>
            <MoonIcon />
            Mark as quiet
          </DropdownMenuItem>
        )}
        {/* A hidden project is in the sidebar only while open, and All projects brings it back. */}
        <DropdownMenuItem onClick={() => hideProject(project, !hidden)}>
          {hidden ? <EyeIcon /> : <EyeSlashIcon />}
          {hidden ? "Show in sidebar" : "Hide from sidebar"}
        </DropdownMenuItem>
        {viewerCan("projects.write") && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => archiveProject(project)}>
              <ArchiveIcon />
              Archive project
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
