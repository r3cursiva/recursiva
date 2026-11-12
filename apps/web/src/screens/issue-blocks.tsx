// The blocks under an issue's description. On a wide pane, after the IssuePage artboard: the row of Sub-issue, Relation,
// Link and Attach stands for all of them, and a block appears once it has something to show. On a phone, after the
// IssuePhone artboard: no row; relations, links and files read as one block with a single heading, whose "+" adds any of
// them, as sub-issues' does. Files can be dropped anywhere in here. A wide pane's pull requests stand between the row and the blocks.
import { ArrowsInSimpleIcon, FileIcon, LinkIcon, LinkSimpleIcon, PaperclipIcon, PlusIcon } from "@phosphor-icons/react";
import type { Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Hint } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { useRef, useState, type ComponentProps } from "react";
import { useIsPhone } from "../lib/phone.ts";
import { Files, useAttach } from "./files.tsx";
import { GithubPanel } from "./github-panel.tsx";
import { Links } from "./links.tsx";
import { PanelHeader, PanelPlus } from "./panel-section.tsx";
import { AddRelation, KINDS, RelationPicker, Relations, type RelationKind } from "./relations.tsx";
import { AddSubIssue, SubIssues } from "./sub-issues.tsx";

/** A button of the row. Props pass through, so a menu's trigger can render it. */
function RowButton(props: ComponentProps<typeof Button>) {
  return <Button variant="ghost" className="gap-1.5 px-2 font-normal" {...props} />;
}

const ROW_ICON = "size-[13px]";

export function IssueBlocks({ issue }: { issue: Issue }) {
  const [relation, setRelation] = useState<RelationKind | null>(null);
  const [link, setLink] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const attach = useAttach(issue.id);
  const github = !useIsPhone() && <GithubPanel issue={issue} />;
  if (issue.deletedAt) return github;
  return (
    <div {...attach.drop} className={cn("flex flex-col gap-7 rounded-sm outline-offset-2 max-md:gap-6", attach.over && "outline-2 outline-dashed outline-signal")}>
      {attach.field}
      <div role="toolbar" aria-label="Add to the issue" data-roving="row" className="-ml-2 flex flex-wrap gap-1 max-md:hidden">
        <AddSubIssue
          issue={issue}
          align="start"
          trigger={
            <RowButton>
              <PlusIcon weight="bold" className={ROW_ICON} />
              Sub-issue
            </RowButton>
          }
        />
        <AddRelation
          issue={issue}
          align="start"
          trigger={
            <RowButton>
              <ArrowsInSimpleIcon weight="bold" className={ROW_ICON} />
              Relation
            </RowButton>
          }
        />
        <RowButton onClick={() => setLink(true)}>
          <LinkIcon weight="bold" className={ROW_ICON} />
          Link
        </RowButton>
        <Hint label="Attach files (drop them here; with Alt, originals)">
          <RowButton onClick={attach.pick}>
            <PaperclipIcon weight="bold" className={ROW_ICON} />
            Attach
          </RowButton>
        </Hint>
      </div>
      {github}
      <SubIssues issue={issue} />
      <div className="max-md:flex max-md:flex-col md:contents">
        <PanelHeader
          label="Relations and links"
          className="md:hidden"
          after={attach.busy > 0 && <span className="text-[12px] text-ink-3">{attach.busy} uploading</span>}
          action={
            <DropdownMenu>
              <DropdownMenuTrigger ref={add} render={<PanelPlus label="Add a relation, link or file" />} />
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={attach.pick}>
                  <FileIcon />
                  File
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLink(true)}>
                  <LinkSimpleIcon />
                  Link
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {KINDS.map((k) => (
                  <DropdownMenuItem key={k.type} onClick={() => setRelation(k)}>
                    {k.add}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <Relations issue={issue} />
        <Links issue={issue} adding={link} setAdding={setLink} />
        <Files issue={issue} busy={attach.busy} />
        {relation && <RelationPicker issue={issue} kind={relation} anchor={add} onClose={() => setRelation(null)} />}
      </div>
    </div>
  );
}
