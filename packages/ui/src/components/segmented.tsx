import { Fragment, useId, type ReactElement, type ReactNode } from "react"
import { cn } from "../lib/utils.ts"

/**
 * A few options side by side, one chosen, with a thumb under the chosen option. The options are the browser's own radio
 * inputs (one name per group): arrow keys move the choice, the group is one Tab stop, the choice cannot be cleared, with
 * no script of ours. The thumb is anchored to the chosen option (`segmented-thumb` in globals.css), so it slides to an
 * option of any width with no script either; a browser without anchor positioning fills the chosen option instead.
 * Compared (PLNR-235): Base UI's RadioGroup, the same behaviour for 9.6 KB brotli more in the startup chunk.
 *
 * `ink` (the default) is the Ledger's role picker: equally wide options, 88px or as wide as the widest one, an ink thumb. `quiet` is the layout switch:
 * options as wide as their icon and label in a group sunk on the rail, the chosen one lifted onto the panel; with `iconOnly` the label is only the
 * option's accessible name, and with `fill` the options share the whole width. `dial` is the history's detail dial:
 * equally wide options, as wide as the widest one, so the thumb slides without changing size; the quiet look at a larger size. An option's `count`
 * follows its label in mono. `wrap` puts each option in something of the caller's, such as a tooltip: importing the tooltip here would bring
 * it and Floating UI into the startup chunk with the layout switch (about 21 KB brotli).
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = "ink",
  iconOnly = false,
  fill = false,
  wrap,
  className,
  labelClassName,
  countClassName,
}: {
  options: readonly { value: T; label: string; icon?: ReactNode; title?: string; disabled?: boolean; count?: ReactNode }[]
  value: T
  onChange: (value: T) => void
  /** The group's accessible name. */
  label: string
  variant?: keyof typeof LOOK
  iconOnly?: boolean
  fill?: boolean
  wrap?: (option: ReactElement<Record<string, unknown>>, index: number) => ReactNode
  className?: string
  /** The label's own box, so a caller can hide it where room runs out (it stays the option's name, as `sr-only`). */
  labelClassName?: string
  /** The count's own class, so a caller can drop it where room runs out. */
  countClassName?: string
}) {
  const name = useId()
  const look = LOOK[variant]
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("segmented relative border border-control-border p-0.5", fill ? "w-full" : "w-max", look.group, className)}
    >
      <span aria-hidden className={cn("segmented-thumb", look.thumb)} />
      {options.map((o, i) => {
        const content = (
          <>
            {o.icon}
            {!iconOnly && (
              <span data-label={o.label} className={cn(BOLD_WIDTH, labelClassName)}>
                {o.label}
              </span>
            )}
            {o.count !== undefined && <span className={cn("font-mono text-[10.5px]", look.count, countClassName)}>{o.count}</span>}
          </>
        )
        const option = (
          <label
            title={o.title}
            data-checked={o.value === value || undefined}
            data-disabled={o.disabled || undefined}
            className={cn(
              "relative flex touch-manipulation items-center gap-1.5 whitespace-nowrap text-ink-2 select-none transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
              look.option,
              variant === "quiet" && (iconOnly ? "px-1.5 max-md:px-2" : "px-2 max-md:px-2.5"),
              fill && "flex-1 justify-center"
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              disabled={o.disabled}
              aria-label={iconOnly ? o.label : undefined}
              onChange={() => onChange(o.value)}
              // Enter in a form would submit it; a radio only answers Space and the arrows.
              onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              className="sr-only"
            />
            {content}
          </label>
        )
        return <Fragment key={o.value}>{wrap ? wrap(option, i) : option}</Fragment>
      })}
    </div>
  )
}

/** A label as wide as its bold self (RSVA-500): the chosen option is medium, so without it the widest option, and with it
 * the group, changes width with the choice (Milestones 63.00 → 63.67 px in Onest at 12.5px). The bold copy is a
 * pseudo-element of no height, out of the accessibility tree. Compared: a hidden second span per option (a DOM node each,
 * the `steady` copy RSVA-499 removed) and no weight change on the chosen option (a look the artboards do not have). */
const BOLD_WIDTH =
  "inline-grid after:invisible after:h-0 after:overflow-hidden after:font-medium after:select-none after:content-[attr(data-label)]"

/** Each look's group, thumb, option and count. `not-supports-[anchor-scope:--a]:` is the chosen option's own fill where
 * the thumb cannot be anchored. */
const LOOK = {
  ink: {
    group: "grid auto-cols-[minmax(88px,1fr)] grid-flow-col rounded-[7px] bg-panel",
    thumb: "rounded-[5px] bg-primary",
    option:
      "h-[26px] justify-center rounded-[5px] px-2.5 text-[12.5px] font-medium duration-200 data-checked:text-primary-foreground max-md:h-[34px] max-md:text-[13.5px] not-supports-[anchor-scope:--a]:data-checked:bg-primary [&_svg]:size-3.5 [&_svg]:shrink-0",
    count: "font-normal text-ink-3",
  },
  // After the artboards' `ql-seg`: a sunk group on the rail with no edge, the chosen option lifted onto the panel by a shadow.
  quiet: {
    group: "flex gap-0.5 rounded-[6px] border-0 bg-rail",
    thumb: "rounded-[5px] bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.08)]",
    option:
      "h-[22px] rounded-[5px] text-[12px] duration-120 max-md:h-8 max-md:text-[13px] max-md:[&_svg]:size-4 hover:text-ink data-disabled:text-faint data-disabled:hover:text-faint data-checked:font-medium data-checked:text-ink not-supports-[anchor-scope:--a]:data-checked:bg-panel not-supports-[anchor-scope:--a]:data-checked:shadow-[0_1px_2px_rgb(0_0_0/0.08)] [&_svg]:size-[13px]",
    count: "font-normal text-ink-3",
  },
  // The quiet look at the dial's size: sunk on the rail, the chosen level lifted onto the panel; options of one width.
  dial: {
    group: "grid auto-cols-fr grid-flow-col gap-0.5 rounded-[7px] border-0 bg-rail",
    thumb: "rounded-[5px] bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.08)]",
    option:
      "h-[30px] justify-center gap-[7px] rounded-[5px] px-2.5 text-[12.5px] duration-200 max-md:h-9 not-data-checked:hover:text-ink data-checked:font-medium data-checked:text-ink not-supports-[anchor-scope:--a]:data-checked:bg-panel not-supports-[anchor-scope:--a]:data-checked:shadow-[0_1px_2px_rgb(0_0_0/0.08)]",
    count: "font-normal text-ink-3",
  },
} as const

export { Segmented }
