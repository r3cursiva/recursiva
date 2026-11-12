import { CSPProvider } from "@base-ui/react/csp-provider"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"

import { focusBackOnKeys, MENU_ITEM, MENU_SURFACE, POPUP_MOTION, SHEET_BACKDROP } from "../lib/menu"

/** `shadcn add select`, with the Ledger's field and menu look; a bottom sheet on a phone like every popup. */
function Select<T extends string>({
  options,
  value,
  onChange,
  size = "default",
  className,
  "aria-label": ariaLabel,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  /** `default` is the 32px field, `sm` the 28px one for a table row or a line of text. */
  size?: "default" | "sm"
  className?: string
  "aria-label"?: string
}) {
  return (
    <SelectPrimitive.Root items={options} value={value} onValueChange={(v) => v !== null && v !== value && onChange(v)}>
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        data-size={size}
        aria-label={ariaLabel}
        className={cn(
          "flex w-fit max-w-full cursor-pointer items-center justify-between gap-1.5 rounded-md border border-control-border bg-field whitespace-nowrap transition-colors duration-120 outline-none hover:border-ink-3 focus-visible:border-ink-3 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:border-ink-3 max-md:rounded-lg data-[size=default]:h-8 data-[size=default]:px-2.5 data-[size=default]:text-[13.5px] max-md:data-[size=default]:h-11 max-md:data-[size=default]:px-3 max-md:data-[size=default]:text-base data-[size=sm]:h-7 data-[size=sm]:px-2 data-[size=sm]:text-[12.5px] max-md:data-[size=sm]:h-10 max-md:data-[size=sm]:text-base",
          className
        )}
      >
        <SelectPrimitive.Value className="min-w-0 truncate text-left" />
        <SelectPrimitive.Icon render={<CaretDownIcon className="pointer-events-none size-3 shrink-0 text-ink-3 max-md:size-3.5" />} />
      </SelectPrimitive.Trigger>
      {/* No <style> from Base UI (PLNR-274): the server's style-src 'self' blocks an inline one. Its rule hides the
          scrollbar of .base-ui-disable-scrollbar, a class Base UI gives only a popup aligned with its trigger or one with
          scroll arrows, and this popup is neither. */}
      <CSPProvider disableStyleElements>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Backdrop className={SHEET_BACKDROP} />
          <SelectPrimitive.Positioner alignItemWithTrigger={false} align="start" sideOffset={4} className="sheet-positioner isolate z-50 outline-none">
            <SelectPrimitive.Popup
              data-slot="select-content"
              finalFocus={focusBackOnKeys}
              className={cn(
                "sheet z-50 max-h-(--available-height) w-max max-w-(--available-width) min-w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
                MENU_SURFACE,
                POPUP_MOTION
              )}
            >
              <SelectPrimitive.List>
                {options.map((o) => (
                  <SelectPrimitive.Item key={o.value} value={o.value} data-slot="select-item" className={cn(MENU_ITEM, "pr-8 max-md:pr-11")}>
                    <SelectPrimitive.ItemText className="min-w-0 truncate">{o.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator render={<span className="pointer-events-none absolute right-2 flex items-center justify-center max-md:right-[18px]" />}>
                      <CheckIcon />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.List>
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </CSPProvider>
    </SelectPrimitive.Root>
  )
}

export { Select }
