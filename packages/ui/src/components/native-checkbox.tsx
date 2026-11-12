import { CheckIcon } from "@phosphor-icons/react"
import type { ComponentProps } from "react"
import { cn } from "../lib/utils.ts"

/**
 * The browser's own checkbox drawn as Checkbox is: the box, the check and the focus ring alike. For a box on every row of
 * a startup screen (the list's mark for bulk actions, PLNR-294), where Base UI's Checkbox cost 3.4 KB brotli of startup
 * JS (measured 2026-11-05) for behaviour the input has by itself: keyboard, label, form state, its role.
 * `className` places the box; `checked` and `onChange` are the input's.
 */
function NativeCheckbox({ className, ...props }: ComponentProps<"input">) {
  return (
    <span data-slot="checkbox" className={cn("relative inline-grid size-4 shrink-0 place-items-center", className)}>
      <input
        type="checkbox"
        className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-[4px] border border-input outline-none checked:border-primary checked:bg-primary focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:checked:bg-primary"
        {...props}
      />
      <CheckIcon weight="bold" className="pointer-events-none relative size-3 text-primary-foreground opacity-0 peer-checked:opacity-100" />
    </span>
  )
}

export { NativeCheckbox }
