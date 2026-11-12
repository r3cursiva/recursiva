import type { ReactElement, ReactNode } from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react"

import { Button } from "@rsva/ui/components/button"

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@rsva/ui/components/combobox"

/** Where a popup without its own trigger is placed: an element, or a virtual one such as the pointer position. */
export type PopupAnchor = ComboboxPrimitive.Positioner.Props["anchor"]

/** One choice. `label` is what the search matches; options with a `group` are shown under its heading; `meta` is a quiet
 * figure at the end of its line, such as a count. */
export interface SearchSelectOption {
  value: string
  label: string
  icon?: ReactNode
  group?: string
  meta?: ReactNode
}

type Selection =
  | { multiple?: false; value: string | null; onChange: (value: string) => void }
  | { multiple: true; value: readonly string[]; onChange: (value: string[]) => void }

interface OptionGroup {
  value: string
  items: SearchSelectOption[]
}

/** Consecutive options with the same group become one section, in the order given. */
function toGroups(options: readonly SearchSelectOption[]): OptionGroup[] {
  const out: OptionGroup[] = []
  for (const o of options) {
    const g = o.group ?? ""
    const last = out.at(-1)
    if (last && last.value === g) last.items.push(o)
    else out.push({ value: g, items: [o] })
  }
  return out
}

/** A list this short needs no search on a phone: its field would only take room in the sheet. */
const SHORT = 9

function OptionItem({ o, mixed }: { o: SearchSelectOption; mixed: ReadonlySet<string> | undefined }) {
  return (
    <ComboboxItem value={o} mixed={mixed?.has(o.value) ?? false} className="pr-7 max-md:pr-11">
      {o.icon}
      <span className="truncate">{o.label}</span>
      {o.meta !== undefined && <span className="ml-auto pl-2 font-mono text-[10.5px] text-ink-3 tabular-nums">{o.meta}</span>}
    </ComboboxItem>
  )
}

/** The one action under the options, such as "Clear filters": a quiet full-width line over a rule. */
function SearchSelectAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="h-auto w-full justify-start rounded-none border-0 border-t border-border px-3 py-2 text-left text-xs font-normal text-ink-3 hover:bg-transparent focus-visible:border-border focus-visible:text-ink focus-visible:ring-0 max-md:h-auto max-md:rounded-none max-md:px-3 max-md:text-xs transition-none active:scale-100!"
    >
      {children}
    </Button>
  )
}

/**
 * A property picker as in Plane: a trigger button opens a popup with a search field and the options.
 * Single mode closes on pick; multiple mode stays open and keeps the typed filter.
 */
function SearchSelect({
  options,
  trigger,
  anchor,
  open,
  onOpenChange,
  placeholder = "Search",
  empty = "No matches",
  className,
  align = "start",
  footer,
  mixed,
  ...selection
}: Selection & {
  options: readonly SearchSelectOption[]
  /** The element that opens the popup, e.g. a Button; rendered as the combobox trigger. */
  trigger?: ReactElement
  /** Without a trigger: the element (or a virtual one at the pointer) the controlled popup is placed at. */
  anchor?: PopupAnchor
  open?: boolean
  onOpenChange?: (open: boolean) => void
  placeholder?: string
  empty?: string
  className?: string
  align?: "start" | "center" | "end"
  /** Shown under the options, e.g. a hint. */
  footer?: ReactNode
  /** Values only some of several things have (a bulk change): a dash instead of the check. */
  mixed?: ReadonlySet<string>
}) {
  const byValue = (v: string) => options.find((o) => o.value === v)
  const grouped = options.some((o) => o.group !== undefined)
  const common = {
    items: grouped ? toGroups(options) : options,
    // Typing then Enter picks the first match.
    autoHighlight: true,
    isItemEqualToValue: (a: SearchSelectOption, b: SearchSelectOption) => a.value === b.value,
    ...(open === undefined ? {} : { open }),
    ...(onOpenChange ? { onOpenChange: (o: boolean) => onOpenChange(o) } : {}),
  }
  const body = (
    <>
      {trigger && <ComboboxPrimitive.Trigger render={trigger} />}
      <ComboboxContent className={className ?? "w-56"} align={align} {...(anchor ? { anchor } : {})}>
        <p className="px-[18px] pb-2 text-[16px] font-semibold md:hidden">{placeholder.replace(/…$/, "")}</p>
        <ComboboxInput showTrigger={false} placeholder={placeholder} {...(options.length <= SHORT ? { className: "max-md:hidden" } : {})} />
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {grouped
            ? (g: OptionGroup) => (
                <ComboboxGroup key={g.value} items={g.items}>
                  {g.value && <ComboboxLabel>{g.value}</ComboboxLabel>}
                  <ComboboxCollection>{(o: SearchSelectOption) => <OptionItem key={o.value} o={o} mixed={mixed} />}</ComboboxCollection>
                </ComboboxGroup>
              )
            : (o: SearchSelectOption) => <OptionItem key={o.value} o={o} mixed={mixed} />}
        </ComboboxList>
        {footer}
      </ComboboxContent>
    </>
  )

  if (selection.multiple) {
    const { onChange } = selection
    return (
      <Combobox
        {...common}
        multiple
        value={selection.value.map(byValue).filter((o) => o !== undefined)}
        onValueChange={(v) => onChange(v.map((o) => o.value))}
        // Keep the typed filter while picking several options.
        onInputValueChange={(_, details) => {
          if (details.isItemPress) details.cancel()
        }}
      >
        {body}
      </Combobox>
    )
  }
  const { onChange } = selection
  return (
    <Combobox
      {...common}
      value={selection.value === null ? null : (byValue(selection.value) ?? null)}
      onValueChange={(o) => {
        if (o) onChange(o.value)
      }}
    >
      {body}
    </Combobox>
  )
}

export { SearchSelect, SearchSelectAction }
