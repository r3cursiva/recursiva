// Whether a settings page's changes reached the server, in its header: settings have no Save button, they save as they
// change (PLNR-194). After the artboards (NavProjectSettings, NavAccountSettings, NotifRules, LedgerSettings): "Saved"
// with a check, then "All changes saved"; until the first change the page's own note stands there. Edits through the
// sync engine are followed by its queue (store.saveState, a rejection), REST ones (Profile) are handed to `track`.
// A refusal keeps its toast with the reason; the header only says the change was not saved.
import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@rsva/ui/lib/utils";
import { makeAutoObservable, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { store } from "../store.ts";
import { notice } from "./notice.ts";
import { errorText } from "@rsva/schema/util";

/** How long "Saved" stands before it settles into "All changes saved", as on the NotifRules artboard. */
const SAVED_MS = 1600;

type Phase = "idle" | "saving" | "saved" | "all" | "failed";

class SettingsSave {
  phase: Phase = "idle";
  /** REST requests on their way. */
  private requests = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    makeAutoObservable<SettingsSave, "requests" | "timer">(this, { requests: false, timer: false });
  }

  /** A change saved by a request of its own; the promise is returned as it is. */
  track<T>(p: Promise<T>): Promise<T> {
    this.requests++;
    this.phase = "saving";
    p.then(
      () => this.settle(true),
      () => this.settle(false),
    );
    return p;
  }

  private settle(ok: boolean): void {
    this.requests--;
    if (!ok) this.phase = "failed";
    else if (this.phase === "saving") this.done();
  }

  /** The sync queue started on a change, emptied, or one of its changes was refused. */
  synced(state: "saving" | "saved" | "refused"): void {
    if (state === "refused") this.phase = "failed";
    else if (state === "saving") this.phase = "saving";
    else if (this.phase === "saving") this.done();
  }

  private done(): void {
    if (this.requests > 0 || store.saveState !== "saved") return;
    this.phase = "saved";
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rest(), SAVED_MS);
  }

  private rest(): void {
    if (this.phase === "saved") this.phase = "all";
  }

  /** Another page: its note again until its first change. */
  reset(): void {
    clearTimeout(this.timer);
    this.phase = this.requests > 0 ? "saving" : "idle";
  }
}

const settingsSave = new SettingsSave();

/** A REST save from a settings page: in the header's status, and a refusal's reason in a toast. */
export const saving = (p: Promise<unknown>) => void settingsSave.track(p).catch((e: unknown) => notice.show(errorText(e)));

/** The header's status: the page's note until a change, then how that change went. */
export const SaveStatus = observer(function SaveStatus({ page, note, className }: { page: string; note?: string; className?: string }) {
  useEffect(() => {
    settingsSave.reset();
    const queue = reaction(
      () => store.saveState === "saved",
      (idle) => settingsSave.synced(idle ? "saved" : "saving"),
    );
    const refused = reaction(
      () => store.lastRejection,
      (r) => r && settingsSave.synced("refused"),
    );
    return () => (queue(), refused());
  }, [page]);
  const phase = settingsSave.phase;
  const text =
    phase === "saving"
      ? store.saveState === "offline"
        ? "Offline · saves when back"
        : "Saving…"
      : phase === "saved"
        ? "Saved"
        : phase === "all"
          ? "All changes saved"
          : phase === "failed"
            ? "Not saved"
            : note;
  if (!text) return null;
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 truncate font-mono text-meta",
        phase === "saved" ? "text-success" : phase === "failed" ? "text-signal-text" : "text-ink-3",
        phase === "saved" && "animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200",
        className,
      )}
    >
      {phase === "saved" && <CheckIcon weight="bold" className="size-3 shrink-0" />}
      {text}
    </span>
  );
});
