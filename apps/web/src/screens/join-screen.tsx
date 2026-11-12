// /join/<secret>: an invite link opened, after the "Invite link opened" artboard (ADR 0011). Signed out, it is the
// sign-in screen with the invited address fixed and the invite above it, and the sign-in ends in the workspace.
// Signed in as that address: one button. Signed in as someone else: sign out and come back as the invited one. A dead
// link says only that it is dead: the server tells nothing about a workspace to a link that does not work.
import type { InviteView } from "@rsva/protocol";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { useEffect, useState } from "react";
import { signOut } from "../auth.ts";
import { signedIn } from "../lib/signed-in.ts";
import { paths } from "../router.ts";
import { workspacePath } from "../workspaces.ts";
import { ApiError, peopleApi } from "./people-api.ts";
import { AuthFrame as Frame, SignIn } from "./sign-in.tsx";
import { workspaceTileTone } from "./workspace-switcher.tsx";
import { useAction } from "./action.tsx";

/** Accepts the invite and opens its workspace with a full load: the engines start with the new membership. */
async function join(secret: string): Promise<void> {
  const { slug } = await peopleApi.acceptLink(secret);
  location.assign(workspacePath(slug));
}

export function JoinScreen({ secret }: { secret: string }) {
  const [view, setView] = useState<InviteView | "dead" | null>(null);
  useEffect(() => {
    peopleApi.byLink(secret).then(setView, () => setView("dead"));
  }, [secret]);
  if (view === null) return <Frame>{null}</Frame>;
  if (view === "dead") return <Dead />;
  if (!signedIn()) return <SignIn email={view.email} intro={<Invite view={view} />} onSignedIn={() => join(secret)} />;
  return <SignedIn view={view} secret={secret} />;
}

function SignedIn({ view, secret }: { view: InviteView; secret: string }) {
  const [me, setMe] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    // A 401 starts the page over signed out by itself (people-api.ts); anything else signs out here.
    peopleApi.me().then(
      (u) => setMe(u.email.toLowerCase()),
      (e: unknown) => void (e instanceof ApiError && e.status === 401 ? null : signOut(paths.join(secret))),
    );
  }, [secret]);
  if (!me) return <Frame>{null}</Frame>;
  return (
    <Frame>
      <Invite view={view} />
      {me === view.email ? (
        <div className="flex flex-col gap-2">
          <Button type="button" size="lg" disabled={busy} onClick={() => void run(() => join(secret), { leaves: true })}>
            Join {view.workspace.name}
          </Button>
          <p className="m-0 text-center text-caption text-ink-3">Signed in as {me}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-label text-ink-2">
            This invite is for <span className="font-mono text-ink">{view.email}</span>. You are signed in as <span className="font-mono text-ink">{me}</span>.
          </p>
          <Button type="button" size="lg" disabled={busy} onClick={() => void run(() => signOut(paths.join(secret)), { leaves: true })}>
            Sign out and continue as {view.email}
          </Button>
          <a href="/" className={buttonVariants({ variant: "outline", size: "lg" })}>
            Stay as {me}
          </a>
          <p className="m-0 text-caption text-ink-3">To join with this account, ask {view.invitedBy ?? "an admin"} to invite {me}.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-caption text-destructive">
          {error}
        </p>
      )}
    </Frame>
  );
}

/** The workspace's tile and who invites whom, above the sign-in steps or the Join button. */
function Invite({ view }: { view: InviteView }) {
  const w = view.workspace;
  return (
    <div className="flex flex-col gap-3">
      <LetterTile name={w.name} tone={workspaceTileTone(w, false)} className="size-12 rounded-xl text-xl" />
      <h1 className="m-0 text-title-md font-semibold">
        {view.invitedBy ? `${view.invitedBy} invited you to ${w.name}` : `You are invited to ${w.name}`}
      </h1>
      <p className="m-0 text-label text-ink-3">
        {w.members} {w.members === 1 ? "member" : "members"} · you join as {view.role === "admin" ? "an admin" : "a member"}
      </p>
    </div>
  );
}

function Dead() {
  return (
    <Frame>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-title-md font-semibold">This invite link no longer works</h1>
        <p className="m-0 text-label text-ink-2">It was revoked, already used, or ran out after 7 days. Ask the person who invited you for a new one.</p>
      </div>
      <a href="/" className={buttonVariants({ variant: "outline", size: "lg" })}>
        Go to your workspaces
      </a>
    </Frame>
  );
}
