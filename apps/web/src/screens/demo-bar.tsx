// Over the app in the public demo (apps/server/src/demo), for a visitor: what this place is, and where recursiva is.
import { ArrowUpRightIcon } from "@phosphor-icons/react";

export function DemoBar() {
  return (
    <div className="flex shrink-0 items-center justify-center gap-x-3 gap-y-0.5 border-b border-rule-soft bg-ground px-4 py-1.5 text-caption text-ink-2 max-md:flex-wrap max-md:pt-[calc(var(--safe-top)+0.375rem)]">
      <span>The demo: shared with the other visitors in it now, and it starts over every night.</span>
      <a href="https://github.com/r3cursiva/recursiva" target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-medium text-ink hover:text-ink-2">
        Get recursiva
        <ArrowUpRightIcon weight="bold" />
      </a>
    </div>
  );
}
