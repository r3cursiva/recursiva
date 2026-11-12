// A comment thread in the activity feed: the top comment, its replies and reactions, and the reply, edit and delete
// actions. Every action applies at once through the store; the server's answer only confirms or reverts it. Bodies are
// Markdown, drawn by the same renderer as descriptions; the composer is the rich editor (rich-editors.tsx).
//
// A wide pane, after the IssuePage artboard: actions float over a hovered comment (.comment-acts, index.css) and reactions
// show only when there are some, so a plain comment takes no row for them. A phone has them under the comment, and "…"
// opens its sheet. One element for both wherever the two agree.
import { ArrowBendUpLeftIcon, CopyIcon, DotsThreeIcon, LinkIcon, PencilSimpleIcon, PlusIcon, QuotesIcon, SmileyIcon, TrashIcon } from "@phosphor-icons/react";
import type { Comment, CommentThread, IssueFeed } from "@rsva/sync";
import { Badge } from "@rsva/ui/components/badge";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@rsva/ui/components/popover";
import { Spinner } from "@rsva/ui/components/spinner";
import { Toggle } from "@rsva/ui/components/toggle";
import { KeyHint } from "@rsva/ui/components/kbd";
import { Hint } from "@rsva/ui/components/tooltip";
import { AgentAvatar, UserAvatar, UserAvatarStack, type Face } from "@rsva/ui/components/user-avatar";
import { face, faceOf } from "../lib/face.ts";
import { viaWords } from "@rsva/display/history";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { clockTime } from "@rsva/display/time";
import { useHash } from "../lib/location-hash.ts";
import { useIsPhone } from "../lib/phone.ts";
import { exactTime, timeAgo } from "../lib/time.ts";
import { store } from "../store.ts";
import { copy, issuePath } from "./issue-actions.ts";
import type { FeedReply } from "./issue-feed.tsx";
import { ignoredKey } from "./list-view.ts";
import { useWindowKeys } from "./list-keys.ts";
import { Composer, issueFromComment, reopensDraft } from "./rich-editors.tsx";
import { MarkdownBody } from "./rich-text.tsx";

export { Composer };

/** The picker's row, and the top of a comment's sheet on a phone. */
const QUICK = [
  ["👍", "Thumbs up"],
  ["🎉", "Party"],
  ["👀", "Looking"],
  ["❤️", "Heart"],
  ["🚀", "Rocket"],
  ["🙏", "Thanks"],
] as const;
/** Behind More reactions. */
const MORE = [
  ["👎", "Thumbs down"],
  ["😄", "Smile"],
  ["😕", "Confused"],
  ["🔥", "Fire"],
  ["👏", "Clap"],
  ["✅", "Done"],
] as const;

/** A comment as a Markdown quote, ready for a reply: its author on the first line (render.ts draws them small). */
export const quoted = (body: string, author: string): string => `> **${author.replace(/[\\*_`[\]]/g, "\\$&")}**\n>\n${body.split("\n").map((l) => `> ${l}`).join("\n")}\n`;


/** What a hovered comment does with a key. */
interface CommentKeys {
  r?: (() => void) | undefined;
  q?: (() => void) | undefined;
  e?: (() => void) | undefined;
  del?: (() => void) | undefined;
}
const keyed = new WeakMap<Element, CommentKeys>();

/** R, Q, E and ⌫ on the comment under the pointer: first, so that an E on it does not reach the list beside the issue. */
export function useCommentKeys(): void {
  // Capture handlers run newest first (useWindowKeys): the list beside the issue mounted before this.
  useWindowKeys((e) => {
    if (e.shiftKey || ignoredKey(e)) return;
    const key = e.key === "Backspace" || e.key === "Delete" ? "del" : e.key.toLowerCase();
    if (key !== "r" && key !== "q" && key !== "e" && key !== "del") return;
    const under = [...document.querySelectorAll("[data-comment]:hover")].at(-1);
    const act = under && keyed.get(under)?.[key];
    if (!act) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    act();
  }, true);
}

/** A row of the picker. A phone's seven 48 px buttons fit a 375 px screen without gaps, and wrap on a narrower one. */
const ROW = "flex items-center gap-0.5 max-md:flex-wrap max-md:justify-center max-md:gap-0";

/** The emoji, with what the viewer has already given lit; a second press takes it back. */
const ReactionPicker = observer(function ReactionPicker({
  feed,
  issueId,
  commentId,
  children,
}: {
  feed: IssueFeed;
  issueId: string;
  commentId: string | null;
  /** The button that opens it. */
  children: ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const mine = new Set(feed.reactions(commentId ?? issueId).filter((g) => g.mine).map((g) => g.emoji));
  const emoji = ([e, name]: readonly [string, string]) => (
    <Button
      key={e}
      type="button"
      variant="ghost"
      size="icon-lg"
      aria-label={name}
      aria-pressed={mine.has(e)}
      className="size-8 text-[17px] font-normal transition-[transform,background-color] duration-120 ease-spring hover:scale-115 aria-pressed:bg-signal/12 max-md:size-12 max-md:rounded-md max-md:text-2xl"
      onClick={() => {
        store.toggleReaction(issueId, commentId, e);
        setOpen(false);
      }}
    >
      {e}
    </Button>
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setMore(false);
      }}
    >
      <PopoverTrigger render={children} />
      {/* On a phone the sheet stays a column, its grabber on top; each row of emoji is centred in it. */}
      <PopoverContent className="w-auto gap-0.5 p-1" align="start">
        <div className={ROW}>
          {QUICK.map(emoji)}
          <span aria-hidden className="mx-[3px] h-5 w-px bg-rule max-md:hidden" />
          {!more && (
            <Button variant="ghost" size="icon-sm" aria-label="More reactions" className="text-ink-2 max-md:size-12" onClick={() => setMore(true)}>
              <DotsThreeIcon />
            </Button>
          )}
        </div>
        {more && <div className={ROW}>{MORE.map(emoji)}</div>}
      </PopoverContent>
    </Popover>
  );
});

/**
 * Reactions of a comment, or of the issue when commentId is null: counts, toggles and the add chip. On a wide pane the row
 * shows only with reactions in it, unless `always`: a comment adds its first one from the toolbar.
 */
export const ReactionBar = observer(function ReactionBar({
  feed,
  issueId,
  commentId,
  className,
  onAdd,
  always,
  children,
}: {
  feed: IssueFeed;
  issueId: string;
  commentId: string | null;
  className?: string;
  /** On a phone the add chip does this instead of opening the picker: a comment's sheet has the emoji on top. */
  onAdd?: (() => void) | undefined;
  /** Stands even with no reactions, as the issue's does: it has no toolbar. */
  always?: boolean;
  /** After the reactions, on a phone: the Reply button. */
  children?: ReactNode;
}) {
  const groups = feed.reactions(commentId ?? issueId);
  const phone = useIsPhone();
  if (!groups.length && !always && !phone) return null;
  const add = cn(
    "h-6 w-[30px] rounded-xl border border-control-border bg-panel text-ink-3 [&_svg:not([class*='size-'])]:size-4 hover:border-rule-strong hover:bg-panel hover:text-ink aria-expanded:border-rule-strong aria-expanded:bg-panel max-md:h-8 max-md:w-9 max-md:rounded-2xl",
    !groups.length && "md:border-transparent md:bg-transparent",
  );
  return (
    <div className={cn("flex flex-wrap items-center gap-[5px] max-md:gap-1.5", className)}>
      {groups.map((g) => (
        <Toggle
          key={g.emoji}
          pressed={g.mine}
          title={g.userIds.map((id) => store.users.get(id)?.name ?? "someone").join(", ")}
          onPressedChange={() => store.toggleReaction(issueId, commentId, g.emoji)}
          className="group/rx h-6 min-w-0 gap-[5px] rounded-xl border border-control-border bg-panel px-2 text-[12.5px] font-normal text-ink transition-[transform,background-color,border-color] duration-120 ease-spring hover:bg-row-hover hover:text-ink active:scale-92 aria-pressed:border-signal/55 aria-pressed:bg-signal/10 aria-pressed:hover:bg-signal/15 max-md:h-8 max-md:px-2.5 max-md:text-[14px]"
        >
          {g.emoji}
          <b className="font-mono text-[11px] font-normal text-ink-2 group-aria-pressed/rx:font-medium group-aria-pressed/rx:text-signal-text">{g.userIds.length}</b>
        </Toggle>
      ))}
      {phone && onAdd ? (
        <Button variant="ghost" size="icon-sm" aria-label="Add reaction" className={add} onClick={onAdd}>
          <SmileyIcon />
        </Button>
      ) : (
        <ReactionPicker feed={feed} issueId={issueId} commentId={commentId}>
          <Button variant="ghost" size="icon-sm" aria-label="Add reaction" title="Add reaction" className={add}>
            <SmileyIcon />
          </Button>
        </ReactionPicker>
      )}
      {children}
    </div>
  );
});

interface CommentActions {
  onReply?: (() => void) | undefined;
  /** Start a reply with this comment quoted. */
  onQuote?: (() => void) | undefined;
  onEdit: () => void;
  onDelete: () => void;
}

const linkTo = (comment: Comment): string | null => {
  const issue = store.issues.get(comment.issueId);
  return issue ? new URL(`${issuePath(issue)}#comment-${comment.id}`, location.origin).href : null;
};

/**
 * A comment's actions: the menu of a wide pane's "…", on a phone the sheet (the IssuePhoneActions artboard) with the emoji
 * on top and Reply. What only its author may do comes last. `shortcuts`: the keys work here (useCommentKeys).
 */
const CommentMenu = observer(function CommentMenu({
  comment,
  feed,
  open,
  onOpenChange,
  trigger,
  actions,
  shortcuts,
}: {
  comment: Comment;
  feed: IssueFeed;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement<Record<string, unknown>>;
  actions: CommentActions;
  shortcuts: boolean;
}) {
  const phone = useIsPhone();
  const issue = store.issues.get(comment.issueId);
  const mine = comment.authorId === store.me?.id;
  const reacted = feed.reactions(comment.id);
  const key = (k: string) => shortcuts && !phone && <DropdownMenuShortcut>{k}</DropdownMenuShortcut>;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger}>
        <DotsThreeIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Comment actions" align="end" className="md:w-[210px]">
        {phone && (
          <div className="flex justify-between border-b border-rule px-4 pb-3">
            {QUICK.map(([emoji, name]) => (
              <DropdownMenuItem
                key={emoji}
                aria-label={name}
                data-mine={reacted.some((g) => g.emoji === emoji && g.mine) || undefined}
                className="size-12 min-h-0! justify-center rounded-full! border border-rule bg-ground p-0! text-[22px]! data-mine:border-signal/55 data-mine:bg-signal/10"
                onClick={() => store.toggleReaction(comment.issueId, comment.id, emoji)}
              >
                {emoji}
              </DropdownMenuItem>
            ))}
          </div>
        )}
        <div className="max-md:pt-1.5">
          {phone && actions.onReply && (
            <DropdownMenuItem onClick={actions.onReply}>
              <ArrowBendUpLeftIcon />
              Reply
            </DropdownMenuItem>
          )}
          {actions.onQuote && (
            <DropdownMenuItem onClick={actions.onQuote}>
              <QuotesIcon />
              Quote in reply
              {key("Q")}
            </DropdownMenuItem>
          )}
          {issue && (
            <DropdownMenuItem onClick={() => void copy(linkTo(comment)!, "Link")}>
              <LinkIcon />
              Copy link
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void copy(comment.body, phone ? "Text" : "Markdown")}>
            <CopyIcon />
            {phone ? "Copy text" : "Copy as Markdown"}
          </DropdownMenuItem>
          {issue && (
            <DropdownMenuItem onClick={() => issueFromComment(comment.body, issue.projectId)}>
              <PlusIcon />
              New issue from comment
            </DropdownMenuItem>
          )}
        </div>
        {mine && (
          <>
            <DropdownMenuSeparator className="max-md:mx-5" />
            <DropdownMenuItem onClick={actions.onEdit}>
              <PencilSimpleIcon />
              Edit
              {key("E")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={actions.onDelete}>
              <TrashIcon />
              Delete
              {key("⌫")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** The toolbar in a hovered comment's top corner, inside its light (PLNR-207). Hidden by index.css until then; where it
 * always stands (no hover), it sits over the edge instead, off the text. */
function CommentToolbar({ comment, feed, actions, menu, className }: { comment: Comment; feed: IssueFeed; actions: CommentActions; menu: ReactElement; className: string }) {
  return (
    <div role="toolbar" aria-label="Comment actions" className={cn("comment-acts absolute z-3 flex items-center gap-px rounded-md border border-rule bg-panel p-0.5 shadow-pop pointer-coarse:-top-[15px] pointer-coarse:right-2 max-md:hidden", className)}>
      <ReactionPicker feed={feed} issueId={comment.issueId} commentId={comment.id}>
        <Button variant="ghost" size="icon-sm" aria-label="Add reaction" title="Add reaction" className="size-[26px]">
          <SmileyIcon />
        </Button>
      </ReactionPicker>
      {actions.onReply && (
        <Hint label={<KeyHint label="Reply" keys="R" />}>
          <Button variant="ghost" size="icon-sm" aria-label="Reply" className="size-[26px]" onClick={actions.onReply}>
            <ArrowBendUpLeftIcon />
          </Button>
        </Hint>
      )}
      <Hint label="Copy link">
        <Button variant="ghost" size="icon-sm" aria-label="Copy link" className="size-[26px]" onClick={() => void copy(linkTo(comment) ?? "", "Link")}>
          <LinkIcon />
        </Button>
      </Hint>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-rule" />
      {menu}
    </div>
  );
}

/** What stands in the avatar's place: an agent's mark is square. */
function CommentMark({ who, agent, nested }: { who: Face; agent: boolean; nested?: boolean | undefined }) {
  const place = cn("absolute z-1", nested ? "top-1.5 left-2.5 max-md:top-[5px] max-md:left-0" : "top-[7px] left-0 max-md:top-1");
  if (agent) return <AgentAvatar name={who.name} className={cn(place, nested ? "size-[22px] rounded-[6px] [&_svg]:size-[13px]" : "size-7 rounded-[7px] [&_svg]:size-4")} />;
  return <UserAvatar {...who} className={cn(place, nested ? "size-[22px]" : "size-7", "ring-3 ring-(--feed-ground,var(--color-panel))")} />;
}

/**
 * A comment that came since the viewer last read the issue: a signal dot and "new" in its header, by the time, where
 * the eye already is. On the comment, not on its author (an avatar ring read as the author's state), and not a bar down
 * its side (far from the text, long on a long comment, red as an error). It stays while the issue is open; nothing
 * lights up and fades. The one mark of "not read yet" everywhere: the event that just happened is the row flash.
 */
const NewMark = () => (
  <span className="inline-flex items-center gap-1 font-mono text-[11px] text-signal-text">
    <span aria-hidden className="size-1.5 rounded-full bg-signal" />
    new
  </span>
);

const CommentView = observer(function CommentView({
  comment,
  feed,
  now,
  onReply,
  onQuote,
  highlighted,
  nested,
  clock,
  footReply,
  shortcuts = false,
  className,
  children,
}: {
  comment: Comment;
  feed: IssueFeed;
  now: number;
  onReply?: (() => void) | undefined;
  /** Start a reply with this comment quoted. */
  onQuote?: (() => void) | undefined;
  /** The comment that brought the issue to the inbox: a ring round its avatar. */
  highlighted?: boolean;
  /** A reply in a thread: smaller, and on a phone its "…" only for its author. */
  nested?: boolean;
  /** On the clock, as in a feed with days marked. */
  clock?: boolean | undefined;
  /** On a phone: Reply beside the reactions (a comment with no thread under it yet). */
  footReply?: boolean;
  /** The menu names the keys of useCommentKeys. */
  shortcuts?: boolean;
  className?: string | undefined;
  /** The thread: under the comment, inside its hover. */
  children?: ReactNode;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">(() => (reopensDraft(`edit:${comment.id}`) ? "edit" : "view"));
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  const sheet = phone && menu;
  const author = comment.authorId ? store.users.get(comment.authorId) : undefined;
  const name = author?.name ?? "Unknown";
  const mine = !!comment.authorId && comment.authorId === store.me?.id;
  const agent = author?.kind === "agent";
  const pending = store.isPending(comment.id);
  const actions: CommentActions = { onReply, onQuote, onEdit: () => setMode("edit"), onDelete: () => setMode("confirm") };
  useEffect(() => {
    if (box.current) keyed.set(box.current, { r: onReply, q: onQuote, e: mine ? actions.onEdit : undefined, del: mine ? actions.onDelete : undefined });
  });
  if (comment.deletedAt) {
    return (
      <article aria-label="Deleted comment" className={cn("relative pl-10", className)}>
        <span className="absolute top-0 left-0 z-1 grid size-7 place-items-center rounded-full border-[1.5px] border-dashed border-faint bg-(--feed-ground,var(--color-panel)) text-ink-3">
          <TrashIcon className="size-[13px]" />
        </span>
        <div className="flex min-h-7 items-center gap-2 text-[12.5px] text-ink-3 max-md:text-[13px]">
          Comment deleted by {name}
          <time dateTime={comment.deletedAt} title={exactTime(comment.deletedAt)} className="font-mono text-[11px]">
            {clock ? clockTime(comment.deletedAt) : timeAgo(comment.deletedAt, now)}
          </time>
        </div>
        {children && <div className="mt-2">{children}</div>}
      </article>
    );
  }
  // Agents write through the API (and MCP later). The one they work for: the issue's person, when it is delegated to them.
  const issue = store.issues.get(comment.issueId);
  const owner = agent && issue?.delegateId === comment.authorId ? issue.assigneeIds.map((id) => store.users.get(id)).find((u) => u?.kind === "human") : undefined;
  const menuButton = (
    <Button variant="ghost" size="icon-sm" aria-label={phone ? "Comment actions" : "More"} title="More" className={phone ? "-my-1 ml-auto size-8 self-center text-ink-3" : "size-[26px]"} />
  );
  const commentMenu = <CommentMenu comment={comment} feed={feed} open={menu} onOpenChange={setMenu} trigger={menuButton} actions={actions} shortcuts={shortcuts} />;
  const body = (
    <>
      <header className="flex min-h-[22px] flex-wrap items-baseline gap-x-2 gap-y-1 max-md:items-center">
        <span className={cn("text-[13px] font-semibold text-ink max-md:text-[14px]", nested && "text-[12.5px] max-md:text-[13.5px]", agent && "font-mono text-[12.5px] font-medium max-md:text-[13.5px]")}>{name}</span>
        {agent && <Badge variant="pill">Agent</Badge>}
        {agent && !nested && <span className="text-[11.5px] text-ink-3 max-md:hidden">{owner ? `for ${owner.name} · via API` : "via API"}</span>}
        {viaWords(comment.via) && <span className="text-[11.5px] text-ink-3">{viaWords(comment.via)}</span>}
        <time dateTime={comment.createdAt} title={exactTime(comment.createdAt)} className="font-mono text-[11px] whitespace-nowrap text-ink-3">
          {clock ? clockTime(comment.createdAt) : timeAgo(comment.createdAt, now)}
        </time>
        {highlighted && <NewMark />}
        {mode === "edit" ? (
          <span className="text-[11.5px] text-ink-3">editing</span>
        ) : (
          comment.editedAt && (
            <span className="text-[11.5px] text-ink-3" title={`Edited ${exactTime(comment.editedAt)}`}>
              edited
            </span>
          )
        )}
        {phone && (!nested || mine) && commentMenu}
      </header>
      {mode === "edit" ? (
        <div className="mt-1">
          <Composer
            draftKey={`edit:${comment.id}`}
            initial={comment.body}
            placeholder="Edit comment"
            submitLabel="Save"
            tools="edit"
            autoFocus
            onSubmit={(text) => {
              store.editComment(comment.id, text);
              setMode("view");
            }}
            onCancel={() => setMode("view")}
          />
        </div>
      ) : (
        <MarkdownBody body={comment.body} className={cn("max-md:mt-0.5", nested ? "rich-reply" : "rich-comment", pending && "opacity-60")} />
      )}
      {pending && (
        <p className="mt-1.5 flex items-center gap-[7px] text-[12px] text-ink-3">
          <Spinner className="size-[13px]" />
          Saved here, sending…
        </p>
      )}
      {mode === "confirm" && (
        <div role="alert" className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-control-border px-3 py-1.5 text-caption">
          Delete this comment?
          <Button variant="destructive" size="sm" className="ml-auto" onClick={() => store.deleteComment(comment.id)}>
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </div>
      )}
      <ReactionBar feed={feed} issueId={comment.issueId} commentId={comment.id} className={cn("mt-2", nested && feed.reactions(comment.id).length === 0 && "max-md:hidden")} {...(nested ? {} : { onAdd: () => setMenu(true) })}>
        {footReply && onReply && (
          <Button type="button" variant="ghost" onClick={onReply} className="ml-auto gap-1.5 border-0 active:bg-row-hover max-md:h-8 max-md:rounded-md max-md:px-2 max-md:text-[13px] md:hidden">
            <ArrowBendUpLeftIcon className="size-[15px]" />
            Reply
          </Button>
        )}
      </ReactionBar>
    </>
  );
  const hover = "transition-colors duration-120 hover:bg-row-hover max-md:hover:bg-transparent";
  // The comment's own surface carries the light of a link. On a phone it has no padding of its own: this margin keeps the
  // light off the text without moving it.
  const surface = "max-md:-m-1 max-md:p-1";
  const toolbar = !phone && <CommentToolbar comment={comment} feed={feed} actions={actions} menu={commentMenu} className={nested ? "top-0.5 right-1" : "-top-px right-0"} />;
  // A reply's own box holds its avatar; a top comment's stops at the avatar, which stands on the feed's rule.
  if (nested) {
    return (
      <article id={`comment-${comment.id}`} className={cn("relative max-md:pt-1 max-md:pb-0.5 max-md:pl-8 md:-ml-2.5", className)}>
        <div ref={box} data-comment="" data-comment-lit="" className={cn("comment-box rounded-sm md:rounded-md md:py-[5px] md:pr-2.5 md:pl-[42px]", hover, surface)}>
          <CommentMark who={face(author, name)} agent={agent} nested />
          {toolbar}
          {body}
        </div>
      </article>
    );
  }
  return (
    <article id={`comment-${comment.id}`} className={cn("comment-row relative pl-10 max-md:pt-1 max-md:pb-0.5", className)}>
      <CommentMark who={face(author, name)} agent={agent} />
      <div ref={box} data-comment="" className="comment-box relative md:-ml-2.5 md:rounded-lg">
        {toolbar}
        {/* The sheet's comment is lit, not its thread; the light reaches under the avatar. */}
        <div data-comment-lit="" className={cn("relative rounded-sm md:rounded-lg md:px-2.5 md:pt-1.5 md:pb-2", surface, sheet && "max-md:-mr-2.5 max-md:-ml-[50px] max-md:rounded-lg max-md:bg-row-selected max-md:pr-2.5 max-md:pl-[50px]")}>
          {body}
        </div>
        {children && <div className="max-md:mt-2 md:px-2.5 md:pb-2">{children}</div>}
      </div>
    </article>
  );
});

/** How long after it was written a comment still counts as just arrived. */
const FRESH_MS = 3000;
/** A longer thread folds to its last reply. */
const FOLD_REPLIES = 2;

/** A thread as the ledger draws it: no box, the replies in the comment's column, smaller. */
export const Thread = observer(function Thread({
  thread,
  feed,
  now,
  highlight,
  clock,
  reply,
  className,
}: {
  thread: CommentThread;
  feed: IssueFeed;
  now: number;
  /** Comments to frame (the inbox's). */
  highlight?: ReadonlySet<string> | undefined;
  /** Times on the clock (a feed with days marked). */
  clock?: boolean;
  /** The issue's feed keeps one reply open at a time: a wide pane writes it in the thread, a phone in the bottom field. Without it the thread has its own. */
  reply?: FeedReply & { active: boolean };
  className?: string;
}) {
  const phone = useIsPhone();
  const [own, setOwn] = useState(false);
  const { comment, replies } = thread;
  // A reply that has to be seen is not folded: the inbox's, or the one a link points at.
  const [unfolded, setUnfolded] = useState(() => replies.some((r) => highlight?.has(r.id)));
  const hash = useHash();
  const canReply = !comment.deletedAt;
  const startReply = () => (reply ? reply.start(comment) : setOwn(true));
  const endReply = () => (reply ? reply.end() : setOwn(false));
  const replying = reply ? reply.active && !phone : own;
  const quote = (c: Comment) => (reply ? () => reply.start(comment, c) : undefined);
  const folded = replies.length > FOLD_REPLIES && !unfolded && !replies.some((r) => hash === `#comment-${r.id}`) ? replies.length - 1 : 0;
  const issue = store.issues.get(comment.issueId);
  const under = (replies.length > 0 || replying) && (
    <div className="flex flex-col gap-0.5">
      {folded > 0 && (
        <Button type="button" variant="ghost" onClick={() => setUnfolded(true)} className="-ml-2 flex h-7 w-fit gap-2 border-0 px-2 font-normal max-md:ml-0 max-md:h-8 max-md:px-0 max-md:text-[13px]">
          <UserAvatarStack people={[...new Set(replies.slice(0, folded).map((r) => r.authorId))].map((id) => faceOf(id, "Unknown"))} />
          {folded} earlier {folded > 1 ? "replies" : "reply"}
        </Button>
      )}
      {replies.map((r, i) => (
        <CommentView key={r.id} comment={r} feed={feed} now={now} clock={clock} nested shortcuts={!!reply} highlighted={!!highlight?.has(r.id)} className={cn(i < folded && "hidden")} {...(canReply ? { onReply: startReply, onQuote: quote(r) } : {})} />
      ))}
      {replying && (
        <div className="mt-1.5">
          <Composer
            issue={issue}
            quotes={!!reply}
            draftKey={`reply:${comment.id}`}
            placeholder="Reply…"
            submitLabel="Reply"
            tools="reply"
            autoFocus
            onSubmit={(body) => {
              store.addComment(comment.issueId, body, comment.id);
              endReply();
            }}
            onCancel={endReply}
          />
        </div>
      )}
      {canReply && !replying && (
        <>
          <button type="button" onClick={startReply} className="mt-1 flex h-[34px] w-full cursor-text items-center gap-2.5 rounded-md border border-rule bg-field px-2.5 text-left text-[13px] text-ink-3 transition-colors duration-120 hover:border-rule-strong max-md:hidden">
            <UserAvatar {...face(store.me, "You")} />
            Reply…
          </button>
          <Button type="button" variant="ghost" className={cn("flex w-fit border-0 max-md:h-8 max-md:px-0 max-md:text-[13px] md:hidden", reply?.active ? "text-signal-text" : "text-ink-2")} onClick={startReply}>
            <ArrowBendUpLeftIcon className="size-[15px]" />
            {reply?.active ? "Replying below" : "Reply to thread"}
          </Button>
        </>
      )}
    </div>
  );
  // Only a comment that just arrived slides in: not every thread each time an issue opens, which shakes J/K (PLNR-82).
  return (
    <div className={cn(Date.now() - Date.parse(comment.createdAt) < FRESH_MS && "animate-in duration-300 fade-in-0 slide-in-from-bottom-1", className)}>
      <CommentView
        comment={comment}
        feed={feed}
        now={now}
        clock={clock}
        shortcuts={!!reply}
        highlighted={!!highlight?.has(comment.id)}
        footReply={replies.length === 0}
        {...(canReply ? { onReply: startReply, onQuote: quote(comment) } : {})}
      >
        {under}
      </CommentView>
    </div>
  );
});
