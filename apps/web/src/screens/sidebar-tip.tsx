import { Kbd } from "@rsva/ui/components/kbd";
import type { ReactNode } from "react";

/** The tooltip's quieter half: a count, a state. */
export function TipNote({ children }: { children: ReactNode }) {
  return <span className="font-mono text-meta opacity-65">{children}</span>;
}

/**
 * The name and shortcut beside an item of the collapsed sidebar, on hover or keyboard focus; CSS only. The item needs
 * group/tip. The sidebar scrolls, and a scroller clips what sticks out of it: a fixed box does not get clipped, and with
 * no offsets it stays at its static place, the middle of the item, so no script has to measure anything.
 */
export function Tip({ children, kbd }: { children: ReactNode; kbd?: string }) {
  return (
    <span aria-hidden className="pointer-events-none fixed z-40 hidden size-0 strip:block in-data-dragging:hidden!">
      <span className="absolute top-0 left-[36px] flex -translate-x-1 -translate-y-1/2 items-center gap-2 rounded-[5px] bg-inverse px-2 py-1 text-caption font-medium whitespace-nowrap text-inverse-ink opacity-0 transition duration-150 group-hover/tip:translate-x-0 group-hover/tip:opacity-100 group-focus-visible/tip:translate-x-0 group-focus-visible/tip:opacity-100">
        {children}
        {kbd && <Kbd inverse>{kbd}</Kbd>}
      </span>
    </span>
  );
}
