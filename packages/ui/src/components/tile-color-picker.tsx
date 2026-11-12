import { cn } from "../lib/utils.ts"
import { LetterTile, TILE_TONE, type TileTone } from "./letter-tile"

const TONES = Object.keys(TILE_TONE) as TileTone[]

/** The Ledger's names for the tile tones; `signal` is the design system's vermilion. */
const TONE_NAMES: Record<TileTone, string> = {
  ink: "Ink",
  slate: "Slate",
  signal: "Vermilion",
  umber: "Umber",
  ochre: "Ochre",
  olive: "Olive",
  forest: "Forest",
  teal: "Teal",
  cobalt: "Cobalt",
  indigo: "Indigo",
  plum: "Plum",
  rose: "Rose",
}

/**
 * The tone of a project's or a workspace's tile: "automatic" (null) and every tone, each drawn as the tile itself
 * with its letter, so the choice shows what the sidebar will draw.
 */
function TileColorPicker({
  name,
  value,
  autoTone,
  autoTitle,
  label,
  disabled,
  onChange,
}: {
  /** What the tile's letter comes from: a project's key, a workspace's name. */
  name: string
  value: TileTone | null
  /** How the tile looks without a choice. */
  autoTone: TileTone
  /** The automatic choice's name when the tone alone would mislead; "Automatic (<tone>)" by default. */
  autoTitle?: string
  /** The group's accessible name. */
  label: string
  disabled?: boolean
  onChange: (tone: TileTone | null) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className="flex flex-wrap gap-2">
      {[null, ...TONES].map((c) => {
        const on = value === c
        const title = c ? TONE_NAMES[c] : (autoTitle ?? `Automatic (${TONE_NAMES[autoTone]})`)
        return (
          <button
            key={c ?? "auto"}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={title}
            title={title}
            disabled={disabled}
            onClick={() => onChange(c)}
            className={cn(
              "relative grid size-7 place-items-center rounded-[8px] outline-none max-md:size-10 max-md:rounded-[10px] transition-[box-shadow,transform] duration-200 ease-spring active:scale-95 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              on && "ring-2 ring-ink ring-offset-2 ring-offset-ground"
            )}
          >
            <LetterTile name={name} tone={c ?? autoTone} className="size-6 rounded-[7px] text-xs" />
            {!c && <span className="absolute -right-1 -bottom-1 rounded-xs bg-ground px-0.5 font-mono text-[8.5px] leading-tight text-ink-3">A</span>}
          </button>
        )
      })}
    </div>
  )
}

export { TileColorPicker }
