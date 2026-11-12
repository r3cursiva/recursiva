// Group chats on Settings › Notifications › Telegram (PLNR-204), after the NotifTgGroup artboard: a row per group in
// "Where messages go", and the dialog that links one and picks its projects and events.
//
// Linking: the page asks for a code; "Open Telegram" is the bot's startgroup link, where Telegram asks which group to
// add the bot to and sends the code there itself; in a group the bot is already in, `/link@<bot> <code>` does it. The
// page waits on a long request the server answers when the code arrives, then shows which group it was. Nothing goes
// there until Save: a code read off this screen links someone else's group to nothing.
//
// A group keeps getting messages after the session that linked it ends, so the code and a Save that gives the group more
// need a recent sign-in (PLNR-246): an older session confirms it's you first, as for the personal chat (PLNR-223). The
// sign-in screen takes the dialog's place, then a new code is asked for or Save runs again; Cancel there comes back here.
import { ArrowSquareOutIcon, CheckIcon, DotsThreeIcon, PlusIcon, UsersThreeIcon, WarningIcon } from "@phosphor-icons/react";
import { GROUP_EVENTS, type GroupEvent, type TelegramGroupLink, type TelegramGroupView, type TelegramView } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { Checkbox } from "@rsva/ui/components/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@rsva/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { Spinner } from "@rsva/ui/components/spinner";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState, type ReactNode } from "react";
import { call } from "../lib/api.ts";
import { paths, router } from "../router.ts";
import { store } from "../store.ts";
import { ConfirmSignIn } from "./account-menu.tsx";
import { notice, reported } from "./notice.ts";
import { ProjectChip } from "./project-chip.tsx";
import { CopyField, left, reauthOr, ReauthNote, Step, useCountdown, useLinkCode, useTelegramWait } from "./telegram-link.tsx";
import { plural } from "@rsva/schema/util";

/** One place messages go: the personal chat or a group, its projects and events, whether it delivers, its menu. */
export function DestRow({ icon, name, sub, what, status, menu }: { icon: ReactNode; name: string; sub: string; what: ReactNode; status: ReactNode; menu?: ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-3 px-3.5 py-2.5 text-[13px] max-md:grid-cols-[28px_minmax(0,1fr)_auto]">
      <span className="grid size-7 place-items-center rounded-lg bg-ground text-ink-2 [&_svg]:size-[15px]">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <b className="truncate font-medium">{name}</b>
        <span className="truncate text-[11.5px] text-ink-3">{sub}</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-ink-2 max-md:col-start-2 max-md:row-start-2">{what}</span>
      <span className="flex items-center gap-1.5 justify-self-end max-md:col-start-3 max-md:row-start-1">
        {status}
        {menu}
      </span>
    </div>
  );
}

export const Delivering = ({ ok, error }: { ok: boolean; error?: string | null }) =>
  error ? (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-warning">
      <WarningIcon className="size-3" />
      {error}
    </span>
  ) : ok ? (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-success">
      <CheckIcon weight="bold" className="size-3" />
      Delivering
    </span>
  ) : (
    <span className="text-[12px] text-ink-3">Nothing picked</span>
  );

const eventsText = (events: readonly GroupEvent[]) => GROUP_EVENTS.filter((e) => events.includes(e.id)).map((e) => e.label.toLowerCase()).join(", ");

/** What the dialog opens for: a new group, a group to change, or one whose bot was removed, to link again. */
export type GroupDialogMode = { kind: "add" } | { kind: "edit" | "relink"; group: TelegramGroupView };

export const GroupRow = observer(function GroupRow({ group, slug, onOpen, onRemove }: { group: TelegramGroupView; slug: string | null; onOpen: (m: GroupDialogMode) => void; onRemove: () => void }) {
  const here = group.workspaceId === store.workspace?.id;
  const keys = here ? group.projectIds.flatMap((id) => store.projects.get(id)?.key ?? []) : [];
  const set = group.projectIds.length > 0 && group.events.length > 0;
  const sub = ["Group", group.members && `${group.members} members`, !here && slug, !group.linkedByMe && `linked by ${group.linkedBy}`].filter(Boolean).join(" · ");
  const other = slug && paths.accountIn(slug, paths.accountTelegram());
  return (
    <DestRow
      icon={<UsersThreeIcon />}
      name={group.title}
      sub={sub}
      what={
        set ? (
          <>
            {here ? keys.map((k) => <ProjectChip key={k} projectKey={k} />) : `${plural(group.projectIds.length, "project")},`}
            <span className="min-w-0">{eventsText(group.events)}</span>
          </>
        ) : (
          <span className="text-ink-3">Pick its projects and events</span>
        )
      }
      status={<Delivering ok={set} error={group.error} />}
      menu={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" aria-label={`${group.title} options`} className="size-7 max-md:size-11" />}
          >
            <DotsThreeIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="md:w-[200px]">
            {here ? (
              <>
                {group.error && <DropdownMenuItem onClick={() => onOpen({ kind: "relink", group })}>Link again</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => onOpen({ kind: "edit", group })}>Projects and events</DropdownMenuItem>
              </>
            ) : (
              other && <DropdownMenuItem onClick={() => router.push(other)}>Open in {slug}</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              Remove group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
});

export const removeGroup = (group: TelegramGroupView, view: TelegramView, onChange: (t: TelegramView) => void) =>
  void reported(
    call("DELETE", `/auth/telegram/groups/${group.id}`).then(() => onChange({ ...view, groups: view.groups.filter((g) => g.id !== group.id) })),
    `${group.title} removed: the bot left the group`,
  );

export const AddGroupButton = ({ onClick }: { onClick: () => void }) => (
  <div className="mt-3">
    <Button variant="outline" onClick={onClick}>
      <PlusIcon />
      Add a group chat
    </Button>
  </div>
);

/** Add a group chat, change what one gets, or link one again after the bot was removed. */
export const GroupDialog = observer(function GroupDialog({ mode, bot, view, onChange, onClose }: { mode: GroupDialogMode; bot: string; view: TelegramView; onChange: (t: TelegramView) => void; onClose: () => void }) {
  const linking = mode.kind !== "edit";
  const [found, setFound] = useState<TelegramGroupView | null>(mode.kind === "edit" ? mode.group : null);
  const [projects, setProjects] = useState<string[]>(mode.kind === "add" ? [] : mode.group.projectIds);
  const [events, setEvents] = useState<GroupEvent[]>(mode.kind === "add" ? ["urgent"] : mode.group.events);
  const [round, setRound] = useState(0);
  const workspaceId = store.workspace?.id;
  const { link, error, reauth } = useLinkCode<TelegramGroupLink>("/auth/telegram/groups/link", { workspaceId }, linking && !!workspaceId, round);
  // Cancel on the sign-in screen for the code; Save refused for an older sign-in, to run again once confirmed.
  const [declined, setDeclined] = useState(false);
  const [saveAfter, setSaveAfter] = useState(false);
  const linked = !!found && (!linking || !found.error);
  const { now, expired } = useCountdown(link, linked);

  // Linked by this code: a group this person linked after it was made.
  useTelegramWait("/auth/telegram/groups/wait", linking && !!link && !linked && !expired, (t) => {
    const g = link && t.groups.find((x) => x.linkedByMe && Date.parse(x.linkedAt) >= Date.parse(link.createdAt));
    if (!g) return false;
    setFound(g);
    onChange(t);
    return true;
  });

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = () => {
    const group = found!;
    void call("PATCH", `/auth/telegram/groups/${group.id}`, { projectIds: projects, events }).then(
      () => {
        onChange({ ...view, groups: view.groups.map((g) => (g.id === group.id ? { ...g, projectIds: projects, events } : g)) });
        onClose();
        notice.show(`${group.title} saved`);
      },
      reauthOr(() => setSaveAfter(true)),
    );
  };
  const list = store.projectList();

  const email = store.me?.email;
  // Signing in calls onClose and then onDone: this render's saveAfter says which of the two goes on.
  if (email && (saveAfter || (reauth && !declined)))
    return (
      <ConfirmSignIn
        email={email}
        purpose={saveAfter ? "Giving a group chat more projects or events" : "Linking a group chat"}
        onClose={() => (setDeclined(true), setSaveAfter(false))}
        onDone={() => (setDeclined(false), saveAfter ? save() : setRound((r) => r + 1))}
      />
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton aria-describedby={undefined} className="gap-0 p-0 text-[13px]/[1.45] sm:max-w-[600px]">
        <div className="flex items-center gap-2.5 border-b px-5 py-4">
          <UsersThreeIcon className="size-4" />
          <DialogTitle className="text-[15px] font-semibold">{mode.kind === "edit" ? mode.group.title : mode.kind === "relink" ? `Link ${mode.group.title} again` : "Add a group chat"}</DialogTitle>
        </div>
        <div className="flex flex-col gap-5 p-5">
          {linking &&
            (reauth ? (
              <ReauthNote why="A group keeps getting notifications after this session ends, so linking it needs a recent sign-in." onConfirm={() => setDeclined(false)} />
            ) : error ? (
              <p role="alert" className="m-0 text-ink-2">
                {error}
              </p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
                <Step n={linked ? <CheckIcon weight="bold" className="size-[11px]" /> : "1"}>
                  <span>
                    Add <b className="font-semibold">@{bot}</b> to the group: Telegram asks which one and sends the code there itself.
                  </span>
                  {link && !expired && !linked && (
                    <Button render={<a href={link.url} target="_blank" rel="noreferrer" />} nativeButton={false}>
                      <ArrowSquareOutIcon />
                      Open Telegram
                    </Button>
                  )}
                </Step>
                {!linked && (
                  <Step n="2">
                    <span>Or, in a group the bot is already in, send:</span>
                    {link && !expired && <CopyField text={link.command} label="Copy command" what="Command" />}
                  </Step>
                )}
                <Step n={linked ? <CheckIcon weight="bold" className="size-[11px]" /> : "3"}>
                  {linked ? (
                    <span className="flex items-center gap-2 self-stretch rounded-[6px] bg-ground px-3 py-2">
                      <UsersThreeIcon className="size-4 shrink-0 text-ink-2" />
                      <span className="min-w-0 flex-1 truncate">
                        <b className="font-semibold">{found.title}</b>
                        {found.members ? ` · ${found.members} members` : ""}, linked by you
                      </span>
                    </span>
                  ) : link && expired ? (
                    <span className="flex items-center gap-2.5 self-stretch rounded-[6px] bg-ground px-3 py-2 text-[12.5px] text-ink-2">
                      <span className="flex-1">This code has expired.</span>
                      <Button variant="outline" size="sm" onClick={() => setRound((r) => r + 1)}>
                        New code
                      </Button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2.5 self-stretch rounded-[6px] bg-ground px-3 py-2 text-[12.5px] text-ink-2">
                      <Spinner className="size-[15px] shrink-0 text-ink-3 motion-reduce:animate-none" />
                      <span className="flex-1">Waiting for the group. This updates on its own.</span>
                      {link && <span className="font-mono text-[11px] text-ink-3">code works {left(Date.parse(link.expiresAt) - now)}</span>}
                    </span>
                  )}
                </Step>
              </ol>
            ))}
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold">Projects</span>
            <div role="group" aria-label="Projects" className="flex flex-wrap gap-1.5">
              {list.map((p) => {
                const on = projects.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setProjects(toggle(projects, p.id))}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-[6px] border pr-2.5 pl-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-9",
                      on ? "border-inverse bg-inverse text-inverse-ink" : "border-control-border bg-panel text-ink-2 hover:border-rule-strong",
                    )}
                  >
                    <LetterTile name={p.key} {...(p.color ? { tone: p.color } : {})} className="size-4 rounded-[4px] text-[8.5px]" />
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-semibold">Events</span>
            {GROUP_EVENTS.map((e) => (
              <label key={e.id} className="flex cursor-pointer items-start gap-2.5 rounded-[6px] py-1.5 max-md:py-2.5">
                <Checkbox checked={events.includes(e.id)} onCheckedChange={() => setEvents(toggle(events, e.id))} className="mt-px" />
                <span className="flex flex-col gap-px">
                  {e.label}
                  <span className="text-[12px] text-ink-3">{e.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="m-0 text-caption text-ink-3">Everyone in the group sees these, as far as you may read them in this workspace.</p>
        </div>
        <div className="flex items-center justify-end gap-2 rounded-b-xl border-t bg-ground px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!linked || !projects.length || !events.length} onClick={save}>
            Save group
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});
