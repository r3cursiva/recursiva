// The issues' tools: List or Board, the settings link and "New issue", and the lazy board itself.
import { GearSixIcon, KanbanIcon, ListBulletsIcon, PlusIcon } from "@phosphor-icons/react";
import type { Project } from "@rsva/schema/models";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { Kbd } from "@rsva/ui/components/kbd";
import { Segmented } from "@rsva/ui/components/segmented";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { type ReactNode } from "react";
import { paths } from "../router.ts";
import { boardable, type Layout, type ProjectView } from "../view-state.ts";
import { createIssue } from "./create-state.ts";
import { chunk, loadEditChunk as loadBoard } from "./load-edit-chunk.ts";
import { swapLayout } from "./view-transition.ts";
import { Link } from "../link.tsx";

// The board (with drag and drop) is its own chunk: the list is what most screens open with.
export const Board = chunk("Board");
export const BoardColumn = chunk("BoardColumn");

/** List and Board; Board only where it can show (`boardable`). */
export const layoutOptions = (canBoard: boolean): { value: Layout; label: string; icon: ReactNode; title: string; disabled?: boolean }[] => [
  { value: "list", label: "List", icon: <ListBulletsIcon />, title: "List (V)" },
  {
    value: "board",
    label: "Board",
    icon: <KanbanIcon />,
    title: canBoard ? "Board (V)" : "A board shows one project: add a Project filter with one project",
    disabled: !canBoard,
  },
];

/** Applies a change of what the list shows: the pane cross-fades. The board is lazy: its first render is the fallback. */
function showLayout(layout: Layout, apply: () => void): void {
  performance.mark("rsva:layout-start");
  swapLayout(apply, layout === "board" ? () => !!document.querySelector('[data-slot="board"]') : undefined);
}

function switchLayout(list: ProjectView, layout: Layout): void {
  if (layout !== list.layout) showLayout(layout, () => list.setLayout(layout));
}

/** Switches a list between its layouts (V), where a board can show. */
export function toggleLayout(list: ProjectView, project: Project | null): void {
  if (list.layout === "list" && !boardable(list, project)) return;
  switchLayout(list, list.layout === "list" ? "board" : "list");
}

/**
 * List or Board, next to View (PLNR-78): the viewer's choice on this device, so switching is no edit of the view.
 */
export const LayoutToggle = observer(function LayoutToggle({
  list,
  project,
  labels = false,
  className,
}: {
  list: ProjectView;
  project: Project | null;
  labels?: boolean;
  className?: string;
}) {
  const canBoard = boardable(list, project);
  return (
    <span className={cn("flex shrink-0", className)} onPointerEnter={loadBoard}>
      <Segmented<Layout>
        label="Layout"
        variant="quiet"
        iconOnly={!labels}
        labelClassName={HEAD_FIT.layout}
        options={layoutOptions(canBoard)}
        value={canBoard ? list.layout : "list"}
        onChange={(layout) => switchLayout(list, layout)}
      />
    </span>
  );
});

/** The gear to the project's settings, a page of its own (`,`). */
export function SettingsLink({ ws, project }: { ws: string; project: Project }) {
  const href = paths.settings(ws, project.key);
  return (
    <Link
      href={href}
      aria-label="Project settings"
      onPointerEnter={loadBoard}
      className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "group/gear relative rounded-[5px] text-ink max-md:hidden")}
    >
      <GearSixIcon className="size-4" />
      <span
        aria-hidden
        className="pointer-events-none absolute top-[calc(100%+6px)] right-0 z-30 flex gap-1.5 rounded-[5px] bg-inverse px-[7px] py-[3px] text-[11.5px] font-medium whitespace-nowrap text-inverse-ink opacity-0 transition-opacity duration-120 group-hover/gear:opacity-100 group-focus-visible/gear:opacity-100"
      >
        Project settings
        <Kbd inverse className="border-0 p-0 text-[10px] leading-[1.4] text-inverse-ink opacity-65">
          ,
        </Kbd>
      </span>
    </Link>
  );
}

/**
 * What a project's header (`@container/head`, project-header.tsx) gives up as it narrows, so it stays one row, the
 * names of the project and the page (their own 320px at most) last of all. First a cycle's own text: its dates
 * (the tooltip of "day 7 of 14 · 7 days left" keeps them), the word on Complete, then that line itself; then the days
 * in the Cycles chip, the shortcut on the add button and the project's key (all said elsewhere: the tooltip, every
 * row), the words beside List, Board, View and Display, "New issue", last the other pages' tab names. Steps found
 * 2026-11-10 on the demo workspace (RSVA-593) by hiding one thing at a time and measuring the header's content box:
 * with the Cycles chip, Home, History and Display the 2026-11-05 steps no longer fit. Checked every 2px from 1024 to
 * 1600px wide, with the sidebar open and folded, on the issues, the Cycles and a cycle's page: no cut title, no second
 * row, no wrapped chip; the issues and Cycles pages also down to 780px, a cycle's page to about 840.
 * Words given up stay the controls' names (sr-only or aria-label) and their tooltips.
 */
export const HEAD_FIT = {
  dates: "@max-[91rem]/head:hidden",
  done: "md:@max-[83rem]/head:hidden",
  when: "@max-[80rem]/head:hidden",
  days: "@max-[69rem]/head:hidden",
  key: "@max-[68rem]/head:hidden",
  kbd: "@max-[68rem]/head:hidden",
  layout: "md:@max-[65rem]/head:sr-only",
  add: "@max-[61rem]/head:hidden",
  tab: "@max-[57rem]/head:sr-only",
} as const;

/** On a phone: the corner button of the artboards (LedgerPhoneList), over the list and above the tab bar. */
export const FAB =
  "max-md:fixed max-md:right-4 max-md:bottom-[calc(var(--tabbar)+var(--safe-bottom)+16px)] max-md:z-20 max-md:size-14 max-md:rounded-2xl max-md:p-0 max-md:shadow-[0_14px_30px_-12px_rgb(0_0_0/0.45)] max-md:[&>kbd]:hidden max-md:[&>span]:sr-only in-[[data-keyboard]]:hidden in-[[data-marking]]:hidden";

/** The screen's one primary action: a button in its header, the corner button on a phone. */
export function AddButton({ label, kbd, onClick }: { label: string; kbd?: string; onClick: () => void }) {
  return (
    <Button className={`shrink-0 ${FAB}`} onClick={onClick} aria-label={label} title={kbd ? `${label} (${kbd})` : label}>
      <PlusIcon className="size-[13px] max-md:size-[22px]" />
      <span className={HEAD_FIT.add}>{label}</span>
      {kbd && <Kbd inverse className={HEAD_FIT.kbd}>{kbd}</Kbd>}
    </Button>
  );
}

/** New issue. C opens the plain form; a preset one (a cycle's) has no key. */
export function AddIssueButton({ onClick }: { onClick?: () => void }) {
  return <AddButton label="New issue" onClick={onClick ?? (() => createIssue.show())} {...(onClick ? {} : { kbd: "C" })} />;
}
