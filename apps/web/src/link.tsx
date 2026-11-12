// A link inside the app: the address once, for the browser (a new tab, copy link) and for the router (RSVA-426).
import type { ComponentProps, MouseEvent } from "react";
import { navigateOnClick } from "./router.ts";

type LinkProps = ComponentProps<"a"> & {
  href: string;
  /** Where a plain click goes when it is not `href`: an issue beside its list while the link keeps the issue's page. */
  to?: string;
  /** Runs before a plain click navigates. */
  before?: () => void;
  /** The list an issue page follows (Router.from). */
  from?: string | null;
};

/** A plain left click navigates in place; a modified one, or one the caller's onClick prevents, keeps the browser's. */
export function Link({ href, to, before, from = null, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (!e.defaultPrevented) navigateOnClick(e, to ?? href, before, from);
      }}
      {...rest}
    />
  );
}
