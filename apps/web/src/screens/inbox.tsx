// The inbox (PLNR-26): notifications on the left, the issue itself on the right (PLNR-161, ADR 0022): the pane of a project's
// list under a strip that says what happened and what it asks for, its feed at the notification's comment. On a wide
// screen the header and tabs of the FramedInbox artboard (owner's call, 2026-11-06, over the Linear-like header of
// 2026-10-29): Mark all read in the header, Unread and All as tabs, the filter and display options at the tabs' right
// end, the other bulk actions behind "…". Everything applies at once: marks through store.inbox, state moves
// through the issue's own edit; a toast offers Undo (⌘Z).
//
// On a phone: the LedgerPhoneInbox artboard, a row's actions behind its "…" instead of the artboard's swipes (ADR 0016).
// The artboard's cycle chip, GitHub as an actor and unread dots on other workspaces wait for the features behind them
// (docs/features.md).
//
// The inbox is what happened, My work is what to do (RSVA-571, owner 2026-11-10). So it opens on the unread ones with a
// row open, a comment's row says how the comment starts, read notifications of finished issues leave by themselves,
// and the artboard's Waiting on you tab is gone: it and My work counted different things under one name. A run of an
// agent's closures was to fold into one row; with the read ones leaving by themselves what is left of a run is unread,
// and an unread closure's title is the news, so the rows stay.
//
// One inbox for every workspace (RSVA-613, owner 2026-11-11), as My work is: the engines of all the viewer's workspaces
// are held while it is open, a row says its workspace when there are several, and its marks go to its own. The issue pane
// reads the workspace on screen (every part of it reads `store`), so a row of another workspace moves the address there
// first; the screen is remounted on that engine and takes the visit over from inbox-view.ts. Considered: a pane that
// takes its engine as a parameter (every component under IssueDetail reads `store`: a rewrite of the issue's screens),
// and other workspaces' rows opening their page (the inbox's split view lost for them).
import {
  AlarmIcon,
  ArchiveIcon,
  ArrowBendUpLeftIcon,
  ArrowsLeftRightIcon,
  AtIcon,
  ChatCircleIcon,
  ChecksIcon,
  CircleIcon,
  CubeIcon,
  DotsThreeIcon,
  EyeIcon,
  FunnelSimpleIcon,
  SealCheckIcon,
  SlidersHorizontalIcon,
  TrayIcon,
  UserPlusIcon,
  type Icon,
} from "@phosphor-icons/react";
import { PRIORITY_ORDER, STATE_GROUP_ORDER } from "@rsva/query";
import type { InboxKind, InboxRow, SyncStore } from "@rsva/sync";
import { isClosedGroup, priorityName, type Issue } from "@rsva/schema/models";
import { Badge } from "@rsva/ui/components/badge";
import { Button } from "@rsva/ui/components/button";
import { Checkbox } from "@rsva/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@rsva/ui/components/dropdown-menu";
import { Kbd, KeyHint } from "@rsva/ui/components/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@rsva/ui/components/popover";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { SearchSelect, SearchSelectAction, type SearchSelectOption } from "@rsva/ui/components/search-select";
import { SplitView } from "@rsva/ui/components/split-view";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { ToggleGroup, ToggleGroupItem } from "@rsva/ui/components/toggle-group";
import { Separator } from "@rsva/ui/components/separator";
import { Hint } from "@rsva/ui/components/tooltip";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { enterPane, leavePane } from "../lib/areas.ts";
import { face } from "../lib/face.ts";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { inboxView, type InboxShow, type InboxView } from "../inbox-view.ts";
import {
  arrange,
  filterCount,
  INBOX_GROUP_OPTIONS,
  INBOX_ORDER_OPTIONS,
  inboxActions,
  KIND_LABELS,
  matches,
  reason,
  snoozeOptions,
  untilLabel,
  type InboxAction,
  type InboxFilter,
  type WsRow,
} from "../lib/inbox.ts";
import { useIsPhone } from "../lib/phone.ts";
import { clockOrDate } from "@rsva/display/time";
import { exactTime, useNow } from "../lib/time.ts";
import { plural } from "@rsva/schema/util";
import { Link } from "../link.tsx";
import { paths, router } from "../router.ts";
import { store } from "../store.ts";
import { useEngines, useWorkspaceList, type Workspace } from "../held-engines.ts";
import { WorkspaceIcon } from "./workspace-switcher.tsx";
import { STATE_GROUP_LABELS } from "./filter-model.ts";
import { IssueDetail } from "./issue-detail.tsx";
import { typedInto } from "../lib/typing.ts";
import { listView } from "./list-view.ts";
import { neighbour, stepIn } from "../lib/step-keys.ts";
import { paneKeys, useWindowKeys } from "./list-keys.ts";
import { Choice, Section } from "./menu-parts.tsx";
import { notice } from "./notice.ts";
import { StateGlyph } from "./state-glyph.tsx";
import { RowHoverActions } from "./row-hover-actions.tsx";

/** A row's workspace: its engine, for its names and its marks. */
type Engine = SyncStore;

const userName = (e: Engine, id: string | null | undefined) => (id ? (e.users.get(id)?.name ?? "Someone") : "Someone");
const faceIn = (e: Engine, id: string) => face(e.users.get(id), "Someone");

// ── Actions, each with its toast and undo ──────────────────────────────────────────────────────────────────────

function archive(e: Engine, issue: Issue): void {
  const before = e.inbox.marksOf([issue.id]);
  e.inbox.archive([issue.id]);
  notice.show(`Archived ${e.issueKey(issue)}`, () => e.inbox.restore(before));
}

function snooze(e: Engine, issue: Issue, at: Date): void {
  const before = e.inbox.marksOf([issue.id]);
  e.inbox.snooze(issue.id, at);
  notice.show(`${e.issueKey(issue)} snoozed until ${untilLabel(at.toISOString(), Date.now())}`, () => e.inbox.restore(before));
}

function unsnooze(e: Engine, issue: Issue): void {
  e.inbox.snooze(issue.id, null);
  notice.show("Back in your inbox");
}

function toggleRead(e: Engine, row: InboxRow): void {
  e.inbox.read([row.issue.id], row.unread);
}

function moveTo(e: Engine, issue: Issue, a: InboxAction): void {
  const prev = issue.stateId;
  e.updateIssue(issue.id, { stateId: a.stateId });
  notice.show(`${e.issueKey(issue)} → ${e.states.get(a.stateId)?.name ?? a.label}`, () => e.updateIssue(issue.id, { stateId: prev }));
}

/** Marks of rows of several workspaces at once, each in its own; the undo puts every one back. */
function markEach(rows: readonly WsRow[], engineOf: (ws: string) => Engine, act: (e: Engine, ids: string[]) => void): () => void {
  const byWs = new Map<string, string[]>();
  for (const r of rows) byWs.set(r.ws, [...(byWs.get(r.ws) ?? []), r.issue.id]);
  const undo = [...byWs].map(([ws, ids]) => {
    const e = engineOf(ws);
    const before = e.inbox.marksOf(ids);
    act(e, ids);
    return () => e.inbox.restore(before);
  });
  return () => undo.forEach((u) => u());
}

// ── Screen ──────────────────────────────────────────────────────────────────────────────────────────────────

const SHOW_TABS: readonly { value: InboxShow; label: string }[] = [
  { value: "unread", label: "Unread" },
  { value: "all", label: "All" },
];

/** A tab of the inbox: framed, the artboards' plate (`tab-plate`, globals.css); flat, a line under the open one. */
const showTab =
  "tab-plate relative flex h-full items-center gap-1.5 px-2.5 text-label text-ink-2 outline-none transition-colors duration-120 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-selected:font-medium aria-selected:text-ink aria-selected:after:absolute aria-selected:after:inset-x-2.5 aria-selected:after:-bottom-px aria-selected:after:h-0.5 aria-selected:after:bg-ink";

export const Inbox = observer(function Inbox({ ws }: { ws: string }) {
  const view = inboxView();
  // Once per mount: a visit goes on after a move to another workspace, else a new one starts.
  const [moved] = useState(() => view.arrive());
  const list = useWorkspaceList(ws);
  const engines = useEngines(ws, list.map((w) => w.slug).join(","));
  const engineOf = (slug: string): Engine => engines.get(slug) ?? store;
  const many = list.length > 1;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const now = useNow();
  const phone = useIsPhone();
  const inbox = store.inbox;
  // Issue ids are unique across workspaces: a row is known by its issue, as before.
  const all: WsRow[] = [...engines].flatMap(([slug, e]) => e.inbox.rows.map((r) => ({ ...r, ws: slug })));
  const { filter, display } = view;
  const show = view.show;
  const stateGroup = (r: WsRow) => engineOf(r.ws).states.get(r.issue.stateId)?.group;
  const listable = (r: WsRow) => (display.showSnoozed || !r.snoozedUntil) && matches(r, filter, () => stateGroup(r));
  const listed = all.filter(listable);
  // Unread keeps what was read on this visit: opening a row reads it, and it must not leave from under the pointer.
  const inUnread = (r: WsRow) => r.unread || view.readHere.has(r.issue.id);
  const inTab = (r: WsRow) => show !== "unread" || inUnread(r);
  // A tab's number is the rows it holds (RSVA-574): Unread said 0 over a row read a moment ago and still there. It is
  // in the signal colour only while something is unread.
  const unread = listed.filter((r) => r.unread).length;
  const counts = { all: listed.length, unread: show === "unread" ? listed.filter(inUnread).length : unread };
  const shown = listed.filter(inTab);
  const projectName = (id: string) => {
    for (const e of engines.values()) {
      const p = e.projects.get(id);
      if (p) return p.name;
    }
    return "Project";
  };
  const groups = arrange(shown, display, now, projectName);
  const rows = groups.flatMap((g) => g.rows);
  const selectedId = view.selected;
  const selected = rows.find((r) => r.issue.id === selectedId) ?? null;
  const filtered = filterCount(filter) > 0 || show !== "all";
  const listbox = useRef<HTMLDivElement>(null);

  // What was read of a row when it was first opened on this visit (RSVA-575): the pane marks as new what came after,
  // and going back to the row keeps the marks, though opening it read it. A row of another workspace is opened there.
  const select = (row: WsRow) => {
    setMenuFor(null);
    if (row.ws !== ws) {
      view.moveTo(row.issue.id, listbox.current?.scrollTop ?? 0);
      router.replace(paths.inbox(row.ws));
      return;
    }
    const e = engineOf(row.ws);
    if (!view.readBefore.has(row.issue.id)) view.readBefore.set(row.issue.id, e.inbox.marksOf([row.issue.id])[0]?.readId ?? 0);
    view.select(row.issue.id);
    if (!row.unread) return;
    view.readOnVisit(row.issue.id);
    e.inbox.read([row.issue.id]);
  };
  const finished = (r: WsRow) => isClosedGroup(stateGroup(r));
  // After a move from another workspace: the row that was chosen there is opened here, at the list's place.
  const landed = useRef(!moved);
  useEffect(() => {
    if (landed.current || inbox.status !== "ready") return;
    landed.current = true;
    if (listbox.current) listbox.current.scrollTop = view.scrollTop;
    const row = rows.find((r) => r.issue.id === view.selected);
    if (row) select(row);
  });
  // What was read and is over leaves by itself, in each workspace once its inbox is here (RSVA-571): a closed issue's
  // read notification asks nothing, and kept, the inbox turns into a log (History is that).
  useEffect(() => {
    const over: WsRow[] = [];
    for (const [slug, e] of engines) {
      if (view.swept.has(slug) || e.inbox.status !== "ready") continue;
      view.swept.add(slug);
      over.push(...all.filter((r) => r.ws === slug && !r.unread && !r.snoozedUntil && finished(r)));
    }
    if (!over.length) return;
    const undo = markEach(over, engineOf, (e, ids) => e.inbox.archive(ids));
    notice.show(`Archived ${plural(over.length, "read notification")} of finished issues`, undo);
  });
  // Coming in (RSVA-571), once the rows of the workspace on screen are there: the unread ones if there are any, and a
  // row open: the first unread, else the top one. A phone opens on the list.
  const entered = useRef(moved);
  useEffect(() => {
    if (entered.current || inbox.status !== "ready") return;
    entered.current = true;
    const anyUnread = all.some((r) => r.unread && !r.snoozedUntil);
    view.setShow(anyUnread ? "unread" : "all");
    if (phone) return;
    const left = arrange(all.filter((r) => listable(r) && (!anyUnread || r.unread)), display, Date.now(), () => "").flatMap((g) => g.rows);
    if (left[0]) select(left[0]);
  });
  /** Acts on the row; when that takes the selected row off the list (archived, snoozed), the next one is selected. */
  const leave = (row: WsRow, act: () => void) => {
    const next = neighbour(rows.map((r) => r.issue.id), row.issue.id);
    setMenuFor(null);
    act();
    const after = engineOf(row.ws).inbox.rows.find((r) => r.issue.id === row.issue.id);
    const stays = after && listable({ ...after, ws: row.ws }) && inTab({ ...after, ws: row.ws });
    if (row.issue.id === selectedId && !stays) view.select(next ?? null);
  };
  // Bulk actions take the rows on screen, so a filter narrows them; snoozed rows stay as they are.
  const awake = rows.filter((r) => !r.snoozedUntil);
  const markAll = () => {
    const which = awake.filter((r) => r.unread);
    if (!which.length) return;
    notice.show(`Marked ${which.length} as read`, markEach(which, engineOf, (e, ids) => e.inbox.read(ids)));
  };
  const archiveAll = (which: WsRow[]) => {
    if (!which.length) return;
    if (selectedId && which.some((r) => r.issue.id === selectedId)) view.select(null);
    notice.show(`Archived ${which.length}`, markEach(which, engineOf, (e, ids) => e.inbox.archive(ids)));
  };
  const bulk = {
    markAll,
    archiveAll: () => archiveAll(awake),
    archiveRead: () => archiveAll(awake.filter((r) => !r.unread)),
    archiveFinished: () => archiveAll(awake.filter(finished)),
  };

  // On the window, as on a project's list: the keys hold wherever the focus is, in the list or in the issue. The list is a
  // listbox, which typedInto counts; anything else that takes keys keeps them. Capture (useWindowKeys): a picker's Esc
  // closes the picker, not the notification too.
  useWindowKeys((e) => {
    if (listView.picker || (typedInto(e) && !listbox.current?.contains(e.target as Node))) return;
    if (e.altKey && e.code === "KeyU") {
      e.preventDefault();
      return markAll();
    }
    if (e.shiftKey && e.key === "Backspace") {
      e.preventDefault();
      return bulk.archiveRead();
    }
    const eng = selected && engineOf(selected.ws);
    if (e.metaKey || e.ctrlKey || e.altKey) {
      const primary = selected && eng && inboxActions(selected, eng.statesOf(selected.issue.projectId), eng.me?.id ?? "").find((a) => a.primary);
      if (selected && eng && primary && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        leave(selected, () => moveTo(eng, selected.issue, primary));
      }
      return;
    }
    const k = e.key;
    const pane = paneKeys(e, k, {
      move: (by) => {
        const next = stepIn(rows, selected ? rows.indexOf(selected) : -1, by);
        if (next) select(next);
      },
      // Into the pane, on the issue's properties (PLNR-304); ⤢ in its header opens the page.
      enter: () => !!selected && !!eng && (enterPane() || router.push(paths.browse(selected.ws, eng.issueKey(selected.issue))), true),
      ownEnter: "button, a, [data-slot=split-detail]",
      // From the pane to the list, then the notification closes.
      leave: selected ? () => leavePane() || view.select(null) : undefined,
      issue: selected?.issue,
    });
    if (pane) return e.preventDefault();
    if (selected && eng && (k === "e" || k === "Backspace")) leave(selected, () => archive(eng, selected.issue));
    else if (selected && eng && k === "u") toggleRead(eng, selected);
    else if (selected && eng && k === "h") {
      if (selected.snoozedUntil) leave(selected, () => unsnooze(eng, selected.issue));
      else setMenuFor(menuFor === selected.issue.id ? null : selected.issue.id);
    } else if (k === "f") view.setPanel("filter");
    else if (k === "v") view.setPanel("display");
    else return;
    e.preventDefault();
  }, true);

  const loading = inbox.status === "loading" && all.length === 0;
  const totalUnread = all.filter((r) => r.unread && !r.snoozedUntil).length;
  const workspaceOf = (slug: string) => list.find((w) => w.slug === slug);

  return (
    <SplitView
      label="Notifications"
      open={!!selected}
      // 540px on a wide screen, so a title and a comment's line are read whole more often than not (RSVA-571; it was 452);
      // a narrower window takes the room from the list, down to 300px, not from the issue.
      width="clamp(300px, 40%, 540px)"
      listClassName="bg-ground"
      list={
        <>
          <header className="flex h-(--topbar) shrink-0 items-center gap-1 border-b pr-2.5 pl-5 max-md:h-auto max-md:gap-0 max-md:border-b-0 max-md:bg-panel max-md:pt-2.5 max-md:pr-1 max-md:pb-1 max-md:pl-4">
            <TrayIcon aria-hidden className="mr-1.5 size-4 shrink-0 max-md:hidden" />
            <h1 className="mr-1 text-[15px] font-semibold tracking-[-0.01em] max-md:text-[24px] max-md:tracking-[-0.02em]">Inbox</h1>
            <span className="truncate pt-1.5 pl-1 font-mono text-id text-ink-3 md:hidden">{totalUnread ? `${totalUnread} unread` : "all read"}</span>
            <span className="flex-1 max-md:hidden" />
            <Hint label={<KeyHint label="Mark all as read" keys={keys("alt", "U")} />}>
              <Button variant="ghost" className="max-md:hidden" onClick={bulk.markAll}>
                <ChecksIcon />
                Mark all read
              </Button>
            </Hint>
            <span className="max-md:order-last">
              <BulkMenu {...bulk} />
            </span>
            {phone && (
              <>
                <span className="flex-1" />
                <Hint label="Unread only">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Unread only"
                    aria-pressed={show === "unread"}
                    className={cn("relative", show === "unread" && "bg-nav-current text-ink")}
                    onClick={() => view.setShow(show === "unread" ? "all" : "unread")}
                  >
                    <TrayIcon />
                    <span aria-hidden className="absolute top-[5px] right-[5px] size-[5px] rounded-full bg-signal" />
                  </Button>
                </Hint>
                <InboxFilterMenu view={view} rows={all} engines={engines} workspaces={many ? list : []} />
                <InboxDisplayMenu view={view} />
              </>
            )}
          </header>
          {!phone && (
            <div className="flex h-10 shrink-0 items-center gap-0.5 border-b pr-2.5 pl-2.5">
              <div role="tablist" aria-label="Notifications to show" className="flex h-full items-stretch gap-0.5">
                {SHOW_TABS.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="tab"
                    aria-selected={show === t.value}
                    onClick={() => (view.clearReadHere(), view.setShow(t.value))}
                    className={showTab}
                  >
                    {t.label}
                    <span className={cn("font-mono text-meta tabular-nums", t.value === "unread" && unread > 0 ? "text-signal-text" : "text-ink-3")}>{counts[t.value]}</span>
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              <InboxFilterMenu view={view} rows={all} engines={engines} workspaces={many ? list : []} />
              <InboxDisplayMenu view={view} />
            </div>
          )}
          <KindChips view={view} rows={all} />
          {/* No ring on the list: its selected row marks the place, as WAI-ARIA asks of aria-activedescendant (PLNR-245). */}
          <div
            ref={listbox}
            role="listbox"
            data-page-list
            data-roving="list"
            aria-label="Notifications"
            aria-activedescendant={selected ? `inbox-${selected.issue.id}` : undefined}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto outline-none"
          >
            {loading ? (
              <p className="p-10 text-center text-caption text-ink-3">Loading…</p>
            ) : rows.length === 0 ? (
              filtered ? (
                <Empty title="No matches" text="Nothing in the inbox matches the filter.">
                  <Button variant="outline" onClick={() => (view.setFilter({}), view.setShow("all"))}>
                    Clear filters
                  </Button>
                </Empty>
              ) : (
                <Empty title="Inbox zero" text="Reviews, assignments, replies and changes to your issues land here." />
              )
            ) : (
              groups.map((g) => (
                <div key={g.name} role="group" aria-label={g.name || "Notifications"}>
                  {/* Framed, a group's name over rows that are plates is a bare caption with room above it, the FramedInbox
                      artboard's Today and Earlier: no band, no rule. */}
                  {g.name && (
                    <div className="flex h-[calc(var(--row-head)-2px)] items-center gap-2 border-b border-rule-soft bg-group px-5 framed:h-auto framed:border-b-transparent framed:bg-transparent framed:pt-3 framed:pb-1.5 font-mono text-[10.5px] tracking-[.08em] text-ink-3 uppercase max-md:h-8 max-md:px-4">
                      {g.name}
                      <span>{g.rows.length}</span>
                    </div>
                  )}
                  {g.rows.map((r) => (
                    <Row
                      key={r.issue.id}
                      row={r}
                      engine={engineOf(r.ws)}
                      workspace={many ? workspaceOf(r.ws) : undefined}
                      current={r.ws === ws}
                      now={now}
                      selected={r === selected}
                      menuOpen={menuFor === r.issue.id}
                      onMenu={(open) => setMenuFor(open ? r.issue.id : null)}
                      onSelect={() => select(r)}
                      onLeave={(act) => leave(r, act)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      }
      detail={
        // The pane reads the workspace on screen: a row of another one is opened after the move there (select).
        selected && selected.ws === ws ? (
          <IssuePane
            key={selected.issue.id}
            ws={ws}
            row={selected}
            readBefore={view.readBefore.get(selected.issue.id) ?? Infinity}
            onClose={() => view.select(null)}
            onLeave={(act) => leave(selected, act)}
          />
        ) : (
          <Idle ws={ws} unread={unread} read={awake.filter((r) => !r.unread).length} archiveRead={bulk.archiveRead} />
        )
      }
    />
  );
});

// ── Header menus ────────────────────────────────────────────────────────────────────────────────────────────

/** ⋯ next to the title: everything on screen at once. */
function BulkMenu({ markAll, archiveAll, archiveRead, archiveFinished }: Record<"markAll" | "archiveAll" | "archiveRead" | "archiveFinished", () => void>) {
  return (
    <DropdownMenu>
      <Hint label="Inbox actions">
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" aria-label="Inbox actions">
              <DotsThreeIcon />
            </Button>
          }
        />
      </Hint>
      <DropdownMenuContent align="start" className="w-[232px]">
        <DropdownMenuItem onClick={markAll}>
          <ChecksIcon />
          Mark all as read
          <DropdownMenuShortcut>{keys("alt", "U")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={archiveAll}>
          <ArchiveIcon />
          Archive all
        </DropdownMenuItem>
        <DropdownMenuItem onClick={archiveRead}>
          <ArchiveIcon />
          Archive all read
          <DropdownMenuShortcut>{keys("shift", "⌫")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={archiveFinished}>
          <ArchiveIcon />
          Archive all completed
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The kinds that are addressed to the viewer, not the general traffic of an issue they follow. */
const ADDRESSED: ReadonlySet<InboxKind> = new Set(["assigned", "review", "approved", "mention", "reply"]);

const KIND_ICONS: Record<InboxKind, Icon> = {
  assigned: UserPlusIcon,
  review: EyeIcon,
  approved: SealCheckIcon,
  state: ArrowsLeftRightIcon,
  mention: AtIcon,
  reply: ArrowBendUpLeftIcon,
  comment: ChatCircleIcon,
};

type FilterKey = keyof InboxFilter;
const FILTER_GROUPS: Record<FilterKey, string> = {
  kind: "Notification type",
  from: "From",
  workspace: "Workspace",
  project: "Project",
  priority: "Issue priority",
  stateGroup: "Issue status type",
};

/**
 * The filter as "key:value" choices; people and projects only as far as the inbox has them, workspaces when there are
 * several (`workspaces` is empty with one).
 */
function filterOptions(rows: readonly WsRow[], engines: ReadonlyMap<string, Engine>, workspaces: readonly Workspace[]): SearchSelectOption[] {
  const out: SearchSelectOption[] = [];
  const add = (key: FilterKey, value: string | number, label: string, icon: ReactNode) =>
    out.push({ value: `${key}:${value}`, label, icon, group: FILTER_GROUPS[key] });
  for (const [k, label] of Object.entries(KIND_LABELS) as [InboxKind, string][]) {
    const I = KIND_ICONS[k];
    add("kind", k, label, <I className="text-ink-3" />);
  }
  // A person in two workspaces is one choice.
  const actors = new Set(rows.flatMap((r) => r.events.map((e) => e.by)));
  const people = new Map([...engines.values()].flatMap((e) => [...e.users.values()].filter((u) => actors.has(u.id)).map((u) => [u.id, u] as const)));
  for (const u of [...people.values()].sort((a, b) => a.name.localeCompare(b.name))) add("from", u.id, u.name, <UserAvatar {...face(u)} className="size-4" />);
  for (const w of workspaces) add("workspace", w.slug, w.name, <WorkspaceIcon workspace={w} className="size-4 rounded-[4px] text-[9px]" />);
  const projects = new Set(rows.map((r) => r.issue.projectId));
  for (const e of engines.values()) for (const p of [...e.projects.values()].filter((p) => projects.has(p.id))) add("project", p.id, p.name, <CubeIcon className="text-ink-3" />);
  for (const p of PRIORITY_ORDER) add("priority", p, priorityName(p), <PriorityIcon priority={p} />);
  for (const g of STATE_GROUP_ORDER) add("stateGroup", g, STATE_GROUP_LABELS[g]!, <StateIcon group={g} />);
  return out;
}

function toChoices(f: InboxFilter): string[] {
  return (Object.keys(FILTER_GROUPS) as FilterKey[]).flatMap((k) => (f[k] ?? []).map((v) => `${k}:${v}`));
}

function fromChoices(choices: readonly string[]): InboxFilter {
  const f: Record<string, (string | number)[]> = {};
  for (const c of choices) {
    const i = c.indexOf(":");
    const key = c.slice(0, i);
    (f[key] ??= []).push(key === "priority" ? Number(c.slice(i + 1)) : c.slice(i + 1));
  }
  return f as InboxFilter;
}

const InboxFilterMenu = observer(function InboxFilterMenu({
  view,
  rows,
  engines,
  workspaces,
}: {
  view: InboxView;
  rows: readonly WsRow[];
  engines: ReadonlyMap<string, Engine>;
  workspaces: readonly Workspace[];
}) {
  const n = filterCount(view.filter);
  return (
    <SearchSelect
      open={view.panel === "filter"}
      onOpenChange={(open) => view.setPanel(open ? "filter" : null)}
      multiple
      align="end"
      className="w-64"
      placeholder="Add filter…"
      options={filterOptions(rows, engines, workspaces)}
      value={toChoices(view.filter)}
      onChange={(next) => view.setFilter(fromChoices(next))}
      trigger={
        <Button
          variant="ghost"
          size="icon"
          aria-label={n ? `Filter, ${n} active` : "Filter"}
          title="Filter (F)"
          className={cn("relative", n > 0 && "bg-nav-current text-ink")}
        >
          <FunnelSimpleIcon />
          {n > 0 && (
            <Badge variant="count" className="absolute -top-0.5 -right-0.5 size-3.5 min-w-0 border-0 px-0 text-[9px]">
              {n}
            </Badge>
          )}
        </Button>
      }
      footer={n > 0 && <SearchSelectAction onClick={() => view.setFilter({})}>Clear filters</SearchSelectAction>}
    />
  );
});

const InboxDisplayMenu = observer(function InboxDisplayMenu({ view }: { view: InboxView }) {
  const d = view.display;
  return (
    <Popover open={view.panel === "display"} onOpenChange={(open) => view.setPanel(open ? "display" : null)}>
      <Hint label={<KeyHint label="Display options" keys="V" />}>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="icon" aria-label="Display options">
              <SlidersHorizontalIcon />
            </Button>
          }
        />
      </Hint>
      <PopoverContent align="end" className="w-56 gap-4 p-3">
        <Section title="Group by">
          <Choice label="Group by" options={INBOX_GROUP_OPTIONS} value={d.groupBy} onChange={(groupBy) => view.setDisplay({ groupBy })} />
        </Section>
        <Section title="Ordering">
          <Choice label="Ordering" options={INBOX_ORDER_OPTIONS} value={d.orderBy} onChange={(orderBy) => view.setDisplay({ orderBy })} />
        </Section>
        <div className="flex flex-col gap-2 border-t pt-3">
          <label className="flex items-center gap-2 px-1 text-xs max-md:min-h-10 max-md:gap-3 max-md:text-[15px]">
            <Checkbox checked={d.showSnoozed} onCheckedChange={(showSnoozed) => view.setDisplay({ showSnoozed })} />
            Show snoozed
          </label>
          <label className="flex items-center gap-2 px-1 text-xs max-md:min-h-10 max-md:gap-3 max-md:text-[15px]">
            <Checkbox checked={d.unreadFirst} onCheckedChange={(unreadFirst) => view.setDisplay({ unreadFirst })} />
            Show unread first
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
});

/** A phone's filter, from the LedgerPhoneInbox artboard: the kinds that ask something of the viewer, in one tap. */
const KIND_CHIPS: { label: string; kinds: InboxKind[] }[] = [
  { label: "All", kinds: [] },
  { label: "Mentions", kinds: ["mention", "reply"] },
  { label: "Reviews", kinds: ["review", "approved"] },
  { label: "Assigned", kinds: ["assigned"] },
];

const KindChips = observer(function KindChips({ view, rows }: { view: InboxView; rows: readonly InboxRow[] }) {
  const current = view.filter.kind ?? [];
  const chosen = KIND_CHIPS.filter(({ kinds }) => current.length === kinds.length && kinds.every((k) => current.includes(k))).map((c) => c.label);
  return (
    <ToggleGroup aria-label="Inbox filter" value={chosen} className="no-scrollbar w-auto shrink-0 gap-2 overflow-x-auto rounded-none border-b bg-panel px-4 pt-1 pb-3 md:hidden">
      {KIND_CHIPS.map(({ label, kinds }) => {
        const unread = rows.filter((r) => r.unread && !r.snoozedUntil && (!kinds.length || r.events.some((e) => kinds.includes(e.kind)))).length;
        return (
          <ToggleGroupItem
            key={label}
            value={label}
            onClick={() => view.setFilter(kinds.length ? { ...view.filter, kind: kinds } : { ...view.filter, kind: [] })}
            className="h-8 min-w-0 gap-1.5 rounded-full border border-control-border px-3 text-[13px] font-normal text-ink-2 transition-colors duration-150 hover:bg-transparent hover:text-ink-2 focus-visible:border-control-border focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-inverse aria-pressed:bg-inverse aria-pressed:text-inverse-ink"
          >
            {label}
            {unread > 0 && <span className="font-mono text-[11px] opacity-70">{unread}</span>}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
});

/**
 * The pane with no notification open (the list is empty, or Esc closed the row): where the inbox stands and what to do
 * about it, not a prompt to select something.
 */
function Idle({ ws, unread, read, archiveRead }: { ws: string; unread: number; read: number; archiveRead: () => void }) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="flex max-w-[320px] flex-col items-center gap-3 px-6 text-center">
        <StateIcon group="completed" className="size-7" />
        <p className="text-sm font-semibold">{unread ? `${unread} unread` : "All read"}</p>
        <p className="text-[12.5px] text-ink-3">
          {unread ? "J and K move through them; a row opens here." : "Nothing new. What waits on you is in My work."}
        </p>
        <span className="flex gap-2">
          {read > 0 && (
            <Button variant="outline" onClick={archiveRead}>
              <ArchiveIcon />
              Archive {read} read
              <Kbd>{keys("shift", "⌫")}</Kbd>
            </Button>
          )}
          <Button variant="ghost" render={<Link href={paths.myWork(ws)} />} nativeButton={false}>
            My work
          </Button>
        </span>
      </div>
    </div>
  );
}

function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex animate-in flex-col items-center gap-3.5 px-10 py-[72px] text-center duration-300 fade-in-0 slide-in-from-bottom-1">
      <StateIcon group="completed" className="size-7" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-[280px] text-[12.5px] text-ink-3">{text}</p>
      {children}
    </div>
  );
}

const iconButton = "size-[26px] bg-panel text-ink-2 shadow-[0_0_0_1px_var(--color-control-border)] hover:bg-field hover:text-ink max-md:size-10 max-md:bg-transparent max-md:shadow-none";

/** Snooze times; the trigger is the caller's (row or header). */
function SnoozeMenu({
  engine,
  issue,
  open,
  onOpenChange,
  trigger,
  onSnoozed,
}: {
  engine: Engine;
  issue: Issue;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: ReactElement;
  onSnoozed: (act: () => void) => void;
}) {
  return (
    <DropdownMenu {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" className="w-[212px]" onClick={(e) => e.stopPropagation()}>
        <SnoozeItems engine={engine} issue={issue} onSnoozed={onSnoozed} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SnoozeItems({ engine, issue, onSnoozed }: { engine: Engine; issue: Issue; onSnoozed: (act: () => void) => void }) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="pb-1 font-mono text-[10.5px] tracking-[.08em] text-ink-3 uppercase max-md:px-2 max-md:text-[10.5px] max-md:leading-[inherit]">Snooze until</DropdownMenuLabel>
      {snoozeOptions(Date.now()).map((o) => (
        <DropdownMenuItem key={o.label} onClick={() => onSnoozed(() => snooze(engine, issue, o.at))} className="justify-between">
          <span>{o.label}</span>
          <span className="font-mono text-meta text-ink-3">{o.hint}</span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}

/** A phone's row has no hover: its "…" opens what the hover buttons do elsewhere, as a sheet. */
function PhoneRowMenu({ engine: e, row, onLeave }: { engine: Engine; row: InboxRow; onLeave: (act: () => void) => void }) {
  const { issue } = row;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label="More actions" className="absolute top-0 right-0 size-11 text-ink-3 md:hidden" />}
      >
        <DotsThreeIcon weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[212px]" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => toggleRead(e, row)}>
          <CircleIcon weight={row.unread ? "fill" : "bold"} />
          {row.unread ? "Mark as read" : "Mark as unread"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onLeave(() => archive(e, issue))}>
          <ArchiveIcon />
          Archive
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {row.snoozedUntil ? (
          <DropdownMenuItem onClick={() => onLeave(() => unsnooze(e, issue))}>
            <AlarmIcon />
            Unsnooze
          </DropdownMenuItem>
        ) : (
          <SnoozeItems engine={e} issue={issue} onSnoozed={onLeave} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const Row = observer(function Row({
  row,
  engine: e,
  workspace,
  current,
  now,
  selected,
  menuOpen,
  onMenu,
  onSelect,
  onLeave,
}: {
  row: InboxRow;
  engine: Engine;
  /** The row's workspace, when the inbox has several. */
  workspace: Workspace | undefined;
  /** Its workspace is the one on screen. */
  current: boolean;
  now: number;
  selected: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onSelect: () => void;
  onLeave: (act: () => void) => void;
}) {
  const { issue, latest, unread, snoozedUntil } = row;
  const state = e.states.get(issue.stateId);
  const actor = userName(e, latest.by);
  const KindIcon = KIND_ICONS[latest.kind];
  const primary = inboxActions(row, e.statesOf(issue.projectId), e.me?.id ?? "").find((a) => a.primary);
  // The option holds the text only; its buttons sit beside it, so the listbox keeps a flat list of options.
  return (
    <div
      className={cn(
        "list-row group/row relative bg-ground transition-colors duration-120 hover:bg-row-hover",
        selected && "bg-row-selected hover:bg-row-selected",
      )}
    >
      <div
        id={`inbox-${issue.id}`}
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className="flex h-[calc(62px+2*var(--air))] cursor-pointer items-center gap-3 py-2.5 pr-3.5 pl-[26px] max-md:h-auto max-md:items-start max-md:py-[13px] max-md:pr-4 max-md:pl-5"
      >
        {unread && <span aria-label="Unread" className="absolute top-1/2 left-[10px] size-[7px] -translate-y-1/2 rounded-full bg-signal max-md:top-[27px] max-md:left-[7px] max-md:translate-y-0" />}
        {/* What happened leads, who did it is the badge (RSVA-571): one agent's face on every row told the rows apart by
            nothing. A kind addressed to the viewer is in the signal colour. */}
        <span aria-hidden className="relative shrink-0" title={KIND_LABELS[latest.kind]}>
          <span className={cn("grid size-8 place-items-center rounded-full max-md:size-9", ADDRESSED.has(latest.kind) ? "bg-signal/15 text-signal-text" : "bg-sidebar text-ink-2")}>
            <KindIcon className="size-4" />
          </span>
          <UserAvatar {...faceIn(e, latest.by)} className="absolute -right-1 -bottom-1 size-[17px] text-[7px] shadow-[0_0_0_1.5px_var(--color-ground)]" />
        </span>
        <div className={cn("flex min-w-0 flex-1 flex-col gap-[5px] max-md:gap-[3px]", !unread && !selected && "opacity-70")}>
          {/* A phone's order, from the LedgerPhoneInbox artboard: who and when, the title, then the key and the state. */}
          <div className="flex min-w-0 items-center gap-2 max-md:order-2 max-md:flex-wrap max-md:gap-x-1.5 max-md:gap-y-[3px]">
            <span title={workspace?.name} className="flex shrink-0 items-center gap-1.5 font-mono text-id text-ink-3 max-md:order-2">
              {workspace && <WorkspaceIcon workspace={workspace} current={current} className="size-[13px] rounded-[3px] text-[8px]" />}
              {e.issueKey(issue)}
            </span>
            {state && <StateGlyph state={state} className="shrink-0 max-md:order-3" />}
            <span className={cn("min-w-0 flex-1 truncate max-md:order-1 max-md:line-clamp-2 max-md:basis-full max-md:text-[15px]/[1.35] max-md:whitespace-normal", unread ? "font-semibold text-ink" : "text-ink-2 max-md:font-medium max-md:text-ink")}>{issue.title}</span>
            {state && <span className="order-4 font-mono text-id text-ink-3 md:hidden">{state.name}</span>}
          </div>
          {/* On a phone the first line leaves room for the row's "…" (PhoneRowMenu). */}
          <div className="flex min-w-0 items-center gap-2 max-md:order-1 max-md:pr-7">
            <span className="min-w-0 flex-1 truncate text-xs text-ink-2 max-md:text-[13.5px]">
              <span className="font-medium text-ink">{actor}</span> {reason(latest, (id) => e.states.get(id)?.name)}
            </span>
            <span className={cn("flex shrink-0 items-center gap-2 transition-opacity group-hover/row:opacity-0", menuOpen && "opacity-0")}>
              {issue.priority !== 0 && <PriorityIcon priority={issue.priority} />}
              {snoozedUntil ? (
                <span title={`Snoozed until ${untilLabel(snoozedUntil, now)}`} className="flex items-center gap-1 font-mono text-[11px] text-signal-text">
                  <AlarmIcon className="size-3" />
                  {untilLabel(snoozedUntil, now)}
                </span>
              ) : (
                <>
                  {/* A row is an issue, not an event (RSVA-574): how many notifications came before the one it says. */}
                  {row.events.length > 1 && (
                    <span title={`${plural(row.events.length, "notification")} on this issue; the latest is shown`} className="font-mono text-[11px] text-ink-3">
                      +{row.events.length - 1}
                    </span>
                  )}
                  <time dateTime={latest.at} title={exactTime(latest.at)} className="font-mono text-[11px] text-ink-3">
                    {clockOrDate(latest.at, now)}
                  </time>
                </>
              )}
            </span>
          </div>
          {primary && (
            <span className="order-3 mt-1.5 flex gap-2 md:hidden">
              <Button variant="outline" size="xs" className="h-8 gap-[7px] px-3 text-[13px]" onClick={(ev) => (ev.stopPropagation(), onLeave(() => moveTo(e, issue, primary)))}>
                {e.states.get(primary.stateId) && <StateGlyph state={e.states.get(primary.stateId)!} />}
                {primary.label}
              </Button>
              <Button variant="outline" size="xs" className="h-8 px-3 text-[13px]">
                Review
              </Button>
            </span>
          )}
        </div>
      </div>
      <RowHoverActions shown={menuOpen} className="absolute right-2.5 bottom-2 gap-0.5 max-md:hidden">
        <InboxActions engine={e} row={row} onLeave={onLeave} menuOpen={menuOpen} onMenu={onMenu} className={iconButton} />
      </RowHoverActions>
      <PhoneRowMenu engine={e} row={row} onLeave={onLeave} />
    </div>
  );
});

/** Snooze (or unsnooze), read toggle and archive: on a row's hover and with the open issue. */
function InboxActions({
  engine: e,
  row,
  onLeave,
  menuOpen,
  onMenu,
  className,
}: {
  engine: Engine;
  row: InboxRow;
  onLeave: (act: () => void) => void;
  menuOpen?: boolean;
  onMenu?: (open: boolean) => void;
  className?: string;
}) {
  const { issue } = row;
  // A row is clickable: its buttons keep the click to themselves.
  const stop = (f: () => void) => (e: { stopPropagation: () => void }) => (e.stopPropagation(), f());
  return (
    <>
      {row.snoozedUntil ? (
        <Button variant="ghost" size="icon" aria-label="Unsnooze" title="Unsnooze (H)" className={className} onClick={stop(() => onLeave(() => unsnooze(e, issue)))}>
          <AlarmIcon />
        </Button>
      ) : (
        <SnoozeMenu
          engine={e}
          issue={issue}
          {...(menuOpen === undefined ? {} : { open: menuOpen })}
          {...(onMenu ? { onOpenChange: onMenu } : {})}
          onSnoozed={onLeave}
          trigger={
            <Button variant="ghost" size="icon" aria-label="Snooze" title="Snooze (H)" className={className} onClick={(ev) => ev.stopPropagation()}>
              <AlarmIcon />
            </Button>
          }
        />
      )}
      <ReadButton engine={e} row={row} {...(className ? { className } : {})} />
      <Button variant="ghost" size="icon" aria-label="Archive" title="Archive (E)" className={className} onClick={stop(() => onLeave(() => archive(e, issue)))}>
        <ArchiveIcon />
      </Button>
    </>
  );
}

function ReadButton({ engine, row, className }: { engine: Engine; row: InboxRow; className?: string }) {
  const label = row.unread ? "Mark as read" : "Mark as unread";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={`${label} (U)`}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        toggleRead(engine, row);
      }}
    >
      <CircleIcon weight={row.unread ? "fill" : "bold"} />
    </Button>
  );
}

// ── The issue ───────────────────────────────────────────────────────────────────────────────────────────────

/** Over the issue, out of its scroll: what happened and what it asks for stay in view at the comment far down the feed. */
const Strip = observer(function Strip({ row, onLeave, children }: { row: InboxRow; onLeave: (act: () => void) => void; children: ReactNode }) {
  const { issue, latest } = row;
  const now = useNow();
  const actor = userName(store, latest.by);
  const actions = inboxActions(row, store.statesOf(issue.projectId), store.me?.id ?? "");
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-[9px] gap-y-2 border-b bg-ground py-2 pr-3 pl-5 max-md:px-4">
      <UserAvatar {...faceIn(store, latest.by)} className="size-[22px]" />
      <span className="min-w-0 flex-1 text-[13px] text-ink-2">
        <span className="font-semibold text-ink">{actor}</span> {reason(latest, (id) => store.states.get(id)?.name)}
      </span>
      <time dateTime={latest.at} title={exactTime(latest.at)} className="font-mono text-[11px] text-ink-3">
        {clockOrDate(latest.at, now)}
      </time>
      <span className="flex items-center gap-2 empty:hidden max-md:basis-full">
        {children}
        {actions.map((a) => {
          const target = store.states.get(a.stateId);
          return (
            <Button key={a.stateId} variant={a.primary ? "default" : "outline"} className="max-md:h-11 max-md:flex-1" onClick={() => onLeave(() => moveTo(store, issue, a))}>
              {target && <StateGlyph state={target} className={cn("size-3.5", a.primary && "text-primary-foreground")} />}
              {a.label}
              {a.primary && <Kbd inverse>{keys("mod", "↵")}</Kbd>}
            </Button>
          );
        })}
      </span>
    </div>
  );
});

const IssuePane = observer(function IssuePane({
  ws,
  row,
  readBefore,
  onClose,
  onLeave,
}: {
  ws: string;
  row: InboxRow;
  /** The log number the viewer had read the issue's notifications up to when the row was opened. */
  readBefore: number;
  onClose: () => void;
  onLeave: (act: () => void) => void;
}) {
  const { issue } = row;
  const project = store.projects.get(issue.projectId);
  const phone = useIsPhone();
  // New is what came since the viewer last read the row (RSVA-575): those comments carry a bar, and the feed opens at
  // the first of them, read top down, with no light. A row read before has none: the feed goes to its last comment and
  // lights it for a moment, as a link to a comment does, since nothing else tells which one the row was about (an agent
  // writes what it did, then moves the issue: the comment, not the move). As of the opening: a comment arriving later
  // does not pull the feed away.
  const [{ focus, fresh }] = useState(() => {
    const comments = row.events.filter((e) => e.commentId);
    const unread = comments.filter((e) => e.id > readBefore);
    const to = unread[0] ?? comments.at(-1);
    return {
      focus: to?.commentId ? { comment: to.commentId, at: to.at, quiet: unread.length > 0 } : null,
      fresh: new Set(unread.map((e) => e.commentId!)),
    };
  });
  if (!project) return null;
  const actions = <InboxActions engine={store} row={row} onLeave={onLeave} />;
  return (
    <IssueDetail
      ws={ws}
      project={project}
      issue={issue}
      inList
      onClose={onClose}
      notification={{
        strip: (
          <Strip row={row} onLeave={onLeave}>
            {phone && actions}
          </Strip>
        ),
        actions: !phone && (
          <>
            {actions}
            <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-center" />
          </>
        ),
        focus,
        highlight: fresh,
      }}
    />
  );
});
