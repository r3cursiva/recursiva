import * as React from "react"
import { cn } from "../lib/utils.ts"

/** A text field's box, fill, type, focus ring and invalid state: one line (inputStyles) or several (Textarea). */
export const fieldStyles =
  "w-full rounded-md border border-input bg-input/20 px-2 text-sm transition-colors max-md:rounded-lg max-md:px-3 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-xs/relaxed dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"

/** The one-line text field's look, shared by Input (Base UI, with Field context) and NativeInput. */
export const inputStyles = `${fieldStyles} h-7 min-w-0 py-0.5 max-md:h-11 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs/relaxed file:font-medium file:text-foreground disabled:pointer-events-none`

/**
 * A plain <input> that looks like Input, without Base UI: for screens outside the app's chunks (the sign-in screen
 * ships in the startup JS, where Base UI's input would add 14 KB).
 */
function NativeInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(inputStyles, className)} {...props} />
}

export { NativeInput }
