// A row's buttons that slide in at its right end on hover or focus (My work, Inbox; RSVA-426). `shown` keeps them out
// for the selected row or while one of their menus is open; `className` places them.
import { cn } from "@rsva/ui/lib/utils";
import type { ReactNode } from "react";

export function RowHoverActions({ shown, className, children }: { shown: boolean; className: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "pointer-events-none flex translate-x-1 opacity-0 transition duration-150 group-focus-within/row:pointer-events-auto group-focus-within/row:translate-x-0 group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:translate-x-0 group-hover/row:opacity-100",
        shown && "pointer-events-auto translate-x-0 opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}
