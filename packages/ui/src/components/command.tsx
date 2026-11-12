import * as React from "react"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { Autocomplete } from "@base-ui/react/autocomplete"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { POPUP_SURFACE } from "../lib/menu"
import { cn } from "../lib/utils.ts"

import { Dialog, DialogOverlay, DialogPortal } from "@rsva/ui/components/dialog"

// A command menu in shadcn's shape (Command, CommandInput, CommandList…) on Base UI's Autocomplete and Dialog instead
// of cmdk: cmdk brings Radix Dialog (+14 KiB, ADR 0005). Filtering is the caller's: pass already filtered `items`
// (groups of items) and `filter={null}` is set here, so a large data set never becomes thousands of DOM options.

/** A dialog placed near the top, like Plane's and Linear's palettes. */
function CommandDialog({
  open,
  onOpenChange,
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogPortal>
        <DialogOverlay className="bg-black/40 data-closed:animate-none max-md:duration-100 dark:bg-black/40" />
        <DialogPrimitive.Popup
          data-slot="command-dialog"
          // The search field, not the first button (a sub-page's "Back"), takes the focus.
          initialFocus={() => document.querySelector<HTMLElement>("[data-slot=command-dialog] [data-slot=command-input]") ?? true}
          className={cn(
            "sheet max-md:h-[calc(100dvh-var(--keyboard)-var(--safe-top)-40px)] fixed top-[12vh] left-1/2 z-50 flex max-h-[min(32rem,76vh)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden",
            POPUP_SURFACE,
            "outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98",
            className
          )}
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

/** The autocomplete root, always open and inline; the caller filters. */
function Command(props: Omit<Autocomplete.Root.Props<unknown>, "open" | "inline" | "filter">) {
  return <Autocomplete.Root open inline filter={null} autoHighlight="always" keepHighlight {...props} />
}

function CommandInputRow({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="command-input-row" className={cn("flex h-12 shrink-0 items-center gap-2 border-b px-4 max-md:gap-3 max-md:px-[18px] max-md:pb-1 [&>svg]:size-4 max-md:[&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground", className)} {...props} />
}

function CommandInput({ className, ...props }: Autocomplete.Input.Props) {
  return (
    <Autocomplete.Input
      data-slot="command-input"
      className={cn("h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground max-md:text-base", className)}
      {...props}
    />
  )
}

/**
 * Where a sub-page of the palette is, before the field: "← Theme", "← PLNR-12 State" (pass the parts as children). A
 * press goes back; the focus stays in the field.
 */
function CommandScope({ className, children, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-slot="command-scope"
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-muted pr-2 pl-1.5 text-xs font-medium whitespace-nowrap text-foreground outline-none hover:bg-accent max-md:h-8 max-md:text-[13px]",
        className
      )}
      {...props}
    >
      <ArrowLeftIcon aria-hidden className="size-3.5 text-muted-foreground" />
      {children}
    </button>
  )
}

function CommandEmpty({ className, ...props }: Autocomplete.Empty.Props) {
  return <Autocomplete.Empty data-slot="command-empty" className={cn("px-4 py-8 text-center text-sm text-muted-foreground empty:hidden", className)} {...props} />
}

function CommandList({ className, ...props }: Autocomplete.List.Props) {
  return <Autocomplete.List data-slot="command-list" className={cn("min-h-0 flex-1 scroll-py-1.5 overflow-y-auto overscroll-contain p-1.5 max-md:p-0 max-md:pb-2 empty:p-0", className)} {...props} />
}

/** A group, titled unless `heading` is left out (a sub-page's one list); `children` renders each of its `items`. */
function CommandGroup({
  heading,
  className,
  children,
  ...props
}: Omit<Autocomplete.Group.Props, "children"> & { heading?: React.ReactNode; children: Autocomplete.Collection.Props["children"] }) {
  return (
    <Autocomplete.Group data-slot="command-group" className={cn("pb-1.5", className)} {...props}>
      {heading && <Autocomplete.GroupLabel className="px-2.5 pt-1.5 pb-1 text-caption text-muted-foreground max-md:px-[18px] max-md:pt-2.5">{heading}</Autocomplete.GroupLabel>}
      <Autocomplete.Collection>{children}</Autocomplete.Collection>
    </Autocomplete.Group>
  )
}

function CommandItem({ className, ...props }: Autocomplete.Item.Props) {
  return (
    <Autocomplete.Item
      data-slot="command-item"
      className={cn(
        "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm max-md:h-[52px] max-md:gap-3.5 max-md:rounded-none max-md:px-[18px] max-md:text-[15px] outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([data-slot=state-icon],[data-slot=priority-icon])]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="command-shortcut" className={cn("ml-auto shrink-0 text-xs text-muted-foreground tabular-nums max-md:font-mono max-md:text-[11.5px]", className)} {...props} />
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="command-footer" className={cn("flex h-9 shrink-0 items-center gap-3 border-t px-4 text-xs text-muted-foreground pointer-coarse:hidden", className)} {...props} />
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandInputRow,
  CommandItem,
  CommandList,
  CommandScope,
  CommandShortcut,
}
