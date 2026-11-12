// Settings › Appearance (ADR 0031): the theme — the mode, a light and a dark theme out of eight each — and the layout,
// the window's panes and the rows' density (panes.ts). After the
// NavAccountSettings artboard: a card per theme with the app in miniature, drawn in that theme's own colors (its box
// carries data-theme, so the tokens inside are the theme's, whatever is on screen), its name and a line on its look.
// A change shows at once and is saved to the account.
import { CheckCircleIcon, WarningOctagonIcon } from "@phosphor-icons/react";
import type { ThemeMode } from "@rsva/protocol";
import { RadioCard, RadioGroup } from "@rsva/ui/components/radio-group";
import { Segmented } from "@rsva/ui/components/segmented";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import type { StartedStage } from "@rsva/schema/models";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef } from "react";
import { account } from "../account.ts";
import { DARK_THEME_INFO, LIGHT_THEME_INFO, type ThemeInfo } from "@rsva/display/themes";
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
  system: "Follows your device: the light theme by day, the dark one at night.",
  light: "The light theme all day.",
  dark: "The dark theme all day.",
};

export const Appearance = observer(function Appearance() {
  const { mode, light, dark } = theme.choice;
  const { panes, density } = uiChoice();
  // Another device may have changed them since this one saved its copy.
  useEffect(() => void account.refresh(), []);
  return (
    <>
      <SettingsSection id="theme" title="Theme">
        <SettingRow label="Mode" hint={MODE_HINT[mode]}>
          <Segmented label="Mode" options={MODES} value={mode} onChange={(m) => saving(theme.set({ mode: m }))} />
        </SettingRow>
        <ThemeGroup label="Light theme" hint="In light mode." themes={LIGHT_THEME_INFO} value={light} active={!theme.dark} />
        <ThemeGroup label="Dark theme" hint="In dark mode." themes={DARK_THEME_INFO} value={dark} active={theme.dark} />
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

/**
 * Eight themes of one kind in one row that scrolls sideways, its edges fading while there is more (shadcn's
 * scroll-fade-x); `active`: the kind on screen now. The padding keeps the focus ring inside the scroll box, which clips
 * both ways.
 */
const ThemeGroup = observer(function ThemeGroup({ label, hint, themes, value, active }: { label: string; hint: string; themes: readonly ThemeInfo[]; value: string; active: boolean }) {
  const id = `theme-${themes[0]!.dark ? "dark" : "light"}`;
  const row = useRef<HTMLDivElement>(null);
  // The chosen card in view on opening, centered when it is past the edge; the page itself does not scroll.
  useLayoutEffect(() => {
    const r = row.current;
    const card = r?.querySelector<HTMLElement>("[data-checked]");
    if (r && card && card.offsetLeft + card.offsetWidth > r.clientWidth) r.scrollLeft = card.offsetLeft - (r.clientWidth - card.offsetWidth) / 2;
  }, []);
  return (
    <div className="flex flex-col gap-2.5 border-b border-rule-soft py-4 last:border-b-0">
      <span id={id} className="flex items-baseline gap-2">
        <span className="font-medium">{label}</span>
        <span className="text-caption text-ink-3">{active ? "On screen now." : hint}</span>
      </span>
      <RadioGroup
        aria-labelledby={id}
        value={value}
        onValueChange={(v: unknown) => saving(theme.use(v as ThemeInfo["id"], themes[0]!.dark))}
        ref={row}
        className="no-scrollbar relative -mx-1.5 -my-1.5 flex scroll-fade-x gap-3 overflow-x-auto p-1.5"
      >
        {themes.map((t) => (
          <ThemeCard key={t.id} info={t} />
        ))}
      </RadioGroup>
    </div>
  );
});

// The miniature's rows: a status, how long the title is, and whether it is urgent; the second one is selected.
const ROWS: readonly [group: string, stage: StartedStage | undefined, width: string, urgent: boolean][] = [
  ["started", "progress", "72%", false],
  ["started", "review", "58%", true],
  ["unstarted", undefined, "80%", false],
  ["completed", undefined, "46%", false],
];

function ThemeCard({ info }: { info: ThemeInfo }) {
  return (
    <RadioCard value={info.id} className="w-[176px] shrink-0">
      <Miniature info={info} />
      <span className="flex flex-col gap-0.5 border-t border-rule px-3 pt-2 pb-2.5">
        <span className="flex items-center gap-1.5">
          <span className="text-body font-semibold text-ink">{info.name}</span>
          <span className="flex-1" />
          <CheckCircleIcon weight="fill" aria-hidden className="size-4 scale-50 text-ink opacity-0 transition duration-200 ease-spring group-data-checked/card:scale-100 group-data-checked/card:opacity-100" />
        </span>
        <span className="text-caption leading-[1.45] text-ink-3">{info.note}</span>
      </span>
    </RadioCard>
  );
}

/** The app in a theme's colors: the sidebar with the workspace and its views, the top bar, four rows of a list. */
function Miniature({ info }: { info: ThemeInfo }) {
  return (
    <span aria-hidden data-theme={info.id} className={cn(info.dark ? "dark" : "light", "flex h-[92px] bg-ground text-ink")}>
      <span className="flex w-[34%] flex-col gap-[5px] border-r border-rule bg-(--ql-sidebar) px-1.5 pt-2">
        <span className="flex items-center gap-1">
          <span className="size-[7px] rounded-[2px] bg-ws-teal" />
          <span className="h-[3px] w-[60%] rounded-full bg-ink-2" />
        </span>
        <span className="h-[9px] rounded-[2px] bg-nav-current" />
        <span className="h-[3px] w-[64%] rounded-full bg-rule-strong" />
        <span className="h-[3px] w-[78%] rounded-full bg-rule-strong" />
        <span className="h-[3px] w-[52%] rounded-full bg-rule-strong" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex h-[16px] items-center gap-1 border-b border-rule bg-panel px-1.5">
          <span className="h-[3px] w-[30%] rounded-full bg-ink" />
          <span className="flex-1" />
          <span className="h-[8px] w-[22%] rounded-[2px] bg-inverse" />
        </span>
        {ROWS.map(([group, stage, width, urgent], i) => (
          <span key={i} className={cn("flex h-[19px] items-center gap-[5px] border-b border-rule-soft px-1.5", i === 1 && "bg-row-selected")}>
            <StateIcon group={group} {...(stage ? { stage } : {})} className="size-[9px]" />
            <span className="h-[3px] rounded-full bg-ink-2 opacity-75" style={{ width }} />
            <span className="flex-1" />
            {urgent && <WarningOctagonIcon weight="fill" className="size-[9px] text-signal" />}
          </span>
        ))}
      </span>
    </span>
  );
}
