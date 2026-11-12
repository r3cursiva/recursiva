// The issue's activity, after the IssuePage and IssuePhone artboards: one line down the whole feed, days marked, times on
// the clock, comments breaking the line with their avatars, and a run of state changes folded into one sentence. A wide
// pane has the time in a column on the right, a phone after the text.
import { DotsThreeIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Comment, HistoryEntry, IssueFeed, NotSentComment } from "@rsva/sync";
import { Button } from "@rsva/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rsva/ui/components/collapsible";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { observer } from "mobx-react-lite";
import { useState, type ReactNode } from "react";
import { layOut } from "@rsva/display/activity-rows";
import { foldParts, REMOVED, type HistoryEvent, type HistoryPart } from "@rsva/display/history";
import { clockTime } from "@rsva/display/time";
import { exactTime } from "../lib/time.ts";
import { store } from "../store.ts";
import { Thread } from "./comment-thread.tsx";
import { drawPart, drawParts, stateMark, userName, type HistoryLine } from "./issue-history.tsx";
import { StateGlyph } from "./state-glyph.tsx";

/** A history event (packages/display history.ts) with its line drawn. */
export type Event = Omit<HistoryEvent<HistoryEntry>, "line"> & { line: HistoryLine };
type ThreadItem = { kind: "thread"; at: string; by: string | null; key: string; thread: IssueFeed["threads"][number] };
type NotSentItem = { kind: "notSent"; at: string; by: string | null; comment: NotSentComment };
export type Item = Event | ThreadItem | NotSentItem;

/** The reply a feed has open: the thread, and the comment it quotes. */
export interface FeedReply {
  /** The thread answered, or null. */
  to: string | null;
  start: (comment: Comment, quote?: Comment) => void;
  end: () => void;
}

/** The feed; `children` follow its last row, on its line. */
export const Feed = observer(function Feed({ items, feed, now, since, reply, highlight, children }: { items: readonly Item[]; feed: IssueFeed; now: number; since: string | null; reply: FeedReply; highlight?: ReadonlySet<string> | undefined; children?: ReactNode }) {
  return (
    <div className="relative flex flex-col [--feed-ground:var(--color-panel)] before:absolute before:top-2 before:bottom-2 before:left-[13.5px] before:w-px before:bg-rule *:relative max-md:[--feed-ground:var(--color-ground)]">
      {layOut(items, now, since, store.me?.id).map((r) => {
        if (r.kind === "day") return <Day key={r.key} label={r.label} />;
        if (r.kind === "new") return <NewMark key={r.key} count={r.count} />;
        if (r.kind === "fold") return <Fold key={(r.items[0] as Event).line.key} events={r.items as Event[]} />;
        const it = r.item;
        if (it.kind === "event") return <EventRow key={it.line.key} event={it} />;
        if (it.kind === "notSent") return <NotSent key={it.comment.id} comment={it.comment} feed={feed} />;
        return <Thread key={it.key} thread={it.thread} feed={feed} now={now} clock reply={{ ...reply, active: reply.to === it.thread.comment.id }} highlight={highlight} className="my-1.5" />;
      })}
      {children}
    </div>
  );
});

function Day({ label }: { label: string }) {
  return (
    <div className="mt-4 mb-1 flex items-center gap-2.5 text-[11.5px] font-medium text-ink-3 after:h-px after:flex-1 after:bg-rule-soft">
      <span className="bg-(--feed-ground) pr-0.5">{label}</span>
    </div>
  );
}

function NewMark({ count }: { count: number }) {
  return (
    <div className="mt-3.5 mb-1 flex items-center gap-2.5 text-[11.5px] font-semibold text-signal-text before:h-px before:w-[18px] before:bg-signal/55 after:h-px after:flex-1 after:bg-signal/55">
      {count} new since your last visit
    </div>
  );
}

/** The line with its 28 px mark: `icon` sits over the feed's rule. A line that wraps keeps its mark and time on the first. */
function Line({ icon, at, children }: { icon: ReactNode; at: string; children: ReactNode }) {
  const time = clockTime(at);
  return (
    <div className="grid min-h-[30px] grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 py-1.5 text-[12.5px]/[18px] text-ink-2 max-md:grid-cols-[28px_minmax(0,1fr)] max-md:text-[13px]/[18px]">
      <span className="-my-0.5 grid h-[22px] w-7 place-items-center bg-(--feed-ground) text-ink-3 [&_svg]:size-[13px]">{icon}</span>
      <p className="m-0 min-w-0 wrap-break-word">
        {children}
        <time dateTime={at} title={exactTime(at)} className="ml-1 font-mono text-[11px] whitespace-nowrap text-ink-3 md:hidden">
          · {time}
        </time>
      </p>
      <time dateTime={at} title={exactTime(at)} className="font-mono text-[11px] whitespace-nowrap text-ink-3 max-md:hidden">
        {time}
      </time>
    </div>
  );
}

const Who = ({ id }: { id: string | null }) => <b className="font-medium text-ink">{userName(id)}</b>;

function EventRow({ event }: { event: Event }) {
  return (
    <div data-event={event.line.key}>
      <Line icon={event.line.icon} at={event.at}>
        {event.line.who === undefined ? <Who id={event.by} /> : event.line.who && <b className="font-medium text-ink">{event.line.who}</b>} {event.line.text}
      </Line>
    </div>
  );
}

const StateName = observer(function StateName({ id }: { id: string | null }) {
  return stateMark(id);
});

const Glyph = observer(function Glyph({ id }: { id: string | null }) {
  const s = id ? store.states.get(id) : undefined;
  return s ? <StateGlyph state={s} /> : null;
});

const stateNameOf = (id: string | null) => store.states.get(id ?? "")?.name ?? REMOVED.state;

/** The fold's sentence draws its count in ink, keeps the minutes off a phone, and follows renamed states on its own. */
function foldPart(p: HistoryPart): ReactNode {
  if (typeof p === "object" && "em" in p) return <b className="font-medium text-ink">{p.em}</b>;
  if (typeof p === "object" && "aside" in p) return <span className="max-md:hidden">{p.aside}</span>;
  if (typeof p === "object" && "state" in p) return <StateName id={p.state as string | null} />;
  return drawPart(p);
}

/** "Robin changed the state 8 times in 4 min: Backlog → In review", opened into every step. */
function Fold({ events }: { events: Event[] }) {
  const [open, setOpen] = useState(false);
  const last = events.at(-1)!;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Line icon={last.line.icon} at={last.at}>
        <Who id={last.by} /> {drawParts(foldParts(events), foldPart)}
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-my-0.5 ml-1.5 h-[22px] px-1.5 align-baseline text-[12px] font-normal text-ink-3 max-md:h-7" />}>{open ? "Hide" : "Show all"}</CollapsibleTrigger>
      </Line>
      <CollapsibleContent>
        <ol className="m-0 mb-1 ml-10 flex list-none flex-col border-l border-dashed border-rule-strong py-1 pl-3 animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
          {events.map((e) => (
            <li key={e.line.key} className="grid h-6 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 text-[12px] text-ink-2 max-md:h-7 max-md:text-[12.5px]">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Glyph id={e.move!.from} />
                <span className="truncate max-md:hidden">{stateNameOf(e.move!.from)}</span>→<Glyph id={e.move!.to} />
                <span className="truncate">{stateNameOf(e.move!.to)}</span>
              </span>
              <time dateTime={e.at} className="font-mono text-[11px] text-ink-3">
                {clockTime(e.at)}
              </time>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A comment the server refused, kept with the reason: its text is nowhere else. */
const NotSent = observer(function NotSent({ comment, feed }: { comment: NotSentComment; feed: IssueFeed }) {
  const send = () => {
    feed.dropNotSent(comment.id);
    // Its thread may be gone: the parent refused too, or deleted. Then it starts a new one.
    store.addComment(comment.issueId, comment.body, feed.threads.some((t) => t.comment.id === comment.parentId) ? comment.parentId : null);
  };
  return (
    <article aria-label="Your comment, not sent" className="relative my-1.5 pl-10">
      <UserAvatar {...face(store.me, "You")} className="absolute top-[7px] left-0 size-7 ring-3 ring-(--feed-ground,var(--color-panel)) max-md:top-1" />
      <div className="py-1.5">
        <p className="m-0 text-[13.5px]/[1.6] whitespace-pre-wrap opacity-70">{comment.body}</p>
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-x-[7px] text-[12px] text-destructive max-md:text-[12.5px]">
          <WarningCircleIcon className="size-[14px] shrink-0" />
          <span className="min-w-0">Not sent: {comment.reason}</span>
          <Button type="button" variant="link" className="-mx-1 h-6 px-1 text-[12px] text-destructive max-md:h-8 max-md:text-[12.5px]" onClick={send}>
            Send again
          </Button>
          <span aria-hidden>·</span>
          <Button type="button" variant="link" className="-mx-1 h-6 px-1 text-[12px] text-destructive max-md:h-8 max-md:text-[12.5px]" onClick={() => feed.dropNotSent(comment.id)}>
            Delete
          </Button>
        </div>
      </div>
    </article>
  );
});

/** The button that loads older pages, in the feed's first line. */
export function OlderButton({ feed }: { feed: IssueFeed }) {
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={feed.loadingOlder}
      onClick={() => feed.loadOlder()}
      className="relative z-1 flex h-[30px] w-fit gap-2 border-0 px-0 pr-2.5 font-normal text-ink-2 hover:bg-transparent hover:text-ink disabled:text-ink-3 disabled:opacity-100 max-md:h-9 max-md:px-0 max-md:text-[13px]"
    >
      <span className="grid h-[22px] w-7 place-items-center bg-(--feed-ground) text-ink-3">
        <DotsThreeIcon className="size-3.5" />
      </span>
      {feed.loadingOlder ? "Loading earlier events…" : "Show earlier events"}
    </Button>
  );
}
