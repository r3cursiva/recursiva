// A project's pages on a phone (PLNR-282): the title of the header opens them as a sheet, in place of a row of tabs that
// took 40 px on every page while Issues is the page used nearly always. In the lazy edit chunk, opened through LazyMenu.
import type { Project } from "@rsva/schema/models";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { currentWs } from "../store.ts";
import type { MenuProps } from "./lazy-menu.tsx";
import { PageBadge, projectPages } from "./project-header.tsx";
import { Link } from "../link.tsx";

export const ProjectPagesMenu = observer(function ProjectPagesMenu({ open, onOpenChange, trigger, project }: MenuProps & { project: Project }) {
  const pages = projectPages(currentWs(), project);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent className="w-56" align="start">
        <DropdownMenuRadioGroup value={pages.find((p) => p.here)?.label}>
          {pages.map((p) => (
            // A link, so a long press can open the page in a new tab; the radio check marks the page you are on.
            <DropdownMenuRadioItem key={p.label} value={p.label} closeOnClick render={<Link href={p.href} />}>
              {p.icon}
              {p.label}
              <PageBadge project={project} label={p.label} className="ml-auto" />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
