// A saved view's icon (PLNR-74). The icons themselves are in the lazy edit chunk (view-icons.tsx), which loads right
// after the first paint: until then an empty square of the same size holds the place, so nothing moves.
import type { ViewIcon as ViewIconName } from "@rsva/protocol";
import { cn } from "@rsva/ui/lib/utils";
import { Suspense } from "react";
import { chunk } from "./load-edit-chunk.ts";

const Glyph = chunk("ViewIconGlyph");

export function ViewIcon({ name, className }: { name: ViewIconName; className?: string }) {
  return (
    <Suspense fallback={<span aria-hidden className={cn("size-3.5 shrink-0", className)} />}>
      <Glyph name={name} {...(className ? { className } : {})} />
    </Suspense>
  );
}
