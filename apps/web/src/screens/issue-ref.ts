// Issue keys in text (PLNR-43): "PLNR-27" in a description or a comment links the issue (packages/editor issue-ref.ts
// finds them), and hovering one shows the issue's card. Readers and editors draw keys as plain elements, so this is one
// set of listeners on the document, not a component per key: a click on a key opens the issue in place, a pointer
// that rests on one for a moment asks the card (issue-ref-card.tsx, in the lazy edit chunk) to show. A key that leaves the
// page sends no pointerout, so the card also closes on any key press (j/k in the inbox redraw the text), on navigation and
// when another popup opens (the app's shortcuts stop their keys before any other listener).
import { makeAutoObservable, observableRef, reaction } from "mobx";
import { navigateOnClick, router } from "../router.ts";
import { store } from "../store.ts";
import { createIssue } from "./create-state.ts";
import { issuePath } from "./issue-actions.ts";
import { palette } from "./palette-state.ts";
import { rowPopup } from "./row-popup.ts";
import { viewPanel } from "./view-panel-state.ts";

/** The address of the issue a key names; none for a key the workspace has no live issue for. */
export function issueHref(key: string): string | undefined {
  const issue = store.issueByKey(key);
  return issue && !issue.deletedAt ? issuePath(issue) : undefined;
}

const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 200;

class IssueRefHover {
  current: { key: string; anchor: HTMLElement } | null = null;

  constructor() {
    makeAutoObservable(this, { current: observableRef });
  }

  show(key: string, anchor: HTMLElement): void {
    this.current = { key, anchor };
  }

  close(): void {
    this.current = null;
  }
}

export const issueRefHover = new IssueRefHover();

let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

/** The pointer is on the key or on its card: stay open. */
export function holdIssueCard(): void {
  clearTimeout(closeTimer);
}

/** The pointer left the key or the card: close soon, unless it comes back to either. */
export function releaseIssueCard(): void {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => issueRefHover.close(), CLOSE_DELAY_MS);
}

const keyAt = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".rich-text [data-issue]") : null);

function onOver(e: PointerEvent): void {
  if (e.pointerType === "touch") return;
  if (issueRefHover.current && !issueRefHover.current.anchor.isConnected) issueRefHover.close();
  const el = keyAt(e.target);
  if (!el) return;
  holdIssueCard();
  if (issueRefHover.current?.anchor === el) return;
  clearTimeout(openTimer);
  openTimer = setTimeout(() => issueRefHover.show(el.dataset.issue!, el), OPEN_DELAY_MS);
}

function onOut(e: PointerEvent): void {
  const el = keyAt(e.target);
  if (el && !el.contains(e.relatedTarget as globalThis.Node | null)) releaseIssueCard();
}

const closeNow = () => {
  clearTimeout(openTimer);
  if (issueRefHover.current) issueRefHover.close();
};

/** A plain click on a key in an editor (the description, a comment being written): the issue opens here (RSVA-484). */
export function openIssueRef(href: string): void {
  closeNow();
  router.push(href);
}

/** A modifier alone keeps the card: Cmd or Ctrl is held for a click that opens the key in a new tab. */
const onKey = (e: KeyboardEvent) => {
  if (!["Meta", "Control", "Shift", "Alt"].includes(e.key)) closeNow();
};

/** A plain click on a key in read-only text opens the issue here; modified clicks keep the browser's behaviour. */
function onClick(e: MouseEvent): void {
  const a = !e.defaultPrevented && e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a.issue-ref") : null;
  if (a) navigateOnClick(e, a.pathname, closeNow);
}

/** Installs the listeners; returns their removal. */
export function watchIssueRefs(): () => void {
  document.addEventListener("pointerover", onOver);
  document.addEventListener("pointerout", onOut);
  document.addEventListener("click", onClick);
  window.addEventListener("keydown", onKey, true);
  const offRoute = reaction(() => [router.path, createIssue.open, palette.open, rowPopup.current, viewPanel.open], closeNow);
  return () => {
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut);
    document.removeEventListener("click", onClick);
    window.removeEventListener("keydown", onKey, true);
    offRoute();
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  };
}
