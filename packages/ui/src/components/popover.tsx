"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "../lib/utils.ts"
import { focusBackOnKeys, POPUP_MOTION, POPUP_SIDES, POPUP_SURFACE, SHEET_BACKDROP } from "../lib/menu"

/** What a popover's onOpenChange is told: why it changes, and `cancel()` to keep it as it is. */
type PopoverCloseDetails = PopoverPrimitive.Root.ChangeEventDetails

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  anchor,
  side = "bottom",
  sideOffset = 4,
  finalFocus = focusBackOnKeys,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "anchor" | "side" | "sideOffset"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Backdrop className={SHEET_BACKDROP} />
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        className="sheet-positioner isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          finalFocus={finalFocus}
          className={cn(
            "sheet z-50 flex w-72 origin-(--transform-origin) flex-col gap-4 p-2.5 text-xs outline-hidden duration-100",
            POPUP_SURFACE,
            POPUP_SIDES,
            POPUP_MOTION,
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  type PopoverCloseDetails,
}
