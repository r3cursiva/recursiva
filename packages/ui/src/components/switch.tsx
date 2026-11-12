import type { ComponentProps } from "react"
import { cn } from "../lib/utils.ts"

const SIZE = {
  sm: { track: "h-4 w-7 max-md:h-7 max-md:w-12", thumb: "top-0.5 left-0.5 max-md:size-6", on: "translate-x-3 max-md:translate-x-5" },
  md: { track: "h-[18px] w-[30px]", thumb: "top-[3px] left-[3px]", on: "translate-x-3" },
}

/** An on/off control. Inside a <label>, a click on the label's text flips it too. */
function Switch({
  checked,
  onCheckedChange,
  size = "md",
  className,
  ...props
}: Omit<ComponentProps<"button">, "onChange"> & { checked: boolean; onCheckedChange: (checked: boolean) => void; size?: keyof typeof SIZE }) {
  const s = SIZE[size]
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn("relative shrink-0 rounded-full bg-rule-strong outline-none transition-colors duration-250 focus-visible:ring-2 focus-visible:ring-ring", s.track, checked && "bg-primary", className)}
      {...props}
    >
      <span aria-hidden className={cn("absolute size-3 rounded-full bg-panel transition-transform duration-280 ease-[cubic-bezier(0.3,0.7,0.3,1.5)]", s.thumb, checked && s.on)} />
    </button>
  )
}

export { Switch }
