// A project's key on a small outlined chip with its color tile: the projects a GitHub repository or a Telegram group
// chat (PLNR-204) is linked to.
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { store } from "../store.ts";

export const ProjectChip = observer(function ProjectChip({ projectKey, className }: { projectKey: string; className?: string }) {
  const color = store.projectByKey(projectKey)?.color;
  return (
    <span className={cn("inline-flex h-5 items-center gap-[5px] rounded-[5px] border border-control-border pr-1.5 pl-1 font-mono text-[11px] text-ink-2", className)}>
      <LetterTile name={projectKey} {...(color ? { tone: color } : {})} className="size-3 rounded-[3px] text-[7.5px]" />
      {projectKey}
    </span>
  );
});
