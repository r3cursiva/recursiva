// A bottom sheet (globals.css) goes away when pulled down by its top edge, where the grabber is. One listener for every
// sheet, instead of Base UI's Drawer around each popup: the lists inside keep their own scrolling.
import { isPhone } from "../lib/phone.ts";

const EDGE = 36;
const FAR = 90;
const FAST = 0.6;

let sheet: HTMLElement | null = null;
let from = 0;
let at = 0;
let moved = 0;

function release(el: HTMLElement): void {
  el.removeAttribute("data-dragging");
  el.style.transform = "";
  el.style.transition = "";
}

addEventListener(
  "touchstart",
  (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>(".sheet") : null;
    const y = e.touches[0]?.clientY ?? 0;
    if (!el || !isPhone() || el.scrollTop > 0 || y - el.getBoundingClientRect().top > EDGE) return;
    sheet = el;
    from = y;
    at = e.timeStamp;
    moved = 0;
  },
  { passive: true },
);

addEventListener(
  "touchmove",
  (e) => {
    if (!sheet) return;
    moved = Math.max(0, (e.touches[0]?.clientY ?? from) - from);
    sheet.setAttribute("data-dragging", "");
    sheet.style.transform = `translateY(${moved}px)`;
  },
  { passive: true },
);

addEventListener("touchend", (e) => {
  const el = sheet;
  sheet = null;
  if (!el || !moved) return;
  if (moved > FAR || moved / (e.timeStamp - at) > FAST) {
    el.style.setProperty("--drag", `${moved}px`);
    release(el);
    // Esc to the sheet itself, bubbling: Base UI closes its popup at the document; the page under it leaves a key sent to a
    // menu or dialog alone (typedInto); a caret menu of the editor closes on it and stops it there (caret-menu.tsx).
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  } else {
    el.style.transition = "transform 200ms ease-out";
    el.style.transform = "";
    setTimeout(() => release(el), 200);
    el.removeAttribute("data-dragging");
  }
});
