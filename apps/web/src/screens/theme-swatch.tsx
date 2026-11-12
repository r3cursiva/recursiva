// A theme in a dot (the command palette's theme list, ADR 0031): its panel with its signal in the middle, drawn in the
// theme's own colors whatever is on screen.
import { cn } from "@rsva/ui/lib/utils";
import type { ThemeInfo } from "@rsva/display/themes";

export function ThemeSwatch({ info }: { info: ThemeInfo }) {
  return (
    <span aria-hidden data-theme={info.id} className={cn(info.dark ? "dark" : "light", "grid size-4 shrink-0 place-items-center rounded-full border border-rule-strong bg-panel")}>
      <span className="size-1.5 rounded-full bg-signal" />
    </span>
  );
}
