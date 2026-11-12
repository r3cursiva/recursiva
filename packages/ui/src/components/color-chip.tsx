import type { ReactNode } from "react"
import { cn } from "../lib/utils.ts"

/** A label's own color, where the color itself is the information: label pickers and filter menus. */
function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      data-slot="color-dot"
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color }}
    />
  )
}

/** A label as Plane shows it: an outlined pill with the label's color dot. */
function LabelTag({ color, children, className }: { color: string; children: ReactNode; className?: string }) {
  return (
    <span
      data-slot="label-tag"
      className={cn(
        "inline-flex h-5 max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-rule px-2 font-sans text-meta whitespace-nowrap text-ink-2",
        className,
      )}
    >
      <ColorDot color={color} />
      <span className="truncate">{children}</span>
    </span>
  )
}

/** A row's labels: the first `max` as tags, the rest as a count. */
function LabelTags({ labels, max = 2 }: { labels: readonly { id: string; name: string; color: string }[]; max?: number }) {
  return (
    <>
      {labels.slice(0, max).map((l) => (
        <LabelTag key={l.id} color={l.color} className="max-w-28">
          {l.name}
        </LabelTag>
      ))}
      {labels.length > max && <span>+{labels.length - max}</span>}
    </>
  )
}

export { ColorDot, LabelTag, LabelTags }
