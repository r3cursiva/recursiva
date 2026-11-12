// The calendar of a date (PLNR-112, PLNR-114): a popover with a month's page and the field to type the date in. DateChip
// (the issue panel) draws the field in the chip; DatePopup (list and board cells, the create modal) puts it at the top of
// the popup, where focus lands on open. Focus has to be inside the popup: a popup that leaves it outside lets Escape and
// the list's keys (J, K, c, g) reach the screen behind. The days stay out of the tab order, the field has the keyboard.
// On a phone there is no field (it would raise the native picker): the popup takes focus itself. A due date's chip and
// cell open a menu of quick dates first (DatePresetMenu); its Pick a date hands over to the calendar.
import { ArrowBendUpRightIcon, CalendarBlankIcon, CaretLeftIcon, CaretRightIcon, XCircleIcon } from "@phosphor-icons/react";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Popover, PopoverContent } from "@rsva/ui/components/popover";
import { Hint } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useRef, useState, type ChangeEvent, type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { account } from "../account.ts";
import { monthOf, shifted } from "../lib/cycle-calendar.ts";
import { cycleEnd, datePresets } from "@rsva/display/date-presets";
import { localToday } from "@rsva/query";
import { formatDate } from "@rsva/display/time";
import { finishDate } from "../lib/date-write.ts";
import { useIsPhone } from "../lib/phone.ts";
import { store } from "../store.ts";
import { MONTHS, MonthGrid } from "./month-grid.tsx";

type Content = ComponentProps<typeof PopoverContent>;

/** What a half-typed year reads as ("0299") stays out: no issue starts before this. */
const FIRST_DAY = "1900-01-01";
/** Holds the year to four digits; without it Chromium takes six. */
const LAST_DAY = "9999-12-31";

/** The open calendar's state: what the person typed so far (`undefined`: nothing, the live `value` shows), and the page. */
export function useDateDraft(value: string | null) {
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [month, setMonth] = useState(() => monthOf(value ?? localToday()));
  return {
    chosen,
    draft: chosen === undefined ? value : chosen,
    month,
    setMonth,
    /** Starts from `value` again. */
    reset: () => {
      setChosen(undefined);
      setMonth(monthOf(value ?? localToday()));
    },
    /** A date typed in the field: a whole day, or null when the field was emptied. */
    typed: (day: string | null) => {
      setChosen(day);
      if (day) setMonth(monthOf(day));
    },
  };
}

/**
 * The native date field, to type in. Not controlled: setting the value of a field holding a half-typed year would throw
 * the typing away. `onDraft` gets each whole date; Enter calls `onEnter`.
 */
export function DateField({ name, value, onDraft, onEnter, inputRef, className }: { name: string; value: string | null; onDraft: (day: string | null) => void; onEnter: () => void; inputRef?: React.Ref<HTMLInputElement>; className?: string }) {
  const read = (field: HTMLInputElement) => {
    const day = field.value;
    if (day >= FIRST_DAY) onDraft(day);
    else if (!day && !field.validity.badInput) onDraft(null); // Every part of the field emptied; a part still missing reads as badInput.
  };
  const onChange = (e: ChangeEvent<HTMLInputElement>) => read(e.target);
  // Chromium fires one input event, on the first part Backspace clears (badInput); emptying the rest fires none, so the
  // field would look empty while Enter kept the date. The key's release sees the field as it is now.
  const onKeyUp = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" || e.key === "Delete") read(e.currentTarget);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault(); // The close hands focus to the opener: the Enter must not press it again.
      onEnter();
    }
    // The browser's own picker: a calendar is open already.
    if (e.key === " ") e.preventDefault();
  };
  return (
    <label className={cn("flex items-center gap-2 [&_svg]:size-3.5 [&_svg]:shrink-0", className)}>
      <CalendarBlankIcon className="text-ink-3" />
      <input
        ref={inputRef}
        autoFocus
        type="date"
        aria-label={name}
        min={FIRST_DAY}
        max={LAST_DAY}
        defaultValue={value ?? ""}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className="w-[92px] bg-transparent font-mono text-[12.5px] text-ink outline-none scheme-light dark:scheme-dark [&::-webkit-calendar-picker-indicator]:hidden"
      />
    </label>
  );
}

export function DateCalendar({
  open,
  onOpenChange,
  anchor,
  side = "bottom",
  finalFocus,
  initialFocus = false,
  top,
  month,
  onMonth,
  picked,
  onPick,
  onClear,
}: {
  open: boolean;
  onOpenChange: ComponentProps<typeof Popover>["onOpenChange"];
  anchor: Content["anchor"];
  side?: Content["side"];
  finalFocus?: Content["finalFocus"];
  /** Where focus goes on open: nowhere by default (the chip's field has it already). */
  initialFocus?: Content["initialFocus"];
  /** Above the month, in the popup. */
  top?: ReactNode;
  month: { y: number; m: number };
  onMonth: (page: (v: { y: number; m: number }) => { y: number; m: number }) => void;
  /** The day shown as chosen. */
  picked: string | null;
  onPick: (day: string) => void;
  /** Shows a button that clears the date: where the calendar has no chip with its own. */
  onClear?: () => void;
}) {
  const now = localToday();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent anchor={anchor} side={side} align="start" sideOffset={8} initialFocus={initialFocus} finalFocus={finalFocus} className="w-[264px] gap-2 p-3 max-md:w-full">
        <TabWrap to="last" />
        {top}
        <div className="flex items-center gap-0.5">
          <p className="flex-1 pl-1 text-label font-semibold">
            {MONTHS[month.m]} {month.y}
          </p>
          {onClear && picked && (
            <Hint label="Clear date">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear date" onClick={onClear}>
                <XCircleIcon weight="fill" />
              </Button>
            </Hint>
          )}
          <Hint label="This month">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="This month" onClick={() => onMonth(() => monthOf(now))}>
              <ArrowBendUpRightIcon />
            </Button>
          </Hint>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Earlier month" onClick={() => onMonth((v) => shifted(v, -1))}>
            <CaretLeftIcon />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Later month" onClick={() => onMonth((v) => shifted(v, 1))}>
            <CaretRightIcon />
          </Button>
        </div>
        <div className="relative">
          <span className="absolute inset-y-0 right-0 w-[calc(200%/7)] rounded-md bg-row-hover" />
          <MonthGrid y={month.y} m={month.m} className="relative">
            {(d) => {
              const own = monthOf(d).m === month.m;
              const isPicked = d === picked;
              return (
                <button
                  key={d}
                  type="button"
                  tabIndex={-1}
                  aria-pressed={isPicked}
                  aria-label={`${formatDate(d)}${d === now ? ", today" : ""}`}
                  onClick={() => onPick(d)}
                  className="relative grid h-8 place-items-center font-mono text-[11.5px] outline-none max-md:h-11 max-md:text-[13px]"
                >
                  <span className={cn("grid h-6 w-7 place-items-center rounded-[4px] max-md:h-9 max-md:w-10", !own && "text-faint", isPicked ? "bg-inverse text-inverse-ink" : "hover:bg-row-selected")}>{Number(d.slice(8))}</span>
                  {d === now && !isPicked && <span className="absolute top-[3px] right-[5px] size-1 rounded-full bg-signal" />}
                </button>
              );
            }}
          </MonthGrid>
        </div>
        <TabWrap to="first" />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Tab past either end of the calendar comes back in at the other (RSVA-165). The popover is not modal, and in Chromium
 * Tab off its last button left the popup open with focus behind it, where J and K reached the list. A guard at each end
 * rather than a key handler: Tab also moves between the parts of the date field, and only the browser knows which part
 * is the last. Base UI traps focus only in a modal popover with a close part, and modal hides the rest of the page.
 */
function TabWrap({ to }: { to: "first" | "last" }) {
  return (
    <span
      tabIndex={0}
      aria-hidden
      className="sr-only"
      onFocus={(e) => {
        const inside = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("input, button") ?? [])].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled"));
        (to === "first" ? inside[0] : inside.at(-1))?.focus();
      }}
    />
  );
}

/**
 * The calendar open at `anchor`, for a place that has no chip: a list or board cell (row-popup-host.tsx), the create
 * modal. It writes once, when it closes with a choice: a day, Clear, Enter in the field, or a click elsewhere with a
 * date typed (a click elsewhere or Enter with nothing typed writes nothing, so a date changed meanwhile by another
 * client stays). Escape leaves the date as it was.
 */
export function DatePopup({ name, anchor, value, onChange, onClose }: { name: string; anchor: Content["anchor"]; value: string | null; onChange: (day: string | null) => void; onClose: () => void }) {
  const phone = useIsPhone();
  const field = useRef<HTMLInputElement>(null);
  const cell = useRef(anchor instanceof HTMLElement ? anchor : null); // Focus goes back to where the calendar was asked for: the field has it when the popup mounts.
  const { chosen, draft, month, setMonth, typed } = useDateDraft(value);
  const finish = (day: string | null | undefined) => finishDate(value, day, onClose, onChange);
  return (
    <DateCalendar
      open
      onOpenChange={(next, details) => !next && finish(details.reason === "escape-key" ? undefined : chosen)}
      anchor={anchor}
      finalFocus={cell}
      initialFocus={phone ? true : field}
      top={phone ? null : <DateField name={name} value={value} onDraft={typed} onEnter={() => finish(chosen)} inputRef={field} className="px-1" />}
      month={month}
      onMonth={setMonth}
      picked={draft}
      onPick={finish}
      onClear={() => finish(null)}
    />
  );
}

/** Where the menu reads the cycle's end from: the issue's cycle, or the project's cycle in progress. */
export interface PresetsOf {
  projectId: string;
  cycleId: string | null;
}

/**
 * Where the quick dates open: at the caller's chip, which opens them, or placed at `anchor` and open from the start (a
 * list or board cell, row-popup-host.tsx), where `onClose` takes the menu away: a press on an item does its own close.
 */
type PresetMenuAt = { trigger: ReactElement } | { anchor: NonNullable<ComponentProps<typeof DropdownMenuContent>["anchor"]>; onClose: () => void };

/**
 * A due date's quick dates (PLNR-117, the LedgerNewIssue artboard), each with its day; Pick a date opens the calendar. A
 * preset is written at once, as a day picked in the calendar is.
 */
export function DatePresetMenu({ projectId, cycleId, onPick, onCalendar, ...at }: PresetsOf & PresetMenuAt & { onPick: (day: string) => void; onCalendar: () => void }) {
  const placed = "anchor" in at ? at : null;
  return (
    <DropdownMenu {...(placed && { open: true, onOpenChange: (open: boolean, details: { reason: string }) => !open && details.reason !== "item-press" && placed.onClose() })}>
      {"trigger" in at && <DropdownMenuTrigger render={at.trigger} />}
      <DropdownMenuContent className="w-[212px]" {...(placed && { anchor: placed.anchor })}>
        {/* A sheet on a phone says what it sets, as the pickers' sheets do. */}
        <p className="px-[18px] pb-2 text-[16px] font-semibold md:hidden">Due date</p>
        <PresetItems projectId={projectId} cycleId={cycleId} onPick={onPick} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCalendar}>
          <CalendarBlankIcon />
          Pick a date
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Counted as the menu opens: today is the day it opens on. */
const PresetItems = observer(function PresetItems({ projectId, cycleId, onPick }: PresetsOf & { onPick: (day: string) => void }) {
  const now = localToday();
  const end = cycleEnd(cycleId ? store.cycles.get(cycleId) : undefined, store.cyclesOf(projectId), now);
  return datePresets(now, account.settings.weekStart, end).map((p) => (
    <DropdownMenuItem key={p.label} onClick={() => onPick(p.day)} className="justify-between">
      <span>{p.label}</span>
      <span className="font-mono text-meta text-ink-3">{formatDate(p.day)}</span>
    </DropdownMenuItem>
  ));
});
