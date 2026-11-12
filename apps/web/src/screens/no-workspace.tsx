// Signed in without a workspace, after the "Signed in, no workspace yet" artboard (ADR 0011): someone invited who has
// not joined yet, or who left their last workspace while invited elsewhere (without an invite the session ends with the
// last workspace), or let in from the waitlist (ADR 0054). Their invites with Join, a field for a link someone sent, and
// "Create a workspace" for the people who may create them: first when they have no invites (RSVA-552, lib/welcome.ts),
// the link field then below it with no empty invite list. The invite list is also the "Join existing" tab of the create
// dialog (create-workspace.tsx).
import { ArrowRightIcon, PlusIcon } from "@phosphor-icons/react";
import type { InviteView } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { Input } from "@rsva/ui/components/input";
import { Label } from "@rsva/ui/components/label";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { Separator } from "@rsva/ui/components/separator";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { welcomeLead } from "../lib/welcome.ts";
import { signOut } from "../auth.ts";
import { paths, router } from "../router.ts";
import { store } from "../store.ts";
import { workspacePath, workspaces } from "../workspaces.ts";
import { linkSecret, peopleApi } from "./people-api.ts";
import { Mark } from "./mark.tsx";
import { fieldClass } from "./settings-fields.tsx";
import { workspaceTileTone } from "./workspace-switcher.tsx";
import { ErrorLine, useAction } from "./action.tsx";
import { Link } from "../link.tsx";

export const NoWorkspace = observer(function NoWorkspace() {
  const [me, setMe] = useState<{ name: string; email: string } | null>(null);
  const [invites, setInvites] = useState<number | null>(null);
  useEffect(() => {
    peopleApi.me().then(setMe, () => {});
  }, []);
  const createFirst = welcomeLead(workspaces.mayCreate, invites) === "create";
  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <header className="flex h-13 items-center gap-2.5 px-5">
        <Mark size={19} />
        <span className="font-semibold">recursiva</span>
        <span className="ml-auto truncate font-mono text-meta text-ink-3">{me?.email}</span>
        <Button variant="ghost" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
      <main className="flex flex-1 justify-center px-4 pt-16 pb-12">
        <div className="flex w-[560px] max-w-full flex-col gap-7">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[26px] leading-[1.15] font-semibold tracking-[-0.02em]">{me ? `Welcome, ${me.name.split(" ")[0]}` : "Welcome"}</h1>
            <p className="m-0 text-[13.5px] text-ink-2">
              {createFirst
                ? "You are not in a workspace yet. Start your own, or join one you were invited to."
                : `You are not in a workspace yet. Join one you were invited to${workspaces.mayCreate ? ", or start your own" : ""}.`}
            </p>
          </div>
          {/* One invite list in either order (CSS order), so changing the lead neither remounts it nor loads it again. */}
          <div className="flex flex-col gap-7">
            <MyInvites email={me?.email} quiet={createFirst} onCount={setInvites} />
            {workspaces.mayCreate && <CreateCard first={createFirst} />}
          </div>
        </div>
      </main>
    </div>
  );
});

/** "Create a workspace" with the "or" that parts it from the invites: above it, or below it when it leads. */
function CreateCard({ first }: { first: boolean }) {
  const create = paths.newWorkspace();
  return (
    <div className={cn("flex gap-7", first ? "order-first flex-col-reverse" : "flex-col")}>
      <div className="flex items-center gap-3 text-xs text-ink-3">
        <Separator className="flex-1" />
        or
        <Separator className="flex-1" />
      </div>
      <Link
        href={create}
        className="flex items-center gap-3.5 rounded-[10px] border bg-panel p-4 outline-none transition-colors duration-200 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[10px] border-[1.5px] border-dashed border-faint text-ink-3">
          <PlusIcon className="size-3.5" />
        </span>
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="font-semibold">Create a workspace</span>
          <span className="text-[12.5px] text-ink-3">Name it, add your first projects, invite people.</span>
        </span>
        <ArrowRightIcon className="size-3.5 text-ink-3" />
      </Link>
    </div>
  );
}

/**
 * Invites to the signed-in person's address with Join and Decline, then a field for a link. Joining opens the
 * workspace with a full load, so the sidebar and the engines start with the new membership. `quiet` leaves out the list
 * while it is empty or loading (the Welcome screen leads with creating then); `onCount` hears how many there are.
 */
export function MyInvites({ email, quiet = false, onCount }: { email?: string | undefined; quiet?: boolean; onCount?: (n: number | null) => void }) {
  const [invites, setInvites] = useState<InviteView[] | null>(null);
  const { busy, busyTag, error, run } = useAction();
  const [link, setLink] = useState("");
  useEffect(() => {
    peopleApi.mine().then(setInvites, () => setInvites([]));
  }, []);
  const secret = linkSecret(link);
  // Already on screen when the store has a workspace: the workspace menu lists it; only the new ones are offered here.
  const shown = invites?.filter((i) => i.workspace.slug !== store.workspace?.slug) ?? null;
  const count = shown?.length ?? null;
  useEffect(() => onCount?.(count), [count, onCount]);
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="my-invites-h" hidden={quiet && !count} className="flex flex-col gap-2.5">
        <h2 id="my-invites-h" className="m-0 text-[15px] font-semibold">
          Invites{email ? ` for ${email}` : ""}
        </h2>
        {shown === null ? (
          <p className="m-0 text-label text-ink-3">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="m-0 rounded-lg border border-dashed p-4 text-label text-ink-3">No invites yet. Ask a teammate to invite {email ?? "your address"}, or open the link they sent you.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-panel">
            {shown.map((i) => (
              <div key={i.id} className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0">
                <LetterTile name={i.workspace.name} tone={workspaceTileTone(i.workspace, false)} className="size-8 rounded-lg text-[13px]" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{i.workspace.name}</span>
                  <span className="truncate text-xs text-ink-3">
                    {i.invitedBy ? `${i.invitedBy} invited you · ` : ""}
                    {i.workspace.members} {i.workspace.members === 1 ? "member" : "members"} · as {i.role}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  // The list again from the server: declining the last invite without a workspace ends the session, and
                  // its 401 starts the page over on the sign-in screen (people-api.ts).
                  onClick={() => void run(async () => setInvites((await peopleApi.decline(i.id), await peopleApi.mine())), { tag: i.id })}
                >
                  Decline
                </Button>
                <Button disabled={busy} onClick={() => void run(async () => location.assign(workspacePath((await peopleApi.accept(i.id)).slug)), { tag: i.id, leaves: true })}>
                  {busyTag === i.id ? "Joining…" : "Join"}
                </Button>
              </div>
            ))}
          </div>
        )}
        <ErrorLine error={error} />
      </section>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (secret) router.push(paths.join(secret));
        }}
      >
        <Label htmlFor="invite-link" className="text-[13px]/[1.4] select-text max-md:text-[14px]">
          Have an invite link?
        </Label>
        <div className="flex gap-2">
          <Input
            id="invite-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={`${location.host}/join/…`}
            aria-invalid={(link.trim() !== "" && !secret) || undefined}
            className={cn(fieldClass, "font-mono text-[12.5px] md:text-[12.5px] dark:bg-field aria-invalid:ring-0 aria-invalid:ring-ring aria-invalid:focus-visible:ring-2 dark:aria-invalid:border-signal-text dark:aria-invalid:ring-ring")}
          />
          <Button type="submit" variant="outline" disabled={!secret}>
            Open
          </Button>
        </div>
      </form>
    </div>
  );
}
