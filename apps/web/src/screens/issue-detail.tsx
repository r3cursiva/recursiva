// The open issue (PLNR-34), in two places. Beside its list, which narrows to a column: the header walks the list's
// order (N / M, ↑↓, J/K) and ⤢ opens the issue's own page. The page (/:ws/browse/KEY-N, the link to share) keeps
// walking that list when it was opened from it, and ⤡ puts the issue back beside the list. Properties sit in a pane of
// their own on the right when the issue has the page and room for it (the FramedIssue artboard), as chips under the title
// when not or when hidden.
import {
  ArchiveIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretUpIcon,
  DotsThreeIcon,
  ExportIcon,
  GitBranchIcon,
  LinkIcon,
  SidebarSimpleIcon,
  TrashIcon,
  TreeStructureIcon,
  XIcon,
} from "@phosphor-icons/react";
import { pinRef } from "@rsva/protocol";
import { TITLE_MAX, cleanName, isLiveIssue, type Issue, type Project } from "@rsva/schema/models";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from "@rsva/ui/components/breadcrumb";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Kbd, KeyHint } from "@rsva/ui/components/kbd";
import { Skeleton } from "@rsva/ui/components/skeleton";
import { Textarea } from "@rsva/ui/components/textarea";
import { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { readLocal, writeLocal } from "../lib/local-storage.ts";
import { isTouch, useIsPhone } from "../lib/phone.ts";
import { paths, router } from "../router.ts";
import { store } from "../store.ts";
import { shownList } from "./view-panel-state.ts";
import { CopyKeyButton } from "./copy-key-button.tsx";
import { FavoriteButton } from "./favorite-button.tsx";
import { GithubPanel } from "./github-panel.tsx";
import { FeedFailed, IssueActivity, IssueReactions, type FeedFocus } from "./issue-activity.tsx";
import { canRestore, copyBranchHint, copyIssueBranch, copyIssueLink, issueBranch, issuePath, liveParent, restoreIssue } from "./issue-actions.ts";
import { stepSelection, walkOrder } from "./issue-list.tsx";
import { IssueMenuItems } from "./issue-menu.tsx";
import { AssigneesProperty, CycleProperty, DateProperty, DelegateChip, LabelsProperty, ParentProperty, PriorityProperty, PropertyChips, StateProperty } from "./issue-properties.tsx";
import { ignoredKey, listView } from "./list-view.ts";
import { normKey } from "../lib/step-keys.ts";
import { paneKeys, useWindowKeys } from "./list-keys.ts";
import { LATE, useLate } from "./late.ts";
import { ParentCrumb, ProjectLink } from "./project-link.tsx";
import { DescriptionEditor } from "./rich-editors.tsx";
import { IssueBlocks } from "./issue-blocks.tsx";
import { ReviewBar } from "./review.tsx";
import { isReviewFrom, reviewQueue } from "./review-queue.ts";
import { SubscribeButton } from "./subscribe.tsx";
import { useWalkAhead } from "./walk.ts";
import { Link } from "../link.tsx";

/** The issue's own page: the pane on the whole width, Esc back to where it was opened from. */
export const IssuePage = observer(function IssuePage({ ws, project, issue }: { ws: string; project: Project; issue: Issue }) {
  const go = (next: Issue) => router.replace(paths.browse(ws, store.issueKey(next)));
  // Opened with ⤢ from the project's list: J/K walk that list, page to page, without filling the history.
  const listed = router.from === project.key;
  // Opened from a list of reviews: J/K walk the reviews that wait, and a decision opens the next one (RSVA-597).
  const reviews = isReviewFrom(router.from) ? reviewQueue(ws, router.from) : null;
  const at = reviews ? reviews.findIndex((r) => r.id === issue.id) : -1;
  const step = listed
    ? (by: number) => {
        const next = stepSelection(project, by, issue.id);
        if (next) go(next);
      }
    : reviews
      ? (by: number) => {
          const next = reviews[at < 0 ? 0 : at + by];
          if (next) go(next);
        }
      : undefined;
  useWalkAhead(project, listed ? issue.id : null);
  const close = () => {
    listView.setPicker(null);
    router.back(paths.issues(ws, project.key), listed ? paths.listIssue(ws, project.key, store.issueKey(issue)) : null);
  };
  // The queue as it stood before the decision: the next review, else the one before, else back where it was opened.
  const decided = reviews
    ? () => {
        const next = reviews[at + 1] ?? reviews[at - 1];
        if (next && next.id !== issue.id) go(next);
        else close();
      }
    : undefined;
  // Capture, as on the list: a picker's Esc does not also leave the page.
  useWindowKeys((e) => {
    if (!ignoredKey(e) && paneKeys(e, normKey(e), { move: step, leave: close, issue })) e.preventDefault();
  }, true);
  return (
    <div data-region className="flex min-h-0 min-w-0 flex-1 flex-col">
      <IssueDetail
        ws={ws}
        project={project}
        issue={issue}
        onStep={step}
        onClose={close}
        position={reviews && <PositionText at={at} of={reviews.length} title="Position among the reviews waiting on you" />}
        onReviewed={decided}
      />
    </div>
  );
});

/** The description's full 824px and the 300px pane of properties (and the gap between them, --pane-gap): the pane never
 * squeezes the description, it folds. */
const COLUMN_FITS = 824 + 300;

/** The properties pane hidden on this device: its button in the pane's header, put back from the issue's header. */
const PROPS_HIDDEN = "rsva:issue-properties-hidden";

/**
 * Whether the pane is too narrow for that column, null until measured before the first paint, so that neither is mounted
 * only to be replaced. Not a container query: the column and the chips would both be mounted, and every picker, which S,
 * P, A and L open by name, would open twice.
 */
function useNarrowPane(watch: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!watch || !pane) return;
    const measure = () => setNarrow(pane.clientWidth < COLUMN_FITS + (parseFloat(getComputedStyle(pane).columnGap) || 0));
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(pane);
    return () => resized.disconnect();
  }, [watch]);
  return [ref, narrow] as const;
}

/** The height of the bar and the tab bar under it in --docked, so the toast stands above both (toast.tsx). The tab bar is
 *  hidden on the issue's own page and under the keyboard, and either is 0 off a phone. */
function useDocked(bar: HTMLElement | null) {
  useEffect(() => {
    if (!bar) return;
    const root = document.documentElement;
    const tabbar = document.querySelector<HTMLElement>("[data-tabbar]");
    const resized = new ResizeObserver(() => root.style.setProperty("--docked", `${bar.offsetHeight + (tabbar?.offsetHeight ?? 0)}px`));
    resized.observe(bar);
    if (tabbar) resized.observe(tabbar);
    return () => {
      resized.disconnect();
      root.style.removeProperty("--docked");
    };
  }, [bar]);
}

/** What the inbox lays over the pane: the strip stays in view above the scroll, the feed goes to the notification's comment. */
export interface PaneNotification {
  strip: ReactNode;
  /** Beside the header's own buttons; a phone has no room there. */
  actions: ReactNode;
  focus: FeedFocus | null;
  highlight: ReadonlySet<string>;
}

/**
 * The pane; `inList` when it is beside a list, `onStep` when it walks the project's list (N / M, ↑↓; its page then walks the
 * same list), `walked` when it came from another issue.
 */
export const IssueDetail = observer(function IssueDetail({
  ws,
  project,
  issue,
  inList,
  walked,
  onStep,
  onClose,
  notification,
  position,
  onReviewed,
}: {
  ws: string;
  project: Project;
  issue: Issue;
  inList?: boolean;
  walked?: boolean;
  onStep?: ((by: number) => void) | undefined;
  onClose: () => void;
  notification?: PaneNotification;
  /** Where the issue is in what J/K walk, when that is not the project's list. */
  position?: ReactNode;
  /** After Approve or Send back on the review bar. */
  onReviewed?: (() => void) | undefined;
}) {
  const key = store.issueKey(issue);
  const deleted = !!issue.deletedAt;
  const inListHref = paths.listIssue(ws, project.key, key);
  const pageHref = paths.browse(ws, key);
  // On a phone the comment field stays over the keyboard, under the scroll (issue-activity.tsx).
  const [commentBar, setCommentBar] = useState<HTMLElement | null>(null);
  useDocked(commentBar);
  const phone = useIsPhone();
  const [box, narrow] = useNarrowPane(!inList && !phone);
  const [hidden, setHidden] = useState(() => readLocal(PROPS_HIDDEN) === true);
  const hide = (h: boolean) => {
    setHidden(h);
    writeLocal(PROPS_HIDDEN, h);
  };
  // The page with room for them has the properties in a pane of their own; beside its list, in a narrow window or with
  // that pane hidden, they go under the title. A phone has its own line.
  const room = !phone && !inList && narrow === false;
  const pane = room && !hidden;
  const chips = !phone && (inList || narrow === true || (room && hidden));
  const back = notification ? "Inbox" : project.name;
  return (
    // The pane takes the focus itself (not by Tab) where Esc leaves a field in it, so the next Esc steps out of it (PLNR-304).
    <article
      ref={box}
      aria-label={`${key} ${issue.title}`}
      data-pane
      tabIndex={-1}
      data-walked={walked || undefined}
      className="flex min-h-0 min-w-0 flex-1 gap-(--pane-gap) outline-none max-md:flex-col max-md:bg-ground"
    >
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", pane && "pane")}>
        {/* One Tab stop, ← → through the crumbs and buttons. */}
        <header role="toolbar" aria-label="Issue" data-roving="row" className="flex h-(--topbar) shrink-0 items-center gap-2 border-b pr-3 pl-2 max-md:h-13 max-md:gap-0 max-md:pr-1 max-md:pl-1 md:pl-5">
          {/* A phone's back button names where it leads, as in the IssuePhone artboard. */}
          <Button variant="ghost" size="icon" aria-label={`Back to ${back}`} className="max-w-[38%] justify-start gap-0.5 px-1.5 text-[15px] font-normal max-md:w-auto md:hidden" onClick={onClose}>
            <CaretLeftIcon />
            <span className="truncate">{back}</span>
          </Button>
          <Breadcrumb className="max-md:flex-1">
            <BreadcrumbList>
              <ProjectLink ws={ws} project={project} />
              <ParentCrumb issue={issue} />
              <BreadcrumbSeparator className="text-rule-strong max-md:hidden" />
              <BreadcrumbItem className="shrink-0 max-md:flex-1 max-md:justify-center">
                <CopyKeyButton issue={issue} className="text-ink max-md:mx-0 max-md:text-[12.5px] max-md:font-normal max-md:text-ink-3" />
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {isLiveIssue(issue) && issue.number > 0 && <FavoriteButton pin={pinRef("issue", issue.id)} name={key} />}
          {store.isPending(issue.id) && <span className="text-caption text-ink-3 max-md:hidden">Saving…</span>}
          <span className="flex items-center gap-0.5 md:ml-auto">
            {notification?.actions}
            {onStep && (
              <span className="contents max-md:hidden">
                {position ?? <Position project={project} issue={issue} />}
                <Hint label={<KeyHint label="Previous" keys="K" />}>
                  <Button variant="ghost" size="icon" aria-label="Previous" onClick={() => onStep(-1)}>
                    <CaretUpIcon />
                  </Button>
                </Hint>
                <Hint label={<KeyHint label="Next" keys="J" />}>
                  <Button variant="ghost" size="icon" aria-label="Next" onClick={() => onStep(1)}>
                    <CaretDownIcon />
                  </Button>
                </Hint>
              </span>
            )}
            {inList ? (
              <Hint label="Open as a page">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Open as a page"
                  className="max-md:hidden"
                  render={<Link href={pageHref} from={onStep ? project.key : null} />}
                  nativeButton={false}
                >
                  <ArrowsOutSimpleIcon />
                </Button>
              </Hint>
            ) : (
              <Hint label="Show in the list">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Show in the list"
                  className="max-md:hidden"
                  render={<Link href={inListHref} />}
                  nativeButton={false}
                >
                  <ArrowsInSimpleIcon />
                </Button>
              </Hint>
            )}
            <Hint label="Copy link">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy link"
                className="max-md:hidden"
                onClick={() => void navigator.clipboard.writeText(new URL(pageHref, location.origin).href)}
              >
                <LinkIcon />
              </Button>
            </Hint>
            <CopyBranchButton issue={issue} />
            {room && hidden && (
              <Hint label="Show properties">
                <Button variant="ghost" size="icon" aria-label="Show properties" onClick={() => hide(false)}>
                  <SidebarSimpleIcon className="-scale-x-100" />
                </Button>
              </Hint>
            )}
            {!deleted && (
              <span className="contents md:hidden">
                <SubscribeButton issue={issue} className="max-md:size-11" />
              </span>
            )}
            <DropdownMenu>
              <Hint label="More actions">
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="More actions" />}>
                  <DotsThreeIcon weight="bold" />
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem className="md:hidden" onClick={() => shareIssue(issue, pageHref)}>
                  <ExportIcon />
                  Share
                </DropdownMenuItem>
                <IssueMenuItems issue={issue} open={false} />
              </DropdownMenuContent>
            </DropdownMenu>
            <Hint label={<KeyHint label="Close" keys="Esc" />}>
              <Button variant="ghost" size="icon" aria-label="Close (Esc)" className="max-md:hidden" onClick={onClose}>
                <XIcon />
              </Button>
            </Hint>
          </span>
        </header>
        {notification?.strip}
        {!deleted && <ReviewBar issue={issue} onDecided={onReviewed} />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Shelved issue={issue} />
          {/* In the trash the issue takes no edits, comments or reactions until restored (the server refuses them). */}
          <div inert={deleted} className={cn("grid grid-cols-1", deleted && "opacity-70")}>
            {/* A phone's order, from the IssuePhone artboard: the parent, title, the properties as one scrolling line of chips, description. */}
            <div className="mx-auto w-full max-w-[824px] px-8 pt-7 max-md:contents">
              <div className="max-md:order-1 max-md:px-4 max-md:pt-4">
                <ParentLine issue={issue} />
                <Title issue={issue} />
                {chips && <PropertyChips issue={issue} />}
              </div>
              <div className="rich-description max-md:order-3 max-md:px-4 max-md:pt-3 md:contents">
                <Description issue={issue} />
                <IssueReactions issueId={issue.id} />
              </div>
            </div>
            {phone && (
              <aside aria-label="Properties" className="order-2 min-w-0">
                <IssueProperties issue={issue} />
              </aside>
            )}
            {/* On a phone right after the chips, as the GhPhone artboard has it; elsewhere under the row of blocks (IssueBlocks). */}
            {phone && (
              <div className="order-2 min-w-0 empty:hidden">
                <GithubPanel issue={issue} />
              </div>
            )}
            <div className="mx-auto flex w-full max-w-[824px] flex-col gap-7 px-8 pt-[18px] pb-10 max-md:order-4 max-md:min-w-0 max-md:gap-6 max-md:px-4 max-md:pt-6 max-md:pb-5">
              <IssueBlocks issue={issue} />
              <IssueActivity issue={issue} composer={!deleted} bar={commentBar} focus={notification?.focus} highlight={notification?.highlight} />
            </div>
          </div>
        </div>
        <div ref={setCommentBar} className="shrink-0 md:hidden" />
      </div>
      {pane && (
        <aside aria-label="Properties" className="pane flex w-[300px] shrink-0 flex-col">
          <header className="flex h-(--topbar) shrink-0 items-center border-b pr-3 pl-4">
            <span className="eyebrow">Properties</span>
            <Hint label="Hide properties">
              <Button variant="ghost" size="icon" aria-label="Hide properties" className="ml-auto" onClick={() => hide(true)}>
                <SidebarSimpleIcon className="-scale-x-100" />
              </Button>
            </Hint>
          </header>
          <div inert={deleted} className={cn("min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-5", deleted && "opacity-70")}>
            <IssueProperties issue={issue} />
          </div>
        </aside>
      )}
    </article>
  );
});

/**
 * The issue's properties as ledger lines, in the properties pane; on a phone one scrolling line of chips, what is set
 * first in the IssuePhone artboard's order, what is empty after it, the parent last (it is named over the title).
 */
const IssueProperties = observer(function IssueProperties({ issue }: { issue: Issue }) {
  return (
    <dl data-roving="column" data-region-entry className="m-0 grid grid-cols-[92px_minmax(0,1fr)] max-md:no-scrollbar max-md:flex max-md:gap-1.5 max-md:overflow-x-auto max-md:px-4 max-md:pt-3 max-md:pb-0.5">
      <Property label="State" shortcut="S" order="max-md:order-1">
        <StateProperty issue={issue} />
      </Property>
      <Property label="Assignees" shortcut="A" order={issue.assigneeIds.length ? "max-md:order-3" : "max-md:order-9"}>
        <AssigneesProperty issue={issue} />
      </Property>
      <Property label="Priority" shortcut="P" order={issue.priority ? "max-md:order-2" : "max-md:order-9"}>
        <PriorityProperty issue={issue} />
      </Property>
      <Property label="Labels" shortcut="L" order={issue.labelIds.length ? "max-md:order-7" : "max-md:order-9"}>
        <LabelsProperty issue={issue} />
      </Property>
      <Property label="Cycle" order={issue.cycleId ? "max-md:order-5" : "max-md:order-9"}>
        <CycleProperty issue={issue} />
      </Property>
      <Property label="Start date" order={issue.startDate ? "max-md:order-6" : "max-md:order-9"}>
        <DateProperty issue={issue} field="startDate" />
      </Property>
      <Property label="Due date" order={issue.dueDate ? "max-md:order-6" : "max-md:order-9"}>
        <DateProperty issue={issue} field="dueDate" />
      </Property>
      <Property label="Parent" order="max-md:order-10">
        <ParentProperty issue={issue} />
      </Property>
      {issue.delegateId && (
        <span className="contents md:hidden">
          <Property label="Delegate" order="max-md:order-4">
            <DelegateChip issue={issue} />
          </Property>
        </span>
      )}
    </dl>
  );
});

/** Copy branch name beside Copy link; its tooltip names the branch. A phone has the button alone. An unnumbered issue has no name yet. */
const CopyBranchButton = observer(function CopyBranchButton({ issue }: { issue: Issue }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon" aria-label={`Copy branch name (${copyBranchHint})`} disabled={issue.number === 0} className="max-md:size-11" onClick={() => copyIssueBranch(issue)} />}
        >
          <GitBranchIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8} className="flex-col items-stretch gap-[3px] px-2.5 pt-[7px] pb-2 pointer-coarse:hidden has-data-[slot=kbd]:pr-2.5">
          <span className="flex items-center gap-2.5 text-[12.5px] font-semibold">
            Copy branch name
            <Kbd inverse className="ml-auto">
              {copyBranchHint}
            </Kbd>
          </span>
          <span className="font-mono text-[11px] break-all text-inverse-ink-2">{issueBranch(issue)}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

/** An archived or deleted issue says so on top, with the way back (Plane's archived banner). */
const Shelved = observer(function Shelved({ issue }: { issue: Issue }) {
  if (!issue.archivedAt && !issue.deletedAt) return null;
  const deleted = !!issue.deletedAt;
  return (
    <div role="status" className="mx-8 mt-5 flex items-center gap-2 rounded-md border border-rule bg-row-hover px-3 py-2 text-caption max-md:mx-5">
      {deleted ? <TrashIcon className="size-4 text-ink-3" /> : <ArchiveIcon className="size-4 text-ink-3" />}
      {deleted ? "This issue is in the trash." : "This issue is archived."}
      {canRestore(issue) && (
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => restoreIssue(issue)}>
          Restore
        </Button>
      )}
    </div>
  );
});

/** The system's share sheet where there is one (phones), else the link is copied. */
function shareIssue(issue: Issue, path: string): void {
  if (isTouch() && navigator.share) void navigator.share({ title: issue.title, url: new URL(path, location.origin).href }).catch(() => {});
  else copyIssueLink(issue);
}

/** "3 / 49": where the issue is in the list's order; a dash when the filter hides it. */
const Position = observer(function Position({ project, issue }: { project: Project; issue: Issue }) {
  const rows = walkOrder(project, issue.id);
  return <PositionText at={rows.indexOf(issue)} of={rows.length} title={`Position in the ${shownList(project.id).layout === "board" ? "column" : "list"}`} />;
});

/** "3 / 49"; a dash for an issue that is not among them. */
const PositionText = ({ at, of, title }: { at: number; of: number; title: string }) => (
  <span className="mr-1 shrink-0 font-mono text-caption whitespace-nowrap text-ink-3 tabular-nums" title={title}>
    {at < 0 ? "–" : at + 1} / {of}
  </span>
);

/** A ledger property line: the label in ink-3, the value as a quiet button, a soft rule under both. `order`: its place among a phone's chips. */
function Property({ label, shortcut, order, children }: { label: string; shortcut?: string; order?: string; children: ReactNode }) {
  return (
    <>
      <dt className="border-b border-rule-soft py-1 text-caption text-ink-3 max-md:sr-only" title={shortcut && `${label} (${shortcut})`}>
        {/* As high as a value's first line: a row of wrapped labels keeps its caption at the top. */}
        <span className="flex h-6 items-center">{label}</span>
      </dt>
      <dd className={cn("m-0 flex min-w-0 items-center border-b border-rule-soft py-1 max-md:shrink-0 max-md:border-0 max-md:p-0", order)}>{children}</dd>
    </>
  );
}

/** "Sub-issue of INFRA-231" over a phone's title: the wider panes have the parent in their breadcrumb. */
const ParentLine = observer(function ParentLine({ issue }: { issue: Issue }) {
  const parent = liveParent(issue);
  if (!parent) return null;
  const href = issuePath(parent);
  return (
    <Link href={href} className="-mt-[7px] mb-[5px] flex w-fit items-center gap-1.5 py-[7px] text-[12.5px] text-ink-3 md:hidden">
      <TreeStructureIcon className="size-[13px]" />
      Sub-issue of <span className="font-mono text-[11.5px]">{store.issueKey(parent)}</span>
    </Link>
  );
});

/** The title is edited as a draft and saved on Enter or blur; Esc restores it. No hover fade: under a resting cursor it replays on every J/K. */
const Title = observer(function Title({ issue }: { issue: Issue }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const t = draft === null ? "" : cleanName(draft);
    if (t && t !== issue.title) store.updateIssue(issue.id, { title: t });
    setDraft(null);
  };
  return (
    <Textarea
      aria-label="Title"
      rows={1}
      maxLength={TITLE_MAX}
      value={draft ?? issue.title}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className="-mx-2 min-h-0 border-transparent bg-transparent px-2 py-1 transition-none text-[22px] leading-[1.25] font-semibold tracking-[-0.02em] hover:bg-row-hover focus-visible:border-transparent focus-visible:bg-row-hover focus-visible:ring-0 max-md:px-2 md:text-[22px] dark:bg-transparent"
    />
  );
});

/** Description: comes with the issue's feed (one request on open), straight into the editor. */
const Description = observer(function Description({ issue }: { issue: Issue }) {
  const feed = store.feed(issue.id);
  const d = store.description(issue.id);
  const loading = !d && feed.status === "loading";
  const late = useLate(loading, issue.id);
  if (loading) return <Skeleton className="mt-4 h-5 w-48" />;
  // No stored document and a failed load: the description is unknown, not empty. An editor here would start empty and
  // its first save would replace the real description (a save sends the whole document).
  if (!d && feed.status === "error") return <FeedFailed feed={feed} what="The description" className="mt-4" />;
  return <DescriptionEditor key={issue.id} issue={issue} className={late ? LATE : undefined} />;
});
