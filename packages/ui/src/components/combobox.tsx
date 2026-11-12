import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import { cn } from "../lib/utils.ts"
import { focusBackOnKeys, MENU_ITEM, POPUP_MOTION, POPUP_SIDES, POPUP_SURFACE, SHEET_BACKDROP } from "../lib/menu"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@rsva/ui/components/input-group"
import { CaretDownIcon, XIcon, CheckIcon, MinusIcon } from "@phosphor-icons/react"

const Combobox = ComboboxPrimitive.Root

function ComboboxTrigger({
  className,
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("[&_svg:not([class*='size-'])]:size-3.5", className)}
      {...props}
    >
      {children}
      <CaretDownIcon className="pointer-events-none size-3.5 text-muted-foreground" />
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroupButton variant="ghost" />}
      className={cn(className)}
      {...props}
    >
      <XIcon className="pointer-events-none" />
    </ComboboxPrimitive.Clear>
  )
}

function ComboboxInput({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  ...props
}: ComboboxPrimitive.Input.Props & {
  showTrigger?: boolean
  showClear?: boolean
}) {
  return (
    <InputGroup className={cn("w-auto", className)}>
      <ComboboxPrimitive.Input
        render={<InputGroupInput disabled={disabled} />}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        {showTrigger && (
          <InputGroupButton
            variant="ghost"
            render={<ComboboxTrigger />}
            data-slot="input-group-button"
            className="group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent"
            disabled={disabled}
          />
        )}
        {showClear && <ComboboxClear disabled={disabled} />}
      </InputGroupAddon>
      {children}
    </InputGroup>
  )
}

function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  finalFocus = focusBackOnKeys,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Backdrop className={SHEET_BACKDROP} />
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="sheet-positioner isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          finalFocus={finalFocus}
          data-chips={!!anchor}
          className={cn("sheet group/combobox-content relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-[calc(var(--anchor-width)+--spacing(7))] origin-(--transform-origin) overflow-hidden duration-100 data-[chips=true]:min-w-(--anchor-width) *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-7 max-md:*:data-[slot=input-group]:mx-3.5 max-md:*:data-[slot=input-group]:mb-1 max-md:*:data-[slot=input-group]:h-11 *:data-[slot=input-group]:border-none *:data-[slot=input-group]:bg-input/20 *:data-[slot=input-group]:shadow-none dark:bg-popover", POPUP_SURFACE, POPUP_SIDES, POPUP_MOTION, className )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 max-md:max-h-none max-md:min-h-0 max-md:flex-1 max-md:p-0 data-empty:p-0",
        className
      )}
      {...props}
    />
  )
}

/** The marker on the right of an item: a check when it is chosen, a dash when only some of several things have it. */
const ITEM_MARK = "pointer-events-none absolute right-2 flex items-center justify-center max-md:right-[18px]"

function ComboboxItem({
  className,
  children,
  mixed,
  ...props
}: ComboboxPrimitive.Item.Props & {
  /** Some of the things being changed have this value, not all (a bulk change): a dash, as a checkbox's indeterminate. */
  mixed?: boolean
}) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        MENU_ITEM,
        "group/item",
        className
      )}
      {...props}
    >
      {children}
      {mixed && (
        <span className={cn(ITEM_MARK, "group-data-selected/item:hidden")}>
          <MinusIcon aria-hidden />
          <span className="sr-only">on some</span>
        </span>
      )}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className={ITEM_MARK} />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      data-slot="combobox-group"
      className={cn(className)}
      {...props}
    />
  )
}

function ComboboxLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn("px-2 py-1.5 text-caption text-muted-foreground max-md:px-[18px]", className)}
      {...props}
    />
  )
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
  return (
    <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
  )
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "hidden w-full justify-center py-2 text-center text-xs/relaxed text-muted-foreground max-md:py-8 max-md:text-label group-data-empty/combobox-content:flex",
        className
      )}
      {...props}
    />
  )
}

export {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
}
