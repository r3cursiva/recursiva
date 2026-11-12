// The small pieces of GitHub on an issue, after the Gh artboards: its round mark, a pull request's state icon, the Linked
// tag and the chip a feed line names a pull request with. The artboards' note decides the colors: open green, draft grey,
// merged violet, closed red.
import { GitMergeIcon, GitPullRequestIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { commitUrl, pullUrl, SHA_SHOWN, type GithubEvent, type PullState } from "@rsva/schema/models";
import { Badge } from "@rsva/ui/components/badge";
import { cn } from "@rsva/ui/lib/utils";
import { pullRef } from "../lib/github.ts";

/** The mark in a feed line and for the GitHub bot in a row. */
export function GithubMark({ className, title }: { className?: string; title?: string }) {
  return (
    <span title={title} className={cn("grid size-5 shrink-0 place-items-center rounded-full bg-inverse text-inverse-ink", className)}>
      <GithubLogoIcon className="size-3" />
    </span>
  );
}

const STATE_COLOR: Record<PullState, string> = { open: "text-status-review", draft: "text-ink-3", merged: "text-status-done", closed: "text-error" };

export function PullStateIcon({ state, className }: { state: PullState | null; className?: string }) {
  const Icon = state === "merged" ? GitMergeIcon : GitPullRequestIcon;
  return <Icon className={cn(STATE_COLOR[state ?? "open"], className)} />;
}

export function LinkedTag({ title, className }: { title?: string; className?: string }) {
  return (
    <Badge title={title} className={cn("h-4 border-dashed px-[5px] font-mono text-[10px] text-ink-2", className)}>
      Linked
    </Badge>
  );
}

/** "#412 Rotate restic keys" in a sentence, or "pi-ansible#57 …" for one that only links; a phone leaves such a title out. The negative margin keeps it from stretching the line; in a row it gives way before the words around it, down to its number: the title's column may be 0 wide, so it adds nothing to the chip's least width. */
export function PullChip({ gh }: { gh: GithubEvent }) {
  const ref = gh.closing ? `#${gh.number}` : pullRef(gh);
  return (
    <a
      href={pullUrl(gh)}
      target="_blank"
      rel="noopener"
      className="-my-0.5 inline-grid h-[18px] max-w-full shrink-99999 grid-cols-[auto_minmax(0,auto)] items-center rounded-[5px] border bg-panel px-1.5 align-[-2px] text-[12px] text-ink no-underline outline-none hover:border-rule-strong focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="inline-flex items-center gap-[5px]">
        <PullStateIcon state={gh.state} className="size-3 shrink-0" />
        <span className="font-mono text-[11px] text-ink-3">{ref}</span>
      </span>
      <span className={cn("ml-[5px] max-w-[240px] truncate max-md:max-w-[150px]", !gh.closing && "max-md:hidden")}>{gh.title}</span>
    </a>
  );
}

export function CommitChip({ gh }: { gh: GithubEvent }) {
  return (
    <a href={commitUrl(gh)} target="_blank" rel="noopener" className="link-plate font-mono text-[11.5px] font-medium text-ink no-underline">
      {gh.sha?.slice(0, SHA_SHOWN)}
    </a>
  );
}
