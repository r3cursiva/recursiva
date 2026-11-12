import { useEffect, useState } from "react"
import { WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"

import { Button } from "@rsva/ui/components/button"
import { Kbd } from "@rsva/ui/components/kbd"

// One toast at a time, bottom center, in the Ledger's inverse ink. On a phone it stands above what is pinned under the scroll
// (--docked, or the tab bar) and the keyboard. shadcn's toast is sonner (+ next-themes): ≈ 9 KiB brotli for what we need here,
// a message that disappears by itself.

function Toast({
  title,
  description,
  code,
  lead,
  field,
  onClose,
  duration = 6000,
  variant = "default",
  action,
}: {
  title: string
  description?: string
  /** A name the message is about, in mono: after the title, under it on a phone. */
  code?: string
  /** The key of what the message is about, in mono: before the title, which then stays on one line. */
  lead?: string
  /** What could not be done for the reader, in a read-only field that selects itself; such a toast waits to be dismissed. */
  field?: { label: string; value: string }
  onClose: () => void
  duration?: number
  variant?: "default" | "destructive" | "error"
  /** One button beside the text, such as Undo; `kbd` is its shortcut, shown in the button. */
  action?: { label: string; onClick: () => void; kbd?: string }
}) {
  // Timing out and Dismiss play the way out first; `onClose` comes when it ends (in 1 ms with reduced motion).
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    setLeaving(false)
    if (field) return
    const t = setTimeout(() => setLeaving(true), duration)
    return () => clearTimeout(t)
  }, [title, description, duration, field])

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      aria-live={variant === "error" ? "assertive" : "polite"}
      data-slot="toast"
      onAnimationEnd={(e) => leaving && e.target === e.currentTarget && onClose()}
      className={cn(
        "fixed bottom-5 left-1/2 z-50 flex max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 gap-3 rounded-(--float-radius) bg-inverse py-2 pr-2 pl-3.5 text-label font-normal text-inverse-ink shadow-toast max-md:bottom-[calc(var(--docked,var(--tabbar)+var(--safe-bottom))+var(--keyboard)+12px)] max-md:w-max max-md:rounded-xl max-md:py-1.5 max-md:pl-4",
        leaving ? "pointer-events-none animate-out duration-150 ease-in fill-mode-forwards fade-out slide-out-to-bottom-2" : "animate-in duration-300 ease-spring fade-in-0 slide-in-from-bottom-3",
        action ? "items-center" : "items-start",
        field && "w-[420px] max-w-[calc(100vw-2rem)] max-md:w-[calc(100vw-1.5rem)]",
      )}
    >
      {/* The first line is as tall as the Dismiss button (20px, 36px on a phone) and centers its text, so a one-line toast reads
          centered and a longer one keeps its first line level with the button and the icon; the rest grows under it. */}
      {variant === "error" && <WarningCircleIcon className="mt-[3px] -mr-1 size-3.5 shrink-0 text-error-on-inverse max-md:mt-[11px]" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn("flex min-h-5 items-center gap-2 font-medium max-md:min-h-9", code && "flex-wrap gap-y-0 max-md:flex-col max-md:items-start max-md:justify-center")}>
          {variant === "destructive" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-signal" />}
          {lead ? (
            <>
              <span className="shrink-0 font-mono text-[11.5px] font-normal">{lead}</span>
              <span className="max-w-80 truncate">{title}</span>
            </>
          ) : (
            title
          )}
          {code && <span className="min-w-0 font-mono text-[11.5px] font-normal break-all max-md:text-inverse-ink-2">{code}</span>}
        </p>
        {description && <p className={variant === "error" ? "text-inverse-ink-2" : "text-kbd-ink-on-inverse"}>{description}</p>}
        {field && (
          <textarea
            aria-label={field.label}
            readOnly
            rows={field.value.includes("\n") ? 4 : 1}
            value={field.value}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1.5 min-h-[26px] w-full min-w-0 resize-none rounded-[5px] border border-inverse-line bg-transparent px-2 py-1 font-mono text-[11.5px] leading-4 text-inverse-ink outline-none selection:bg-signal selection:text-signal-ink focus-visible:border-inverse-ink max-md:min-h-9 max-md:text-[13px]"
          />
        )}
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          onClick={action.onClick}
          className="h-[26px] gap-1.5 border border-kbd-on-inverse px-2.5 text-inverse-ink hover:bg-inverse-ink/15 hover:text-inverse-ink max-md:h-[34px] max-md:border-0 max-md:bg-inverse-ink/15"
        >
          {action.label}
          {action.kbd && <Kbd inverse>{action.kbd}</Kbd>}
        </Button>
      )}
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setLeaving(true)} className={cn("text-inverse-ink hover:bg-inverse-ink/15 hover:text-inverse-ink", action && "max-md:hidden")}>
        <XIcon />
      </Button>
    </div>
  )
}

export { Toast }
