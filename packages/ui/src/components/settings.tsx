import type { ReactNode } from "react"
import { cn } from "../lib/utils.ts"

/**
 * A settings page section as the Ledger draws it: a 15px title, a muted line under it, then its rows. `id` is the
 * anchor the page's section nav links to; the title labels the section for screen readers. The rows lie in a box of
 * their own: in the framed window a rounded card (`ROWS`), flat just the rows.
 */
/**
 * Framed, a section's rows are a card under its title, as a system's settings draw them. Only a section of setting rows:
 * one that holds cards or a table of its own (Notifications' channels and grid) has its boxes already, and a card around
 * them would be a box in a box.
 */
const ROWS =
  "framed:has-[>[data-slot=setting-row]]:mt-2 framed:has-[>[data-slot=setting-row]]:rounded-(--float-radius) framed:has-[>[data-slot=setting-row]]:border framed:has-[>[data-slot=setting-row]]:border-rule framed:has-[>[data-slot=setting-row]]:bg-panel framed:has-[>[data-slot=setting-row]]:px-4"

function SettingsSection({
  id,
  title,
  description,
  aside,
  compact,
  children,
}: {
  id: string
  title: string
  description?: ReactNode
  /** Beside the title: a count, a state. */
  aside?: ReactNode
  /** A read-only block of cards or tables, not rows: a smaller title, and a gap between what is under it. */
  compact?: boolean
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} data-slot="settings-section" className={cn("flex scroll-mt-6 flex-col", compact && "gap-2.5 max-md:gap-2")}>
      <div className={cn("flex items-baseline gap-2", !compact && "mb-0.5", compact && "max-md:px-0.5")}>
        <h2 id={`${id}-title`} className={cn("m-0 font-semibold", compact ? "text-[14px] max-md:text-[13px] max-md:text-ink-2" : "text-[15px] max-md:text-[16px]")}>
          {title}
        </h2>
        {aside}
      </div>
      {description && <p className="m-0 mb-1.5 text-label text-ink-3">{description}</p>}
      {compact ? children : <div className={ROWS}>{children}</div>}
    </section>
  )
}

/**
 * One setting: its name (with an optional hint) in a 200px column, the control beside it; stacked on a phone. Pass
 * `htmlFor` when the control is a single field, so the name is its label.
 */
function SettingRow({
  label,
  hint,
  htmlFor,
  top,
  className,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  /** Align the name with the control's first line instead of its middle (tall controls). */
  top?: boolean
  className?: string
  children: ReactNode
}) {
  const Name = htmlFor ? "label" : "span"
  return (
    <div
      data-slot="setting-row"
      className={cn(
        "grid grid-cols-[200px_minmax(0,1fr)] gap-x-6 gap-y-2.5 border-b border-rule-soft py-4 last:border-b-0 max-md:grid-cols-1",
        top ? "items-start" : "items-center",
        className
      )}
    >
      <Name {...(htmlFor ? { htmlFor } : {})} className={cn("flex flex-col gap-[3px]", top && "pt-1.5")}>
        <span className="font-medium">{label}</span>
        {hint && <span className="text-caption text-ink-3">{hint}</span>}
      </Name>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export { SettingRow, SettingsSection }
