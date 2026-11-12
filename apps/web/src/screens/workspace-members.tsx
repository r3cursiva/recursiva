// Workspace › Settings › Members, after the "A · Ledger — workspace members" artboard: who is in the workspace with
// their role, the invites still open, and the invite dialog (ADR 0011). Members come from the sync engine, so a role
// change or a removal shows at once and in every open tab; invites are admins' business and come over REST.
//
// Left out of the artboard: the workspace-wide invite link (an email invite is bound to its address, a shared link is
// not: on the owner's decision), "last active" (sessions are server-only) and undo of a removal (coming back needs an
// invite). The owner's row has no controls: ownership moves only by a transfer, which is not built.
import { MagnifyingGlassIcon, TrashIcon, UserPlusIcon } from "@phosphor-icons/react";
import { MEMBER_RIGHTS, type MemberRight } from "@rsva/policy";
import { shortDate } from "@rsva/display/time";
import type { PendingInvite } from "@rsva/protocol";
import { ASSIGNABLE_ROLES, type AssignableRole, type User } from "@rsva/schema/models";
import { Badge } from "@rsva/ui/components/badge";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@rsva/ui/components/dialog";
import { EmailInput } from "@rsva/ui/components/email-input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@rsva/ui/components/input-group";
import { Label } from "@rsva/ui/components/label";
import { Segmented } from "@rsva/ui/components/segmented";
import { Select } from "@rsva/ui/components/select";
import { Hint } from "@rsva/ui/components/tooltip";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useState } from "react";
import { ROLE_LABEL, viewerCan } from "../lib/roles.ts";
import { router } from "../router.ts";
import { store } from "../store.ts";
import { notice, reported } from "./notice.ts";
import { peopleApi } from "./people-api.ts";
import { ChoiceRow, ConfirmBar, fieldClass, listBox, ListNote } from "./settings-fields.tsx";
import { ErrorLine, useAction } from "./action.tsx";

const RANK = { owner: 0, admin: 1, member: 2, guest: 3 } as const;
export const ROLE_OPTIONS = ASSIGNABLE_ROLES.map((value) => ({ value, label: ROLE_LABEL[value] }));
const ROLE_HINT: Record<AssignableRole, string> = {
  member: "Creates and edits issues in every project, and what Who can change opens to members.",
  admin: "Also changes settings, members and invites.",
};

/** Members of the open workspace: owner, admins, members, each by name. Someone who left keeps a row with role null. */
function members(): User[] {
  return [...store.users.values()].filter((u) => u.role).sort((a, b) => RANK[a.role!] - RANK[b.role!] || a.name.localeCompare(b.name));
}

export const memberCount = (): number | undefined => (store.status === "loading" ? undefined : members().length);

export const Members = observer(function Members({ ws }: { ws: string }) {
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  // "?invite" (the command palette) opens the dialog, also on this page already open: the page is not mounted anew.
  const path = router.path;
  useEffect(() => {
    if (new URLSearchParams(location.search).has("invite")) setInviting(true);
  }, [path]);
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);
  const admin = viewerCan("members.manage");
  const reload = useCallback(() => {
    if (admin) peopleApi.invites(ws).then(setInvites, (e: unknown) => notice.show(`Could not load invites: ${String(e)}`));
  }, [ws, admin]);
  useEffect(reload, [reload]);
  const closeInvite = () => {
    setInviting(false);
    // "?invite" opened it: drop it so a reload does not open it again.
    if (location.search) router.replace(location.pathname);
  };

  const q = query.trim().toLowerCase();
  const all = members();
  const shown = q ? all.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) : all;
  return (
    <>
      <section aria-labelledby="members-h" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 id="members-h" className="m-0 text-[15px] font-semibold">
            {all.length} {all.length === 1 ? "member" : "members"}
          </h2>
          <InputGroup className={cn(fieldClass, "ml-auto w-60 max-w-full dark:bg-field has-[[data-slot=input-group-control]:focus-visible]:border-ink-3 max-md:order-last max-md:ml-0 max-md:w-full")}>
            <InputGroupAddon className="py-0 pl-0">
              <MagnifyingGlassIcon className="size-3.5 shrink-0 text-ink-3" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search members"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or email"
              className="pr-0 placeholder:text-ink-3 md:text-[13.5px] max-md:pr-0 max-md:text-base"
            />
          </InputGroup>
          {admin && (
            <Button onClick={() => setInviting(true)}>
              <UserPlusIcon />
              Invite people
            </Button>
          )}
        </div>
        <div role="table" aria-label="Members" className={listBox}>
          {shown.map((u) => (
            <MemberRow key={u.id} user={u} admin={admin} />
          ))}
          {shown.length === 0 && <p className="m-0 p-5 text-center text-label text-ink-3">Nobody matches “{query}”.</p>}
        </div>
        <p className="m-0 text-xs text-ink-3">The owner's role changes only by a transfer of ownership. Agents are members that work through API tokens.</p>
      </section>
      <MemberRights admin={admin} />
      <Triagers admin={admin} />
      {admin && <PendingInvites ws={ws} invites={invites} onChange={setInvites} />}
      {admin && <InviteDialog ws={ws} open={inviting} onClose={closeInvite} onSent={reload} />}
    </>
  );
});

const RIGHT_ROWS: readonly { right: MemberRight; name: string; hint: string }[] = [
  { right: "labels.write", name: "Labels", hint: "make, rename, delete" },
  { right: "states.write", name: "States", hint: "the workflow" },
  { right: "projects.write", name: "Projects", hint: "create, archive" },
];
const WHO = [
  { value: "admins", label: "Admins" },
  { value: "members", label: "All members" },
] as const;

/**
 * What the workspace opened to members, as Linear's team permissions (ADR 0037). Agents are members, so this is also
 * what agents may change: a token never goes past its member. A signed-in admin changes it; the others see it.
 */
const MemberRights = observer(function MemberRights({ admin }: { admin: boolean }) {
  const rights = store.workspace?.memberRights ?? [];
  const set = (right: MemberRight, open: boolean) => store.updateWorkspace({ memberRights: MEMBER_RIGHTS.filter((r) => (r === right ? open : rights.includes(r))) });
  return (
    <section aria-labelledby="rights-h" className="flex flex-col gap-2.5">
      <h2 id="rights-h" className="m-0 text-[15px] font-semibold">
        Who can change
      </h2>
      <div role="group" aria-label="Who can change" className={cn(listBox, "px-3 py-1")}>
        {RIGHT_ROWS.map((r) => (
          <ChoiceRow key={r.right} name={r.name} hint={r.hint}>
            {admin ? (
              <Segmented variant="quiet" label={r.name} options={WHO} value={rights.includes(r.right) ? "members" : "admins"} onChange={(v) => set(r.right, v === "members")} />
            ) : (
              <span className="text-label text-ink-2">{rights.includes(r.right) ? "All members" : "Admins"}</span>
            )}
          </ChoiceRow>
        ))}
      </div>
      <p className="m-0 text-xs text-ink-3">Agents are members: their tokens change what members can, never more. States and labels marked Only people stay with people.</p>
    </section>
  );
});

const TRIAGE_WHO = [
  { value: "no", label: "No" },
  { value: "yes", label: "Triages" },
] as const;

/**
 * Who triages, as Linear's triage responsibility (owner 2026-11-11): the people whose Triage lists the proposals and the
 * agents' reviews, and whose sidebar shows it. Nobody chosen: every owner and admin, as before. A signed-in admin sets it.
 */
const Triagers = observer(function Triagers({ admin }: { admin: boolean }) {
  const named = store.workspace?.triagers ?? [];
  const people = members().filter((u) => u.kind === "human");
  const set = (id: string, on: boolean) => store.updateWorkspace({ triagers: on ? [...named.filter((x) => x !== id), id] : named.filter((x) => x !== id) });
  return (
    <section aria-labelledby="triage-h" className="flex flex-col gap-2.5">
      <h2 id="triage-h" className="m-0 text-[15px] font-semibold">
        Who triages
      </h2>
      <div role="group" aria-label="Who triages" className={cn(listBox, "px-3 py-1")}>
        {people.map((u) => {
          const on = named.includes(u.id);
          return (
            <ChoiceRow key={u.id} name={u.name} hint={u.email}>
              {admin ? (
                <Segmented variant="quiet" label={`${u.name} triages`} options={TRIAGE_WHO} value={on ? "yes" : "no"} onChange={(v) => set(u.id, v === "yes")} />
              ) : (
                <span className="text-label text-ink-2">{on ? "Triages" : "No"}</span>
              )}
            </ChoiceRow>
          );
        })}
      </div>
      <p className="m-0 text-xs text-ink-3">
        {named.length ? "Only these people see Triage: proposals and the reviews of what agents made." : "Nobody is chosen: every owner and admin triages. Choose people to narrow it."}
      </p>
    </section>
  );
});

const MemberRow = observer(function MemberRow({ user, admin }: { user: User; admin: boolean }) {
  const [removing, setRemoving] = useState(false);
  const you = user.id === store.me?.id;
  // Admins change anyone but the owner and themselves; the server checks the same (sync/members.ts).
  const editable = admin && user.role !== "owner" && !you;
  return (
    <div role="row" className="flex flex-col border-b transition-colors duration-200 last:border-b-0 hover:bg-row-hover">
      <div className="grid min-h-12 grid-cols-[minmax(0,1fr)_140px_36px] items-center gap-3 px-3 py-1.5 max-sm:grid-cols-[minmax(0,1fr)_auto_36px]">
        <span role="cell" className="flex min-w-0 items-center gap-2.5">
          <UserAvatar {...face(user)} className={cn("size-7", user.kind === "agent" && "rounded-[7px]")} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5 truncate font-medium">
              <span className="truncate max-md:shrink-0">{user.name}</span>
              {you && <span className="font-mono text-[10.5px] font-normal text-ink-3">you</span>}
              {user.kind === "agent" && <Badge className="border-border font-mono leading-[1.4]">agent</Badge>}
            </span>
            <span className="truncate font-mono text-[11.5px] text-ink-3">{user.email}</span>
          </span>
        </span>
        <span role="cell">
          {editable ? (
            <Select
              aria-label={`Role of ${user.name}`}
              size="sm"
              options={ROLE_OPTIONS}
              value={user.role as AssignableRole}
              onChange={(role) => {
                store.setMemberRole(user.id, role);
                notice.show(`${user.name} is now ${role === "admin" ? "an admin" : "a member"}`);
              }}
              className="w-[120px] max-md:w-[108px]"
            />
          ) : (
            <span className="pl-2 text-[12.5px] text-ink-2">{ROLE_LABEL[user.role!]}</span>
          )}
        </span>
        <span role="cell">
          {editable && (
            <Hint label="Remove from the workspace">
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${user.name}`} aria-expanded={removing} onClick={() => setRemoving(!removing)}>
                <TrashIcon />
              </Button>
            </Hint>
          )}
        </span>
      </div>
      {removing && (
        <div className="px-3 pb-2.5 pl-[50px]">
          <ConfirmBar
            action="Remove"
            onCancel={() => setRemoving(false)}
            onConfirm={() => {
              setRemoving(false);
              store.removeMember(user.id);
              notice.show(`${user.name} removed`);
            }}
          >
            <span className="font-semibold text-ink">Remove {user.name}?</span> Access ends at once, open tabs too. Their issues, comments and history stay; an admin can
            invite them back.
          </ConfirmBar>
        </div>
      )}
    </div>
  );
});

function PendingInvites({ ws, invites, onChange }: { ws: string; invites: PendingInvite[] | null; onChange: (i: PendingInvite[]) => void }) {
  return (
    <section aria-labelledby="invites-h" className="flex flex-col gap-2.5">
      <h2 id="invites-h" className="m-0 text-[15px] font-semibold">
        Pending invites {invites && <span className="font-mono text-xs font-normal text-ink-3">{invites.length}</span>}
      </h2>
      {invites === null ? (
        <p className="m-0 text-label text-ink-3">Loading…</p>
      ) : invites.length === 0 ? (
        <ListNote>No pending invites. Invites show here until they are accepted or revoked; a link works for 7 days.</ListNote>
      ) : (
        <div className={listBox}>
          {invites.map((i) => {
            const expired = Date.parse(i.expiresAt) <= Date.now();
            return (
              <div key={i.id} className="grid min-h-12 grid-cols-[minmax(0,1fr)_80px_auto] items-center gap-3 border-b px-3 py-1.5 transition-colors duration-200 last:border-b-0 hover:bg-row-hover max-sm:grid-cols-[minmax(0,1fr)_auto]">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-dashed border-faint text-[10.5px] font-semibold text-ink-3 uppercase">
                    {i.email[0]}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-[12.5px]">{i.email}</span>
                    <span className={cn("truncate text-xs", expired ? "text-signal-text" : "text-ink-3")}>
                      {i.invitedBy ? `Invited by ${i.invitedBy} · ` : ""}
                      {expired ? `ran out ${shortDate(i.expiresAt)}` : `works until ${shortDate(i.expiresAt)}`}
                    </span>
                  </span>
                </span>
                <span className="text-[12.5px] text-ink-2 max-sm:hidden">{ROLE_LABEL[i.role]}</span>
                <span className="flex justify-end gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void reported(peopleApi.resend(ws, i.id).then((r) => onChange(invites.map((x) => (x.id === i.id ? r : x)))), `Invite sent again to ${i.email}`)}
                  >
                    {expired ? "Send again" : "Resend"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-signal-text"
                    onClick={() => void reported(peopleApi.revoke(ws, i.id).then(() => onChange(invites.filter((x) => x.id !== i.id))), `Invite for ${i.email} revoked`)}
                  >
                    Revoke
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Emails and a role; the server leaves out members, sends each address its own link. */
function InviteDialog({ ws, open, onClose, onSent }: { ws: string; open: boolean; onClose: () => void; onSent: () => void }) {
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);
  const [role, setRole] = useState<AssignableRole>("member");
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    if (open) (setEmails([]), setRole("member"), setError(null));
  }, [open]);
  const n = emails.length;
  const send = () =>
    run(async () => {
      const r = await peopleApi.invite(ws, emails, role);
      const sent = r.invited.length;
      notice.show(
        [sent ? (sent === 1 ? `Invite sent to ${r.invited[0]!.email}` : `${sent} invites sent`) : "", r.members.length ? `already in: ${r.members.join(", ")}` : ""]
          .filter(Boolean)
          .join("; "),
      );
      onSent();
      onClose();
    });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Invite to {store.workspace?.name ?? ws}</DialogTitle>
          <DialogDescription>Each person gets an email with a link that works for 7 days. They sign in with a code sent to that address.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-emails" className="text-[length:inherit] leading-[inherit]">
              Emails
            </Label>
            <EmailInput id="invite-emails" value={emails} onChange={setEmails} onDraftChange={setDraft} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">Invite as</span>
            <Segmented label="Role" options={ROLE_OPTIONS} value={role} onChange={setRole} />
            <span className="text-xs text-ink-3">{ROLE_HINT[role]}</span>
          </div>
          <ErrorLine error={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || n === 0 || draft} onClick={() => void send()}>
            {n ? `Send ${n} ${n === 1 ? "invite" : "invites"}` : "Send invites"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
