// The frame of a dialog that makes one thing, a project or a cycle (RSVA-426): high on the screen, where it is made as
// a crumb over the name, and a footer with a note, Cancel and the submit button that stays over a phone's keyboard.
import { NAME_MAX } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@rsva/ui/components/dialog";
import { Kbd } from "@rsva/ui/components/kbd";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import type { ComponentProps, ReactNode } from "react";

/** `className` gives the dialog its width. */
export function CreateDialog({ onClose, className, children }: { onClose: () => void; className: string; children: ReactNode }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className={cn("top-[10vh] max-w-[calc(100%-2rem)] translate-y-0 gap-0 p-0 text-sm", className)} aria-describedby={undefined}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Where the new thing goes (a chip with its icon and name), then the dialog's title. */
export function CreateCrumb({ where, title }: { where: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-5 pt-5">
      {where && <span className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-caption">{where}</span>}
      <span aria-hidden className="text-faint">
        ›
      </span>
      <DialogTitle className="text-label font-medium">{title}</DialogTitle>
    </div>
  );
}

/** The name, large and without a frame, focused when the dialog opens. */
export function CreateName({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      autoFocus
      aria-label="Name"
      maxLength={NAME_MAX}
      className={cn("bg-transparent py-1 text-lg font-medium outline-none placeholder:text-ink-3", className)}
      {...props}
    />
  );
}

/** The note on what happens next, Cancel and the submit button with its ⌘↵. */
export function CreateFooter({ note, onCancel, disabled, children }: { note: ReactNode; onCancel: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <div className="mt-4 flex items-center gap-2 border-t px-5 py-3 max-md:sticky max-md:-bottom-[calc(10px+var(--safe-bottom))] max-md:z-10 max-md:-mb-[calc(10px+var(--safe-bottom))] max-md:bg-panel max-md:pb-[calc(12px+var(--safe-bottom))]">
      <span className="flex-1 text-caption text-ink-3">{note}</span>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={disabled}>
        {children}
        <Kbd inverse>{keys("mod", "↵")}</Kbd>
      </Button>
    </div>
  );
}
