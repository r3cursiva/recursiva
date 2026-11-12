import { CaretRightIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"

// Apart from collapsible.tsx: the list's group headers draw it without Base UI's Collapsible, which stays out of the
// startup JS.

/** The caret before a collapsible group's name: right while shut, down while open. */
export function CollapsibleCaret({ open, className }: { open: boolean; className?: string }) {
  return <CaretRightIcon weight="bold" className={cn("size-2.5 text-ink-3 transition-transform", open && "rotate-90", className)} />
}
