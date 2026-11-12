// Settings › Notifications (PLNR-199), after the NotifRules artboard: the channels, "What reaches you where" (an event
// by channel, a click cycles a cell), presets, timing and the mode per workspace. The inbox gets everything; these
// rules decide email and Telegram. Changes save at once (PUT /auth/notifications) and show in the header's status.
//
// An email cell cycles Instantly, Digest (the morning digest, PLNR-201), Off; how email comes is the Email page's
// (account-email.tsx, PLNR-208). A Telegram cell is Instantly or Off, and only once a chat is linked (account-telegram.tsx,
// PLNR-202). Not here yet, as the artboard has them: the rows without a source (PLNR-206).
import { CaretRightIcon, CheckIcon, EnvelopeSimpleIcon, TelegramLogoIcon, TrayIcon } from "@phosphor-icons/react";
import {
  NOTIFY_GROUPS,
  NOTIFY_PRESETS,
  NOTIFY_ROWS,
  delivery,
  telegramDelivering,
  withCell,
  withPreset,
  type Channel as ChannelId,
  type Delivery,
  type NotifyPrefs,
  type NotifyRow,
  type NotifySettingsView,
  type TelegramView,
  type WorkspaceMode,
} from "@rsva/protocol";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { Segmented } from "@rsva/ui/components/segmented";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import { Switch } from "@rsva/ui/components/switch";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { account } from "../account.ts";
import { call } from "../lib/api.ts";
import { paths } from "../router.ts";
import { store } from "../store.ts";
import { saving } from "./save-status.tsx";
import { ChoiceRow, ListNote } from "./settings-fields.tsx";
import { telegramSummary, useConnectableSettings } from "./account-telegram.tsx";
import { workspaceTileTone } from "./workspace-switcher.tsx";
import { Link } from "../link.tsx";

const LABEL: Record<Delivery, string> = { now: "Instantly", digest: "Digest", off: "Off" };
const NEXT: Record<ChannelId, Record<Delivery, Delivery>> = {
  email: { now: "digest", digest: "off", off: "now" },
  // Telegram has no digest.
  telegram: { now: "off", digest: "off", off: "now" },
};
const MODES: readonly { value: WorkspaceMode; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "me", label: "Only about me" },
  { value: "off", label: "Nothing" },
];

/**
 * The settings of Notifications and its Email page: read on opening, shown at once on a change and saved whole; a
 * refusal reads them again (the toast says why). Until they are read, `placeholder` says why there is nothing.
 */
export function useNotifySettings():
  | { view: NotifySettingsView; save: (next: NotifyPrefs) => void; setTelegram: (t: TelegramView) => void; placeholder: null }
  | { view: null; placeholder: ReactNode } {
  const [view, setView] = useState<NotifySettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    call<NotifySettingsView>("GET", "/auth/notifications").then(
      (v) => (setView(v), setFailed(false)),
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);
  if (!view) return { view: null, placeholder: failed ? <ListNote>Could not load this page. Check the connection and open it again.</ListNote> : <p className="m-0 text-label text-ink-3">Loading…</p> };
  const save = (next: NotifyPrefs) => {
    setView({ ...view, prefs: next });
    saving(call("PUT", "/auth/notifications", next).catch((e: unknown) => (load(), Promise.reject(e))));
  };
  // Telegram changes through its own requests (link, disconnect): the page shows what they answered.
  const setTelegram = (telegram: TelegramView) => setView((v) => v && { ...v, telegram });
  return { view, save, setTelegram, placeholder: null };
}

/** How email stands, for the Email card and the Email page: "Instantly for 4 kinds of events, the rest in the 08:00 digest". */
export function emailSummary(prefs: NotifyPrefs): string {
  const count = (d: Delivery) => NOTIFY_ROWS.filter((r) => delivery(prefs, r.id, "email") === d).length;
  const now = count("now");
  const digest = prefs.digest.on ? count("digest") : 0;
  const kinds = (n: number) => `${n} ${n === 1 ? "kind" : "kinds"} of events`;
  if (!now && !digest) return "Nothing by email but sign-in and security mail";
  if (!digest) return `Instantly for ${kinds(now)}`;
  return `${now ? `Instantly for ${kinds(now)}, ` : ""}${now ? "the rest" : kinds(digest)} in the ${prefs.digest.time} digest`;
}

export const AccountNotifications = observer(function AccountNotifications() {
  const { settings, connect, dialog } = useConnectableSettings();
  if (!settings.view) return settings.placeholder;
  const { view, save } = settings;
  const prefs = view.prefs;
  const tg = view.telegram;
  return (
    <>
      <SettingsSection id="channels" title="Channels" description="Inbox gets everything. Email and Telegram get what you pick below.">
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          <Channel icon={<TrayIcon />} name="Inbox" state={<Dot on />} status="Always on">
            Unread count in the panel and the browser tab. Read on one device, read everywhere.
          </Channel>
          <Channel
            icon={<EnvelopeSimpleIcon />}
            name="Email"
            state={<Dot on={NOTIFY_ROWS.some((r) => delivery(prefs, r.id, "email") !== "off")} />}
            status={store.me?.email ?? ""}
            link={{ href: paths.accountEmail(), label: "Email settings" }}
          >
            {emailSummary(prefs)}.
          </Channel>
          <TelegramCard telegram={tg} prefs={prefs} onConnect={connect} />
        </div>
        {dialog}
      </SettingsSection>

      <SettingsSection
        id="rules"
        title="What reaches you where"
        description={`Click a cell: Instantly, Digest, Off; Telegram is Instantly or Off. Digest is the ${prefs.digest.time} email${prefs.digest.on ? "" : ", turned off on the Email page"}.`}
      >
        <Matrix prefs={prefs} telegram={telegramDelivering(tg)} onChange={save} />
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <span className="mr-0.5 text-caption text-ink-3">Email, start from</span>
          {NOTIFY_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="inline-flex h-7 items-center rounded-[6px] border border-control-border bg-panel px-[11px] text-[12.5px] text-ink outline-none hover:border-rule-strong focus-visible:ring-2 focus-visible:ring-ring max-md:h-9"
              onClick={() => save(withPreset(prefs, "email", p.pick))}
            >
              {p.label}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection id="timing" title="Timing">
        <SettingRow
          label="Quiet hours"
          hint={account.settings.timeZone ? `In your time zone, ${account.settings.timeZone.replaceAll("_", " ")}. Mail waits until they end.` : "They need your time zone: set it in Preferences. Until then they do not apply."}
          top
        >
          <div className="flex flex-col items-start gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Switch aria-label="Quiet hours" checked={!!prefs.quiet} onCheckedChange={(on) => save({ ...prefs, quiet: on ? { from: "22:00", to: "08:00" } : null })} />
              {prefs.quiet && (
                <>
                  <TimeField label="Quiet from" value={prefs.quiet.from} onChange={(from) => save({ ...prefs, quiet: { ...prefs.quiet!, from } })} />
                  <span className="text-caption text-ink-3">to</span>
                  <TimeField label="Quiet until" value={prefs.quiet.to} onChange={(to) => save({ ...prefs, quiet: { ...prefs.quiet!, to } })} />
                </>
              )}
            </div>
            {prefs.quiet && (
              <Toggle size="sm" checked={prefs.urgent} onChange={(urgent) => save({ ...prefs, urgent })}>
                Urgent issues still get through
              </Toggle>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Already seen" hint="We wait 10 minutes after an event. If you open it in that time, nothing is sent.">
          <Toggle checked={prefs.seen} onChange={(seen) => save({ ...prefs, seen })}>
            Don’t email what I’ve already seen in the app
          </Toggle>
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="workspaces" title="Per workspace" description="The rules above apply where you pick Everything.">
        <div>
          {view.workspaces.map((w) => (
            <ChoiceRow
              key={w.id}
              name={w.name}
              hint={w.role}
              hintClass="capitalize"
              lead={<LetterTile name={w.name} tone={workspaceTileTone(w, false)} className="size-5 rounded-[5px] text-[10px]" />}
            >
              <Segmented
                variant="quiet"
                label={`Notifications from ${w.name}`}
                options={MODES}
                value={prefs.workspaces[w.id] ?? "all"}
                onChange={(mode) => {
                  const workspaces = { ...prefs.workspaces, [w.id]: mode };
                  if (mode === "all") delete workspaces[w.id];
                  save({ ...prefs, workspaces });
                }}
              />
            </ChoiceRow>
          ))}
        </div>
      </SettingsSection>
    </>
  );
});

const Dot = ({ on, warn }: { on: boolean; warn?: boolean }) => <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", warn ? "bg-warning" : on ? "bg-success" : "border border-rule-strong")} />;

function TelegramCard({ telegram, prefs, onConnect }: { telegram: TelegramView; prefs: NotifyPrefs; onConnect: () => void }) {
  const { bot, chat } = telegram;
  const icon = <TelegramLogoIcon />;
  if (!bot) return <Channel icon={icon} name="Telegram" state={<Dot on={false} />} status="Not set up">Telegram is not set up on this server yet.</Channel>;
  if (!chat)
    return (
      <Channel
        icon={icon}
        name="Telegram"
        state={<Dot on={false} />}
        status="Not connected"
        action={
          <Button variant="outline" size="sm" onClick={onConnect}>
            <TelegramLogoIcon />
            Connect Telegram
          </Button>
        }
      >
        What waits on you, in a chat with @{bot}.
      </Channel>
    );
  return (
    <Channel icon={icon} name="Telegram" state={<Dot on warn={!!chat.error} />} status={chat.username ? `@${chat.username}` : chat.name} link={{ href: paths.accountTelegram(), label: "Telegram settings" }}>
      {chat.error ? "Stopped delivering, by email meanwhile: connect it again on its page." : `${telegramSummary(prefs)}${groupsLine(telegram.groups.filter((g) => !g.error && g.events.length && g.projectIds.length).length)}.`}
    </Channel>
  );
}

/** ", and 2 group chats": the groups that deliver, beside the personal chat. */
const groupsLine = (n: number) => (n ? `, and ${n === 1 ? "a group chat" : `${n} group chats`}` : "");

function Channel({ icon, name, state, status, link, action, children }: { icon: ReactNode; name: string; state: ReactNode; status: string; link?: { href: string; label: string }; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-(--float-radius) border bg-panel px-4 py-3.5">
      <span className="flex items-center gap-[9px] text-[13.5px] font-semibold [&_svg]:size-4 [&_svg]:text-ink-2">
        {icon}
        {name}
      </span>
      <span className="flex min-w-0 items-center gap-[7px] text-[12.5px] text-ink-2">
        {state}
        <span className="truncate">{status}</span>
      </span>
      <span className="text-caption text-ink-3">{children}</span>
      {link && (
        <Link href={link.href} className={cn(buttonVariants({ variant: "outline", size: "sm", className: "mt-auto self-start font-normal text-ink-2" }))}>
          {link.label}
          <CaretRightIcon data-icon="inline-end" />
        </Link>
      )}
      {action && <span className="mt-auto">{action}</span>}
    </div>
  );
}

const row = "grid grid-cols-[minmax(0,1fr)_90px_120px_120px] items-center gap-x-2 px-3.5 max-md:grid-cols-[minmax(0,1fr)_92px_92px] max-md:px-3";

function Matrix({ prefs, telegram, onChange }: { prefs: NotifyPrefs; telegram: boolean; onChange: (p: NotifyPrefs) => void }) {
  return (
    <div role="table" aria-label="What reaches you where" className="overflow-hidden rounded-(--float-radius) border bg-panel">
      <div role="row" className={cn(row, "min-h-9 bg-ground text-[12px] text-ink-2")}>
        <span role="columnheader">Event</span>
        <span role="columnheader" className="inline-flex items-center gap-1.5 max-md:hidden">
          <TrayIcon className="size-3.5" />
          Inbox
        </span>
        <span role="columnheader" className="inline-flex items-center gap-1.5">
          <EnvelopeSimpleIcon className="size-3.5" />
          Email
        </span>
        <span role="columnheader" className="inline-flex items-center gap-1.5">
          <TelegramLogoIcon className="size-3.5" />
          <span className="max-md:sr-only">Telegram</span>
        </span>
      </div>
      {NOTIFY_GROUPS.map((g) => (
        <div key={g.name} role="rowgroup">
          <div role="row" className={cn(row, "min-h-[30px] border-t bg-ground")}>
            <span role="rowheader" className="eyebrow">
              {g.name}
            </span>
          </div>
          {g.rows.map((r) => (
            <MatrixRow key={r.id} r={r} prefs={prefs} telegram={telegram} onChange={onChange} />
          ))}
        </div>
      ))}
    </div>
  );
}

function MatrixRow({ r, prefs, telegram, onChange }: { r: NotifyRow; prefs: NotifyPrefs; telegram: boolean; onChange: (p: NotifyPrefs) => void }) {
  const cell = (channel: ChannelId, by: string) => <Cell r={r} channel={channel} by={by} prefs={prefs} onChange={onChange} />;
  return (
    <div role="row" className={cn(row, "min-h-11 border-t border-rule-soft")}>
      <span role="rowheader" className="flex min-w-0 flex-col gap-px py-1.5">
        <b className="truncate text-[13px] font-medium">{r.label}</b>
        {r.hint && <span className="truncate text-[11.5px] text-ink-3">{r.hint}</span>}
      </span>
      {r.inbox === false ? (
        <span role="cell" className="text-faint max-md:hidden" title="Not in the inbox">
          —
        </span>
      ) : (
        <span role="cell" className="text-ink-3 max-md:hidden">
          <CheckIcon className="size-3.5" aria-label="Always" />
        </span>
      )}
      <span role="cell">{cell("email", "by email")}</span>
      {telegram ? (
        <span role="cell">{cell("telegram", "in Telegram")}</span>
      ) : (
        <span role="cell" className="text-faint" title="Telegram is not connected">
          —
        </span>
      )}
    </div>
  );
}

function Cell({ r, channel, by, prefs, onChange }: { r: NotifyRow; channel: ChannelId; by: string; prefs: NotifyPrefs; onChange: (p: NotifyPrefs) => void }) {
  // Telegram has no digest: a cell saved as Digest there reads, and is sent, as Off.
  const value = channel === "telegram" && delivery(prefs, r.id, channel) === "digest" ? "off" : delivery(prefs, r.id, channel);
  return (
    <button
      type="button"
      aria-label={`${r.label} ${by}: ${LABEL[value]}. Change`}
      onClick={() => onChange(withCell(prefs, r.id, channel, NEXT[channel][value]))}
      className={cn(
        "inline-flex h-[26px] min-w-[84px] items-center justify-center rounded-[13px] border px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-8 max-md:min-w-[88px]",
        value === "now"
          ? "border-inverse bg-inverse text-inverse-ink"
          : value === "digest"
            ? "border-control-border bg-panel text-ink hover:border-rule-strong"
            : "border-dashed border-control-border bg-panel text-ink-3 hover:border-rule-strong hover:text-ink",
      )}
    >
      {LABEL[value]}
    </button>
  );
}

export function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="time"
      step={900}
      aria-label={label}
      value={value}
      onChange={(e) => e.target.value && onChange(e.target.value.slice(0, 5))}
      className="h-[30px] rounded-[6px] border border-control-border bg-input px-2.5 font-mono text-[12.5px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-9 max-md:text-[16px]"
    />
  );
}


/** A switch with its words beside it, the words its label. */
export function Toggle({ checked, onChange, size, children }: { checked: boolean; onChange: (v: boolean) => void; size?: "sm"; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2.5 text-label text-ink-2">
      <Switch {...(size ? { size } : {})} checked={checked} onCheckedChange={onChange} />
      {children}
    </label>
  );
}
