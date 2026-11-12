// The issue's activity (the IssuePage and IssuePhone artboards): history as compact lines on one rule, comment threads
// breaking it, oldest first, and the composer at the bottom; the rows themselves are in issue-feed.tsx. Everything comes
// from store.feed(), which loads once when the issue opens and then follows deltas; the composer's comment shows before
// the server answers. A long activity comes in pages, newest first: the older ones load from a button at the top, and the
// issue's creation shows once the first page is in.
//
// The header shows the tabs with counts, the people involved (creator, assignees, commenters), who hear about the issue
// without subscribing, and the viewer's Subscribe button (PLNR-28, subscribe.tsx), which is private to them.
import type { Comment, IssueFeed } from "@rsva/sync";
import type { Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Skeleton } from "@rsva/ui/components/skeleton";
import { UserAvatar, UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { face, faceOf } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowBendUpLeftIcon, XIcon } from "@phosphor-icons/react";
import { byTime, commentCount, feedHolds, feedReaches } from "@rsva/display/activity-rows";
import { historyEvents } from "@rsva/display/history";
import { useHash } from "../lib/location-hash.ts";
import { useIsPhone } from "../lib/phone.ts";
import { useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { Composer, ReactionBar, quoted, useCommentKeys } from "./comment-thread.tsx";
import { reopensDraft } from "./rich-editors.tsx";
import { commentQuote } from "./comment-quote.ts";
import { drawLine, userName } from "./issue-history.tsx";
import { SubscribeButton, UnsubscribedNote } from "./subscribe.tsx";
import { unsubscribedNote } from "./subscription.ts";
import { LATE, useLate } from "./late.ts";
import { Feed, OlderButton, type Event, type Item } from "./issue-feed.tsx";
import { Segmented } from "@rsva/ui/components/segmented";

type Filter = "all" | "comments" | "history";

/** The issue's own reactions, under its description. */
export const IssueReactions = observer(function IssueReactions({ issueId }: { issueId: string }) {
  return <ReactionBar feed={store.feed(issueId)} issueId={issueId} commentId={null} className="mt-3" always />;
});

/** The issue's history as the feed's rows draw it: the shared events (packages/display history.ts) with their lines drawn. */
const events = (issue: Issue, feed: IssueFeed): Event[] => historyEvents(issue, feed.history, !feed.hasOlder).map((e) => ({ ...e, line: drawLine(e.line) }));

const LIT = "color-mix(in srgb, var(--ql-signal) 14%, transparent)";
/** Held, then fading. */
const LIT_FRAMES = [
  { backgroundColor: LIT, offset: 0 },
  { backgroundColor: LIT, offset: 0.45 },
  { backgroundColor: "transparent", offset: 1 },
];

/**
 * Brings the comment a link points at to the middle and lights it for a moment: among many, nothing else tells which one
 * it is. Not the top comment's box, which holds its replies. An animation, so no render, timer or class to take back. A
 * color only, so it stays with reduced motion. A link opened in a background tab waits until the tab is looked at.
 */
function showLinked(id: string, quiet = false): void {
  const comment = document.getElementById(id);
  comment?.scrollIntoView({ block: "center" });
  if (quiet) return;
  const flash = comment?.querySelector("[data-comment-lit]")?.animate(LIT_FRAMES, 2600);
  if (flash && document.hidden) {
    flash.pause();
    document.addEventListener("visibilitychange", () => flash.play(), { once: true });
  }
}

/**
 * The comment a notification points at; `at` is when it was written. `quiet`: brought into view without the light,
 * where the comment is marked as new anyway and is one of several (RSVA-575).
 */
export interface FeedFocus {
  comment: string;
  at: string;
  quiet?: boolean;
}

/** `composer` false: no field for a new comment (an issue in the trash). `focus`: the comment to bring up once it is in; `highlight`: comments to mark. */
export const IssueActivity = observer(function IssueActivity({
  issue,
  composer = true,
  bar,
  focus,
  highlight,
}: {
  issue: Issue;
  composer?: boolean;
  bar?: HTMLElement | null;
  focus?: FeedFocus | null | undefined;
  highlight?: ReadonlySet<string> | undefined;
}) {
  const [picked, setFilter] = useState<Filter>("all");
  const phone = useIsPhone();
  const feed = store.feed(issue.id);
  const now = useNow();
  const late = useLate(feed.status === "loading", issue.id);
  useCommentKeys();
  // One reply at a time: the thread answered, and what it quotes. A wide pane writes it in the thread, a phone in the field at the bottom.
  const [reply, setReply] = useState<{ comment: Comment; quote: Comment | null } | null>(null);
  // After the field has mounted for this comment, so the quote reaches its editor.
  useEffect(() => {
    if (reply?.quote) commentQuote.request(issue.id, quoted(reply.quote.body, userName(reply.quote.authorId)));
  }, [reply, issue.id]);
  useEffect(() => setReply(null), [issue.id]);
  // A reply whose draft a reload for a new version handed over: open again (lib/drafts.ts).
  const reopened = reply ? undefined : feed.threads.find((t) => reopensDraft(`reply:${t.comment.id}`))?.comment;
  useEffect(() => {
    if (reopened) setReply({ comment: reopened, quote: null });
  }, [reopened]);
  // "2 new since your last visit": from the first unread inbox event, as it stood when the issue opened.
  const since = useMemo(() => {
    const row = store.inbox.rows.find((r) => r.issue.id === issue.id);
    const read = store.inbox.marksOf([issue.id])[0]?.readId ?? 0;
    return row?.events.find((e) => e.id > read)?.at ?? null;
  }, [issue.id]);
  // A link to a comment (Copy link): to it, once the feed is in.
  const hash = useHash();
  useEffect(() => {
    if (feed.status === "ready" && hash.startsWith("#comment-")) showLinked(hash.slice(1));
  }, [feed.status, hash]);
  // A notification's comment: the same, from older pages if it takes that.
  const found = !!focus && feedHolds(feed, focus.comment);
  useEffect(() => {
    if (found) showLinked(`comment-${focus.comment}`, focus.quiet);
  }, [found, focus]);
  const fetchOlder = !!focus && !found && feed.status === "ready" && feed.hasOlder && !feed.loadingOlder && !feedReaches(feed, focus.at);
  // One try for what is loaded: a failed page changes nothing, so this would ask again at once, forever. The button below
  // tries again.
  const loaded = feed.history.length + feed.threads.length;
  const triedAt = useRef(-1);
  useEffect(() => {
    if (!fetchOlder || triedAt.current === loaded) return;
    triedAt.current = loaded;
    feed.loadOlder();
  }, [fetchOlder, feed, loaded]);

  const history = events(issue, feed);
  const comments = commentCount(feed.threads);
  // The switch means something only when there are both comments and history (or while the feed is not known yet).
  const mixed = feed.status !== "ready" || (comments > 0 && history.length > 0);
  const filter = mixed ? picked : "all";
  const items: Item[] = filter === "comments" ? [] : [...history];
  if (filter !== "history") {
    for (const thread of feed.threads) items.push({ kind: "thread", at: thread.comment.createdAt, by: thread.comment.authorId, key: thread.comment.id, thread });
    for (const comment of feed.notSent) items.push({ kind: "notSent", at: comment.at, by: store.me?.id ?? null, comment });
  }
  items.sort(byTime);

  const involved = new Set<string>();
  if (issue.createdById) involved.add(issue.createdById);
  for (const id of issue.assigneeIds) involved.add(id);
  for (const t of feed.threads) for (const c of [t.comment, ...t.replies]) if (c.authorId) involved.add(c.authorId);
  const involvedFaces = [...involved].map((id) => faceOf(id, "someone"));

  const feedReply = {
    to: reply?.comment.id ?? null,
    start: (comment: Comment, quote?: Comment) => setReply({ comment, quote: quote ?? null }),
    end: () => setReply(null),
  };
  return (
    <section aria-label="Activity">
      {/* One row on a wide screen however narrow the pane (a container, /act): first the bell loses its word, then the
          involved people go, then the counts (all three measured 2026-11-05: 409px of content for all of it, then 333, 303). */}
      <header className="@container/act mb-2.5 flex items-center gap-x-2.5 gap-y-2.5 border-b border-rule pb-1.5 max-md:flex-wrap max-md:border-b-0 max-md:pb-0">
        <h2 className="m-0 text-[15px] font-semibold max-md:text-[16px]">Activity</h2>
        {mixed && <Segmented
          variant="quiet"
          fill={phone}
          label="Show"
          value={filter}
          onChange={setFilter}
          className="md:[&>button]:h-6 max-md:order-last max-md:basis-full max-md:rounded-lg"
          countClassName="@max-[19rem]/act:hidden"
          options={[
            { value: "all", label: "All", count: history.length + comments },
            { value: "comments", label: "Comments", count: comments },
            { value: "history", label: "History", count: history.length },
          ]}
        />}
        <div className="ml-auto flex items-center gap-2.5 max-md:hidden">
          {/* Without its word the button is a square around the bell (the button's left padding is for an icon before a word). */}
          <SubscribeButton issue={issue} labelled wordClassName="@max-[26rem]/act:hidden" className="@max-[26rem]/act:w-6 @max-[26rem]/act:px-0!" />
          {involvedFaces.length > 0 && (
            <span title={`Involved: ${involvedFaces.map((f) => f.name).join(", ")}`} className="flex @max-[21rem]/act:hidden">
              <UserAvatarStack people={involvedFaces} max={4} />
            </span>
          )}
        </div>
      </header>

      {feed.status === "loading" && <Skeleton className="mb-3 h-4 w-56" />}
      {feed.status === "error" && <FeedFailed feed={feed} what="Activity" className="mb-3" />}

      <div className={cn(late && LATE)}>
        <Feed items={items} feed={feed} now={now} since={since} reply={feedReply} highlight={highlight}>
          {feed.hasOlder && (
            <div className="order-first">
              <OlderButton feed={feed} />
            </div>
          )}
          {filter === "comments" && feed.status === "ready" && items.length === 0 && <p className="m-0 py-1 pl-10 text-caption text-ink-3">No comments yet. Start the discussion below.</p>}
          {unsubscribedNote(store.inbox.subscription(issue)) && <UnsubscribedNote />}
          {composer && <CommentField issue={issue} bar={phone ? bar : null} reply={phone ? (reply?.comment ?? null) : null} quotes={phone || !reply} onReplyEnd={() => setReply(null)} />}
        </Feed>
      </div>
    </section>
  );
});

/** The field for a new comment: at the end of the feed, or on a phone in the bar under the scroll, where it also takes a reply. */
function CommentField({ issue, bar, reply, quotes, onReplyEnd }: { issue: Issue; bar: HTMLElement | null | undefined; reply: Comment | null; quotes: boolean; onReplyEnd: () => void }) {
  const field = reply ? (
    <Composer
      key={reply.id}
      issue={issue}
      quotes
      autoFocus
      draftKey={`reply:${reply.id}`}
      placeholder="Reply…"
      submitLabel="Reply"
      above={<ReplyContext comment={reply} onCancel={onReplyEnd} />}
      onSubmit={(body) => {
        store.addComment(issue.id, body, reply.id);
        onReplyEnd();
      }}
    />
  ) : (
    <Composer key="comment" issue={issue} quotes={quotes} draftKey={`issue:${issue.id}`} placeholder={bar ? "Comment…" : "Leave a comment… / for blocks, @ to mention, # to link an issue"} submitLabel="Comment" onSubmit={(body) => store.addComment(issue.id, body)} />
  );
  if (bar) return createPortal(<div className="border-t bg-panel px-2.5 pt-2 pb-[calc(8px+var(--safe-bottom))] in-[[data-keyboard]]:pb-2">{field}</div>, bar);
  return (
    <div className="relative mt-3.5 pl-10">
      <UserAvatar {...face(store.me, "You")} className="absolute top-[7px] left-0 size-7 ring-3 ring-(--feed-ground)" />
      {field}
    </div>
  );
}

/** "Replying to Mira: …" over the field, with the way out. */
const ReplyContext = observer(function ReplyContext({ comment, onCancel }: { comment: Comment; onCancel: () => void }) {
  const name = comment.authorId ? (store.users.get(comment.authorId)?.name ?? "Unknown") : "Unknown";
  return (
    <div className="flex items-center gap-2 pt-0.5 pr-1 pb-2 pl-1.5 text-[12.5px] text-ink-3 animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
      <ArrowBendUpLeftIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Replying to <b className="font-medium text-ink-2">{name}</b>: {comment.body}
      </span>
      <Button variant="ghost" size="icon" aria-label="Cancel reply" className="size-8 shrink-0" onClick={onCancel}>
        <XIcon />
      </Button>
    </div>
  );
});

/** A failed first load of the issue's feed (offline, a server error): what is missing, and Retry. */
export function FeedFailed({ feed, what, className }: { feed: IssueFeed; what: string; className?: string }) {
  return (
    <p className={cn("flex items-center gap-1 text-caption text-ink-3", className)}>
      {what} could not be loaded.
      <Button variant="ghost" size="sm" className="text-ink-3" onClick={() => feed.retry()}>
        Retry
      </Button>
    </p>
  );
}
