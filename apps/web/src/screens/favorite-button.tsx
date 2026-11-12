// The star after a page's title, as in Linear (owner's call, 2026-11-06): it adds the open issue, view or cycle to the
// sidebar's Favorites or takes it out, the same as the item in its menu and ⌘K (pin-actions.ts), which stay for what
// is not open. Filled and in the warning's amber while it is a favorite. A wide screen's header only: a phone's has no room.
import { StarIcon } from "@phosphor-icons/react";
import type { PinRef } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { Hint } from "@rsva/ui/components/tooltip";
import { observer } from "mobx-react-lite";
import { store } from "../store.ts";
import { pinLabel, togglePin } from "./pin-actions.ts";

/** The star of a favorite: filled while it is one, an outline otherwise. Here and in the menus that add and remove it. */
export function FavoriteStar({ on, className }: { on: boolean; className?: string }) {
  return on ? <StarIcon weight="fill" className={className} /> : <StarIcon />;
}

export const FavoriteButton = observer(function FavoriteButton({ pin, name }: { pin: PinRef; name: string }) {
  const on = store.views.pinned(pin);
  return (
    <Hint label={pinLabel(pin)}>
      <Button variant="ghost" size="icon-sm" aria-label={pinLabel(pin)} aria-pressed={on} onClick={() => togglePin(pin, name)} className="shrink-0 max-md:hidden">
        <FavoriteStar on={on} className="text-warning" />
      </Button>
    </Hint>
  );
});
