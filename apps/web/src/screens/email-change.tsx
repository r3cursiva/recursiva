// Settings › Profile › Email › Change (PLNR-197, ADR 0033): the new address, then the code sent to it. Asking needs a
// recent sign-in; an older session gets the "Confirm it's you" screen and the dialog asks again by itself, with the
// address still typed. The new address comes back to every open tab as a User action, as a new name does.
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@rsva/ui/components/dialog";
import { Input } from "@rsva/ui/components/input";
import { useEffect, useState } from "react";
import { call } from "../lib/api.ts";
import { store } from "../store.ts";
import { useFreshAction } from "./account-menu.tsx";
import { notice } from "./notice.ts";
import { Field, FormEnd, inputFieldClass } from "./settings-fields.tsx";

const ask = (email: string) => call<void>("POST", "/auth/email", { email });
const confirmCode = (code: string) => call<{ user: { email: string } }>("POST", "/auth/email/confirm", { code });

export function EmailChange({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const { busy, error, setError, gate, run } = useFreshAction();
  useEffect(() => {
    if (open) (setEmail(""), setCode(""), setSentTo(null), setError(null), setResent(false));
  }, [open]);

  const send = (again = false) =>
    run(async () => {
      const to = email.trim();
      await ask(to);
      setSentTo(to);
      setCode("");
      setResent(again);
    });
  const submitCode = (digits: string) =>
    run(async () => {
      const { user } = await confirmCode(digits);
      onClose();
      notice.show(`Your email is now ${user.email}.`);
    });
  const typed = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    // A full code goes at once: pasted, typed or filled from the mail by the OS.
    if (digits.length === 6 && !busy) void submitCode(digits);
  };

  // The sign-in screen takes the place of this dialog; the address waits in this component's state.
  const signIn = gate(store.me?.email, "Changing your email", () => send());
  if (signIn) return signIn;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (sentTo === null) void (email.trim() && send());
            else if (code.length === 6) void submitCode(code);
          }}
        >
          <DialogHeader>
            <DialogTitle>Change email</DialogTitle>
            <DialogDescription>
              {sentTo === null ? (
                <>Sign-in codes and every email from recursiva will go to the new address. We'll send a code there to check it's yours.</>
              ) : (
                <>
                  We sent a 6-digit code to <span className="font-medium text-ink">{sentTo}</span>. It works for 10 minutes.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {sentTo === null ? (
            <Field label="New email" htmlFor="new-email">
              <Input
                id="new-email"
                type="email"
                autoFocus
                autoComplete="email"
                required
                placeholder="name@company.com"
                value={email}
                className={inputFieldClass}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          ) : (
            <Field label="Code" htmlFor="email-code">
              <Input
                id="email-code"
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                placeholder="123456"
                value={code}
                className={`${inputFieldClass} font-mono tracking-[0.3em]`}
                onChange={(e) => typed(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-x-3 text-caption text-ink-3">
                <Button type="button" variant="link" size="xs" className="-mx-2" disabled={busy} onClick={() => void send(true)}>
                  Send a new code
                </Button>
                <Button type="button" variant="link" size="xs" className="-mx-2" disabled={busy} onClick={() => (setSentTo(null), setError(null))}>
                  Use another address
                </Button>
                {resent && <span>A new code is on its way.</span>}
              </div>
            </Field>
          )}
          <FormEnd error={error} onCancel={onClose} disabled={busy || (sentTo === null ? !email.trim() : code.length !== 6)}>
            {sentTo === null ? "Send code" : "Change email"}
          </FormEnd>
        </form>
      </DialogContent>
    </Dialog>
  );
}
