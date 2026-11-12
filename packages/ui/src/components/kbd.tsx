import type { ReactNode } from "react"
import { cn } from "../lib/utils.ts"

/** A shortcut as it is pressed: "C", "⌘K", "G I". `inverse` inside a primary button or a toast. */
function Kbd({ children, inverse, className }: { children: ReactNode; inverse?: boolean; className?: string }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-block rounded-xs border px-1 py-px font-mono text-overline leading-none tracking-normal",
        inverse ? "border-kbd-on-inverse text-kbd-ink-on-inverse" : "border-control-border text-ink-3",
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** A tooltip's label with its key after it: "State S". The tooltip sets the key's colors and room. */
function KeyHint({ label, keys }: { label: ReactNode; keys: string }) {
  return (
    <>
      {label}
      <Kbd inverse>{keys}</Kbd>
    </>
  )
}

export { Kbd, KeyHint }
