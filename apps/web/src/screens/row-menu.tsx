// Opening the row menu: right click on a row or card, or its "…" button. The menu itself is in row-popup-host.tsx.
import { DotsThreeIcon } from "@phosphor-icons/react";
import { cn } from "@rsva/ui/lib/utils";
import type { MouseEvent } from "react";
import { pointAnchor, rowPopup } from "./row-popup.ts";

function issueOf(el: Element): string | null {
  return el.closest("[data-issue]")?.getAttribute("data-issue") ?? null;
}

/** Right click: the menu at the pointer. A right click inside an open popup or on a text field keeps the browser's menu. */
export function onRowMenu(e: MouseEvent<HTMLElement>): void {
  const id = issueOf(e.currentTarget);
  if (!id || (e.target as Element).closest("input, textarea")) return;
  e.preventDefault();
  rowPopup.open("menu", id, pointAnchor(e.clientX, e.clientY));
}

const HOLD = 450;
const SLIP = 10;

/**
 * Holding a finger on a row or card opens the same menu. iOS sends no contextmenu for it, so the press is timed here. The
 * lift after a hold is cancelled: a browser that still sends the mouse events of a tap (Chromium does) would otherwise
 * press outside the open menu with them and close it at once (PLNR-283); the click is dropped too, should one come.
 */
export function watchLongPress(): () => void {
  let timer = 0;
  let x = 0;
  let y = 0;
  let held = false;
  const cancel = () => clearTimeout(timer);
  const start = (e: TouchEvent) => {
    held = false;
    const t = e.touches[0];
    const target = e.target instanceof Element ? e.target : null;
    const id = target?.closest("button, input, textarea") ? null : target && issueOf(target);
    if (!t || !id || e.touches.length > 1) return;
    x = t.clientX;
    y = t.clientY;
    timer = window.setTimeout(() => {
      held = true;
      navigator.vibrate?.(8);
      rowPopup.open("menu", id, pointAnchor(x, y));
    }, HOLD);
  };
  const end = (e: TouchEvent) => {
    cancel();
    if (held) e.preventDefault();
  };
  const move = (e: TouchEvent) => {
    const t = e.touches[0];
    if (t && Math.hypot(t.clientX - x, t.clientY - y) > SLIP) cancel();
  };
  const click = (e: Event) => {
    if (!held) return;
    held = false;
    e.preventDefault();
    e.stopPropagation();
  };
  addEventListener("touchstart", start, { passive: true });
  addEventListener("touchmove", move, { passive: true });
  addEventListener("touchend", end);
  addEventListener("touchcancel", cancel);
  addEventListener("click", click, true);
  return () => {
    cancel();
    removeEventListener("touchstart", start);
    removeEventListener("touchmove", move);
    removeEventListener("touchend", end);
    removeEventListener("touchcancel", cancel);
    removeEventListener("click", click, true);
  };
}

function onMenuButton(e: MouseEvent<HTMLButtonElement>): void {
  e.preventDefault();
  e.stopPropagation();
  const id = issueOf(e.currentTarget);
  if (id) rowPopup.open("menu", id, e.currentTarget);
}

/** z-1 lifts it over the title's stretched link; the caller positions it (relative or absolute). */
export function RowMenuButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="More actions"
      title="More actions"
      onClick={onMenuButton}
      className={cn(
        "z-1 flex size-[22px] shrink-0 items-center justify-center rounded-sm text-ink-2 opacity-0 outline-none transition duration-120 group-hover/row:opacity-100 hover:bg-row-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring aria-expanded:opacity-100 pointer-coarse:opacity-100",
        className,
      )}
    >
      <DotsThreeIcon className="size-4" weight="bold" />
    </button>
  );
}
