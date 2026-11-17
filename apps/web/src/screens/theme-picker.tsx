// Settings › Appearance (ADR 0031): the theme — the mode and one of fourteen pairs — and the layout, the window's panes
// and the rows' density (panes.ts). After the ProfileAppearance artboard: a card per pair with the app in miniature
// twice, its light and its dark side, each drawn in that theme's own colors (its box carries data-theme, so the tokens
// inside are the theme's, whatever is on screen); the pair's name and its two themes.
// A change shows at once and is saved to the account.
import { CheckIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import type { ThemeMode } from "@rsva/protocol";
import { RadioCard, RadioGroup } from "@rsva/ui/components/radio-group";
import { Segmented } from "@rsva/ui/components/segmented";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import type { StartedStage } from "@rsva/schema/models";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { account } from "../account.ts";
import { pairOnScreen, THEME_PAIRS, type ThemeInfo, type ThemePair } from "@rsva/display/themes";
import { setUi, uiChoice } from "../panes.ts";
import { DENSITY, DENSITY_HINT, PANES, PANES_HINT } from "./layout-options.tsx";
import { theme } from "../theme.ts";
import { saving } from "./save-status.tsx";

const MODES: readonly { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const MODE_HINT: Record<ThemeMode, string> = {
  system: "Follows your device: the pair's light side by day, its dark side at night.",
  light: "The pair's light side all day.",
  dark: "The pair's dark side all day.",
};

export const Appearance = observer(function Appearance() {
  const { mode, light, dark } = theme.choice;
  const { panes, density } = uiChoice();
  const on = pairOnScreen(light, dark, theme.dark);
  // Another device may have changed them since this one saved its copy.
  useEffect(() => void account.refresh(), []);
  return (
    <>
      <SettingsSection id="theme" title="Theme" description="Each pair is a light and a dark side of one idea: the mode picks the side.">
        <SettingRow label="Mode" hint={MODE_HINT[mode]}>
          <Segmented label="Mode" options={MODES} value={mode} onChange={(m) => saving(theme.set({ mode: m }))} />
        </SettingRow>
        <RadioGroup
          aria-label="Theme"
          value={on.name}
          onValueChange={(v: unknown) => {
            const p = THEME_PAIRS.find((t) => t.name === v)!;
            void saving(theme.pick(p.light.id, p.dark.id));
          }}
          className="grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-4 py-4 max-md:grid-cols-1"
        >
          {THEME_PAIRS.map((p) => (
            <PairCard key={p.name} pair={p} onScreen={p === on ? (theme.dark ? "dark" : "light") : null} />
          ))}
        </RadioGroup>
      </SettingsSection>
      <SettingsSection id="layout" title="Layout" description="On a wide screen; a phone shows one pane at a time.">
        <SettingRow label="Panes" hint={PANES_HINT[panes]}>
          <Segmented label="Panes" options={PANES} value={panes} onChange={(p) => saving(setUi({ panes: p }))} />
        </SettingRow>
        <SettingRow label="Density" hint={DENSITY_HINT[density]}>
          <Segmented label="Density" options={DENSITY} value={density} onChange={(d) => saving(setUi({ density: d }))} />
        </SettingRow>
      </SettingsSection>
    </>
  );
});

/** A pair: its two sides in miniature, the side on screen marked; its name and its two themes. */
function PairCard({ pair, onScreen }: { pair: ThemePair; onScreen: "light" | "dark" | null }) {
  return (
    <RadioCard value={pair.name}>
      <span aria-hidden className="flex h-[104px] border-b border-rule">
        <Miniature info={pair.light} on={onScreen === "light"} />
        <Miniature info={pair.dark} on={onScreen === "dark"} />
      </span>
      <span className="flex flex-col gap-1 px-3 pt-2.5 pb-3">
        <span className="text-body font-semibold text-ink">{pair.name}</span>
        <span className="font-mono text-[11px] leading-[1.3] text-ink-2">
          {pair.light.name} / {pair.dark.name}
        </span>
      </span>
      <span className="absolute top-2 right-2 grid size-5 scale-50 place-items-center rounded-full bg-inverse text-inverse-ink opacity-0 transition duration-200 ease-spring group-data-checked/card:scale-100 group-data-checked/card:opacity-100">
        <CheckIcon weight="bold" className="size-3" />
      </span>
    </RadioCard>
  );
}

// The miniature's rows: a status, how long the title is, and whether it is selected (the signal's mark beside it).
const ROWS: readonly [group: string, stage: StartedStage | undefined, width: string, selected: boolean][] = [
  ["started", "review", "62%", true],
  ["started", "progress", "74%", false],
  ["unstarted", undefined, "52%", false],
  ["completed", undefined, "66%", false],
];

/** The app in one theme's colors: the sidebar, the top bar, four rows of a list; a sun or a moon in the corner, filled on the side on screen. */
function Miniature({ info, on }: { info: ThemeInfo; on: boolean }) {
  const Icon = info.dark ? MoonIcon : SunIcon;
  return (
    <span data-theme={info.id} className={cn(info.dark ? "dark" : "light", "relative flex min-w-0 flex-1 overflow-hidden bg-ground text-ink")}>
      <span className="flex w-[30px] shrink-0 flex-col gap-[5px] border-r border-rule bg-(--ql-sidebar) px-[5px] py-2">
        <span className="h-1 w-[70%] rounded-[2px] bg-ink-3" />
        <span className="h-2 rounded-[2px] bg-nav-current" />
        <span className="h-1 w-[60%] rounded-[2px] bg-rule-strong" />
        <span className="h-1 w-[76%] rounded-[2px] bg-rule-strong" />
        <span className="h-1 w-[52%] rounded-[2px] bg-rule-strong" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex h-[16px] shrink-0 items-center gap-1 border-b border-rule bg-panel px-1.5">
          <span className="h-1 w-[26px] rounded-[2px] bg-ink" />
          <span className="flex-1" />
          <span className="h-[7px] w-4 rounded-[2px] bg-inverse" />
        </span>
        {ROWS.map(([group, stage, width, selected], i) => (
          <span key={i} className={cn("flex h-[19px] shrink-0 items-center gap-[5px] border-b border-rule-soft px-1.5", selected && "bg-row-selected")}>
            <span className={cn("size-[7px] shrink-0 rounded-[2px]", selected && "bg-signal")} />
            <StateIcon group={group} {...(stage ? { stage } : {})} className="size-[8px] shrink-0" />
            <span className={cn("h-1 rounded-[2px]", group === "completed" ? "bg-ink-3" : "bg-ink-2")} style={{ width }} />
          </span>
        ))}
      </span>
      <span className={cn("absolute right-[5px] bottom-1 grid size-4 place-items-center rounded-full", on ? "bg-inverse text-inverse-ink" : "bg-panel text-ink-2 shadow-[inset_0_0_0_1px_var(--color-rule)]")}>
        <Icon weight="bold" className="size-2.5" />
      </span>
    </span>
  );
}
