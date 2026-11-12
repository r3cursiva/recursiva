import { CellSignalFullIcon, CellSignalHighIcon, CellSignalLowIcon, CellSignalMediumIcon, MinusIcon, WarningOctagonIcon, type Icon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"

// Quire Ledger's priority glyphs, as in Linear: gray signal bars over a faint full set (every level the same width, so
// rows line up), and color only for Urgent, the signal.
const LEVEL: Record<number, Icon> = { 2: CellSignalHighIcon, 3: CellSignalMediumIcon, 4: CellSignalLowIcon }

function PriorityIcon({ priority, className }: { priority: number; className?: string }) {
  const size = cn("size-3.5 shrink-0", className)
  if (priority === 1) return <WarningOctagonIcon data-slot="priority-icon" aria-hidden weight="fill" className={cn(size, "text-signal")} />
  const Level = LEVEL[priority]
  if (!Level) return <MinusIcon data-slot="priority-icon" aria-hidden weight="bold" className={cn(size, "text-priority-level")} />
  // One grid cell holds both, so they overlap at whatever size a container gives icons (the palette sets 16 px).
  return (
    <span data-slot="priority-icon" aria-hidden className="inline-grid shrink-0 *:[grid-area:1/1]">
      <CellSignalFullIcon data-slot="priority-icon" weight="bold" className={cn(size, "text-rule-strong")} />
      <Level data-slot="priority-icon" weight="bold" className={cn(size, "text-priority-level")} />
    </span>
  )
}

export { PriorityIcon }
