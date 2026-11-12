// A request behind a button or a form: its busy state and its error line, one shape for the sign-in, invite, workspace and
// account screens (RSVA-426). The error is the request's own text (errorText); `caught` takes the errors a screen answers
// otherwise: a dismissed passkey dialog, a server asking for a recent sign-in (useFreshAction, account-menu.tsx).
import { errorText } from "@rsva/schema/util";
import { useState } from "react";

interface RunOptions {
  /** What is busy, for a list with one button per row: `busyTag` while it runs. */
  tag?: string;
  /** The request ends by leaving the page (location.assign, sign-out): busy stays on after it succeeds, so nothing runs twice. */
  leaves?: boolean;
}

/** `caught` returns true for an error it handled itself: the error line stays empty. */
export function useAction(caught?: (e: unknown) => boolean) {
  const [running, setRunning] = useState<string | true | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<void>, { tag, leaves = false }: RunOptions = {}): Promise<void> => {
    setRunning(tag ?? true);
    setError(null);
    try {
      await f();
      if (!leaves) setRunning(null);
    } catch (e) {
      if (!caught?.(e)) setError(errorText(e));
      setRunning(null);
    }
  };
  return { busy: running !== null, busyTag: typeof running === "string" ? running : null, error, setError, run };
}

/** A form's error under its fields, if any. */
export const ErrorLine = ({ error }: { error: string | null | undefined }) =>
  error ? (
    <p role="alert" className="m-0 text-xs text-signal-text">
      {error}
    </p>
  ) : null;
