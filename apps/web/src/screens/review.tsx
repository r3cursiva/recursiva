// Review where the work shows (RSVA-597). A title is not enough to approve by, so the rows that list reviews (the project
// home's Waiting on you, My work) only open the issue; the decision is the review bar's, on the issue, over its
// description, the hand-off note and the pull request. Send back asks what to fix: the agent gets it as a comment. Opened
// from a list of reviews, the issue walks them (J/K, "2 of 5") and a decision opens the next.
import { commentLine } from "@rsva/protocol";
import { compactAge } from "@rsva/display/time";
import { pullUrl, type GithubLink, type Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Kbd } from "@rsva/ui/components/kbd";
import { keys } from "@rsva/ui/lib/keys";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { githubRows, pullLabel } from "../lib/github.ts";
import { reviewAsk, waitsOnReview } from "../lib/my-work.ts";
import { useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { Face } from "./face.tsx";
import { PullVerdicts } from "./github-panel.tsx";
import { PullStateIcon } from "./github-parts.tsx";
import { ignoredKey } from "./list-view.ts";
import { useWindowKeys } from "./list-keys.ts";
import { notice } from "./notice.ts";
import { Composer } from "./rich-editors.tsx";

/** The project's review step and the step work goes back to: the third started state and the first. */
function moves(issue: Issue) {
  const started = store.statesOf(issue.projectId).filter((s) => s.group === "started");
  return { approve: started[2], back: started[0] };
}

/** The pull request a review is about: the first open one, else the latest. */
const pullOf = (issue: Issue): GithubLink | undefined => githubRows(store.githubOf(issue.id)).pulls[0];

/**
 * Over the issue while its review waits on the viewer: who asks and since when, their latest note, the pull request with
 * its checks, Approve (⇧A) and Send back (⇧B). `onDecided` runs after either: the queue opens the next review.
 */
export const ReviewBar = observer(function ReviewBar({ issue, onDecided }: { issue: Issue; onDecided?: (() => void) | undefined }) {
  const [sending, setSending] = useState(false);
  useEffect(() => setSending(false), [issue.id]);
  const now = useNow();
  const me = store.me?.id;
  const shown = !!me && waitsOnReview(store, issue);
  const { approve, back } = moves(issue);
  const key = store.issueKey(issue);
  const decide = (stateId: string, reason?: string) => {
    const was = { stateId: issue.stateId };
    const comment = reason ? store.addComment(issue.id, reason) : null;
    store.updateIssue(issue.id, { stateId });
    notice.show(reason ? `${key} sent back` : `${key} → ${store.states.get(stateId)?.name}`, () => {
      store.updateIssue(issue.id, was);
      if (comment) store.deleteComment(comment.id);
    });
    setSending(false);
    onDecided?.();
  };
  useWindowKeys((e) => {
    if (!shown || !e.shiftKey || ignoredKey(e) || sending) return;
    const k = e.key.toLowerCase();
    if (k === "a" && approve) decide(approve.id);
    else if (k === "b" && back) setSending(true);
    else return;
    e.preventDefault();
  });
  if (!shown || !me) return null;
  const { from, since } = reviewAsk(store, me, issue);
  const name = (from && store.users.get(from)?.name) ?? "the assignee";
  const note = from ? store.feed(issue.id).threads.flatMap((t) => [t.comment, ...t.replies]).filter((c) => c.authorId === from && !c.deletedAt).at(-1) : undefined;
  const pull = pullOf(issue);

  return (
    <section aria-label="Review" className="shrink-0 border-b bg-panel px-5 py-2.5 max-md:px-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        {from && <Face id={from} />}
        <span className="text-[13px] text-ink">
          {from ? (
            <>
              <span className="font-semibold">{name}</span> asks for your review
            </>
          ) : (
            "Waiting for your review"
          )}
        </span>
        <span className="font-mono text-[11.5px] text-ink-3">{compactAge(Math.max(now - Date.parse(since), 60_000))}</span>
        {pull && <PullLine pull={pull} label={pullLabel(pull, githubRows(store.githubOf(issue.id)).pulls)} />}
        {!sending && (
          <span className="ml-auto flex items-center gap-1.5 max-md:w-full">
            {back && (
              <Button variant="outline" size="sm" className="max-md:h-11 max-md:flex-1" onClick={() => setSending(true)}>
                Send back
                <Kbd>{keys("shift", "B")}</Kbd>
              </Button>
            )}
            {approve && (
              <Button size="sm" className="max-md:h-11 max-md:flex-1" onClick={() => decide(approve.id)}>
                Approve
                <Kbd inverse>{keys("shift", "A")}</Kbd>
              </Button>
            )}
          </span>
        )}
      </div>
      {note && (
        <p className="mt-1.5 text-[12.5px] leading-[1.45] text-ink-2">
          {commentLine(note.body)}{" "}
          <a href={`#comment-${note.id}`} className="whitespace-nowrap text-ink-3 outline-none hover:text-ink focus-visible:text-ink">
            Read the note ↓
          </a>
        </p>
      )}
      {sending && back && (
        <div className="mt-2.5">
          <Composer
            issue={issue}
            draftKey={`send-back:${issue.id}`}
            placeholder={from ? `What to fix: ${name} gets it as a comment` : "What to fix: it goes in as a comment"}
            submitLabel="Send back"
            tools="reply"
            autoFocus
            onSubmit={(body) => decide(back.id, body)}
            onCancel={() => setSending(false)}
          />
        </div>
      )}
    </section>
  );
});

/** "#436 ✓ Checks pass · Approved", opening the pull request on GitHub. */
function PullLine({ pull, label }: { pull: GithubLink; label: string }) {
  return (
    <a
      href={pullUrl(pull)}
      target="_blank"
      rel="noopener"
      title={`${pull.title} · opens on GitHub`}
      className="inline-flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-2 outline-none hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PullStateIcon state={pull.state ?? "open"} className="size-3.5" />
      <span className="font-mono text-ink-3">{label}</span>
      <PullVerdicts pull={pull} />
    </a>
  );
}

