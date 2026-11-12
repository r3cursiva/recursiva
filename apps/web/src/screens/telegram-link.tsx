// What the two Telegram link dialogs share (PLNR-202, PLNR-204): a code good for ten minutes and its countdown, the
// long request the server answers when the code arrives in Telegram, numbered steps, and a field to copy from.
import { CopyIcon } from "@phosphor-icons/react";
import type { TelegramView } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, call } from "../lib/api.ts";
import { copyName, notice } from "./notice.ts";
import { errorText } from "@rsva/schema/util";

/** A failed request's handler: `onReauth` when the server wants a recent sign-in first, its message as a notice otherwise. */
export const reauthOr = (onReauth: () => void) => (e: unknown) => (e instanceof ApiError && e.code === "reauth_required" ? onReauth() : notice.show(errorText(e)));

/** Seconds left as m:ss. */
export const left = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/**
 * Asks for a code when `active` turns on, and again each time `round` moves on ("New link"). `reauth`: the server wants
 * a recent sign-in first (the personal chat, PLNR-223; a group, PLNR-246), and the next round asks again.
 */
export function useLinkCode<T>(path: string, body: unknown, active: boolean, round: number): { link: T | null; error: string | null; reauth: boolean } {
  const [link, setLink] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const json = JSON.stringify(body ?? null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setLink(null);
    setError(null);
    setReauth(false);
    call<T>("POST", path, JSON.parse(json) ?? undefined).then(
      (l) => live && setLink(l),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === "reauth_required") setReauth(true);
        else setError(errorText(e));
      },
    );
    return () => void (live = false);
  }, [path, json, active, round]);
  return { link, error, reauth };
}

/** The time each second while a code is live, and whether it has run out. */
export function useCountdown(link: { expiresAt: string } | null, done: boolean): { now: number; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!link || done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [link, done]);
  return { now, expired: !!link && Date.parse(link.expiresAt) <= now };
}

/**
 * Waits on `path` (the server holds it until the code arrives, or 25 seconds) while `active`, until `accept` takes an
 * answer; a failed wait tries again after a pause. `accept` is read when an answer comes, so it may change meanwhile.
 */
export function useTelegramWait(path: string, active: boolean, accept: (t: TelegramView) => boolean): void {
  const latest = useRef(accept);
  latest.current = accept;
  useEffect(() => {
    if (!active) return;
    const stop = new AbortController();
    const wait = async () => {
      while (!stop.signal.aborted) {
        try {
          if (latest.current(await call<TelegramView>("GET", path, undefined, stop.signal))) return;
        } catch {
          if (stop.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    void wait();
    return () => stop.abort();
  }, [path, active]);
}

/** In place of the steps after Cancel on the sign-in screen: why a recent sign-in is needed, and the way back to it. */
export function ReauthNote({ why, onConfirm }: { why: string; onConfirm: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2.5 text-ink-2 max-md:flex-wrap">
      <span className="flex-1">{why}</span>
      <Button variant="outline" onClick={onConfirm}>
        Confirm it's you
      </Button>
    </div>
  );
}

export function Step({ n, children }: { n: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5">
      <span className="grid size-[22px] place-items-center rounded-full border border-rule-strong font-mono text-[11px] text-ink-2">{n}</span>
      <div className="flex min-w-0 flex-col items-start gap-2">{children}</div>
    </li>
  );
}

/** Text in a mono field with a copy button: a link, or a command to send. */
export function CopyField({ text, label, what }: { text: string; label: string; what: string }) {
  return (
    <span className="inline-flex h-[30px] max-w-full items-center gap-2 rounded-[6px] border border-control-border bg-input pr-1.5 pl-2.5 font-mono text-[12px]">
      <span className="truncate">{text}</span>
      <button
        type="button"
        aria-label={label}
        onClick={() => void copyName(text, what, "Select it and copy it by hand.")}
        className="grid size-6 shrink-0 place-items-center rounded-[4px] text-ink-3 outline-none hover:bg-row-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:size-11"
      >
        <CopyIcon className="size-[13px]" />
      </button>
    </span>
  );
}
