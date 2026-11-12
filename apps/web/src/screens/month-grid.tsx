// A month's page: the weekdays from the person's first day of the week (Settings › Profile) and one cell per day, the
// caller's. The cycle dialog's calendar draws cycles in its cells, a date chip's draws a choice.
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import type { ReactNode } from "react";
import { account } from "../account.ts";
import { monthGrid } from "../lib/cycle-calendar.ts";

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** As getDay counts, from Sunday. */
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export const MonthGrid = observer(function MonthGrid({ y, m, className, children }: { y: number; m: number; className?: string; children: (day: string) => ReactNode }) {
  const start = account.settings.weekStart;
  return (
    <div className={cn("grid grid-cols-7 gap-y-0.5", className)}>
      {[...WEEKDAYS.slice(start), ...WEEKDAYS.slice(0, start)].map((d) => (
        <span key={d} className="grid h-5 place-items-center font-mono text-[10px] text-ink-3">
          {d}
        </span>
      ))}
      {monthGrid(y, m, start).map(children)}
    </div>
  );
});
