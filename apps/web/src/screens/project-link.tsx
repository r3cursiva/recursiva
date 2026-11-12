// An issue's header breadcrumb (the issue panel, the issue page, the inbox detail): the project's name as a link to its
// issues, and the parent's key.
import type { Issue, Project } from "@rsva/schema/models";
import { BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator } from "@rsva/ui/components/breadcrumb";
import { Hint } from "@rsva/ui/components/tooltip";
import { observer } from "mobx-react-lite";
import { navigateOnClick, paths } from "../router.ts";
import { store } from "../store.ts";
import { issuePath, liveParent } from "./issue-actions.ts";

export function ProjectLink({ ws, project }: { ws: string; project: Project }) {
  const href = paths.issues(ws, project.key);
  return (
    <BreadcrumbItem className="max-md:hidden">
      <BreadcrumbLink
        href={href}
        onClick={(e) => navigateOnClick(e, href)}
        className="text-caption text-ink-3 underline-offset-4 transition-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {project.name}
      </BreadcrumbLink>
    </BreadcrumbItem>
  );
}

/** The way up to the parent, as in Linear: one click, in view however far the issue scrolls. A phone has its line over the title. */
export const ParentCrumb = observer(function ParentCrumb({ issue }: { issue: Issue }) {
  const parent = liveParent(issue);
  if (!parent) return null;
  const href = issuePath(parent);
  return (
    <>
      <BreadcrumbSeparator className="text-rule-strong max-md:hidden" />
      <BreadcrumbItem className="shrink-0 max-md:hidden">
        <Hint label={parent.title}>
          <BreadcrumbLink href={href} onClick={(e) => navigateOnClick(e, href)} className="link-plate font-mono text-caption text-ink-3">
            {store.issueKey(parent)}
          </BreadcrumbLink>
        </Hint>
      </BreadcrumbItem>
    </>
  );
});
