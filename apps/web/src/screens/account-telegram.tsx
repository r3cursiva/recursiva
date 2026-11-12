// Settings › Notifications › Telegram (PLNR-202), after the NotifTg, NotifTgConnect, NotifTgDone and NotifTgOn
// artboards. Not connected: what it gives and Connect Telegram. Connected: the chat, a test, Disconnect, where messages
// go and how they read. The settings are the same object as the Notifications page's (useNotifySettings).
//
// Connecting is a dialog shared with the Telegram card on the Notifications page: a start link and its QR code, a
// long request the server answers when Start is pressed, then what should come to Telegram.
//
// A reply to a message in the chat posts as a comment (PLNR-203, telegram/reply.ts). Group chats and the banner of a
// chat that stopped, with what went to email meanwhile, are PLNR-204 (telegram-groups.tsx, NotifTgGroup and
// NotifTgError). The commands the bot takes in the chat are listed as the server's menu has them (TELEGRAM_COMMANDS,
// PLNR-205). Not here, as the artboards have them: buttons under messages (PLNR-203) and the language of messages (the
// app is in English, ADR 0004).
import { ArrowSquareOutIcon, BellSlashIcon, CheckCircleIcon, CheckIcon, PaperPlaneTiltIcon, PlugsIcon, TelegramLogoIcon, UserIcon, WarningIcon } from "@phosphor-icons/react";
import { NOTIFY_ROWS, TELEGRAM_COMMANDS, TELEGRAM_STARTS, delivery, untilClock, withPreset, type NotifyPrefs, type TelegramGroupView, type TelegramLink, type TelegramView } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@rsva/ui/components/dialog";
import { RadioGroup, RadioGroupItem } from "@rsva/ui/components/radio-group";
import { Segmented } from "@rsva/ui/components/segmented";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import { Spinner } from "@rsva/ui/components/spinner";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { Fragment, useState } from "react";
import { call } from "../lib/api.ts";
import { exactTime, useNow } from "../lib/time.ts";
import { account } from "../account.ts";
import { useIsPhone } from "../lib/phone.ts";
import { paths } from "../router.ts";
import { store } from "../store.ts";
import { ConfirmSignIn } from "./account-menu.tsx";
import { Toggle, useNotifySettings } from "./account-notifications.tsx";
import { notice, reported } from "./notice.ts";
import { CopyField, ReauthNote, Step, left, reauthOr, useCountdown, useLinkCode, useTelegramWait } from "./telegram-link.tsx";
import { AddGroupButton, Delivering, DestRow, GroupDialog, GroupRow, removeGroup, type GroupDialogMode } from "./telegram-groups.tsx";
import { Link } from "../link.tsx";

/** How Telegram stands, for its card and its page: "Instantly for 4 kinds of events". */
export function telegramSummary(prefs: NotifyPrefs): string {
  const n = NOTIFY_ROWS.filter((r) => delivery(prefs, r.id, "telegram") === "now").length;
  return n ? `Instantly for ${n} ${n === 1 ? "kind" : "kinds"} of events` : "Nothing yet: pick events in Notifications";
}

/** The settings, with the Connect Telegram dialog that the Notifications card and the Telegram page both open. */
export function useConnectableSettings() {
  const settings = useNotifySettings();
  const [open, setOpen] = useState(false);
  const bot = settings.view?.telegram.bot;
  const dialog = open && bot && settings.view ? <ConnectTelegram bot={bot} prefs={settings.view.prefs} save={settings.save} onLinked={settings.setTelegram} onClose={() => setOpen(false)} /> : null;
  return { settings, connect: () => setOpen(true), dialog };
}

export const AccountTelegram = observer(function AccountTelegram() {
  const { settings, connect, dialog } = useConnectableSettings();
  const [groupDialog, setGroupDialog] = useState<GroupDialogMode | null>(null);
  if (!settings.view) return settings.placeholder;
  const { view, save, setTelegram } = settings;
  const { bot, chat } = view.telegram;
  const p = view.prefs;
  const rules = paths.accountNotifications();
  // A linked chat stays on show, with Disconnect, while Telegram does not answer; without a bot nobody can connect.
  if (!bot && !chat) return <NoBot />;
  return (
    <>
      {dialog}
      {!chat ? (
        bot && <Intro bot={bot} onConnect={connect} />
      ) : (
        <>
          {chat.error && <Stopped bot={bot} chat={chat} groups={view.telegram.groups} onReconnect={bot ? connect : null} />}
          <SettingsSection id="chat" title="Chat">
            <Account chat={chat} onChange={(next) => setTelegram({ ...view.telegram, chat: next })} />
            {chat.mutedUntil && <Muted until={chat.mutedUntil} onResume={setTelegram} />}
          </SettingsSection>
          <SettingsSection id="where" title="Where messages go" description="Your personal chat follows the Telegram column in Notifications. A group gets only what you give it.">
            <div className="flex flex-col divide-y divide-rule-soft rounded-lg border bg-panel">
              <DestRow
                icon={<UserIcon />}
                name="Personal chat"
                sub={[chat.name, chat.username && `@${chat.username}`].filter(Boolean).join(" · ")}
                what={
                  <Link href={rules} className="truncate rounded-[5px] outline-none transition-colors duration-120 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:inline-flex max-md:min-h-8 max-md:items-center">
                    {telegramSummary(p)}
                  </Link>
                }
                status={<Delivering ok error={chat.error} />}
              />
              {view.telegram.groups.map((g) => (
                <GroupRow key={g.id} group={g} slug={view.workspaces.find((w) => w.id === g.workspaceId)?.slug ?? null} onOpen={setGroupDialog} onRemove={() => removeGroup(g, view.telegram, setTelegram)} />
              ))}
            </div>
            {bot && <AddGroupButton onClick={() => setGroupDialog({ kind: "add" })} />}
            {bot && groupDialog && <GroupDialog mode={groupDialog} bot={bot} view={view.telegram} onChange={setTelegram} onClose={() => setGroupDialog(null)} />}
          </SettingsSection>
          <SettingsSection id="messages" title="Messages">
            <ActionsRow on={chat.actions} onChange={(actions) => setTelegram({ ...view.telegram, chat: { ...chat, actions } })} />
            <SettingRow label="Length" hint={p.telegram.length === "full" ? "What happened, and the comment it is about." : "What happened and the issue, nothing more."}>
              <Segmented
                variant="quiet"
                label="Length"
                options={[
                  { value: "short", label: "Short" },
                  { value: "full", label: "With the comment" },
                ]}
                value={p.telegram.length}
                onChange={(length) => save({ ...p, telegram: { ...p.telegram, length } })}
              />
            </SettingRow>
            {chat.actions && (
              <SettingRow label="Replies" hint="In its thread when the message was about a comment.">
                <span className="text-[13px] text-ink-2">Reply to a message in Telegram: it posts as your comment on the issue.</span>
              </SettingRow>
            )}
            <SettingRow
              label="Quiet hours"
              hint={
                p.quiet
                  ? `Off: messages wait until ${p.quiet.to}. Urgent ones ring either way${p.urgent ? "" : " when turned on in Notifications"}.`
                  : "Quiet hours are off in Notifications: messages ring at any time."
              }
              top
            >
              <Toggle checked={p.telegram.silent} onChange={(silent) => save({ ...p, telegram: { ...p.telegram, silent } })}>
                {p.quiet ? `Deliver silently from ${p.quiet.from} to ${p.quiet.to}` : "Deliver silently in quiet hours"}
              </Toggle>
            </SettingRow>
          </SettingsSection>
          <SettingsSection id="commands" title="Commands in the chat" description={chat.actions ? undefined : "Off with notifications only: /mute and /help still answer."} compact>
            <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px] text-ink-2 max-md:grid-cols-[104px_minmax(0,1fr)] max-md:text-[13px]">
              {TELEGRAM_COMMANDS.map((c) => (
                <Fragment key={c.command}>
                  <dt>
                    <code className="font-mono text-[12px] text-ink">{`/${c.command}${c.args ? ` ${c.args}` : ""}`}</code>
                  </dt>
                  <dd className="m-0">{c.description}</dd>
                </Fragment>
              ))}
            </dl>
          </SettingsSection>
        </>
      )}
    </>
  );
});

/**
 * The personal chat stopped (NotifTgError): since when and why, what went to email instead, the groups that stopped too,
 * and Reconnect. Unblocking the bot in Telegram heals it as well (telegram/groups.ts, my_chat_member).
 */
function Stopped({ bot, chat, groups, onReconnect }: { bot: string | null; chat: NonNullable<TelegramView["chat"]>; groups: TelegramGroupView[]; onReconnect: (() => void) | null }) {
  const name = bot ? `@${bot}` : "The bot";
  const why = chat.error === "Bot blocked" ? `${name} was blocked in your personal chat.` : `Your personal chat with ${name} is gone (${chat.error?.toLowerCase()}).`;
  const n = chat.fallbacks;
  const mailed = n ? `The ${n === 1 ? "message" : `${n} messages`} since then went to email.` : "What comes to Telegram goes to email meanwhile.";
  const removed = groups.filter((g) => g.error).map((g) => `“${g.title}”`);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] max-md:flex-wrap">
      <WarningIcon className="mt-px size-4 shrink-0 text-warning" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="font-semibold">Telegram stopped delivering{chat.errorAt ? ` on ${stoppedAt(chat.errorAt)}` : ""}</b>
        <span className="text-ink-2">
          {why} {mailed}
          {removed.length > 0 && ` The bot was also removed from ${removed.join(" and ")}.`}
        </span>
      </span>
      {onReconnect && (
        <Button variant="outline" onClick={onReconnect}>
          <PlugsIcon />
          Reconnect
        </Button>
      )}
    </div>
  );
}

const stoppedFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "Nov 2 at 21:40". */
const stoppedAt = (iso: string) => {
  const p = Object.fromEntries(stoppedFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.month} ${p.day} at ${p.hour}:${p.minute}`;
};

function NoBot() {
  return (
    <SettingsSection id="telegram" title="Not set up">
      <p className="m-0 max-w-[560px] text-[13px] text-ink-2">Telegram is not set up on this server yet, or it does not answer right now. Email and the inbox work as usual.</p>
    </SettingsSection>
  );
}

const POINTS: readonly [title: string, text: string][] = [
  ["What waits on you, as it happens.", "Plans, reviews and mentions reach your phone."],
  ["Answer from the chat, if you want.", "Turn on Actions, and a reply to a notification posts as your comment on the issue."],
  ["Pick per event.", "The Telegram column in Notifications decides; email keeps its own."],
  ["Quiet at night.", "Messages come silently in your quiet hours, or wait until they end."],
];

function Intro({ bot, onConnect }: { bot: string; onConnect: () => void }) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-10 max-md:grid-cols-1 max-md:gap-6">
      <div className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Notifications in Telegram</h2>
          <p className="m-0 max-w-[480px] text-[13.5px] text-ink-2">Messages from @{bot} for what you choose.</p>
        </div>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {POINTS.map(([title, text]) => (
            <li key={title} className="flex gap-2.5 text-[13px] text-ink-2">
              <CheckIcon weight="bold" className="mt-[3px] size-3.5 shrink-0 text-ink" />
              <span>
                <b className="font-medium text-ink">{title}</b> {text}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onConnect}>
            <TelegramLogoIcon />
            Connect Telegram
          </Button>
          <span className="text-caption text-ink-3">About 20 seconds, with Telegram on your phone or this computer.</span>
        </div>
        <p className="m-0 max-w-[480px] text-caption text-ink-3">The bot writes only to the chat you link and can’t read your other chats. Disconnect any time; the chat ID is deleted.</p>
      </div>
      <Example bot={bot} />
    </section>
  );
}

/** A message as the server writes it (telegram/message.ts), so the example shows the real thing. */
function Example({ bot }: { bot: string }) {
  return (
    <div aria-label="Example message" className="flex flex-col gap-2 rounded-lg bg-ground p-4 max-md:hidden">
      <span className="flex items-center gap-2 text-[12px] text-ink-3">
        <span className="grid size-6 place-items-center rounded-full bg-avatar-slate text-ink">
          <TelegramLogoIcon className="size-3.5" />
        </span>
        <b className="font-semibold text-ink">{bot}</b>
        bot · 08:51
      </span>
      <div className="rounded-[10px_10px_10px_3px] bg-panel px-3 py-2.5 text-[13px] leading-normal shadow-[0_1px_1px_rgba(0,0,0,.06)]">
        <span className="font-mono text-[11.5px] text-ink-3">PLNR-37 · Waiting on you</span>
        <br />
        <b className="font-semibold">site-dev moved PLNR-37 into review</b>
        <br />
        <span className="text-ink-2 underline decoration-rule-strong underline-offset-2">Keyboard shortcuts for My work</span>
      </div>
    </div>
  );
}

/**
 * Actions in the chat (RSVA-496). Off, the chat gets notifications only: each with an Open button, and nothing sent there
 * changes issues, so a lost phone or a taken Telegram account reads and changes nothing. On needs a recent sign-in: the
 * sign-in screen opens, and the switch is turned on after it.
 */
function ActionsRow({ on, onChange }: { on: boolean; onChange: (actions: boolean) => void }) {
  const [confirm, setConfirm] = useState(false);
  const email = store.me?.email;
  const set = (actions: boolean) =>
    void call("PATCH", "/auth/telegram", { actions }).then(() => {
      onChange(actions);
      notice.show(actions ? "Actions turned on" : "Notifications only");
    }, reauthOr(() => setConfirm(true)));
  return (
    <SettingRow
      label="Actions"
      hint={on ? "Buttons, commands and replies change issues, comments and your inbox, as you would." : "Notifications only, each with an Open button. Turning actions on asks you to sign in again."}
      top
    >
      <Toggle checked={on} onChange={set}>
        Buttons, commands and replies
      </Toggle>
      {confirm && email && <ConfirmSignIn email={email} purpose="Turning on actions in Telegram" onClose={() => setConfirm(false)} onDone={() => set(true)} />}
    </SettingRow>
  );
}

/**
 * A /mute running in the chat (RSVA-255): until when, on the Profile's clock, and Resume, which ends it as `/mute off`
 * does. Gone on its own within a minute of running out.
 */
function Muted({ until, onResume }: { until: string; onResume: (t: TelegramView) => void }) {
  const now = useNow();
  if (Date.parse(until) <= now) return null;
  const at = untilClock(new Date(until), new Date(now), account.settings.timeZone);
  return (
    <div role="status" className="mt-2 flex items-center gap-2.5 rounded-lg bg-ground px-4 py-2.5 text-[13px] text-ink-2 max-md:flex-wrap">
      <BellSlashIcon className="size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        <b className="font-semibold text-ink">Muted until {at}.</b> Urgent issues still come; the rest waits in your inbox.
      </span>
      <Button variant="outline" size="sm" onClick={() => void reported(call<TelegramView>("DELETE", "/auth/telegram/mute").then(onResume), "Notifications are on again")}>
        Resume
      </Button>
    </div>
  );
}

/** The linked chat. A test that gets through clears a past refusal on the server, so the page clears it too. */
function Account({ chat, onChange }: { chat: NonNullable<TelegramView["chat"]>; onChange: (chat: TelegramView["chat"]) => void }) {
  const [tested, setTested] = useState(false);
  return (
    <div className="flex items-center gap-3.5 rounded-lg border bg-panel px-4 py-3.5 max-md:flex-wrap">
      <UserAvatar name={chat.name} className="size-10" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="truncate text-[14px] font-semibold">{chat.name}</b>
        <span className="truncate font-mono text-[12px] text-ink-3">{[chat.username && `@${chat.username}`, `connected ${exactTime(chat.linkedAt)}`].filter(Boolean).join(" · ")}</span>
      </span>
      <Button variant="outline" onClick={() => void reported(call("POST", "/auth/telegram/test").then(() => {
              setTested(true);
              if (chat.error) onChange({ ...chat, error: null });
            }), "Test message sent")}>
        <PaperPlaneTiltIcon />
        {tested ? "Send another test" : "Send a test"}
      </Button>
      <Button variant="outline" onClick={() => void reported(call("DELETE", "/auth/telegram").then(() => onChange(null)), "Telegram disconnected")}>
        <PlugsIcon />
        Disconnect
      </Button>
    </div>
  );
}


/**
 * Connect Telegram: a start link, then what should come there. The link is asked for on opening; the page waits on
 * /auth/telegram/wait, which the server answers when Start is pressed (or after 25 seconds, and the page asks again).
 * Sign-in codes go to the chat, so an older session confirms it's you first (PLNR-223): the sign-in screen takes this
 * dialog's place and a new link is asked for after it; Cancel there comes back here.
 */
function ConnectTelegram({ bot, prefs, save, onLinked, onClose }: { bot: string; prefs: NotifyPrefs; save: (p: NotifyPrefs) => void; onLinked: (t: TelegramView) => void; onClose: () => void }) {
  const [chat, setChat] = useState<TelegramView["chat"]>(null);
  const [start, setStart] = useState<(typeof TELEGRAM_STARTS)[number]["id"]>("waiting");
  const [round, setRound] = useState(0);
  // A link per round: the first on opening, another after "New link".
  const { link, error, reauth } = useLinkCode<TelegramLink>("/auth/telegram/link", null, true, round);
  const [declined, setDeclined] = useState(false);
  const phone = useIsPhone();
  const { now, expired } = useCountdown(link, !!chat);


  // Waits for Start while the link is good: linked by this link, not a chat from before (Reconnect).
  useTelegramWait("/auth/telegram/wait", !!link && !chat && !expired, (t) => {
    if (!link || !t.chat || Date.parse(t.chat.linkedAt) < Date.parse(link.createdAt)) return false;
    setChat(t.chat);
    onLinked(t);
    return true;
  });

  const finish = () => {
    const pick = TELEGRAM_STARTS.find((s) => s.id === start)!.pick;
    save(withPreset(prefs, "telegram", (r) => pick(r, prefs)));
    onClose();
  };

  const email = store.me?.email;
  // Signing in calls onClose and then onDone, so a confirmed sign-in ends with declined off and the next round.
  if (reauth && !declined && email)
    return <ConfirmSignIn email={email} purpose="Connecting Telegram" onClose={() => setDeclined(true)} onDone={() => (setDeclined(false), setRound((r) => r + 1))} />;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton aria-describedby={undefined} className="gap-0 p-0 text-[13px]/[1.45] sm:max-w-[600px]">
        <div className="flex items-center gap-2.5 border-b px-5 py-4">
          <TelegramLogoIcon className="size-4" />
          <DialogTitle className="text-[15px] font-semibold">{chat ? "Telegram connected" : "Connect Telegram"}</DialogTitle>
        </div>
        {!chat ? (
          <>
            <div className="flex flex-col gap-4 p-5">
              {reauth ? (
                <ReauthNote why="Sign-in codes go to this chat too, so connecting it needs a recent sign-in." onConfirm={() => setDeclined(false)} />
              ) : error ? (
                <p role="alert" className="m-0 text-ink-2">
                  {error}
                </p>
              ) : (
                <div className="grid grid-cols-[184px_minmax(0,1fr)] items-start gap-[22px] max-md:grid-cols-1">
                  <Qr link={link} expired={expired} />
                  <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
                    <Step n="1">
                      <span>{phone ? "Open the link in Telegram on this phone." : "Scan with your phone’s camera, or open the link on this computer."}</span>
                      {link && !expired && (
                        <>
                          <Button render={<a href={link.url} target="_blank" rel="noreferrer" />} nativeButton={false}>
                            <ArrowSquareOutIcon />
                            Open Telegram
                          </Button>
                          <CopyField text={link.url.replace("https://", "")} label="Copy link" what="Link" />
                        </>
                      )}
                    </Step>
                    <Step n="2">
                      <span>
                        Press <b className="font-semibold">Start</b> in the chat with @{bot}.
                      </span>
                    </Step>
                  </ol>
                </div>
              )}
              {link &&
                (expired ? (
                  <div className="flex items-center gap-2.5 rounded-[6px] bg-ground px-3 py-2.5 text-[12.5px] text-ink-2">
                    <span className="flex-1">This link has expired.</span>
                    <Button variant="outline" size="sm" onClick={() => setRound((r) => r + 1)}>
                      New link
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5 rounded-[6px] bg-ground px-3 py-2.5 text-[12.5px] text-ink-2">
                    <Spinner className="size-[15px] shrink-0 text-ink-3 motion-reduce:animate-none" />
                    <span className="flex-1">Waiting for Start in Telegram. This page updates on its own.</span>
                    <span className="font-mono text-[11px] text-ink-3">link works {left(Date.parse(link.expiresAt) - now)}</span>
                  </div>
                ))}
            </div>
            <div className="flex items-center gap-2 rounded-b-xl border-t bg-ground px-5 py-3 max-md:flex-wrap">
              <span className="flex-1 text-caption text-ink-3">
                {link && !expired && (
                  <>
                    No camera? Send <span className="font-mono text-ink">/start {link.code}</span> to @{bot}.
                  </>
                )}
              </span>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-col items-center gap-2 pt-1.5 pb-1 text-center">
                <CheckCircleIcon className="size-9 text-success" />
                <b className="text-[16px] font-semibold">Connected as {[chat.name, chat.username && `@${chat.username}`].filter(Boolean).join(" · ")}</b>
                <span className="text-caption text-ink-3">A test message is in your chat with @{bot}.</span>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-semibold">What should come to Telegram?</span>
                <RadioGroup aria-label="What should come to Telegram?" value={start} onValueChange={(v) => setStart(v as typeof start)} className="gap-0 overflow-hidden rounded-lg border">
                  {TELEGRAM_STARTS.map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-start gap-2.5 border-t border-rule-soft bg-panel px-3 py-2.5 first:border-t-0 hover:bg-row-hover has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-inset">
                      <RadioGroupItem value={s.id} className="mt-px" />
                      <span className="flex flex-col gap-px">
                        {s.label}
                        <span className="text-[12px] text-ink-3">{s.hint}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <span className="text-caption text-ink-3">You can change each event later in Notifications.</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 rounded-b-xl border-t bg-ground px-5 py-3">
              <Button variant="outline" onClick={() => void reported(call("POST", "/auth/telegram/test"), "Test message sent")}>
                Send another test
              </Button>
              <Button onClick={finish}>Done</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The link's QR code on a white plate (cameras want dark on light in either theme), the Telegram mark over its middle. */
function Qr({ link, expired }: { link: TelegramLink | null; expired: boolean }) {
  return (
    <div role="img" aria-label="QR code for the bot link" className={cn("relative grid size-[184px] place-items-center rounded-[10px] border bg-white p-2.5 text-black max-md:hidden", expired && "opacity-25")}>
      {link ? (
        <>
          <svg viewBox={`0 0 ${link.qr.size} ${link.qr.size}`} className="size-full" shapeRendering="crispEdges" aria-hidden>
            <path d={link.qr.path} fill="currentColor" />
          </svg>
          <span className="absolute grid size-[34px] place-items-center rounded-lg bg-white">
            <TelegramLogoIcon weight="fill" className="size-6" />
          </span>
        </>
      ) : (
        <Spinner className="size-5 text-black/40 motion-reduce:animate-none" />
      )}
    </div>
  );
}
