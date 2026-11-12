import type { CSSProperties, ReactNode } from "react"
import { cn } from "../lib/utils.ts"

/**
 * A list and the item opened from it, side by side, as in mail clients (PLNR-34). Nothing is laid over the list: with
 * an item open it narrows to `width`. With `fill` the list takes the whole width while nothing is open (a project's
 * issues); without it the item pane stays, holding its placeholder (the inbox). The list stays mounted throughout, so
 * its scroll, selection and keyboard state survive.
 *
 * `data-split` is set while an item is open, so the list's rows can drop columns with `in-data-[split]:hidden`.
 * Each pane is a block of the window (`.pane`, globals.css). On phones one pane shows at a time. The panes don't animate themselves: the app moves them as one view transition
 * (`split-list`, `split-detail`), which a CSS transition here would fight.
 */
function SplitView({
  list,
  detail,
  open,
  fill,
  width = "400px",
  label,
  listClassName,
}: {
  list: ReactNode
  detail: ReactNode
  open: boolean
  fill?: boolean
  width?: string
  label: string
  listClassName?: string
}) {
  const listWidth = fill && !open ? "100%" : width
  return (
    <div data-slot="split-view" data-split={open || undefined} className="flex min-h-0 min-w-0 flex-1 gap-(--pane-gap) max-md:gap-0">
      <section
        data-slot="split-list"
        data-region
        aria-label={label}
        style={{ "--split-list": listWidth } as CSSProperties}
        className={cn(
          "pane flex w-(--split-list) shrink-0 flex-col overflow-hidden max-md:w-full",
          open && "max-md:hidden",
          listClassName
        )}
      >
        {list}
      </section>
      {(open || !fill) && (
        // With `fill` the pane mounts when an item opens and stays while the next ones replace its content. On the
        // ground as the list is (the Framed* artboards), so the cards in it stand out; a phone's sheet is the panel.
        <div data-slot="split-detail" data-region className={cn("pane flex min-w-0 flex-1 flex-col max-md:bg-panel", !open && "max-md:hidden")}>
          {detail}
        </div>
      )}
    </div>
  )
}

export { SplitView }
