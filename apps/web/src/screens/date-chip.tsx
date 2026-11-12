// A date as a chip, after Linear (PLNR-112): the value with a button that clears it; a click opens a calendar and turns
// the value into a field to type in. The chip writes once, when the calendar closes: a day picked, Enter, or a click
// elsewhere, and only what the person chose: with nothing typed a date changed meanwhile stays. Escape leaves the date.
// A due date's chip opens its quick dates first (PLNR-117): a preset writes at once, Pick a date opens the calendar.
//
// A native date field wrote on every edit: it holds a whole date after each digit of a year, so typing 2991 sent the
// years 2, 29, 299 and 2991 to the server, each a line in the history and a real value for every open client.
// The list and board cells and the create modal open the same calendar and field in a popup (date-calendar.tsx). Considered:
// - the browser's picker alone: one write, but no typing and the look is the browser's;
// - writing on blur with a native field: a click in the browser's popup does not blur, so it needs a timer as well;
// - react-day-picker and the like: 10–20 KB brotli for a page of days the cycle dialog already draws;
// - this: the native field keeps typing, locale and the keyboard for free, and the calendar is one page of buttons for
//   the pointer, so its days stay out of the tab order. The field is not controlled: setting the value of a field holding
//   a half-typed year would throw the typing away.
import { CalendarBlankIcon, XCircleIcon } from "@phosphor-icons/react";
import type { PopoverCloseDetails } from "@rsva/ui/components/popover";
import { Hint } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { useRef, useState } from "react";
import { formatDate } from "@rsva/display/time";
import { finishDate } from "../lib/date-write.ts";
import { useIsPhone } from "../lib/phone.ts";
import { DateCalendar, DateField, DatePresetMenu, useDateDraft, type PresetsOf } from "./date-calendar.tsx";

export interface DateChipForm {
  /** Part of a chip that holds both dates: the value alone, its calendar below; the clear button shows while it is open. */
  compact?: boolean;
  /** Comes up with its calendar open: + Property has just asked for this date. */
  startOpen?: boolean;
  onClosed?: () => void;
}

export function DateChip({
  name,
  value,
  onChange,
  overdue = false,
  compact = false,
  startOpen = false,
  onClosed,
  presets,
}: { name: string; value: string | null; onChange: (day: string | null) => void; overdue?: boolean; presets?: PresetsOf | undefined } & DateChipForm) {
  const phone = useIsPhone();
  const [open, setOpen] = useState(startOpen);
  const { chosen, draft, month, setMonth, reset, typed } = useDateDraft(value);
  const chip = useRef<HTMLSpanElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const show = () => {
    reset();
    setOpen(true);
  };
  const finish = (day: string | null | undefined) => finishDate(value, day, () => setOpen(false), onChange, onClosed);
  const onOpenChange = (next: boolean, details: PopoverCloseDetails) => {
    if (next) return;
    if (details.reason === "escape-key") return finish(undefined);
    // The chip stays part of the open calendar: a press on its field or its clear button is not a press outside.
    if (details.event.target instanceof Node && chip.current?.contains(details.event.target)) return details.cancel();
    finish(chosen);
  };

  const shown = open ? draft : value;
  const button = (
    <button
      ref={opener}
      type="button"
      aria-label={shown ? `${name}: ${formatDate(shown)}` : name}
      // With presets the menu opens on a click and says whether it is open.
      {...(presets ? {} : { "aria-expanded": open, onClick: show })}
      className={cn("flex h-full min-w-0 items-center gap-2 rounded-[inherit] px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:gap-[7px] max-md:px-[11px] [&_svg]:size-3.5 [&_svg]:shrink-0", compact && "px-0.5 max-md:px-0.5")}
    >
      {!compact && <CalendarBlankIcon className="text-ink-3" />}
      {shown ? (
        <span className={cn("truncate font-mono text-[12.5px] text-ink", compact && "text-[11.5px]", overdue && "text-signal-text")}>{formatDate(shown)}</span>
      ) : (
        <span className="truncate text-ink-3">
          <span className="max-md:hidden">No date</span>
          <span className="md:hidden">{name}</span>
        </span>
      )}
    </button>
  );
  const trigger = compact ? <Hint label={name}>{button}</Hint> : button;
  return (
    <>
      <span
        ref={chip}
        className={cn(
          "-ml-2 inline-flex h-6 w-fit max-w-full items-center rounded-md border border-transparent text-[13px] transition-colors duration-120 max-md:ml-0 max-md:h-[34px] max-md:rounded-[9px] max-md:border-control-border max-md:bg-panel",
          shown ? "border-control-border" : "hover:bg-row-hover",
          compact && "ml-0 h-5 border-transparent",
          open && "border-ring ring-1 ring-ring max-md:border-ring",
        )}
      >
        {open && !phone ? (
          <DateField name={name} value={value} onDraft={typed} onEnter={() => finish(chosen)} className="pl-2" />
        ) : presets ? (
          <DatePresetMenu {...presets} trigger={trigger} onPick={finish} onCalendar={show} />
        ) : (
          trigger
        )}
        {shown && (!compact || open) && (
          <Hint label={`Clear ${name.toLowerCase()}`}>
            <button
              type="button"
              aria-label={`Clear ${name.toLowerCase()}`}
              onClick={() => finish(null)}
              className="-ml-1 grid h-full w-6 shrink-0 place-items-center rounded-[inherit] text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:w-8 [&_svg]:size-3.5"
            >
              <XCircleIcon weight="fill" />
            </button>
          </Hint>
        )}
      </span>
      <DateCalendar
        open={open}
        onOpenChange={onOpenChange}
        anchor={chip}
        side={compact ? "bottom" : "left"}
        finalFocus={opener}
        month={month}
        onMonth={setMonth}
        picked={draft}
        onPick={finish}
      />
    </>
  );
}
