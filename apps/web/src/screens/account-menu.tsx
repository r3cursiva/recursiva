// The account menu, opened by the avatar at the bottom of the sidebar: who is signed in, the theme, a passkey, the
// person's security settings, sign out. Lazy like the other menus (edit-chunk.ts); the sidebar draws a plain button
// until the chunk is here.
//
// A passkey, an API token, an email change, the personal Telegram chat and a group chat need a sign-in under ten minutes old
// (apps/server/src/auth/sessions.ts, FRESH_MS): an older session first confirms with a code to the person's address, on
// the sign-in screen over the app, which swaps the session for a fresh one and then offers the passkey or goes on.
import { FingerprintIcon, GearSixIcon, KeyboardIcon, ShieldCheckIcon, SignOutIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent } from "@rsva/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { ApiError } from "../lib/api.ts";
import { signOut } from "../auth.ts";
import { dismissed, passkeysSupported } from "../lib/signed-in.ts";
import { paths, router } from "../router.ts";
import { store, unsentChanges } from "../store.ts";
import { theme } from "../theme.ts";
import { notice } from "./notice.ts";
import { shortcutSheet } from "./palette-state.ts";
import { THEME } from "./sidebar-foot.tsx";
import { SignIn } from "./sign-in.tsx";
import { errorText } from "@rsva/schema/util";
import { useAction } from "./action.tsx";
import type { MenuProps } from "./lazy-menu.tsx";

const added = (name: string) => notice.show(`Passkey added: ${name}`);

/** The passkey code loads on demand: it is the sign-in screen's, and few clicks here need it. */
export function addPasskey(confirm: () => void, done?: () => void): void {
  void import("../passkeys.ts")
    .then((m) => m.addPasskey())
    .then(
      (name) => {
        added(name);
        done?.();
      },
      (e: unknown) => {
        if ((e as { code?: unknown }).code === "reauth_required") confirm();
        else if (!dismissed(e)) notice.show(`Passkey not added: ${errorText(e)}`);
      },
    );
}

export const AccountMenu = observer(function AccountMenu({ open, onOpenChange, trigger }: MenuProps) {
  const me = store.me;
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-60">
          {me && <WhoAmI name={me.name} email={me.email} />}
          <DropdownMenuSeparator />
          <AccountItems onConfirm={() => setConfirming(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming && me && <ConfirmSignIn email={me.email} onClose={() => setConfirming(false)} />}
    </>
  );
});

/** Who is signed in. Not a DropdownMenuLabel: Base UI allows that only as a group's label. */
export function WhoAmI({ name, email }: { name: string; email: string }) {
  return (
    <div className="flex min-w-0 flex-col px-2 py-1.5 max-md:px-[18px]">
      <span className="truncate text-xs font-medium max-md:text-[15px]">{name}</span>
      <span className="truncate text-xs text-muted-foreground max-md:text-caption">{email}</span>
    </div>
  );
}

/** The theme, a passkey, the profile, security and sign out, also in the phone's More menu (more-menu.tsx). */
export const AccountItems = observer(function AccountItems({ onConfirm }: { onConfirm: () => void }) {
  const { label, icon: ThemeIcon } = THEME[theme.mode];
  return (
    <>
      <DropdownMenuItem closeOnClick={false} onClick={() => theme.cycle()}>
        <ThemeIcon />
        Theme
        <span className="ml-auto text-ink-3">{label}</span>
      </DropdownMenuItem>
      {passkeysSupported() && (
        <DropdownMenuItem onClick={() => addPasskey(onConfirm)}>
          <FingerprintIcon />
          Add a passkey
        </DropdownMenuItem>
      )}
      {/* The person's settings open on Profile: beside it are Appearance, notifications and the rest, not only the profile. */}
      <DropdownMenuItem onClick={() => router.push(paths.accountProfile())}>
        <GearSixIcon />
        Settings
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => router.push(paths.accountSecurity())}>
        <ShieldCheckIcon />
        Security
      </DropdownMenuItem>
      {/* A phone has no keyboard to learn. */}
      <DropdownMenuItem className="max-md:hidden" onClick={() => shortcutSheet.show()}>
        <KeyboardIcon />
        Keyboard shortcuts
        <DropdownMenuShortcut>?</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void leave()}>
        <SignOutIcon />
        Sign out
      </DropdownMenuItem>
    </>
  );
});

/** Signing out wipes this device's copies, the queues with them: changes that never reached the server would go in silence. */
export async function leave(): Promise<void> {
  const n = await unsentChanges();
  if (n > 0 && !confirm(`${n === 1 ? "1 change has" : `${n} changes have`} not reached the server. Signing out deletes them from this device.`)) return;
  await signOut();
}

/**
 * The sign-in screen over the app with the person's address fixed; Esc or the cross leaves without going on. A bottom
 * sheet on a phone, as every dialog: `sheet` sets its size with !important. `purpose` says what the confirmation is for
 * and leaves out the offer of a passkey.
 */
export function ConfirmSignIn({ email, onClose, onDone, purpose }: { email: string; onClose: () => void; onDone?: () => void; purpose?: string }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-label="Confirm it's you"
        // The field, not the first button (Cancel), takes the focus.
        initialFocus={() => document.querySelector<HTMLElement>("[data-slot=dialog-content] input") ?? true}
        className="inset-0 block max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none bg-ground p-0 text-[13px]/[1.4] text-foreground ring-0 duration-0 sm:max-w-none max-md:[&>main]:min-h-0 max-md:[&>main]:bg-transparent max-md:[&>main]:py-6"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Cancel"
          onClick={onClose}
          className="absolute top-4 right-4 size-[30px] rounded-md border-0 active:scale-100! max-md:size-[30px] max-md:rounded-md"
        >
          <XIcon className="size-3.5" />
        </Button>
        <SignIn
          email={email}
          confirm={{ title: "Confirm it's you", text: `${purpose ?? "Adding a passkey"} needs a recent sign-in. We'll email a code to this address.`, offer: !purpose }}
          onSignedIn={async (name) => {
            onClose();
            if (name) added(name);
            onDone?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * A request behind a form that may need a recent sign-in: useAction, and `confirming` when the server answers
 * reauth_required. `gate` is then ConfirmSignIn in place of the form, and runs the request again once signed in.
 */
export function useFreshAction() {
  const [confirming, setConfirming] = useState(false);
  const action = useAction((e) => e instanceof ApiError && e.code === "reauth_required" && (setConfirming(true), true));
  const gate = (email: string | undefined, purpose: string, retry: () => Promise<void>) =>
    confirming && email ? <ConfirmSignIn email={email} purpose={purpose} onClose={() => setConfirming(false)} onDone={() => void retry()} /> : null;
  return { ...action, gate };
}
