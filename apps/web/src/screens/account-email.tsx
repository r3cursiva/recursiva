// Settings › Notifications › Email (PLNR-208), after the NotifEmail artboard: how notification email comes, where the
// Notifications page says what comes. The address; instant emails one each or bundled every 30 minutes; already seen;
// the morning digest (time, days, skipping empty days, an example) and the weekly summary (PLNR-201); replying by email,
// when the server takes replies (PLNR-211); the format; and a way to stop all of it. The settings are the same object as
// the Notifications page's (useNotifySettings).
//
// Not here, as the artboard has it: the first-line commands of a reply (approve, send back, snooze) and changing the
// address (PLNR-197).
import { ArrowSquareOutIcon, CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { REPLY_DAYS, unsubscribed, type NotifyPrefs } from "@rsva/protocol";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { Segmented } from "@rsva/ui/components/segmented";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { account } from "../account.ts";
import { paths } from "../router.ts";
import { store } from "../store.ts";
import { emailSummary, TimeField, Toggle, useNotifySettings } from "./account-notifications.tsx";
import { ConfirmBar } from "./settings-fields.tsx";
import { Link } from "../link.tsx";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const AccountEmail = observer(function AccountEmail() {
  const settings = useNotifySettings();
  const [stopping, setStopping] = useState(false);
  if (!settings.view) return settings.placeholder;
  const { view, save } = settings;
  const p = view.prefs;
  const set = <K extends keyof NotifyPrefs>(key: K, value: Partial<NotifyPrefs[K]>) => save({ ...p, [key]: typeof value === "object" && value !== null ? { ...(p[key] as object), ...value } : value });
  const rules = paths.accountNotifications();
  // The days from the person's first day of the week (Profile), as the calendars show them.
  const start = account.settings.weekStart;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + start) % 7);
  return (
    <>
      <SettingsSection id="address" title="Address">
        <SettingRow label="Sends to" hint="Sign-in codes and security emails always go here, whatever you set below.">
          <span className="flex flex-wrap items-center gap-2.5 text-[13.5px]">
            <span className="font-mono text-[12.5px]">{store.me?.email}</span>
            <span className="inline-flex items-center gap-1 text-[12px] text-success">
              <CheckIcon weight="bold" className="size-3" />
              Verified
            </span>
          </span>
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="instant" title="Instant emails" description={`${emailSummary(p)}.`}>
        <SettingRow label="Which events" hint="Set per event on the Notifications page.">
          <Link href={rules} className={cn(buttonVariants({ variant: "outline", size: "sm", className: "font-normal text-ink-2" }))}>
            Change which
            <CaretRightIcon data-icon="inline-end" />
          </Link>
        </SettingRow>
        <SettingRow label="Sending" hint={p.email.bundle ? "Everything from 30 minutes in one email. Urgent ones go at once." : "Each event is its own email, threaded per issue."} top>
          <Segmented
            variant="quiet"
            label="Sending"
            options={[
              { value: "each", label: "One email each" },
              { value: "bundle", label: "Bundle every 30 minutes" },
            ]}
            value={p.email.bundle ? "bundle" : "each"}
            onChange={(v) => set("email", { bundle: v === "bundle" })}
          />
        </SettingRow>
        <SettingRow label="Already seen">
          <Toggle checked={p.seen} onChange={(seen) => save({ ...p, seen })}>
            Skip it if I’ve seen it in the app within 10 minutes
          </Toggle>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        id="digest"
        title="Morning digest"
        aside={
          <a href="/auth/notifications/digest-example" target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm", className: "ml-auto self-center font-normal text-ink-2" }))}>
            See an example
            <ArrowSquareOutIcon data-icon="inline-end" />
          </a>
        }
      >
        <SettingRow label="Send" hint="Waiting on you, due today, what agents finished overnight, and the events you put in the digest.">
          <Toggle checked={p.digest.on} onChange={(on) => set("digest", { on })}>
            {p.digest.on ? "On" : "Off: Digest cells send nothing"}
          </Toggle>
        </SettingRow>
        {p.digest.on && (
          <>
            <SettingRow label="When" hint={account.settings.timeZone ? `In your time zone, ${account.settings.timeZone.replaceAll("_", " ")}.` : "It needs your time zone: set it in Preferences."} top>
              <div className="flex flex-col items-start gap-2.5">
                <TimeField label="Digest time" value={p.digest.time} onChange={(time) => set("digest", { time })} />
                <div role="group" aria-label="Days" className="flex flex-wrap gap-1.5">
                  {days.map((d) => {
                    const on = p.digest.days.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() => set("digest", { days: on ? p.digest.days.filter((x) => x !== d) : [...p.digest.days, d].sort() })}
                        className={cn(
                          "h-7 w-[38px] rounded-[6px] border text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-9 max-md:w-11",
                          on ? "border-inverse bg-inverse text-inverse-ink" : "border-control-border bg-panel text-ink-3 hover:border-rule-strong",
                        )}
                      >
                        {DAY[d]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </SettingRow>
            <SettingRow label="Empty days">
              <Toggle checked={p.digest.skipEmpty} onChange={(skipEmpty) => set("digest", { skipEmpty })}>
                Skip the day when there is nothing
              </Toggle>
            </SettingRow>
          </>
        )}
        <SettingRow label="Weekly summary" hint="Mondays at 09:00. Cycles that ended, done per project, how much agents did.">
          <Toggle checked={p.weekly} onChange={(weekly) => save({ ...p, weekly })}>
            {p.weekly ? "On" : "Off"}
          </Toggle>
        </SettingRow>
      </SettingsSection>

      {view.replyDomain && (
        <SettingsSection id="replying" title="Replying">
          <SettingRow label="Reply by email" hint={`Each email has its own reply address, like infra-112.…@${view.replyDomain}. A reply posts from ${store.me?.email ?? "your address"} only, for ${REPLY_DAYS} days after the email.`}>
            <Toggle checked={p.email.reply} onChange={(reply) => set("email", { reply })}>
              A reply posts as your comment
            </Toggle>
          </SettingRow>
        </SettingsSection>
      )}

      <SettingsSection id="format" title="Format">
        <SettingRow label="Emails as">
          <Segmented
            variant="quiet"
            label="Format"
            options={[
              { value: "html", label: "HTML and text" },
              { value: "text", label: "Text only" },
            ]}
            value={p.email.textOnly ? "text" : "html"}
            onChange={(v) => set("email", { textOnly: v === "text" })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="stop" title="Stop">
        <SettingRow label="Everything" hint="Turns every email rule, the digest and the summary off. Sign-in codes and security emails still arrive." top>
          {stopping ? (
            <ConfirmBar
              action="Unsubscribe"
              onCancel={() => setStopping(false)}
              onConfirm={() => {
                setStopping(false);
                save(unsubscribed(p));
              }}
            >
              <span className="font-semibold text-ink">Stop every notification email?</span> You can turn them back on here.
            </ConfirmBar>
          ) : (
            <Button variant="outline" onClick={() => setStopping(true)}>
              Unsubscribe from everything
            </Button>
          )}
        </SettingRow>
      </SettingsSection>
    </>
  );
});
