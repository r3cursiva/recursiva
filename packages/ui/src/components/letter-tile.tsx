import type { ReactNode } from "react"
import { tileTone, type TileTone } from "@rsva/display/tile"
import { cn } from "../lib/utils.ts"

export { tileTone, type TileTone }

/** A tile's fill and letter colors, for tiles drawn at other sizes. In the order the picker shows them. */
export const TILE_TONE: Record<TileTone, string> = {
  ink: "bg-ink text-ground",
  slate: "bg-ws-slate text-white",
  signal: "bg-signal text-signal-ink",
  umber: "bg-ws-umber text-white",
  ochre: "bg-ws-ochre text-white",
  olive: "bg-ws-olive text-white",
  forest: "bg-ws-forest text-white",
  teal: "bg-ws-teal text-white",
  cobalt: "bg-ws-cobalt text-white",
  indigo: "bg-ws-indigo text-white",
  plum: "bg-ws-plum text-white",
  rose: "bg-ws-rose text-white",
}

/** A workspace or project mark: its first letter, or `children`, on a small colored square, until they get logos. */
function LetterTile({ name, tone, className, children }: { name: string; tone?: TileTone; className?: string; children?: ReactNode }) {
  return (
    <span
      aria-hidden
      data-slot="letter-tile"
      className={cn(
        "grid size-[15px] shrink-0 place-items-center rounded-xs text-[9px] leading-none font-semibold uppercase",
        TILE_TONE[tone ?? tileTone(name)],
        className
      )}
    >
      {children ?? name[0]}
    </span>
  )
}

export { LetterTile }
