// The connection's numbers, behind a click on its status: was it the network or the server, and is this tab keeping up.
// In the lazy edit chunk. `trigger` is left out where the panel opens from a menu item (the phone's More menu): that is
// a sheet, placed by CSS, but a popup with nothing to anchor it stays hidden.
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@rsva/ui/components/popover";
import { observer } from "mobx-react-lite";
import { Fragment, useEffect } from "react";
import { timeAgo } from "../lib/time.ts";
import { store } from "../store.ts";
import type { MenuProps } from "./lazy-menu.tsx";
import { SyncStatus } from "./sidebar-foot.tsx";

const ms = (value: number | null) => (value === null ? "—" : `${value} ms`);

function rows(): [name: string, value: string][] {
  const { pingMs, saveMs, behind, drops, lostAt } = store.link;
  return [
    ["Ping", ms(pingMs)],
    ["Save", ms(saveMs)],
    ["Behind", behind === null ? "—" : String(behind)],
    ["Drops", lostAt ? `${drops}, ${timeAgo(lostAt, Date.now())}` : "0"],
    ["Log", `#${store.lastSyncId}`],
  ];
}

type ConnectionPanelProps = Omit<MenuProps, "trigger"> & Partial<Pick<MenuProps, "trigger">>;

export const ConnectionPanel = observer(function ConnectionPanel({ open, onOpenChange, trigger }: ConnectionPanelProps) {
  useEffect(() => {
    if (open) store.measureLink(); // the regular ping is up to 20 s old
  }, [open]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger && <PopoverTrigger render={trigger} />}
      <PopoverContent anchor={trigger ? undefined : document.body} side="top" align="start" sideOffset={6} className="w-52 gap-2.5 p-3 max-md:w-full">
        <PopoverTitle className="flex items-center gap-2 text-caption font-medium">
          <SyncStatus />
        </PopoverTitle>
        <dl className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1.5 text-caption text-ink-3">
          {rows().map(([name, value]) => (
            <Fragment key={name}>
              <dt>{name}</dt>
              <dd className="text-right font-mono text-meta text-ink-2 tabular-nums">{value}</dd>
            </Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
});
