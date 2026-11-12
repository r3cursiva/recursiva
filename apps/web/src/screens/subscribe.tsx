// Subscribe and Unsubscribe (PLNR-28): a quiet button with a bell and a label in the issue's activity header, the bell alone in a phone's top bar;
// ⇧S where an issue is open does the same (subscription.ts). The tooltip says what the press does and why the state
// holds; the bell rings when it turns on and hushes when it turns off. An involved viewer who unsubscribed sees a note
// that what is addressed to them still arrives. The choice is a mark of the viewer's (packages/sync/src/inbox.ts).
import { BellIcon, BellSlashIcon } from "@phosphor-icons/react";
import type { Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Kbd } from "@rsva/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@rsva/ui/components/tooltip";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useId, useState } from "react";
import { store } from "../store.ts";
import { toggleSubscription } from "./subscription.ts";

const ROLE = { assignee: "you’re the assignee", creator: "you created it", commenter: "you commented" } as const;

/** The bell, and with `labelled` the word for what a press does: a phone's top bar has no room for it. */
export const SubscribeButton = observer(function SubscribeButton({ issue, labelled, className, wordClassName }: { issue: Issue; labelled?: boolean; className?: string; /** The word beside the bell: a caller hides it where room runs out (the button keeps its name). */ wordClassName?: string }) {
  const s = store.inbox.subscription(issue);
  const key = store.issueKey(issue);
  const tipId = useId();
  // Bumped by each press: the icon remounts and plays its animation once, never on first render.
  const [pressed, setPressed] = useState(0);
  const title = s.following ? "Unsubscribe" : s.chosen && s.involved ? "Subscribe again" : "Subscribe";
  const body = s.following
    ? "Stops state changes and new comments. Anything addressed to you still arrives."
    : "Get state changes and new comments from now on. Only you see this.";
  const why = s.following
    ? s.involved
      ? `On because ${ROLE[s.involved]}.`
      : "You subscribed by hand."
    : s.involved
      ? `Off by hand, though ${ROLE[s.involved]}.`
      : "You’re not involved in this issue.";
  const Icon = s.following ? BellIcon : BellSlashIcon;
  return (
    <span className="group/tip relative">
      <TooltipProvider>
        <Tooltip>
          {/* Stays open through a press: the tooltip reads the state it has just turned to. */}
          <TooltipTrigger
            closeOnClick={false}
            render={
              <Button
                variant={labelled ? "outline" : "ghost"}
                size={labelled ? "sm" : "icon"}
                aria-pressed={s.following}
                aria-label={s.following ? `Unsubscribe from ${key}` : `Subscribe to ${key}`}
                aria-describedby={tipId}
                className={cn(className, labelled ? "font-normal text-ink-2" : s.following ? "text-ink" : "text-ink-3")}
                onClick={() => {
                  setPressed((n) => n + 1);
                  toggleSubscription(issue);
                }}
              />
            }
          >
            <Icon key={pressed} data-icon="inline-start" className={cn("transition-transform group-active/tip:scale-[.88]", pressed > 0 && (s.following ? "origin-[50%_15%] animate-bell-ring" : "animate-bell-hush"))} />
            {labelled && (
              // Both words take one cell, so the button keeps its width and a second press lands on it.
              <span className={cn("grid justify-items-center", wordClassName)}>
                <span className="[grid-area:1/1]">{s.following ? "Unsubscribe" : "Subscribe"}</span>
                <span aria-hidden className="invisible [grid-area:1/1]">
                  Unsubscribe
                </span>
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" alignOffset={labelled ? 0 : -6} sideOffset={8} className="max-w-[248px] flex-col items-stretch gap-0 px-2.5 pt-2 pb-[9px] pointer-coarse:hidden has-data-[slot=kbd]:pr-2.5 max-md:hidden">
            <span className="flex items-center gap-2 text-label font-semibold">
              {title}
              <Kbd inverse className="ml-auto">
                {keys("shift", "S")}
              </Kbd>
            </span>
            <span className="mt-[3px] block text-caption opacity-90">{body}</span>
            <span className="mt-1.5 block border-t border-kbd-on-inverse pt-1.5 text-[11.5px] text-kbd-ink-on-inverse">{why}</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* The tooltip is in the page only while open; this keeps the button's description for a screen reader. */}
      <span id={tipId} className="sr-only">
        {title}. {body} {why}
      </span>
    </span>
  );
});

/** What still arrives after Unsubscribe. */
export function UnsubscribedNote() {
  return (
    <div role="status" className="flex animate-in items-center gap-2.5 rounded-md border bg-ground px-3 py-2 text-label text-ink-2 duration-300 fade-in-0 slide-in-from-bottom-1">
      <BellSlashIcon className="size-3.5 shrink-0 text-ink-3" />
      <span className="flex-1">Unsubscribed. Earlier notifications stay in your Inbox; assignments, reviews, approvals, mentions and replies to you still arrive.</span>
    </div>
  );
}
