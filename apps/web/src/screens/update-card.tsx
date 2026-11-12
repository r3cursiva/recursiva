// A new version waits while the page is in use (lib/new-version.ts, RSVA-459): a card above the sidebar's foot, by the
// avatar, after the UpdateAvailable artboard; on the phone the same card over the tab bar. The collapsed sidebar has no
// room for it: a button in its foot does the card's Reload.
import { ArrowsClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@rsva/ui/components/button";
import { Spinner } from "@rsva/ui/components/spinner";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { later, reloadNow, updateCard } from "../lib/new-version.ts";
import { Tip, TipNote } from "./sidebar-tip.tsx";

/** `className` places it: absolute, over what it sits on. */
export const UpdateCard = observer(function UpdateCard({ className }: { className?: string }) {
  const card = updateCard();
  if (!card) return null;
  const reloading = card === "reloading";
  return (
    <div
      role="status"
      className={cn(
        // Over a list of the same ground on the phone, it takes the toast's shadow and a stronger edge.
        "absolute z-50 flex flex-col gap-2.5 rounded-[10px] bg-panel py-3 pr-3 pl-3.5 shadow-pop ring-1 ring-rule max-md:shadow-toast max-md:ring-rule-strong animate-in fade-in slide-in-from-bottom-2 duration-350 ease-out",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-body font-semibold text-ink">
        <ArrowsClockwiseIcon className="size-3.5 shrink-0" />A new version is ready
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Later" title="Later" onClick={later} className="-mr-1 ml-auto text-ink-3 max-md:size-11">
          <XIcon />
        </Button>
      </div>
      <p className="text-label text-ink-2">Reload when it suits you. You come back to this screen, drafts included.</p>
      <Button type="button" onClick={reloadNow} disabled={reloading} className="self-start">
        {reloading && <Spinner className="size-3.5" />}
        {reloading ? "Reloading…" : "Reload"}
      </Button>
    </div>
  );
});

/** The collapsed sidebar's stand-in for the card: one button in its foot. */
export const UpdateButton = observer(function UpdateButton() {
  const card = updateCard();
  if (!card) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="A new version is ready: reload"
      disabled={card === "reloading"}
      onClick={reloadNow}
      className="group/tip relative hidden size-[34px] place-items-center rounded-[7px] border-0 text-ink strip:grid"
    >
      {card === "reloading" ? <Spinner className="size-[18px]" /> : <ArrowsClockwiseIcon className="size-[18px]" />}
      {/* The dot an urgent project has in the strip (sidebar.tsx): the button is new there, not one of the usual ones. */}
      <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-signal ring-2 ring-sidebar" />
      <Tip>
        Update ready
        <TipNote>reload</TipNote>
      </Tip>
    </Button>
  );
});
