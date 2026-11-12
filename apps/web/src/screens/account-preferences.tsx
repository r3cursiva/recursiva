// Settings › Preferences: how recursiva behaves for the person, the same in every workspace: the time zone notifications and
// digests keep to, the first day of the week the calendars start on, where the app and a project open (RSVA-527), and
// after how many still days the sidebar folds a project into Quiet (RSVA-566).
// Split out of Profile, which is who the person is to others; how recursiva looks is on Appearance (theme-picker.tsx).
import type { ProjectPage, QuietDays, StartPage, WeekStart } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { SearchSelect } from "@rsva/ui/components/search-select";
import { Segmented } from "@rsva/ui/components/segmented";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import { observer } from "mobx-react-lite";
import { useEffect, useMemo } from "react";
import { account, deviceTimeZone } from "../account.ts";
import { setUi, uiChoice } from "../panes.ts";
import { saving } from "./save-status.tsx";

const WEEK_START: readonly { value: `${WeekStart}`; label: string }[] = [
  { value: "1", label: "Monday" },
  { value: "0", label: "Sunday" },
  { value: "6", label: "Saturday" },
];

const START: readonly { value: StartPage; label: string }[] = [
  { value: "project", label: "First project" },
  { value: "myWork", label: "My work" },
  { value: "inbox", label: "Inbox" },
];
const START_HINT: Record<StartPage, string> = {
  project: "The issues of the first project in the sidebar.",
  myWork: "Your work across every workspace.",
  inbox: "Your notifications.",
};

const QUIET: readonly { value: `${QuietDays}`; label: string }[] = [
  { value: "0", label: "Never" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
];

const PROJECT: readonly { value: ProjectPage; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "issues", label: "Issues" },
];
const PROJECT_HINT: Record<ProjectPage, string> = {
  home: "A project opens on its widgets; Issues is one tab away.",
  issues: "A project opens on its list; Home stays a tab away.",
};

export const AccountPreferences = observer(function AccountPreferences() {
  // Another device may have changed them since this one saved its copy.
  useEffect(() => void account.refresh(), []);
  const { start, project, quiet } = uiChoice();
  return (
    <>
      <SettingsSection id="time" title="Time">
        <SettingRow label="Time zone" hint="Notifications and digests will keep to it." top>
          <TimeZone />
        </SettingRow>
        <SettingRow label="First day of the week" hint="Calendars start on it.">
          <Segmented
            label="First day of the week"
            options={WEEK_START}
            value={`${account.settings.weekStart}`}
            onChange={(v) => saving(account.update({ weekStart: Number(v) as WeekStart }))}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection id="navigation" title="Navigation">
        <SettingRow label="Start on" hint={START_HINT[start]}>
          <Segmented label="Start on" options={START} value={start} onChange={(v) => saving(setUi({ start: v }))} />
        </SettingRow>
        <SettingRow label="Open projects on" hint={PROJECT_HINT[project]}>
          <Segmented label="Open projects on" options={PROJECT} value={project} onChange={(v) => saving(setUi({ project: v }))} />
        </SettingRow>
        <SettingRow
          label="Quiet projects"
          hint={quiet ? `Projects with no changes for ${quiet} days and nothing for you fold into one Quiet line in the sidebar.` : "Only projects you mark as quiet fold into the sidebar's Quiet line."}
        >
          <Segmented label="Quiet projects" options={QUIET} value={`${quiet}`} onChange={(v) => saving(setUi({ quiet: Number(v) as QuietDays }))} />
        </SettingRow>
      </SettingsSection>
    </>
  );
});

/** "Europe/Sofia" → "Europe/Sofia · GMT+2", as the zone is now. */
function zoneLabel(tz: string, now: Date): string {
  const offset = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;
  return `${tz.replaceAll("_", " ")}${offset ? ` · ${offset}` : ""}`;
}

const TimeZone = observer(function TimeZone() {
  const value = account.settings.timeZone;
  const device = deviceTimeZone();
  const options = useMemo(() => {
    const now = new Date();
    const zones = new Set(Intl.supportedValuesOf("timeZone"));
    // A zone the list leaves out (an alias such as UTC) is still offered when it is the person's or this browser's.
    for (const z of [value, device]) if (z) zones.add(z);
    return [...zones].sort().map((z) => ({ value: z, label: zoneLabel(z, now) }));
  }, [value, device]);
  return (
    <div className="flex flex-col items-start gap-2">
      <SearchSelect
        placeholder="Time zone…"
        className="w-80"
        options={options}
        value={value}
        onChange={(timeZone) => saving(account.update({ timeZone }))}
        trigger={
          <Button type="button" variant="outline" className="max-w-[420px] justify-start">
            <span className="truncate">{value ? zoneLabel(value, new Date()) : "Not set"}</span>
          </Button>
        }
      />
      {value !== device && (
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-caption text-ink-3">
          This browser is in {device.replaceAll("_", " ")}.
          <Button type="button" variant="link" size="xs" className="-mx-2" onClick={() => saving(account.update({ timeZone: device }))}>
            Use it
          </Button>
        </p>
      )}
    </div>
  );
});
