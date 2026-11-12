// A short confirmation toast ("Link copied"), one at a time; overlays.tsx shows it. A change that can be put back
// passes `undo`: the toast then offers Undo, and ⌘Z does the same while it shows.
import { makeAutoObservable, observableRef } from "mobx";
import { errorText } from "@rsva/schema/util";

class Notice {
  text: string | null = null;
  undo: (() => void) | null = null;
  /** A name the message is about, in mono. */
  code: string | null = null;
  /** A copy that failed: why, and the text to take by hand from a field in the toast. */
  failed: { detail: string; label: string; value: string } | null = null;
  /** An issue just created: the toast shows its key, as soon as it has one, and Open. */
  issueId: string | null = null;
  /** Bumped by each show(): the same text twice restarts the toast's timer. */
  n = 0;

  constructor() {
    makeAutoObservable<Notice, "put">(this, { undo: observableRef, failed: observableRef, put: false });
  }

  show(text: string, undo?: () => void): void {
    this.put(text);
    this.undo = undo ?? null;
  }

  /** "Branch name copied" with the name. */
  showCode(text: string, code: string): void {
    this.put(text);
    this.code = code;
  }

  /** Stays until dismissed: the text to copy is in the toast. */
  showFailed(text: string, failed: NonNullable<Notice["failed"]>): void {
    this.put(text);
    this.failed = failed;
  }

  /** The issue's title, its key and Open. */
  showCreated(text: string, issueId: string): void {
    this.put(text);
    this.issueId = issueId;
  }

  private put(text: string): void {
    this.clear();
    this.text = text;
    this.n++;
  }

  clear(): void {
    this.text = null;
    this.undo = null;
    this.code = null;
    this.failed = null;
    this.issueId = null;
  }

  runUndo(): void {
    const undo = this.undo;
    this.clear();
    undo?.();
  }
}

export const notice = new Notice();

/** A request behind a button: its toast when done, the server's reason when refused. */
export const reported = (p: Promise<unknown>, done: string): Promise<void> =>
  p.then(
    () => notice.show(done),
    (e: unknown) => notice.show(errorText(e)),
  );

/** The clipboard write starts in the caller's tick: it needs the click's or the key press's user activation. */
export async function toClipboard(text: string, done: () => void, failed: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    failed();
  }
}

/** A name copied: the toast shows it; when the browser refuses, the same name in a field, with `detail` saying how to take it. */
export function copyName(name: string, what: string, detail: string): Promise<void> {
  return toClipboard(
    name,
    () => notice.showCode(`${what} copied`, name),
    () => notice.showFailed(`Couldn’t copy the ${what.toLowerCase()}`, { detail, label: what, value: name }),
  );
}
