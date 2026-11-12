// The issue's pull requests and commits, after the GhIssue and GhPhone artboards: in the issue's body under the description
// (the artboard's side panel squeezed the rows, owner's decision), on a phone right after the chips, and only when there are any. Each row opens GitHub in a new tab. The rows come with the
// issue's feed and stay live by deltas; nothing here asks the server.
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  EyeIcon,
  GitCommitIcon,
  GithubLogoIcon,
  RobotIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { commitUrl, pullUrl, SHA_SHOWN, type GithubLink, type Issue, type PullChecks, type PullReview } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rsva/ui/components/collapsible";
import { Spinner } from "@rsva/ui/components/spinner";
import { Hint } from "@rsva/ui/components/tooltip";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useState, type ReactNode } from "react";
import { checksName, pullLive } from "@rsva/display/github";
import { githubRows, pullLabel, REVIEW_NAME, STATE_NAME } from "../lib/github.ts";
import { exactTime, shortTime, useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { LinkedTag, PullStateIcon } from "./github-parts.tsx";
import { PanelSection } from "./panel-section.tsx";
import { plural } from "@rsva/schema/util";

/** Pull requests shown before Show N more. */
const SHOWN = 5;

const BLOCK = "max-md:px-4 max-md:pt-5";

const count = (n: number, what: string) => ({ text: String(n), title: plural(n, what) });

const row = "relative -mx-2 grid grid-cols-[16px_minmax(0,1fr)] gap-x-[9px] rounded-md px-2 text-ink no-underline outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring";

export const GithubPanel = observer(function GithubPanel({ issue }: { issue: Issue }) {
  const { pulls, commits } = githubRows(store.githubOf(issue.id));
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const now = useNow();
  useEffect(() => {
    setMore(false);
    setOpen(false);
  }, [issue.id]);
  if (!pulls.length && !commits.length) return null;
  const key = store.issueKey(issue);
  if (!pulls.length)
    return (
      <PanelSection label="Commits" className={BLOCK} count={count(commits.length, "commit")}>
        {commits.map((c) => (
          <CommitRow key={c.id} commit={c} now={now} issueKey={key} />
        ))}
      </PanelSection>
    );
  const rest = pulls.length - SHOWN;
  const Caret = open ? CaretDownIcon : CaretRightIcon;
  return (
    <PanelSection label="Pull requests" className={BLOCK} count={count(pulls.length, "pull request")} action={<SearchGithub issueKey={key} />}>
      {(more ? pulls : pulls.slice(0, SHOWN)).map((p) => (
        <PullRow key={p.id} pull={p} label={pullLabel(p, pulls)} now={now} issueKey={key} />
      ))}
      {!more && rest > 0 && (
        <Button variant="ghost" onClick={() => setMore(true)} className="-ml-2 mt-0.5 gap-1.5 self-start rounded-[5px] border-0 px-2 font-normal max-md:h-11 max-md:rounded-[5px] max-md:px-2 max-md:text-[13.5px]">
          <CaretDownIcon className="size-3" />
          Show {rest} more
        </Button>
      )}
      {commits.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col md:gap-0.5">
          <CollapsibleTrigger className="-mx-2 mt-1 flex h-8 items-center gap-[7px] border-t border-rule-soft px-2 text-left text-[12.5px] font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:text-[14px]">
            <Caret className="size-3 text-ink-3" />
            Commits
            <span className="font-mono text-[11px] font-normal text-ink-3">{commits.length}</span>
          </CollapsibleTrigger>
          {/* animation-duration, not duration-300: a transition duration would make the panel a transition to Base UI. */}
          <CollapsibleContent className="flex flex-col animate-in fade-in-0 slide-in-from-bottom-1 animation-duration-300">
            {commits.map((c) => (
              <CommitRow key={c.id} commit={c} now={now} issueKey={key} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </PanelSection>
  );
});

/** The heading's search on GitHub: a pull request may name the key somewhere the block does not reach. */
function SearchGithub({ issueKey }: { issueKey: string }) {
  return (
    <Hint label={`Search ${issueKey} on GitHub`}>
      <Button
        variant="ghost"
        size="icon-sm"
        nativeButton={false}
        role="link"
        render={<a href={`https://github.com/pulls?q=${encodeURIComponent(issueKey)}`} target="_blank" rel="noopener" />}
        aria-label={`Search ${issueKey} on GitHub`}
        className="grid place-items-center rounded-[5px] border-0 hover:text-ink-2 max-md:-mr-1.5 max-md:size-11 max-md:rounded-[5px]"
      >
        <GithubLogoIcon className="size-3.5" />
      </Button>
    </Hint>
  );
}

const PullRow = observer(function PullRow({ pull: p, label, now, issueKey }: { pull: GithubLink; label: string; now: number; issueKey: string }) {
  const state = p.state ?? "open";
  return (
    <a href={pullUrl(p)} target="_blank" rel="noopener" title={`${STATE_NAME[state]} · opens on GitHub`} className={cn(row, "group/pr pt-2 pb-[9px] max-md:pt-2.5 max-md:pb-[11px]")}>
      <span className="grid justify-items-center pt-px">
        <PullStateIcon state={state} className="size-[15px]" />
      </span>
      {/* A pane wide enough has the verdicts beside the title and the branch on a line of its own; a narrow one and a phone, under them. */}
      <span className="min-w-0 md:@2xl:grid md:@2xl:grid-cols-[minmax(0,1fr)_auto] md:@2xl:gap-x-4 md:@2xl:pr-5">
        <span className="line-clamp-2 pr-4 text-[13px] leading-[1.35] max-md:text-[14px] md:@2xl:pr-0">{p.title}</span>
        <span className="mt-[3px] flex min-w-0 items-center gap-1.5 font-mono text-[11px] whitespace-nowrap text-ink-3 md:@2xl:col-span-2 md:@2xl:row-start-2">
          <span>{label}</span>
          <span className="min-w-0 truncate">
            {p.head} → {p.base}
          </span>
          {!p.closing && <LinkedTag title={`Linked: merging it will not close ${issueKey}`} />}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-ink-2 max-md:text-[12px] md:@2xl:col-start-2 md:@2xl:row-start-1 md:@2xl:mt-0 md:@2xl:flex-nowrap md:@2xl:self-start">
          <PullVerdicts pull={p} />
          <span className="ml-auto inline-flex items-center gap-[5px] whitespace-nowrap text-ink-3">
            <Author link={p} />
            <span title={exactTime(p.at)}>
              {p.author} · {shortTime(p.at, now)}
            </span>
          </span>
        </span>
      </span>
      <span className="absolute top-[9px] right-2 text-ink-3 opacity-0 transition-opacity duration-120 group-hover/pr:opacity-100 group-focus-visible/pr:opacity-100 pointer-coarse:opacity-100">
        <ArrowSquareOutIcon className="size-3" />
      </span>
    </a>
  );
});

function CommitRow({ commit: c, now, issueKey }: { commit: GithubLink; now: number; issueKey: string }) {
  return (
    <a href={commitUrl(c)} target="_blank" rel="noopener" className={cn(row, "py-1.5 max-md:py-2")}>
      <span className="grid justify-items-center pt-px text-ink-3">
        <GitCommitIcon className="size-3.5" />
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-[7px] text-[12.5px] max-md:text-[13.5px]">
          <span className="shrink-0 font-mono text-[11px] text-ink-2">{c.sha?.slice(0, SHA_SHOWN)}</span>
          <span className="min-w-0 truncate">{c.title}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
          <span title={exactTime(c.at)}>
            {c.author} · {shortTime(c.at, now)}
          </span>
          {!c.closing && <LinkedTag title={`Linked: will not close ${issueKey}`} />}
        </span>
      </span>
    </a>
  );
}

function Author({ link }: { link: GithubLink }) {
  if (!link.authorBot) return <UserAvatar name={link.author} className="size-4 max-md:hidden" />;
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded-[4px] border bg-sidebar text-ink-2 max-md:hidden">
      <RobotIcon className="size-[9px]" />
    </span>
  );
}

const Badge = ({ color, children }: { color: string; children: ReactNode }) => <span className={cn("inline-flex items-center gap-1 whitespace-nowrap [&_svg]:size-3", color)}>{children}</span>;

/** What a pull request still has to say: its review and checks while it is live; once merged or closed, only that, in words. */
export function PullVerdicts({ pull: p }: { pull: GithubLink }) {
  if (p.state && !pullLive(p.state)) return <span className="text-ink-3">{STATE_NAME[p.state]}</span>;
  return (
    <>
      {p.review && <Review review={p.review} />}
      {p.checks && <Checks checks={p.checks} failing={p.failing} />}
    </>
  );
}

function Review({ review }: { review: PullReview }) {
  const Icon = review === "approved" ? CheckCircleIcon : review === "changes" ? WarningCircleIcon : EyeIcon;
  return (
    <Badge color={review === "approved" ? "text-success" : review === "changes" ? "text-error" : "text-ink-3"}>
      <Icon />
      {REVIEW_NAME[review]}
    </Badge>
  );
}

function Checks({ checks, failing }: { checks: PullChecks; failing: number }) {
  const { full, short } = checksName(checks, failing);
  return (
    <Badge color={checks === "pass" ? "text-success" : checks === "fail" ? "text-error" : "text-ink-3"}>
      {checks === "pass" ? <CheckIcon /> : checks === "fail" ? <XCircleIcon /> : <Spinner aria-hidden className="motion-reduce:animate-none" />}
      <span className="max-md:hidden">{full}</span>
      <span className="md:hidden">{short}</span>
    </Badge>
  );
}
