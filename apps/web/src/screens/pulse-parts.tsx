// The marks My work's Home and a project's home share (RSVA-568, RSVA-570): a square per live issue in its kind's colour,
// a bar of the parked ones, and the figures that total them. One set, so a colour means the same on both pages.
import { cn } from "@rsva/ui/lib/utils";
import {
  PARKED,
  parkedTotal,
  STILL_DAYS,
  type Parked,
} from "../lib/my-work-projects.ts";

/** What a live issue is doing, each with its colour. A page shows the kinds it has, in its order. */
export type Live = "wait" | "overdue" | "doing" | "agents" | "review" | "blocked";

export const LIVE_TONE: Record<Live, string> = {
  wait: "bg-signal",
  overdue: "bg-error",
  doing: "bg-status-progress",
  agents: "bg-ink-2",
  review: "bg-status-review",
  blocked: "shadow-[inset_0_0_0_1.5px_var(--color-error)]",
};
export const LIVE_NAMES: Record<Live, { head: string; figure: string; tip: string }> = {
  wait: { head: "Waits", figure: "wait on you", tip: "Reviews, mentions and replies waiting on you" },
  overdue: { head: "Overdue", figure: "overdue", tip: "Open issues past their due date, anyone's" },
  doing: { head: "Yours", figure: "yours", tip: "Yours, in progress" },
  agents: { head: "Agents", figure: "with agents", tip: "Agents at work on your behalf" },
  review: { head: "Review", figure: "in review", tip: "In review or approved, not waiting on you" },
  blocked: { head: "Blocked", figure: "blocked", tip: "Open issues waiting on another open issue" },
};

const PARKED_TONE: Record<keyof Parked, string> = {
  still:
    "bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--color-warning)_55%,var(--color-rule))_0_2px,var(--color-rule)_2px_4.5px)]",
  todo: "bg-ink-3/60",
  backlog: "bg-rule-strong",
  proposed: "shadow-[inset_0_0_0_1.5px_var(--color-ink-3)]",
};
const PARKED_NAMES: Record<keyof Parked, string> = {
  still: `still ${STILL_DAYS} d`,
  todo: "todo",
  backlog: "backlog",
  proposed: "proposed",
};

/** A square per issue up to `max`; past it, one fewer and how many more. */
export function Units({ n, max, tone }: { n: number; max: number; tone: string }) {
  const shown = n > max ? max - 1 : n;
  return (
    <>
      {Array.from({ length: shown }, (_, i) => (
        <i key={i} className={cn("block size-2 shrink-0 rounded-[2px]", tone)} />
      ))}
      {n > shown && (
        <span className="ml-px font-mono text-[11px] leading-none text-ink-3">
          +{n - shown}
        </span>
      )}
    </>
  );
}

/** The parked issues as one bar, a segment per kind; `of` is the scale's whole (the largest project's, or its own). */
export function ParkedBar({ parked, of }: { parked: Parked; of: number }) {
  return (
    <span className="flex h-2 min-w-0 flex-1 items-center gap-px overflow-hidden">
      {PARKED.map((k) =>
        parked[k] ? (
          <i
            key={k}
            className={cn("block h-2 min-w-0.5 rounded-[1.5px]", PARKED_TONE[k])}
            style={{ width: `${(parked[k] / Math.max(of, 1)) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  );
}

const NUMBER = "text-[32px] leading-none font-semibold tracking-[-0.03em] tabular-nums";

/**
 * The page's totals: a figure per live kind over its squares, then the parked ones with their bar and what they are.
 * A kind with somewhere to go (`go`) is a button; `deltas` are what was added since the viewer last looked.
 */
export function Figures<K extends Live>({
  kinds,
  n,
  deltas = {},
  go,
  goTip = "",
  parked,
}: {
  kinds: readonly K[];
  n: Record<K, number>;
  deltas?: Partial<Record<K, number>>;
  go: (kind: K) => (() => void) | undefined;
  /** What a click does, added to a button's tip. */
  goTip?: string;
  parked: Parked;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-1.5 gap-y-3">
      {kinds.map((k) => {
        const act = go(k);
        const body = (
          <>
            <span
              className={cn(
                "flex items-baseline gap-1.5",
                NUMBER,
                !n[k] ? "text-faint" : k === "wait" ? "text-signal-text" : k === "overdue" || k === "blocked" ? "text-error" : "text-ink",
              )}
            >
              {n[k]}
              {!!deltas[k] && (
                <span title="Since your last visit" className="font-mono text-[11.5px] font-medium tracking-normal text-ink-3">
                  +{deltas[k]}
                </span>
              )}
            </span>
            <span className="text-[12.5px] whitespace-nowrap text-ink-2">{LIVE_NAMES[k].figure}</span>
            <span className="flex min-h-[18px] max-w-[98px] flex-wrap content-start gap-0.5">
              <Units n={n[k]} max={30} tone={LIVE_TONE[k]} />
            </span>
          </>
        );
        const cls = "flex min-w-[74px] flex-col items-start gap-[7px] rounded-[9px] px-2.5 pt-2 pb-2.5 text-left";
        return act ? (
          <button
            key={k}
            type="button"
            title={`${LIVE_NAMES[k].tip}${goTip && `: ${goTip}`}`}
            onClick={act}
            className={cn(cls, "outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring")}
          >
            {body}
          </button>
        ) : (
          <div key={k} title={LIVE_NAMES[k].tip} className={cls}>
            {body}
          </div>
        );
      })}
      {/* Anyone's, not the viewer's (RSVA-612): "5 parked" on My work's Home read as five of theirs. */}
      <div
        title="Not started in these projects, anyone's"
        className="ml-2 flex min-w-[170px] flex-1 flex-col items-start gap-[7px] border-l border-rule pt-2 pl-[18px] max-md:ml-0 max-md:border-l-0 max-md:pl-2.5"
      >
        <span className={cn(NUMBER, "text-ink-3")}>{parkedTotal(parked)}</span>
        <span className="text-[12.5px] text-ink-2">parked</span>
        <span className="mt-px flex w-full">
          <ParkedBar parked={parked} of={parkedTotal(parked)} />
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
          {PARKED.map((k) => (
            <span key={k} className="inline-flex items-center gap-[5px] whitespace-nowrap">
              <i className={cn("block size-2 rounded-[2px]", PARKED_TONE[k])} />
              {PARKED_NAMES[k]}
              <span className="font-mono text-[11px] text-ink-2">{parked[k]}</span>
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
