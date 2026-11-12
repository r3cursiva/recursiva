import { XIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"
import { useState } from "react"

import { Button } from "@rsva/ui/components/button"

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/** Lower-cased addresses of a typed or pasted text, and what in it is not an address. */
function splitEmails(text: string): { good: string[]; bad: string[] } {
  const parts = text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
  return { good: parts.filter((x) => EMAIL.test(x)), bad: parts.filter((x) => !EMAIL.test(x)) }
}

/**
 * Email addresses as chips: typed or pasted, split on commas, spaces and Enter, and on leaving the field. What is not
 * an address stays in the field, marked. Backspace in an empty field takes the last chip back.
 */
function EmailInput({
  id,
  value,
  onChange,
  onDraftChange,
  placeholder = "name@company.com",
  className,
}: {
  id?: string
  value: readonly string[]
  onChange: (emails: string[]) => void
  /** Whether text that is not an address is left in the field: a form disables its submit meanwhile. */
  onDraftChange?: (pending: boolean) => void
  placeholder?: string
  className?: string
}) {
  const [draft, setDraft] = useState("")
  const [bad, setBad] = useState(false)
  const set = (text: string, wrong: boolean) => {
    setDraft(text)
    setBad(wrong)
    onDraftChange?.(text.trim() !== "")
  }
  const commit = (text: string) => {
    const { good, bad: rest } = splitEmails(text)
    const fresh = good.filter((e) => !value.includes(e))
    if (fresh.length) onChange([...value, ...[...new Set(fresh)]])
    set(rest.join(", "), rest.length > 0)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-control-border bg-field px-1.5 py-1 transition-colors duration-120 focus-within:border-ink-3 focus-within:ring-2 focus-within:ring-ring",
          bad && "border-signal-text",
          className
        )}
      >
        {value.map((e) => (
          <span key={e} className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-control-border bg-panel pr-0.5 pl-2 font-mono text-xs">
            {e}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${e}`}
              onClick={() => onChange(value.filter((x) => x !== e))}
              className="size-[18px] rounded-[4px] border-0 text-ink-3 active:scale-100! max-md:size-[18px] max-md:rounded-[4px]"
            >
              <XIcon className="size-2.5" />
            </Button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          aria-invalid={bad || undefined}
          placeholder={value.length ? "" : placeholder}
          onChange={(e) => {
            const v = e.target.value
            if (/[\s,;]$/.test(v)) commit(v)
            else set(v, false)
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text")
            if (!/[\s,;]/.test(text.trim())) return
            e.preventDefault()
            commit(draft + text)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault()
              commit(draft)
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={() => draft.trim() && commit(draft)}
          className="h-[26px] min-w-[120px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-ink-3"
        />
      </div>
      {bad && (
        <span role="alert" className="text-xs text-signal-text">
          That does not look like an email address.
        </span>
      )}
    </div>
  )
}

export { EmailInput }
