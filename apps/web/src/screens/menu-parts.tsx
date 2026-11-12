// Parts of the header panels (the Display popover, the View panel's Sharing, the inbox's display options): titled
// sections, single choices, a setting's row.
import { CheckIcon } from "@phosphor-icons/react";
import { ToggleGroup, ToggleGroupItem } from "@rsva/ui/components/toggle-group";
import { cn } from "@rsva/ui/lib/utils";
import { useId, type ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <h3 id={id} className="px-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

const ROW =
  "justify-start gap-2 text-left font-normal transition-none hover:text-inherit focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-transparent aria-pressed:font-medium aria-pressed:hover:bg-muted max-md:h-11 max-md:gap-3 max-md:text-[15px]";
const CHIPS = "w-auto flex-wrap gap-[5px] max-md:gap-2";
// Sizes by hand: the toggle's text-xs comes later in the CSS than text-caption and would win.
const CHIP =
  "h-6 min-w-0 rounded-full border border-control-border bg-panel px-2 text-[12px]/[1.4] font-normal whitespace-normal text-ink-2 max-md:h-9 max-md:px-3.5 max-md:text-[13px] transition-colors duration-120 hover:border-rule-strong hover:bg-panel hover:text-ink focus-visible:border-control-border focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-inverse aria-pressed:bg-inverse aria-pressed:text-inverse-ink";

/** A single choice: rows with a check, like Plane's display menu. */
export function Choice<T extends string | null>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <ToggleGroup aria-label={label} value={[String(value)]} className="grid w-auto gap-0.5">
      {options.map((o) => (
        <ToggleGroupItem key={String(o.value)} value={String(o.value)} onClick={() => onChange(o.value)} className={ROW}>
          <CheckIcon className={cn("size-3 shrink-0", o.value !== value && "invisible")} />
          <span className="truncate">{o.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Several things on or off at once, as chips. */
export function ToggleChips({ label, options }: { label: string; options: readonly { label: string; on: boolean; toggle: () => void }[] }) {
  return (
    <ToggleGroup multiple aria-label={label} value={options.filter((o) => o.on).map((o) => o.label)} className={CHIPS}>
      {options.map((o) => (
        <ToggleGroupItem key={o.label} value={o.label} onClick={o.toggle} className={CHIP}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * One setting in a panel: its name at the left, its control (a select, a switch, a segmented choice) at the right. A
 * label, so a press on the name works the control; `group` for a control of several inputs, which a label cannot hold.
 */
export function FieldRow({ label, group, children }: { label: ReactNode; group?: boolean; children: ReactNode }) {
  const Row = group ? "div" : "label";
  return (
    <Row className="flex min-h-8 items-center justify-between gap-3 max-md:min-h-12">
      <span className="min-w-0 truncate text-label text-ink-2">{label}</span>
      {children}
    </Row>
  );
}
