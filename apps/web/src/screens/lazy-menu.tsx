// A menu whose popup lives in the lazy edit chunk (Base UI's Menu is not in the startup JS). Until the chunk is here the
// trigger is a plain button: a click mounts the menu and opens it as soon as the chunk arrives. The workspace switcher,
// the sidebar's project menus and its account button use it.
import { Suspense, useState, type ComponentProps, type ComponentType, type ReactElement } from "react";

export interface MenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
}

/** A menu opened by its trigger, or with none at a point (a right click where no trigger shows). */
export type MenuOrAnchor = Omit<MenuProps, "trigger"> & { trigger?: ReactElement; anchor?: { getBoundingClientRect(): DOMRect } };

/** `props` go to the menu as they are: what it is about (a project), beside the open state and the trigger. */
export function LazyMenu<P extends object = object>({
  menu: Menu,
  props,
  button,
}: {
  menu: ComponentType<MenuProps & P>;
  props?: P;
  button: (props: ComponentProps<"button">, open: boolean) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const fallback = button(
    {
      "aria-haspopup": "menu",
      onClick: () => {
        setMounted(true);
        setOpen(true);
      },
    },
    open,
  );
  if (!mounted) return fallback;
  return (
    <Suspense fallback={fallback}>
      <Menu {...(props as P)} open={open} onOpenChange={setOpen} trigger={button({}, open)} />
    </Suspense>
  );
}
