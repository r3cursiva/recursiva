// The parts the issue panel's lower blocks share (sub-issues, relations, links): a caption header with an optional
// count and its "+" action, and a row for another issue that opens it, changes its state and takes it off the block. Rows
// as the IssuePage artboard's `.irow`: 34 px, no rules, the key in a column of its own.
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { isClosedGroup, priorityTitle, type Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rsva/ui/components/tooltip";
import { UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { faceOf } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import type { ComponentProps, ReactNode } from "react";
import { store } from "../store.ts";
import { issuePath } from "./issue-actions.ts";
import { StatePicker } from "./pickers.tsx";
import { StateGlyph } from "./state-glyph.tsx";
import { Link } from "../link.tsx";

/**
 * Framed, each block under an issue's description is a card, its header ruled off the rows. The padding leaves room for a
 * row's plate, 8px wider than the row.
 */
const CARD =
  "flex flex-col md:gap-0.5 framed:rounded-(--float-radius) framed:border framed:border-rule-soft framed:bg-panel framed:px-3.5 framed:pb-1.5";
const CARD_HEAD = "framed:-mx-3.5 framed:mb-1 framed:h-[38px] framed:border-b framed:border-rule-soft framed:pr-2 framed:pl-3.5";

export function PanelSection({
  label,
  count,
  after,
  noPhoneHeader,
  empty,
  action,
  className,
  children,
}: {
  label: string;
  /** Shown after the label, e.g. "2 / 5"; `title` explains it. */
  count?: { text: string; title: string } | null;
  /** After the count: the sub-issues' progress. */
  after?: ReactNode;
  /** On a phone the block is part of a bigger one, under its heading. */
  noPhoneHeader?: boolean;
  /** Nothing to show: on a wide pane the row under the description stands for the block; a phone has no such row. */
  empty?: boolean;
  action?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <section aria-label={label} className={cn(CARD, empty && "md:hidden", className)}>
      <PanelHeader label={label} count={count} after={after} action={action} className={cn(CARD_HEAD, noPhoneHeader && "max-md:hidden")} />
      {children}
    </section>
  );
}

/** A block's header: its caption, count, what follows them and the "+" at the end. */
export function PanelHeader({
  label,
  count,
  after,
  action,
  className,
}: {
  label: string;
  count?: { text: string; title: string } | null | undefined;
  after?: ReactNode;
  action?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <header className={cn("flex h-[30px] items-center gap-2", className)}>
      <h2 className="m-0 text-[12.5px] font-semibold max-md:text-[14px]">{label}</h2>
      {count && (
        <span className="font-mono text-[11px] text-ink-3" title={count.title}>
          {count.text}
        </span>
      )}
      {after}
      {action && <span className="ml-auto">{action}</span>}
    </header>
  );
}

/**
 * A block's "+". Props pass through, so a menu's trigger can render it. Tooltip parts rather than Hint: Base UI finds a
 * popup's trigger by its DOM id, so under a menu's trigger the tooltip has to take the menu's `id`.
 */
export function PanelPlus({ label, id, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        id={id}
        render={
          <Button variant="ghost" size="icon" aria-label={label} className="max-md:size-10" {...props}>
            <PlusIcon weight="bold" className="size-3.5 max-md:size-[18px]" />
          </Button>
        }
      />
      <TooltipContent className="pointer-coarse:hidden">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The list under a section header. */
export function PanelList({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={cn("m-0 flex list-none flex-col p-0", className)}>{children}</ul>;
}

/**
 * Another issue in a block: its state (a picker), key and title (a link to it), assignees and priority, and × to take it
 * off. `why` is a relation's kind in a column before the state; such a row leaves out the assignees and priority, as the
 * artboard's relations do.
 */
export const LinkedIssueRow = observer(function LinkedIssueRow({
  issue,
  why,
  removeLabel,
  onRemove,
  className,
}: {
  issue: Issue;
  why?: string;
  removeLabel: (key: string) => string;
  onRemove: () => void;
  className?: string | undefined;
}) {
  const state = store.states.get(issue.stateId);
  const href = issuePath(issue);
  const assignees = issue.assigneeIds.map((id) => faceOf(id));
  return (
    <li className={className}>
      <div className="group/sub flex h-[34px] items-center gap-2.5 md:row-plate max-md:h-11">
      {why && <span className="w-[76px] shrink-0 text-[12px] text-ink-3 max-md:w-[74px]">{why}</span>}
      <StatePicker
        projectId={issue.projectId}
        value={issue.stateId}
        onChange={(stateId) => store.updateIssue(issue.id, { stateId })}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label={`State: ${state?.name ?? "none"}`} title={state?.name} className="max-md:-mx-1.5 max-md:size-8">
            {state && <StateGlyph state={state} />}
          </Button>
        }
      />
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-2.5 outline-none max-md:self-stretch">
        <span className="shrink-0 font-mono text-[11.5px] text-ink-3 md:min-w-[66px] max-md:order-1">{store.issueKey(issue)}</span>
        <span className={cn("truncate text-[13px] max-md:min-w-0 max-md:flex-1 max-md:text-[14px]", isClosedGroup(state?.group) && "text-ink-3")}>{issue.title}</span>
      </Link>
      {!why && assignees.length > 0 && (
        <span className="max-md:hidden">
          <UserAvatarStack people={assignees} />
        </span>
      )}
      {!why && (
        <span title={priorityTitle(issue.priority)} className="grid max-md:hidden">
          <PriorityIcon priority={issue.priority} />
        </span>
      )}
      <RemoveButton label={removeLabel(store.issueKey(issue))} onClick={onRemove} />
      </div>
    </li>
  );
});

/** A row's icon button: it shows on the row's hover or focus, and always under a finger; 44 px on a phone. */
export function RowButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className={cn("opacity-0 group-hover/sub:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 max-md:-my-1 max-md:size-11 max-md:text-ink-3 max-md:opacity-100", className)}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** × that takes a row off its block, at the row's end. */
export function RemoveButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <RowButton label={label} onClick={onClick} className={cn("max-md:-mr-3", className)}>
      <XIcon />
    </RowButton>
  );
}
