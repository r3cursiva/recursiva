import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  FlagCheckeredIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon,
  StackIcon,
  FunnelSimpleIcon,
  TrayIcon,
  XIcon,
} from "@phosphor-icons/react";
import { cycleStatus } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { localToday } from "@rsva/query";
import { formatDate } from "@rsva/display/time";
import { cycleShort, daysLeft } from "../lib/cycles.ts";
import { pinTargets, routePin, type PinTarget } from "../lib/pins.ts";
import { viewCount } from "../lib/views.ts";
import { paths, router } from "../router.ts";
import { myAsks, myTriage } from "../lib/my-asks.ts";
import { canTriage } from "../lib/my-work.ts";
import { inboxUnread, store } from "../store.ts";
import { palette } from "./palette-state.ts";
import { SidebarFoot } from "./sidebar-foot.tsx";
import { attachPins, Divider, DragList, heading, itemLabel, navItem, rowButton } from "./sidebar-parts.tsx";
import { ProjectsSection } from "./sidebar-projects.tsx";
import { sidebar } from "./sidebar-state.ts";
import { Tip, TipNote } from "./sidebar-tip.tsx";
import { IssueStateGlyph } from "./state-glyph.tsx";
import { ViewIcon } from "./view-icon.tsx";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";
import { Link } from "../link.tsx";
import { capCount } from "@rsva/schema/util";


/** Every screen but the workspace's settings: the workspace, Inbox, My work and Views, the pins, the projects, then the foot. */
export const Sidebar = observer(function Sidebar({ ws, activeKey }: { ws: string; activeKey: string | null }) {
  return (
    <aside
      data-region
      data-strip={sidebar.strip || undefined}
      className="relative z-30 flex w-(--sidebar-width) shrink-0 flex-col gap-3 pane md:overflow-visible transition-[width] duration-120 ease-out motion-reduce:transition-none bg-sidebar px-2 pt-2 text-sidebar-foreground max-md:hidden strip:w-(--sidebar-strip) strip:items-center strip:gap-1.5 strip:px-0"
    >
      <div className="flex shrink-0 items-center gap-0.5 self-stretch strip:flex-col strip:gap-1.5 strip:self-center">
        <WorkspaceSwitcher ws={ws} />
        <CollapseButton />
      </div>
      {/* One Tab stop, ↑ ↓ through its items (PLNR-304); a project's ⋯ is on right click and in ⌘K. */}
      <nav aria-label="Sidebar" data-roving="column" className="-mx-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2 strip:mx-0 strip:items-center strip:gap-0.5 strip:self-stretch strip:px-0 strip:pb-1 strip:[scrollbar-width:none]">
        <Divider />
        <InboxItem ws={ws} />
        <MyWorkItem ws={ws} />
        {canTriage(store) && <TriageItem ws={ws} />}
        <ViewsItem ws={ws} />
        <button type="button" data-roving-item aria-label="Search" onClick={() => palette.show()} className={cn(navItem, "text-left")}>
          <MagnifyingGlassIcon className="size-4 shrink-0 strip:size-[18px]" />
          <span className={itemLabel}>Search</span>
          <span className="font-mono text-meta text-ink-3 strip:hidden">{keys("mod", "K")}</span>
          <Tip kbd={keys("mod", "K")}>Search</Tip>
        </button>
        <PinnedSection ws={ws} />
        <ProjectsSection ws={ws} activeKey={activeKey} />
      </nav>
      <SidebarFoot />
    </aside>
  );
});

const CollapseButton = observer(function CollapseButton() {
  const label = sidebar.strip ? "Expand sidebar" : "Collapse sidebar";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-expanded={!sidebar.strip}
      title={sidebar.strip ? undefined : `${label} (${keys("mod", "\\")})`}
      onClick={() => sidebar.toggle()}
      className="group/tip relative grid place-items-center rounded-[5px] border-0 text-ink-3 active:scale-94! aria-expanded:bg-transparent aria-expanded:text-ink-3 aria-expanded:hover:bg-row-hover aria-expanded:hover:text-ink strip:h-[34px] strip:w-9 strip:rounded-[7px] strip:text-ink-2"
    >
      <SidebarSimpleIcon className="size-4 strip:hidden" />
      <CaretRightIcon className="hidden size-3.5 strip:block" />
      <Tip kbd={keys("mod", "\\")}>{label}</Tip>
    </Button>
  );
});

/** The inbox, with the count of unread notifications that are not snoozed: a number beside it, a badge on the icon. */
/** An item's count of what is new or waits, in the signal colour; in the strip, a dot with the number on the icon's corner. */
function NavCount({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="font-mono text-meta text-signal-text strip:absolute strip:top-[3px] strip:right-[3px] strip:grid strip:h-3.5 strip:min-w-3.5 strip:place-items-center strip:rounded-full strip:border-[1.5px] strip:border-sidebar strip:bg-signal strip:px-[3px] strip:text-[9px] strip:leading-none strip:font-medium strip:text-signal-ink">
      {capCount(n)}
    </span>
  );
}

const InboxItem = observer(function InboxItem({ ws }: { ws: string }) {
  const href = paths.inbox(ws);
  const unread = inboxUnread();
  return (
    <Link
      href={href}
      aria-current={router.route.name === "inbox" ? "page" : undefined}
      aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"}
      data-roving-item
      className={navItem}
    >
      <TrayIcon className="size-4 shrink-0 strip:size-[18px]" />
      <span className={itemLabel}>Inbox</span>
      <NavCount n={unread} />
      <Tip kbd="G N">Inbox</Tip>
    </Link>
  );
});

/**
 * My work: the viewer's issues across every workspace (PLNR-41). Its count (RSVA-572) is what waits on the viewer in
 * the open workspace: where something is to be done is marked as where something is new is.
 */
const MyWorkItem = observer(function MyWorkItem({ ws }: { ws: string }) {
  const href = paths.myWork(ws);
  const waits = myAsks.get().length;
  return (
    <Link
      href={href}
      aria-current={router.route.name === "myWork" ? "page" : undefined}
      aria-label={waits ? `My work, ${waits} waiting on you` : "My work"}
      data-roving-item
      className={navItem}
    >
      <ListChecksIcon className="size-4 shrink-0 strip:size-[18px]" />
      <span className={itemLabel}>My work</span>
      <NavCount n={waits} />
      <Tip kbd="G M">My work</Tip>
    </Link>
  );
});

/** Triage: what waits on the viewer's decision but is not theirs, the proposals and the reviews of agents' work. */
const TriageItem = observer(function TriageItem({ ws }: { ws: string }) {
  const n = myTriage.get().length;
  return (
    <Link
      href={paths.triage(ws)}
      aria-current={router.route.name === "triage" ? "page" : undefined}
      aria-label={n ? `Triage, ${n} to decide` : "Triage"}
      data-roving-item
      className={navItem}
    >
      <FunnelSimpleIcon className="size-4 shrink-0 strip:size-[18px]" />
      <span className={itemLabel}>Triage</span>
      <NavCount n={n} />
      <Tip>Triage</Tip>
    </Link>
  );
});

/** Every saved view (PLNR-74); the ones the viewer keeps at hand are among the pins. */
export const ViewsItem = observer(function ViewsItem({ ws }: { ws: string }) {
  const href = paths.views(ws);
  return (
    <Link href={href} aria-current={router.route.name === "views" ? "page" : undefined} aria-label="Views" data-roving-item className={navItem}>
      <StackIcon className="size-4 shrink-0 strip:size-[17px]" />
      <span className={itemLabel}>Views</span>
      <Tip kbd="G V">Views</Tip>
    </Link>
  );
});


/**
 * What the viewer keeps at hand (PLNR-292): views, issues and cycles, in their own order, on all their devices. Each
 * shows how it stands now, from the local data: a view its count, an issue its state and done sub-issues, a cycle its
 * days left. No favorites, nothing shown: a title's star, the menus of an issue, a cycle and a view and ⌘K add them.
 */
export const PinnedSection = observer(function PinnedSection({ ws }: { ws: string }) {
  const pins = pinTargets(ws);
  if (!pins.length) return null;
  const open = routePin();
  return (
    <>
      <span className={cn(heading, "cursor-default hover:bg-transparent hover:text-ink-3 max-md:mt-4 max-md:block max-md:py-2")}>Favorites</span>
      <Divider />
      <DragList group="pins" attach={attachPins}>
        {pins.map((p) => (
          <PinLink key={p.ref} ws={ws} pin={p} current={p.ref === open} />
        ))}
      </DragList>
    </>
  );
});

/** A pin's mark: the view's icon, the issue's state, the cycle's arrows (a flag once completed). */
export function PinIcon({ pin }: { pin: PinTarget }) {
  const size = "size-4 shrink-0 strip:size-[17px]";
  if (pin.kind === "view") return <ViewIcon name={pin.view.icon} className={size} />;
  if (pin.kind === "issue")
    return (
      <span className={cn(size, "grid place-items-center")}>
        <IssueStateGlyph issue={pin.issue} />
      </span>
    );
  return pin.cycle.completedAt ? <FlagCheckeredIcon className={size} /> : <ArrowsClockwiseIcon className={size} />;
}

/** What a pin says at its right end: a view's count, an issue's done sub-issues, where a cycle stands. */
function pinMeta(pin: PinTarget): { text: string; signal?: boolean } | null {
  if (pin.kind === "view") {
    const n = viewCount(pin.view.id);
    return n > 0 ? { text: capCount(n) } : null;
  }
  if (pin.kind === "issue") {
    const subs = store.subIssuesOf(pin.issue.id);
    if (!subs.length) return null;
    const done = subs.filter((i) => store.states.get(i.stateId)?.group === "completed").length;
    return { text: `${done}/${subs.length}` };
  }
  switch (cycleStatus(pin.cycle, localToday())) {
    case "active":
      return { text: daysLeft(pin.cycle) };
    case "ended":
      return { text: "ended", signal: true };
    case "upcoming":
      return { text: formatDate(pin.cycle.startDate!) };
    case "completed":
      return { text: "done" };
    case "draft":
      return null;
  }
}

/** The pin's second line in the collapsed sidebar's tooltip and its title: where it is. */
function pinWhere(pin: PinTarget): string {
  if (pin.kind === "view") return "View";
  if (pin.kind === "issue") return pin.key;
  return `${pin.project.name} · ${cycleShort(pin.cycle)}`;
}

/**
 * One pin. On hover the meta gives way to Unpin, as a project's count gives way to its ⋯; a phone unpins from the
 * thing's own menu, its rows having no hover.
 */
const PinLink = observer(function PinLink({ ws, pin, current }: { ws: string; pin: PinTarget; current: boolean }) {
  const meta = pinMeta(pin);
  const where = pinWhere(pin);
  return (
    <div data-card={pin.ref} className="group/pin relative select-none data-dragging:opacity-40 strip:flex strip:flex-col strip:items-center">
      <Link
        href={pin.href}
        draggable={false}
        aria-current={current ? "page" : undefined}
        title={sidebar.strip ? undefined : `${pin.label} · ${where}`}
        data-roving-item
        className={cn(navItem, "pr-8 strip:pr-0")}
      >
        <PinIcon pin={pin} />
        <span className={itemLabel}>{pin.label}</span>
        <Tip>
          {pin.label}
          <TipNote>{meta ? `${where} · ${meta.text}` : where}</TipNote>
        </Tip>
      </Link>
      {meta && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-0 right-2 flex h-7 items-center font-mono text-meta tabular-nums transition-opacity duration-120 group-hover/pin:opacity-0 group-focus-within/pin:opacity-0 max-md:h-12 pointer-coarse:group-hover/pin:opacity-100 strip:hidden",
            meta.signal ? "text-signal-text" : "text-ink-3",
          )}
        >
          {meta.text}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${pin.label} from favorites`}
        title="Remove from favorites"
        onClick={() => store.views.pin(pin.ref, false)}
        className={cn(rowButton, "text-ink-3 opacity-0 group-hover/pin:opacity-100 group-focus-within/pin:opacity-100 hover:text-ink pointer-coarse:hidden")}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
});
