import { CheckCircleIcon, CircleDashedIcon, CircleHalfIcon, CircleIcon, EyeIcon, SealCheckIcon, XCircleIcon, type Icon } from "@phosphor-icons/react"
import type { StartedStage, StateGroup } from "@rsva/schema/models"
import { useRef } from "react"
import { cn } from "../lib/utils.ts"

// Quire Ledger's status glyphs ("Ink for content, color for state"): a Phosphor shape per status in its own color token,
// outlined while open (bold), filled once closed, so status reads by shape in grayscale and by color at a glance. Gray
// means nobody is working on it. Color stays in the glyph: the label beside it is ink.
const GLYPH: Record<StateGroup | StartedStage, { Icon: Icon; weight: "bold" | "fill"; tone: string }> = {
  backlog: { Icon: CircleDashedIcon, weight: "bold", tone: "text-status-backlog" },
  unstarted: { Icon: CircleIcon, weight: "bold", tone: "text-status-todo" },
  started: { Icon: CircleHalfIcon, weight: "fill", tone: "text-status-progress" },
  progress: { Icon: CircleHalfIcon, weight: "fill", tone: "text-status-progress" },
  review: { Icon: EyeIcon, weight: "bold", tone: "text-status-review" },
  approved: { Icon: SealCheckIcon, weight: "bold", tone: "text-status-approved" },
  completed: { Icon: CheckCircleIcon, weight: "fill", tone: "text-status-done" },
  cancelled: { Icon: XCircleIcon, weight: "fill", tone: "text-status-canceled" },
}

/** The glyph a status change brings in pops (300 ms, slight overshoot); a first render, or a row scrolled in, does not. */
function StateIcon({ group, stage, className }: { group: string; stage?: StartedStage; className?: string }) {
  const key = group === "started" && stage ? stage : group in GLYPH ? (group as StateGroup) : "unstarted"
  const first = useRef(key)
  const { Icon, weight, tone } = GLYPH[key]
  return (
    <Icon
      data-slot="state-icon"
      aria-hidden
      weight={weight}
      className={cn("size-[14px] shrink-0", tone, first.current !== key && "animate-glyph-pop", className)}
    />
  )
}

export { StateIcon }
