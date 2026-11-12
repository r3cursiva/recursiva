// Plane's quick add: "+ New issue" at the end of a list group or a board column turns into a title field; Enter
// creates the issue in that group (its state, priority, person or label) right where the field is, and the field
// stays open for the next one. The issue shows at once as "KEY-?" until the server numbers it.
import { PlusIcon } from "@phosphor-icons/react";
import { cn } from "@rsva/ui/lib/utils";
import { Suspense, useState } from "react";
import { chunk } from "./load-edit-chunk.ts";
import type { QuickAddProps } from "./quick-add-form.tsx";

const QuickAddForm = chunk("QuickAddForm");

/** `centered`: the button alone in an empty board cell, in its middle (RSVA-504); the field still takes the width. */
export function QuickAdd({ centered, ...props }: QuickAddProps & { centered?: boolean }) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <Suspense>
        <QuickAddForm {...props} onClose={() => setOpen(false)} />
      </Suspense>
    );
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={cn(
        "flex items-center gap-2 text-caption text-ink-3 outline-none transition-colors duration-120 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        centered ? "self-center" : "w-full",
        props.variant === "card" ? "h-[30px] rounded-[5px] px-1 hover:bg-row-hover" : "list-row h-(--row) pr-6 pl-[30px] hover:bg-row-hover",
      )}
    >
      <PlusIcon className="size-3" />
      New issue
    </button>
  );
}
