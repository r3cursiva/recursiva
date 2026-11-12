// My work (PLNR-41), after the "My work · A — Stacked queue (keyboard-first)" artboard: the viewer's issues from every
// workspace in five stacked groups, the selected row's actions on letter keys, each applied at once with Undo in the
// toast (⌘Z). Its own navigation (scopes) and header take the place of the sidebar and the top bar, as in the inbox.
//
// The groups are lib/my-work.ts. Every workspace's engine is held open while the screen is (store.ts, holdEngines): a
// warm one starts from IndexedDB with no request, edits go through the issue's own engine and socket.
//
// The selected issue docks beside the list as a pane of its own (the FramedMyWork artboard): ↵ or a double click docks
// it, J/K walk the docked issue with the list (the pane has no arrows of its own: they would walk the project's list),
// Esc takes it away, ↵ again opens its page. Only an issue of the workspace on screen docks, and only where the list
// keeps its width (the `dock` width); elsewhere ↵ opens the page.
//
// A project's proposals fold into one row of Waiting on you (RSVA-563, lib/my-work-projects.ts).
//
// One page: the queue, this list, where the work is done. It had a Home, a picture of the whole work (RSVA-568), and a
// board with swimlanes; Home went with the Triage split (owner 2026-11-11: it answered how the projects are, not what to
// do), and the board earlier (owner 2026-11-10): its columns were stages of different projects' workflows, a card moved along two of its four axes only, and the queue is worked by keys. The queue, with swimlanes; it went (owner 2026-11-10): its columns were stages of
// different projects' workflows, a card moved along two of its four axes only, and the queue is worked by keys.
//
// Not from the artboard yet: @mentions as "asked you" (PLNR-27), the Shortcuts page, leave and enter animations of rows.
// On a phone: the MyWorkPhone artboard.
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  FunnelSimpleIcon,
  HourglassMediumIcon,
  PlayIcon,
  RowsIcon,
  StackIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { SyncStore } from "@rsva/sync";
import { Button } from "@rsva/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
} from "@rsva/ui/components/collapsible";
import { LabelTags } from "@rsva/ui/components/color-chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@rsva/ui/components/dropdown-menu";
import { Input } from "@rsva/ui/components/input";
import { Kbd } from "@rsva/ui/components/kbd";
import { Label } from "@rsva/ui/components/label";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { Spinner } from "@rsva/ui/components/spinner";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { ToggleGroup, ToggleGroupItem } from "@rsva/ui/components/toggle-group";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { computed, when } from "mobx";
import { observer } from "mobx-react-lite";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { localToday } from "@rsva/query";
import {
  actionsFor,
  age,
  applyAction,
  asksViewer,
  forTriage,
  collect,
  dueText,
  GROUPS,
  inScope,
  isIdle,
  proposedLabels,
  sortGroup,
  toTriage,
  type GroupId,
  type Scope,
  type WorkAction,
  type WorkItem,
} from "../lib/my-work.ts";
import { isPhone, useMatches } from "../lib/phone.ts";
import { IssueDetail } from "./issue-detail.tsx";
import { exactTime, useNow } from "../lib/time.ts";
import { typing } from "../lib/typing.ts";
import { myWorkView } from "../my-work-view.ts";
import { account } from "../account.ts";
import {
  groupSections,
  toggleFolded,
} from "../lib/my-work-sections.ts";
import { sectionTitle, type MyWorkSection } from "@rsva/protocol/my-work";
import {
  describe,
  LaneMark,
  Ref,
  SectionHead,
  stageOf,
  type Workspace,
} from "./my-work-parts.tsx";
import {
  entryId,
  foldProposals,
  isBundle,
  type Bundle,
  type Entry,
} from "../lib/my-work-projects.ts";
import {
  GROUP_BY_NAMES,
  GROUP_BYS,
  regroup,
  type Lane,
  type MyWorkGroupBy,
} from "../lib/my-work-groups.ts";
import { paths, router } from "../router.ts";
import { plural } from "@rsva/schema/util";
import { store } from "../store.ts";
import { useEngines, useWorkspaceList } from "../held-engines.ts";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { Actor } from "./actor.tsx";
import { neighbour, stepIn, stepKey } from "../lib/step-keys.ts";
import { useWindowKeys } from "./list-keys.ts";
import { notice } from "./notice.ts";
import { workspaceTileTone } from "./workspace-switcher.tsx";
import { Link } from "../link.tsx";
import { RowHoverActions } from "./row-hover-actions.tsx";
import { reviewFrom } from "./review-queue.ts";

const rowId = (x: WorkItem) => `${x.ws}/${x.issue.id}`;
/** A section, or a lane of another grouping, as the list draws it. */
type Block = {
  sec: MyWorkSection;
  rows: WorkItem[];
  lane?: Lane;
};

const dateLine = new Intl.DateTimeFormat("en", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

// ── Screen ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Triage's sections (owner 2026-11-11): what is not the viewer's own but waits on a decision of theirs. The reviews of what
 * agents made come first and open; the proposals follow, one section per project, folded, so that a project's pile is a
 * section of its own and not a row that unfolds inside one. They are not among the saved sections: their folds are this page's.
 */
const triageSection = (id: string, title: string, folded: boolean): MyWorkSection => ({ id, kind: "wait", title, folded });

/** My work (assigned to the viewer), or with `triage` the other screen over the same rows: what waits on them but is not theirs. */
export const MyWork = observer(function MyWork({ ws, triage = false }: { ws: string; triage?: boolean }) {
  const list = useWorkspaceList(ws);
  const engines = useEngines(ws, list.map((w) => w.slug).join(","));
  const now = useNow();
  const today = localToday();
  // One computed per workspace: an edit in one re-reads only its issues, a selection change none.
  const sources = useMemo(
    () =>
      [...engines].map(([slug, e]) =>
        computed(() => {
          const items = collect(slug, e, now, { others: triage });
          return triage ? items.filter((x) => forTriage(x, e.me?.id)) : items;
        }),
      ),
    [engines, now, triage],
  );
  const all = sources.flatMap((c) => c.get());
  const view = myWorkView;
  // A saved scope of a workspace the viewer has left shows everything.
  const scope =
    view.scope === "all" ||
    list.some(
      (w) =>
        view.scope === `ws:${w.slug}` || view.scope.startsWith(`p:${w.slug}/`),
    )
      ? view.scope
      : "all";
  const shown = all.filter((x) => inScope(scope, x));
  const lists = Object.fromEntries(
    GROUPS.map((g) => [
      g.id,
      sortGroup(
        g.id,
        shown.filter((x) => x.group === g.id),
        now,
      ),
    ]),
  ) as Record<GroupId, WorkItem[]>;
  const failed = (e: unknown) =>
    notice.show(
      `My work's folds were not saved: ${e instanceof Error ? e.message : String(e)}`,
    );
  const [triageFolds, setTriageFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const triageSections: MyWorkSection[] = [];
  const triageRows = new Map<string, WorkItem[]>();
  if (triage) {
    const byProject = new Map<string, WorkItem[]>();
    for (const x of lists.wait) {
      const id = x.ask === "review" ? "reviews" : `${x.ws}/${x.issue.projectId}`;
      byProject.set(id, [...(byProject.get(id) ?? []), x]);
    }
    const titleOf = (id: string, rows: WorkItem[]) => {
      if (id === "reviews") return "Agents’ work to review";
      const x = rows[0]!;
      const project = engines.get(x.ws)?.projects.get(x.issue.projectId);
      return `${project?.key ?? ""} ${project?.name ?? ""}`.trim() || "Project";
    };
    const ids = [...byProject.keys()].sort((a, b) => (a === "reviews" ? -1 : b === "reviews" ? 1 : byProject.get(b)!.length - byProject.get(a)!.length));
    for (const id of ids) {
      const rows = byProject.get(id)!;
      triageRows.set(id, rows);
      triageSections.push(triageSection(id, titleOf(id, rows), triageFolds.get(id) ?? id !== "reviews"));
    }
  }
  const blocks: Block[] = (triage ? triageSections : groupSections()).map((sec) => {
    const items = triage ? (triageRows.get(sec.id) ?? []) : sec.kind === "lane" ? [] : lists[sec.kind];
    return { sec, rows: items.filter((x) => inScope(scope, x)) };
  });
  // Grouped by status, priority or project (lib/my-work-groups.ts): the same issues laid out in lanes, each row keeping
  // the name of the section it came from; a lane's fold is this page's, an empty one starts folded.
  const [laneFolds, setLaneFolds] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const groupBy = triage ? "section" : view.groupBy;
  const sectionOf = new Map<string, string>();
  const lanes =
    groupBy === "section"
      ? null
      : regroup(
          groupBy,
          blocks.flatMap(
            (b) => (
              b.rows.forEach((x) =>
                sectionOf.set(rowId(x), sectionTitle(b.sec)),
              ),
              b.rows
            ),
          ),
          (x) => engines.get(x.ws)!,
          (slug) => list.find((w) => w.slug === slug)?.name ?? slug,
          list.length > 1,
        );
  const shownBlocks: Block[] = lanes
    ? lanes.map((l) => ({
        sec: {
          id: l.id,
          kind: "lane",
          title: l.name,
          folded: laneFolds.get(l.id) ?? !l.rows.length,
        },
        rows: l.rows,
        lane: l,
      }))
    : blocks;
  // What J and K walk: the rows of the unfolded sections (or lanes).
  const columns = shownBlocks.filter((b) => !b.sec.folded);
  // In the list a project's proposals in Waiting on you are one row (RSVA-563), unless the list is of one project or laid
  // out another way than by section.
  const [piles, setPiles] = useState<ReadonlySet<string>>(() => new Set());
  const folds = !lanes && !scope.startsWith("p:") && !triage;
  const entries = new Map(
    shownBlocks.map((b) => {
      const all: Entry[] =
        folds && b.sec.kind === "wait" ? foldProposals(b.rows, piles) : b.rows;
      return [b.sec.id, all];
    }),
  );
  const flat: Entry[] = columns.flatMap((c) => entries.get(c.sec.id)!);
  const fold = (id: string, value?: boolean) => {
    const lane = shownBlocks.find((b) => b.sec.id === id && b.lane);
    if (lane)
      setLaneFolds((m) => new Map(m).set(id, value ?? !lane.sec.folded));
    else if (triage) {
      const now = shownBlocks.find((b) => b.sec.id === id)?.sec.folded ?? false;
      setTriageFolds((m) => new Map(m).set(id, value ?? !now));
    }
    else toggleFolded(id, failed, value);
  };
  useEffect(() => void account.refresh(), []);

  const [selId, setSelId] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = flat.find((x) => entryId(x) === selId) ?? flat[0] ?? null;
  /** The selected issue; null on a row of folded proposals. */
  const item = selected && !isBundle(selected) ? selected : null;
  const pile = selected && isBundle(selected) ? selected : null;
  const togglePile = (b: Bundle, open = !b.open) => {
    setSelId(b.id);
    setPiles((s) => {
      const next = new Set(s);
      if (open) next.add(b.id);
      else next.delete(b.id);
      return next;
    });
  };
  useEffect(() => listRef.current?.focus({ preventScroll: true }), []);

  const engineOf = (x: WorkItem) => engines.get(x.ws)!;
  const select = (x: Entry) => {
    setSelId(entryId(x));
    document
      .getElementById(`mw-${entryId(x)}`)
      ?.scrollIntoView({ block: "nearest" });
  };
  /** Keeps a selection when the row leaves its group: the next row, else the one before. */
  const leave = (x: WorkItem) => {
    const next = neighbour(flat, x);
    setSelId(next ? entryId(next) : null);
    setReplyFor(null);
  };
  const run = (x: WorkItem, a: WorkAction) => {
    if (a.id === "review") return open(x);
    if (a.id === "reply") {
      setSelId(rowId(x));
      setReplyFor(rowId(x));
      return;
    }
    leave(x);
    if (a.id === "later") {
      // Put aside: the assignment is read, and the issue stays in Later.
      engineOf(x).inbox.read([x.issue.id]);
      notice.show(`${engineOf(x).issueKey(x.issue)} put in Later`);
      return;
    }
    const { text, undo } = applyAction(engineOf(x), x, a);
    notice.show(text, undo);
  };
  const actionsOf = (x: WorkItem) => {
    const e = engineOf(x);
    return actionsFor(
      x,
      e.statesOf(x.issue.projectId),
      e.me?.id ?? "",
      proposedLabels(e),
    );
  };
  const [docked, setDocked] = useState(false);
  const wide = useMatches(DOCK);
  // A review opens in the queue of the workspace's reviews (RSVA-597): its bar decides, then the next one opens.
  const page = (x: WorkItem) =>
    router.push(paths.browse(x.ws, engineOf(x).issueKey(x.issue)), x.ask === "review" ? reviewFrom() : null);
  const dockable = (x: WorkItem) => x.ws === ws && wide;
  /** Docks the issue where it fits, else opens its page; ↵ on the issue already docked opens its page, a double click does not. */
  const open = (x: WorkItem, byKey = false) => {
    // A new assignment is seen once it is opened: its inbox line is read, so the row stops saying so (RSVA-612).
    if (x.fresh) engineOf(x).inbox.read([x.issue.id]);
    setSelId(rowId(x));
    if (dockable(x) && !(byKey && docked)) setDocked(true);
    else page(x);
  };
  // The docked issue is the selected one, as the store of this workspace holds it.
  const dockIssue =
    docked && item && dockable(item)
      ? store.issues.get(item.issue.id)
      : undefined;
  const dockProject = dockIssue && store.projects.get(dockIssue.projectId);
  /** Brings the group's header to the top and blinks it, so that even an empty group answers; keys go to the list. */
  const jump = (g: string) => {
    fold(g, false);
    const first = entries.get(g)?.[0];
    if (first) select(first);
    const section = document.getElementById(`mw-group-${g}`);
    section?.scrollIntoView({ block: "start" });
    section?.querySelector("[data-group-head]")?.animate(
      [
        {
          backgroundColor:
            "color-mix(in oklab, var(--color-signal) 22%, var(--color-sidebar))",
        },
        {},
      ],
      {
        duration: 900,
        easing: "ease-out",
      },
    );
    listRef.current?.focus({ preventScroll: true });
  };

  // On the window, not the list: a click on the header or the summary takes the focus out of the list.
  useWindowKeys((e) => {
    if (
      e.defaultPrevented ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      typing(e.target)
    )
      return;
    const k = e.key;
    if (k === "Enter" && (e.target as Element).closest("a, button")) return;
    const by = stepKey(k);
    if (by) {
      const next = stepIn(flat, selected ? flat.indexOf(selected) : -1, by);
      if (next) select(next);
    } else if (
      pile &&
      (k === "Enter" ||
        k === "l" ||
        k === "ArrowRight" ||
        k === "h" ||
        k === "ArrowLeft")
    )
      togglePile(
        pile,
        k === "Enter" ? !pile.open : k === "l" || k === "ArrowRight",
      );
    else if (k === "Enter" && item) open(item, true);
    else if (k === "D") toggleFolded("done", failed);
    else if (k === "f") setScopeOpen(true);
    else if (k === "0") view.setScope("all");
    else if (k >= "1" && k <= "9" && shownBlocks[Number(k) - 1])
      jump(shownBlocks[Number(k) - 1]!.sec.id);
    else if (k === "Escape") {
      if (replyFor) setReplyFor(null);
      else setDocked(false);
    } else {
      const hit =
        item && actionsOf(item).find((a) => a.key.toLowerCase() === k);
      if (!hit) return;
      run(item, hit);
    }
    e.preventDefault();
  });

  const active = all.filter((x) => x.group !== "done");
  const counts = (s: Scope) => active.filter((x) => inScope(s, x)).length;
  const loading = [...engines.values()].some((e) => e.status === "loading");
  const nextUp = lists.next[0];
  // Reviews, mentions and replies apart from proposals: the first are today's, the second a pile (RSVA-563).
  const asks = lists.wait.filter(asksViewer).length;
  const proposals = lists.wait.length - asks;
  const proposalProjects = new Set(
    lists.wait.filter(toTriage).map((x) => `${x.ws}/${x.issue.projectId}`),
  ).size;
  const noteOf = (sec: MyWorkSection, rows: readonly WorkItem[]) =>
    sec.kind === "agents"
      ? idleNote(rows, now)
      : sec.kind === "doing" || sec.kind === "next" || sec.kind === "later"
        ? overdueNote(rows, today)
        : "";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-(--pane-gap) max-md:gap-0">
      <main
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col bg-ground",
          dockIssue && "pane",
        )}
      >
        <header className="flex h-(--topbar) shrink-0 items-center gap-2.5 border-b bg-panel pr-4 pl-6 max-md:h-auto max-md:border-b-0 max-md:pt-2.5 max-md:pr-1 max-md:pb-0.5 max-md:pl-4">
          <h1 className="text-sm font-semibold max-md:text-[24px] max-md:tracking-[-0.02em]">
            {triage ? "Triage" : "My work"}
          </h1>
          <span className="contents max-md:hidden">
            <ScopeMenu
              ws={ws}
              list={list}
              engines={engines}
              items={active}
              counts={counts}
              scope={scope}
              open={scopeOpen}
              onOpenChange={setScopeOpen}
            />
            {scope !== "all" && (
              <Button
                variant="ghost"
                onClick={() => view.setScope("all")}
                aria-label="Show all workspaces"
              >
                <XIcon />
                All workspaces
              </Button>
            )}
          </span>
          <span className="flex-1" />
          {!triage && <GroupMenu by={groupBy} />}
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-x-[22px] gap-y-1 border-b px-6 py-[9px] max-md:gap-x-3.5 max-md:gap-y-0 max-md:border-b-0 max-md:bg-panel max-md:px-4 max-md:pt-0 max-md:pb-2">
          {triage ? (
            <>
              <span className="font-mono text-meta text-ink-3 max-md:hidden">{dateLine.format(now)}</span>
              <Summary onClick={() => jump("wait")} bold>
                {lists.wait.length ? `${plural(lists.wait.length, "issue")} to triage` : "Nothing to triage"}
              </Summary>
              {loading && <Spinner className="size-3.5 text-ink-3" />}
            </>
          ) : (
          <>
          <span className="font-mono text-meta text-ink-3 max-md:hidden">
            {dateLine.format(now)}
          </span>
          <Summary onClick={() => jump("wait")} bold>
            {asks
              ? `${asks} waiting on you`
              : proposals
                ? "Nothing to review or answer"
                : "Nothing waits on you"}
          </Summary>
          {proposals > 0 && (
            <Summary onClick={() => jump("wait")}>
              {proposals} to triage in {plural(proposalProjects, "project")}
            </Summary>
          )}
          <Summary onClick={() => jump("doing")}>
            {lists.doing.length} in progress
          </Summary>
          <Summary
            onClick={() => jump("agents")}
            note={idleNote(lists.agents, now, ", ")}
          >
            {lists.agents.length} with agents
          </Summary>
          <Summary
            onClick={() => jump("next")}
            note={overdueNote([...lists.doing, ...lists.next, ...lists.later], today, ", ")}
          >
            {lists.next.length} up next
          </Summary>
          {lists.later.length > 0 && (
            <Summary onClick={() => jump("later")}>
              {lists.later.length} later
            </Summary>
          )}
          {loading && <Spinner className="size-3.5 text-ink-3" />}
          </>
          )}
        </div>
        <ScopeChips
          ws={ws}
          list={list}
          engines={engines}
          items={active}
          counts={counts}
          scope={scope}
        />
        {(
          // No ring on the list: its selected row marks the place, as WAI-ARIA asks of aria-activedescendant (PLNR-245).
          <div className="@container/mw min-h-0 flex-1 overflow-y-auto pb-6">
            <div
              ref={listRef}
              role="listbox"
              data-page-list
              data-roving="list"
              aria-label={`${triage ? "Triage" : "My work"}, j and k to move`}
              aria-activedescendant={
                selected ? `mw-${entryId(selected)}` : undefined
              }
              tabIndex={0}
              className="outline-none"
            >
              {shownBlocks.map(({ sec, rows, lane }, i) => {
                const shownRows = entries.get(sec.id)!;
                const inPile = new Set(
                  shownRows
                    .filter(isBundle)
                    .flatMap((b) => (b.open ? b.items : [])),
                );
                const g = GROUPS.find((x) => x.id === sec.kind);
                const folded = sec.folded;
                const name = sectionTitle(sec);
                const note = noteOf(sec, rows);
                return (
                  <Collapsible
                    key={sec.id}
                    open={!folded}
                    onOpenChange={() => fold(sec.id)}
                    render={
                      <section
                        id={`mw-group-${sec.id}`}
                        role="group"
                        aria-label={name}
                        className="list-group"
                      />
                    }
                  >
                    <SectionHead
                      folded={folded}
                      mark={lane && <LaneMark lane={lane} />}
                      name={name}
                      count={
                        sec.kind === "wait" && !triage
                          ? rows.filter(asksViewer).length
                          : rows.length
                      }
                      right={`${g?.keys ?? ""}   ${i < 9 ? `${i + 1} jump` : ""}`}
                    >
                      {/* The section's count is what asks the viewer; the proposals in it are named beside it. */}
                      {sec.kind === "wait" && !triage && rows.some(toTriage) && (
                        <span className="font-mono text-meta text-ink-3">
                          {rows.filter(toTriage).length} to triage
                        </span>
                      )}
                      <span className="text-xs text-signal-text">{note}</span>
                    </SectionHead>
                    {/* The rows' props are worked out here, so a folded group is spared them, not only their render. */}
                    <CollapsibleContent>
                      {!folded &&
                        shownRows.map((x) =>
                          isBundle(x) ? (
                            <PileRow
                              key={x.id}
                              pile={x}
                              engine={engineOf(x.items[0]!)}
                              workspace={list.find((w) => w.slug === x.ws)!}
                              current={x.ws === ws}
                              many={list.length > 1}
                              selected={x === selected}
                              now={now}
                              onSelect={() => setSelId(x.id)}
                              onToggle={() => togglePile(x)}
                            />
                          ) : (
                            <Row
                              key={rowId(x)}
                              item={x}
                              nested={inPile.has(x)}
                              engine={engineOf(x)}
                              workspace={list.find((w) => w.slug === x.ws)!}
                              current={x.ws === ws}
                              selected={x === selected}
                              replying={replyFor === rowId(x)}
                              now={now}
                              today={today}
                              actions={actionsOf(x)}
                              label={
                                lanes ? (sectionOf.get(rowId(x)) ?? null) : null
                              }
                              onSelect={() => setSelId(rowId(x))}
                              onRun={(a) => run(x, a)}
                              onOpen={() => open(x)}
                              onReplied={() => {
                                leave(x);
                                listRef.current?.focus({ preventScroll: true });
                              }}
                              onCancelReply={() => {
                                setReplyFor(null);
                                listRef.current?.focus({ preventScroll: true });
                              }}
                            />
                          ),
                        )}
                      {!folded &&
                        sec.kind === "wait" &&
                        rows.length === 0 &&
                        !loading && (
                          <div className="flex min-h-11 flex-wrap items-center gap-2.5 border-b border-rule-soft px-[18px] py-2 text-ink-2">
                            <CheckCircleIcon
                              weight="fill"
                              className="size-4 text-status-done"
                            />
                            <span className="font-medium text-ink">
                              Nothing waits for you.
                            </span>
                            <span>
                              Your reviews and new assignments land here.
                            </span>
                            {nextUp && (
                              <span className="flex items-center gap-2 text-ink-3">
                                Next up
                                <Ref
                                  item={nextUp}
                                  engine={engineOf(nextUp)}
                                  workspace={list.find(
                                    (w) => w.slug === nextUp.ws,
                                  )!}
                                  current={nextUp.ws === ws}
                                />
                                <span className="text-ink">
                                  {nextUp.issue.title}
                                </span>
                                <span className="font-mono text-meta">
                                  {dueText(nextUp.issue.dueDate, today)?.text}
                                </span>
                                {actionsOf(nextUp).map((a) => (
                                  <Button
                                    key={a.id}
                                    variant="outline"
                                    size="sm"
                                    onClick={() => run(nextUp, a)}
                                  >
                                    {a.label}
                                    <Kbd>{a.key}</Kbd>
                                  </Button>
                                ))}
                              </span>
                            )}
                          </div>
                        )}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </div>
        )}
        <footer className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t bg-panel px-6 py-2 font-mono text-[10.5px] text-ink-3 pointer-coarse:hidden max-md:hidden">
          {(triage
            ? ["J K move", "↵ open", "A accept", "D decline", "1–9 jump", "F scope", "0 all workspaces", `${keys("mod", "Z")} undo`]
            : [
                "J K move",
                "↵ open",
                "A accept",
                "D decline",
                "R reply",
                "S start",
                "T todo",
                "L later",
                "1–9 jump",
                "F scope",
                "0 all workspaces",
                `${keys("shift", "D")} done`,
                `${keys("mod", "Z")} undo`,
              ]
          ).map((k) => (
            <span key={k}>{k}</span>
          ))}
        </footer>
      </main>
      {dockIssue && dockProject && (
        <div
          data-region
          className="pane flex w-[400px] shrink-0 flex-col max-md:hidden"
        >
          <IssueDetail
            key={dockIssue.id}
            ws={ws}
            project={dockProject}
            issue={dockIssue}
            inList
            onClose={() => {
              setDocked(false);
              listRef.current?.focus({ preventScroll: true });
            }}
          />
        </div>
      )}
    </div>
  );
});

/** Wide enough for the docked issue beside the list (the `dock` variant, globals.css). */
const DOCK = matchMedia("(width >= 80rem)");

function idleNote(rows: readonly WorkItem[], now: number, prefix = ""): string {
  const idle = rows.filter((x) => isIdle(x, now));
  if (!idle.length) return "";
  const oldest = Math.max(...idle.map((x) => now - Date.parse(x.since)));
  return `${prefix}${idle.length} idle ${age(oldest)}`;
}

function overdueNote(
  rows: readonly WorkItem[],
  today: string,
  prefix = "",
): string {
  const n = rows.filter(
    (x) => x.issue.dueDate && x.issue.dueDate < today,
  ).length;
  return n ? `${prefix}${n} overdue` : "";
}

function Summary({
  onClick,
  bold,
  note,
  children,
}: {
  onClick: () => void;
  bold?: boolean;
  note?: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="-mx-1.5 h-[26px] rounded-[5px] border-0 px-1.5 text-[13px] font-normal max-md:h-[30px] max-md:rounded-[5px] max-md:px-1.5 max-md:text-[13px] transition-none active:scale-100!"
    >
      <span>
        <span className={cn("text-ink", bold && "font-semibold")}>
          {children}
        </span>
        {note && <span className="text-signal-text">{note}</span>}
      </span>
    </Button>
  );
}

/** How the queue's rows are grouped: the viewer's sections, or lanes of status, priority or project (lib/my-work-groups.ts). */
const GroupMenu = observer(function GroupMenu({ by }: { by: MyWorkGroupBy }) {
  const name = (g: MyWorkGroupBy) =>
    g === "section" ? "Sections" : GROUP_BY_NAMES[g];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="font-normal max-md:hidden"
            aria-label={`Group by: ${name(by)}`}
          >
            <RowsIcon />
            Group by
            <CaretDownIcon className="size-3" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuGroup>
          <DropdownMenuRadioGroup
            value={by}
            onValueChange={(v) => myWorkView.setGroupBy(v as MyWorkGroupBy)}
          >
            {GROUP_BYS.map((g) => (
              <DropdownMenuRadioItem key={g} value={g}>
                {g === "section" ? "Sections (yours)" : name(g)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

// ── Scopes: the navigation on the left and the F menu ───────────────────────────────────────────────────────

interface ScopeOption {
  scope: Scope;
  label: string;
  /** A workspace's tile; projects are indented keys in mono. */
  workspace?: Workspace;
  all?: boolean;
  count: number;
}

/** All workspaces, then each workspace with the projects it has open work in, by key. */
function scopeOptions(
  list: readonly Workspace[],
  engines: Map<string, SyncStore>,
  items: readonly WorkItem[],
  counts: (s: Scope) => number,
): ScopeOption[] {
  const out: ScopeOption[] = [
    { scope: "all", label: "All workspaces", all: true, count: counts("all") },
  ];
  for (const w of list) {
    out.push({
      scope: `ws:${w.slug}`,
      label: w.name,
      workspace: w,
      count: counts(`ws:${w.slug}`),
    });
    const e = engines.get(w.slug);
    const projects = new Set(
      items.filter((x) => x.ws === w.slug).map((x) => x.issue.projectId),
    );
    const keyed = [...projects]
      .map((id) => ({ id, key: e?.projects.get(id)?.key ?? "?" }))
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const p of keyed)
      out.push({
        scope: `p:${w.slug}/${p.id}`,
        label: p.key,
        count: counts(`p:${w.slug}/${p.id}`),
      });
  }
  return out;
}

function ScopeLabel({ o, current }: { o: ScopeOption; current: boolean }) {
  return (
    <>
      {o.all ? (
        <UsersThreeIcon className="size-[15px]" />
      ) : o.workspace ? (
        <LetterTile
          name={o.workspace.name}
          tone={workspaceTileTone(o.workspace, current)}
        />
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          !o.all && !o.workspace && "font-mono text-[11.5px]",
        )}
      >
        {o.label}
      </span>
      <span className="font-mono text-meta font-normal text-ink-3">
        {o.count}
      </span>
    </>
  );
}

/** A phone's scope, from the MyWorkPhone artboard: every workspace in one tap. Its projects stay on the wider screens. */
function ScopeChips({
  ws,
  list,
  engines,
  items,
  counts,
  scope,
}: Omit<ComponentProps<typeof ScopeMenu>, "open" | "onOpenChange">) {
  if (list.length < 2) return null;
  const chips = scopeOptions(list, engines, items, counts).filter(
    (o) => o.all || o.workspace,
  );
  return (
    <ToggleGroup
      aria-label="Workspace"
      value={[scope]}
      className="no-scrollbar w-auto shrink-0 gap-2 overflow-x-auto rounded-none bg-panel px-4 pt-0.5 pb-3 md:hidden"
    >
      {chips.map((o) => (
        <ToggleGroupItem
          key={o.scope}
          value={o.scope}
          onClick={() => myWorkView.setScope(o.scope)}
          className="h-9 min-w-0 gap-[7px] rounded-full border border-control-border px-3 text-[13px] font-normal transition-colors duration-150 hover:bg-transparent hover:text-inherit focus-visible:border-control-border focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-inverse aria-pressed:bg-inverse aria-pressed:text-inverse-ink"
        >
          {o.workspace && (
            <LetterTile
              name={o.workspace.name}
              tone={workspaceTileTone(o.workspace, o.workspace.slug === ws)}
              className="size-[13px] text-[8px]"
            />
          )}
          {o.all ? "All" : o.label}
          <span className="font-mono text-[11px] opacity-70">{o.count}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function ScopeMenu({
  ws,
  list,
  engines,
  items,
  counts,
  scope,
  open,
  onOpenChange,
}: {
  ws: string;
  list: readonly Workspace[];
  engines: Map<string, SyncStore>;
  items: readonly WorkItem[];
  counts: (s: Scope) => number;
  scope: Scope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const options = scopeOptions(list, engines, items, counts);
  const current = options.find((o) => o.scope === scope) ?? options[0]!;
  const label =
    current.workspace || current.all
      ? current.label
      : `${list.find((w) => scope.startsWith(`p:${w.slug}/`))?.name} / ${current.label}`;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="pr-1.5 pl-2.5 font-normal"
            aria-label={`Limit My work to: ${label}`}
          >
            <FunnelSimpleIcon />
            {label}
            <CaretDownIcon className="size-3" />
            <Kbd>F</Kbd>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-[248px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="pb-1 font-mono text-[10.5px] tracking-[.08em] text-ink-3 uppercase max-md:px-2 max-md:text-[10.5px] max-md:leading-[inherit]">
            Show work from
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={scope}
            onValueChange={(v) => myWorkView.setScope(v as Scope)}
          >
            {options.map((o) => (
              <DropdownMenuRadioItem
                key={o.scope}
                value={o.scope}
                className={cn("gap-2", !o.all && !o.workspace && "pl-8")}
              >
                <ScopeLabel o={o} current={o.workspace?.slug === ws} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────────────

const Row = observer(function Row({
  item: x,
  engine: e,
  workspace,
  current,
  selected,
  replying,
  now,
  today,
  actions,
  label,
  nested = false,
  onSelect,
  onRun,
  onOpen,
  onReplied,
  onCancelReply,
}: {
  item: WorkItem;
  engine: SyncStore;
  workspace: Workspace;
  current: boolean;
  selected: boolean;
  replying: boolean;
  now: number;
  today: string;
  actions: WorkAction[];
  /** Grouped another way than by section: the section the row came from. */
  label: string | null;
  /** One of a project's proposals, unfolded under their row (RSVA-563). */
  nested?: boolean;
  onSelect: () => void;
  onRun: (a: WorkAction) => void;
  onOpen: () => void;
  onReplied: () => void;
  onCancelReply: () => void;
}) {
  const { issue } = x;
  const states = e.statesOf(issue.projectId);
  const state = e.states.get(issue.stateId);
  const stage = state && stageOf(states, state);
  const labels = issue.labelIds
    .map((id) => e.labels.get(id))
    .filter((l) => l !== undefined);
  const d = describe(x, e, now, today);
  const actor = x.group === "wait" || x.group === "agents" || x.fresh ? x.from : null;
  const href = paths.browse(x.ws, e.issueKey(issue));
  const card = x.group === "wait";
  const start = !card ? actions.find((a) => a.id === "start") : undefined;
  return (
    <>
      <div
        className={cn(
          "list-row group/row relative transition-colors duration-120 hover:bg-row-hover",
          nested &&
            "before:absolute before:inset-y-0 before:left-[21px] before:w-px before:bg-rule max-md:before:left-[19px]",
          card
            ? "max-md:bg-panel max-md:active:bg-row-hover"
            : "max-md:bg-ground",
          selected && "bg-row-selected hover:bg-row-selected",
        )}
      >
        {/* A phone's row after the MyWorkPhone artboard: state and title, the key, the time and what it waits for under
            them; a tap opens the issue. The same elements, reordered. */}
        <div
          id={`mw-${x.ws}/${issue.id}`}
          role="option"
          aria-selected={selected}
          onClick={() => (isPhone() ? onOpen() : onSelect())}
          onDoubleClick={onOpen}
          className={cn(
            "flex h-(--row) cursor-default items-center gap-2.5 pr-4 pl-[18px] max-md:h-auto max-md:min-h-[60px] max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-1 max-md:py-2.5 max-md:pl-4",
            start && "max-md:pr-14",
            nested && "pl-[30px] max-md:pl-7",
          )}
        >
          <span
            className={cn(
              "grid shrink-0 max-md:order-3",
              issue.priority === 0 && "max-md:hidden",
            )}
          >
            <PriorityIcon priority={issue.priority} className="size-3.5" />
          </span>
          <span className="w-[98px] shrink-0 max-md:order-2 max-md:ml-[24px] max-md:w-auto">
            <Ref item={x} engine={e} workspace={workspace} current={current} />
          </span>
          {state && (
            <StateIcon
              group={state.group}
              {...(stage ? { stage } : {})}
              className="size-3.5 shrink-0 max-md:mt-0.5 max-md:self-start"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-ink max-md:order-1 max-md:line-clamp-2 max-md:basis-[calc(100%-24px)] max-md:text-[15px]/[1.35] max-md:font-medium max-md:whitespace-normal">
            {issue.title}
          </span>
          {labels.length > 0 && (
            <span
              title={`Labels: ${labels.map((l) => l.name).join(", ")}`}
              className="flex max-w-56 shrink-0 items-center gap-2 overflow-hidden font-mono text-meta text-ink-3 max-md:hidden md:@max-[640px]/mw:hidden"
            >
              <LabelTags labels={labels} />
            </span>
          )}
          <span
            className={cn(
              "flex w-[300px] min-w-0 shrink-0 items-center gap-[7px] text-xs text-ink-2 md:@max-[1180px]/mw:w-[220px] md:@max-[1000px]/mw:hidden max-md:order-5 max-md:ml-[24px] max-md:w-full max-md:text-[13px]",
              !(actor || d.ctx) && "max-md:hidden",
            )}
          >
            {label && (
              <span className="shrink-0 font-mono text-[10.5px] tracking-[.04em] text-ink-3 uppercase">
                {label}
              </span>
            )}
            {actor && <Actor engine={e} id={actor} />}
            <span
              className={cn("min-w-0 truncate", d.accent && "text-signal-text")}
            >
              {d.ctx}
            </span>
          </span>
          <span
            className={cn(
              "flex w-[92px] shrink-0 items-center justify-end gap-1 font-mono text-meta whitespace-nowrap max-md:order-4 max-md:ml-auto max-md:w-auto",
              d.metaTone === "accent"
                ? "text-signal-text"
                : d.metaTone === "ink"
                  ? "text-ink"
                  : "text-ink-3",
            )}
            title={exactTime(x.since)}
          >
            {d.idle && <HourglassMediumIcon className="size-3" />}
            {d.meta}
          </span>
        </div>
        <RowHoverActions
          shown={selected}
          className={cn(
            "absolute top-1/2 right-3 -translate-y-1/2 items-center gap-1.5 bg-inherit pl-3",
            "max-md:pointer-events-auto max-md:translate-x-0 max-md:opacity-100",
            card
              ? "max-md:static max-md:translate-y-0 max-md:gap-2 max-md:bg-transparent max-md:px-4 max-md:pb-3.5"
              : start
                ? "max-md:right-1 max-md:left-auto max-md:bg-transparent max-md:pl-0"
                : "max-md:hidden",
          )}
        >
          {start && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${start.label} ${e.issueKey(issue)}`}
              className="md:hidden"
              onClick={() => onRun(start)}
            >
              <PlayIcon />
            </Button>
          )}
          {actions.map((a) => (
            <Button
              key={a.id}
              variant={a.primary ? "default" : "outline"}
              size="sm"
              className={cn(
                "max-md:h-11 max-md:flex-1 max-md:rounded-[10px] max-md:text-[14px]",
                start && "max-md:hidden",
              )}
              onClick={() => onRun(a)}
            >
              {a.label}
              <Kbd inverse={a.primary}>{a.key}</Kbd>
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            role="link"
            aria-label={`Open ${e.issueKey(issue)} (Enter)`}
            render={<Link href={href} />}
            nativeButton={false}
            className="rounded-[5px] border-0 text-ink-3 hover:bg-panel max-md:hidden transition-none active:scale-100!"
          >
            <ArrowSquareOutIcon className="size-3.5" />
          </Button>
        </RowHoverActions>
      </div>
      {replying && (
        <ReplyBar
          item={x}
          engine={e}
          onDone={onReplied}
          onCancel={onCancelReply}
        />
      )}
    </>
  );
});

/**
 * A project's proposals as one row (RSVA-563): the project, how many, who proposed most of them, the oldest's wait. ↵, →
 * or a click on Triage unfolds them under it, where A and D take them one by one; ←, ↵ again or Fold folds them.
 */
const PileRow = observer(function PileRow({
  pile,
  engine: e,
  workspace,
  current,
  many,
  selected,
  now,
  onSelect,
  onToggle,
}: {
  pile: Bundle;
  engine: SyncStore;
  workspace: Workspace;
  current: boolean;
  many: boolean;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const project = e.projects.get(pile.projectId);
  const since = now - Date.parse(pile.oldest);
  // Who proposed most of them, and how many others did.
  const by = new Map<string, number>();
  for (const x of pile.items)
    if (x.from) by.set(x.from, (by.get(x.from) ?? 0) + 1);
  const top = [...by].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (
    <div
      className={cn(
        "list-row group/row relative transition-colors duration-120 hover:bg-row-hover max-md:bg-panel",
        selected && "bg-row-selected hover:bg-row-selected",
      )}
    >
      <div
        id={`mw-${pile.id}`}
        role="option"
        aria-selected={selected}
        aria-expanded={pile.open}
        onClick={() => (isPhone() ? onToggle() : onSelect())}
        onDoubleClick={onToggle}
        className="flex h-(--row) cursor-default items-center gap-2.5 pr-4 pl-[18px] max-md:h-[52px] max-md:pl-4"
      >
        <CaretRightIcon
          className={cn(
            "size-3.5 shrink-0 text-ink-3 transition-transform duration-200",
            pile.open && "rotate-90",
          )}
        />
        <span
          className="flex w-[98px] shrink-0 items-center gap-1.5 whitespace-nowrap max-md:w-auto"
          title={`${workspace.name} / ${project?.name ?? ""}`}
        >
          {many && (
            <LetterTile
              name={workspace.name}
              tone={workspaceTileTone(workspace, current)}
              className="size-[13px] text-[8px]"
            />
          )}
          {project && (
            <ProjectIcon project={project} className="size-[13px] text-[8px]" />
          )}
          <span className="font-mono text-[11.5px] text-ink-3">
            {project?.key}
          </span>
        </span>
        <StackIcon className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-ink max-md:text-[15px] max-md:font-medium">
          {pile.items.length} proposals to triage
          {project && (
            <span className="ml-2 text-ink-3 max-md:hidden">
              {project.name}
            </span>
          )}
        </span>
        <span className="flex w-[300px] min-w-0 shrink-0 items-center gap-[7px] text-xs text-ink-2 max-md:hidden md:@max-[1180px]/mw:w-[220px] md:@max-[1000px]/mw:hidden">
          {top && <Actor engine={e} id={top} />}
          {by.size > 1 && (
            <span className="text-ink-3">+{plural(by.size - 1, "other")}</span>
          )}
        </span>
        <span
          className={cn(
            "w-[92px] shrink-0 text-right font-mono text-meta whitespace-nowrap max-md:w-auto",
            since >= 86_400_000 ? "text-signal-text" : "text-ink-3",
          )}
          title={exactTime(pile.oldest)}
        >
          oldest {age(since)}
        </span>
      </div>
      <RowHoverActions
        shown={selected}
        className="absolute top-1/2 right-3 -translate-y-1/2 items-center gap-1.5 bg-inherit pl-3 max-md:hidden"
      >
        <Button variant="outline" size="sm" onClick={onToggle}>
          {pile.open ? "Fold" : "Triage"}
          <Kbd>↵</Kbd>
        </Button>
      </RowHoverActions>
    </div>
  );
});

/**
 * Answers the reply in its thread: the comment it answers comes with the issue's feed, which starts loading here.
 * Sending marks the inbox row read, so the row leaves the group.
 */
function ReplyBar({
  item,
  engine: e,
  onDone,
  onCancel,
}: {
  item: WorkItem;
  engine: SyncStore;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const feed = e.feed(item.issue.id);
  const name = (item.from && e.users.get(item.from)?.name) ?? "them";
  const send = () => {
    const body = draft.trim();
    if (!body) return;
    const key = e.issueKey(item.issue);
    void when(() => feed.status !== "loading").then(() => {
      const thread = feed.threads.find(
        (t) =>
          t.comment.id === item.replyTo ||
          t.replies.some((r) => r.id === item.replyTo),
      );
      e.addComment(item.issue.id, body, thread?.comment.id ?? null);
      e.inbox.read([item.issue.id]);
      notice.show(`Replied on ${key}`);
    });
    onDone();
  };
  return (
    <div className="flex h-11 items-center gap-2.5 border-b border-rule-soft bg-panel pr-4 pl-[140px] max-md:h-auto max-md:gap-1.5 max-md:py-2 max-md:pr-2 max-md:pl-4">
      <Label htmlFor="mw-reply" className="sr-only">
        Reply to {name}
      </Label>
      <Input
        id="mw-reply"
        autoFocus
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") (ev.preventDefault(), send());
          else if (ev.key === "Escape") (ev.preventDefault(), onCancel());
          ev.stopPropagation();
        }}
        placeholder={`Reply to ${name}…`}
        className="flex-1 border-control-border bg-input px-2.5 py-0 text-[13px] transition-none placeholder:text-current/50 focus:border-ink-3 focus-visible:border-ink-3 focus-visible:ring-0 md:text-[13px] dark:bg-input max-md:rounded-[22px] max-md:bg-field max-md:px-3.5 max-md:text-base max-md:dark:bg-field"
      />
      <Button size="sm" onClick={send}>
        Send
        <Kbd inverse>↵</Kbd>
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
        <Kbd>esc</Kbd>
      </Button>
    </div>
  );
}
