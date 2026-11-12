import type { ComponentProps, CSSProperties } from "react"
import { cn } from "../lib/utils.ts"

// The track fills up to the value: WebKit draws one track, so a gradient split at --fill; Firefox has its own progress part.
const TRACK = [
  "h-5 w-full min-w-0 cursor-pointer appearance-none bg-transparent outline-none max-md:h-11",
  "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-primary)_var(--fill),var(--color-rule-strong)_var(--fill))]",
  "[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-panel [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--color-rule-strong),0_1px_3px_rgb(0_0_0/0.18)] [&::-webkit-slider-thumb]:transition-transform active:[&::-webkit-slider-thumb]:scale-110",
  "max-md:[&::-webkit-slider-thumb]:-mt-2.5 max-md:[&::-webkit-slider-thumb]:size-6",
  "focus-visible:[&::-webkit-slider-thumb]:outline-2 focus-visible:[&::-webkit-slider-thumb]:outline-offset-2 focus-visible:[&::-webkit-slider-thumb]:outline-ring",
  "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-rule-strong [&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-primary",
  "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-panel [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--color-rule-strong),0_1px_3px_rgb(0_0_0/0.18)] max-md:[&::-moz-range-thumb]:size-6",
  "focus-visible:[&::-moz-range-thumb]:outline-2 focus-visible:[&::-moz-range-thumb]:outline-offset-2 focus-visible:[&::-moz-range-thumb]:outline-ring",
].join(" ")

/**
 * A value on a line. A native range input in the app's look: the keys, touch and screen readers come with it, for no
 * bytes; Base UI's Slider (several thumbs, ranges) is more than a single value needs, as with Switch.
 */
function Slider({
  value,
  min = 0,
  max = 100,
  onValueChange,
  className,
  style,
  ...props
}: Omit<ComponentProps<"input">, "type" | "value" | "min" | "max" | "onChange"> & { value: number; min?: number; max?: number; onValueChange: (value: number) => void }) {
  return (
    <input
      type="range"
      data-slot="slider"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onValueChange(e.currentTarget.valueAsNumber)}
      style={{ "--fill": `${((value - min) / (max - min)) * 100}%`, ...style } as CSSProperties}
      className={cn(TRACK, className)}
      {...props}
    />
  )
}

export { Slider }
