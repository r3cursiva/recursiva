// The sign-in screen: a code to the email, or a passkey.
//
// It ships in the startup JS (1.6 KB brotli) rather than as a lazy chunk: Rolldown moves every module a second lazy
// entry shares with the startup code into a separate chunk, which added a startup file and 2.7 KB (measured
// 2026-10-28, also with preserveEntrySignatures off). So it brings nothing the startup code lacks: Button
// (layout-switch.tsx and ui's toast.tsx render it there already), a NativeInput (Base UI's input is not in the startup
// JS), no icons (Phosphor's fingerprint alone is 2 KB: every weight ships), and the passkey code (passkeys.ts) loads on
// demand.
//
// The email field doubles as the passkey picker: where the browser supports it, saved passkeys show up in the field's
// autofill (conditional mediation), so most sign-ins are one tap with no code and no extra button. After a code
// sign-in on a device that can hold passkeys, the screen offers to add one. A successful sign-in reloads the page:
// the store's engines start fresh with the session (store.ts).
//
// An invite link (join-screen.tsx) shows the same steps with the invited address fixed and its own heading above, and
// joins the workspace after the sign-in instead of opening the first one. Adding a passkey on an older session asks
// for a fresh sign-in the same way (`confirm`, account-menu.tsx): the person's own address, a code only.
//
// Past the daily cap of wrong codes the mail brings a one-time link instead (apps/server/src/auth/codes.ts):
// /#signin=<secret>&email=<address>. The fragment never reaches the server's logs; this screen drops it from the address
// bar and posts it to /auth/link only after the person confirms the address it signs in as: a link opened by itself
// would sign the browser in as whoever sent it (login CSRF: someone mails you a link to their own account).
import { CODE_RESEND_MS } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { NativeInput as Input } from "@rsva/ui/components/native-input";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { signedInAs } from "../auth.ts";
import { dismissed, passkeysSupported, signedIn } from "../lib/signed-in.ts";
import { isAccountRoute, router, routePath } from "../router.ts";
import { workspacePath, workspaces } from "../workspaces.ts";
import { Mark } from "./mark.tsx";
import { useAction } from "./action.tsx";

interface Signed {
  user: { id: string; email: string; name: string };
  passkeys: number;
  mayCreateWorkspaces: boolean;
}

type Step = { name: "email" } | { name: "code"; email: string; sentAt: number } | { name: "link"; secret: string; email: string } | { name: "offer" };

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 204) return undefined as T;
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new Error(data.message ?? `HTTP ${r.status}`);
  return data;
}

/**
 * Opens the page in the URL if it is in one of the person's workspaces, else their first one; a full load starts the
 * engines. The path is built from the parsed route, never taken as it is: "//3405803781/x" is another host.
 */
async function enter(): Promise<void> {
  await workspaces.load();
  const list = workspaces.list ?? [];
  const asked = router.route.ws;
  // The person's own pages need no workspace in the address (PLNR-225).
  const keep = (asked && list.some((w) => w.slug === asked)) || (!asked && isAccountRoute(router.route) && list[0]);
  location.assign(keep ? routePath(router.route) + location.search : list[0] ? workspacePath(list[0].slug) : "/");
}

/**
 * The sign-in link the page was opened with, read once at load: the screen takes it out of the address bar, and the
 * app (App.tsx) keeps showing this screen until the person confirms or picks another address, even when signed in.
 */
const openedLink = ((): { secret: string; email: string } | null => {
  const p = new URLSearchParams(location.hash.slice(1));
  const secret = p.get("signin");
  const email = p.get("email");
  return secret && email ? { secret, email } : null;
})();

/** Whether the page was opened with a sign-in link from the mail. */
export const linkInUrl = (): boolean => openedLink !== null;

/**
 * `confirm` asks a signed-in person for a fresh sign-in: its heading and the code only, then straight to adding the
 * passkey (a click there, as browsers want for creating one). `onSignedIn` gets the new passkey's name if one was added.
 */
export function SignIn({
  email,
  intro,
  confirm,
  onSignedIn = enter,
}: { email?: string; intro?: ReactNode; confirm?: { title: string; text: string; offer: boolean }; onSignedIn?: (added?: string) => Promise<void> } = {}) {
  const [step, setStep] = useState<Step>(() => {
    return openedLink && !confirm ? { name: "link", ...openedLink } : { name: "email" };
  });
  // A dismissed passkey dialog stays silent.
  const action = useAction(dismissed);
  const { busy, error, setError } = action;
  const [notice, setNotice] = useState<string | null>(null);
  const autofill = useRef<AbortController | null>(null);

  const passkeys = () => import("../passkeys.ts");

  async function done(s: Signed): Promise<void> {
    autofill.current?.abort();
    await signedInAs(s.user.id);
    workspaces.setMayCreate(s.mayCreateWorkspaces);
    if ((confirm ? confirm.offer : s.passkeys === 0) && passkeysSupported()) setStep({ name: "offer" });
    else await onSignedIn();
  }

  /** Runs an action with the busy state and the error line, the notice cleared. */
  const run = (f: () => Promise<void>) => (setNotice(null), action.run(f));

  // A link from the mail waits for the person to confirm its address (top of the file); the secret leaves the address bar
  // at once. A dead link leaves the email step with the reason.
  useEffect(() => {
    if (step.name === "link") history.replaceState(null, "", location.pathname + location.search);
  }, []);

  // Passkeys in the email field's autofill, while the email step is on screen.
  useEffect(() => {
    if (step.name !== "email" || confirm) return;
    const ctl = new AbortController();
    autofill.current = ctl;
    if (passkeysSupported())
      void passkeys().then(async (m) => {
        if (!(await m.autofillSupported()) || ctl.signal.aborted) return;
        // Silent on failure: the person did not ask for it (and an IP address, as in local runs, is no RP ID at all).
        m.signInWithPasskey<Signed>({ autofill: true, signal: ctl.signal }).then(done, (e: unknown) => {
          if (!dismissed(e)) console.warn("rsva passkey autofill:", e);
        });
      });
    return () => ctl.abort();
  }, [step.name]);

  return (
    <AuthFrame>
      {intro}
      {step.name === "email" && (
        <EmailStep
          fixed={email}
          heading={confirm}
          busy={busy}
          onSubmit={(email) => run(async () => (await post("/auth/code", { email }), setStep({ name: "code", email, sentAt: Date.now() })))}
          onPasskey={
            confirm
              ? undefined
              : () =>
                  run(async () => {
                    // One ceremony at a time: the autofill request holds the authenticator until it is aborted.
                    autofill.current?.abort();
                    await done(await (await passkeys()).signInWithPasskey<Signed>());
                  })
          }
        />
      )}
      {step.name === "link" && (
        <Heading
          title="Sign in with the link"
          text={
            <>
              This link signs you in as <span className="text-ink">{step.email}</span>. Continue only if you asked for it
              {signedIn() ? "; you will be signed out of the account open here." : "."}
            </>
          }
        >
          <div className="flex gap-2">
            <Button
              size="lg"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  try {
                    await done(await post<Signed>("/auth/link", { secret: step.secret, email: step.email }));
                  } catch (e) {
                    setStep({ name: "email" });
                    throw e;
                  }
                })
              }
            >
              Continue
            </Button>
            <Button size="lg" variant="ghost" disabled={busy} onClick={() => (setError(null), setStep({ name: "email" }))}>
              Use another address
            </Button>
          </div>
        </Heading>
      )}
      {step.name === "code" && (
        <CodeStep
          email={step.email}
          busy={busy}
          onCode={(code) => run(async () => done(await post<Signed>("/auth/verify", { email: step.email, code })))}
          sentAt={step.sentAt}
          onResend={() => run(async () => (await post("/auth/code", { email: step.email }), setStep({ ...step, sentAt: Date.now() }), setNotice("A new code is on its way.")))}
          {...(email ? {} : { onBack: () => (setError(null), setStep({ name: "email" })) })}
        />
      )}
      {step.name === "offer" && (
        <Heading
          title={confirm ? "Confirmed" : "Sign in faster next time"}
          text="Add a passkey: Touch ID, Face ID or your phone signs you in, no code needed."
        >
          <div className="flex gap-2">
            <Button size="lg" disabled={busy} onClick={() => run(async () => onSignedIn(await (await passkeys()).addPasskey()))}>
              Add a passkey
            </Button>
            <Button size="lg" variant="ghost" disabled={busy} onClick={() => run(() => onSignedIn())}>
              Not now
            </Button>
          </div>
        </Heading>
      )}
      {notice && <p className="text-caption text-ink-2">{notice}</p>}
      {error && (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      )}
    </AuthFrame>
  );
}

/** The screen's frame: the mark, then a narrow column. The invite pages (join-screen.tsx) use it too. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ground px-4">
      <div className="flex w-full max-w-[340px] flex-col gap-6">
        <Mark size={36} />
        {children}
      </div>
    </main>
  );
}

/** A step's title and words above its controls; the email-change link page (email-revert.tsx) uses it too. */
export function Heading({ title, text, children }: { title: string; text: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-title-md font-semibold">{title}</h1>
        <p className="text-label text-ink-2">{text}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * Enter sends the form from its keydown instead of waiting for the keypress the browser submits on: something on window,
 * an extension's panel over the field as far as seen, cancels that keydown after the page has seen it, so no keypress
 * comes and nothing is sent (Helium, 2026-11-02, PLNR-186). requestSubmit keeps the field's validation; a disabled button does not stop it, so
 * the steps check `busy` themselves.
 */
function enterSubmits(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.currentTarget.form?.requestSubmit();
}

/** The field's value on the page: a script can fill it without React hearing of it. */
const fieldValue = (e: FormEvent<HTMLFormElement>, name: string): string => String(new FormData(e.currentTarget).get(name) ?? "").trim();

function EmailStep({
  fixed,
  heading,
  busy,
  onSubmit,
  onPasskey,
}: {
  fixed?: string | undefined;
  heading?: { title: string; text: string } | undefined;
  busy: boolean;
  onSubmit: (email: string) => void;
  onPasskey?: (() => void) | undefined;
}) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = fieldValue(e, "email");
    if (email && !busy) onSubmit(email);
  };
  return (
    <Heading
      title={heading?.title ?? (fixed ? "Sign in to join" : "Sign in to recursiva")}
      text={heading?.text ?? (fixed ? "The invite is for this address. We'll email you a code." : "We'll email you a code.")}
    >
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Input
          type="email"
          name="email"
          // "webauthn" lets the browser offer saved passkeys right here (SignIn's autofill request).
          autoComplete="username webauthn"
          autoFocus
          required
          readOnly={!!fixed}
          placeholder="you@example.com"
          aria-label="Email"
          defaultValue={fixed}
          onKeyDown={enterSubmits}
          className="h-8"
        />
        <Button size="lg" type="submit" disabled={busy}>
          Continue with email
        </Button>
      </form>
      {onPasskey && passkeysSupported() && (
        <Button size="lg" variant="outline" disabled={busy} onClick={onPasskey}>
          Sign in with a passkey
        </Button>
      )}
    </Heading>
  );
}

/**
 * `onBack` is left out when the address is fixed (an invite's). A new code can be asked for a minute after the last
 * request: within it the server keeps the code it sent and mails nothing (CODE_RESEND_MS).
 */
function CodeStep(p: { email: string; sentAt: number; busy: boolean; onCode: (code: string) => void; onResend: () => void; onBack?: () => void }) {
  const [code, setCode] = useState("");
  const [canResend, setCanResend] = useState(false);
  useEffect(() => {
    setCanResend(false);
    const t = setTimeout(() => setCanResend(true), p.sentAt + CODE_RESEND_MS - Date.now());
    return () => clearTimeout(t);
  }, [p.sentAt]);
  const digitsOf = (v: string) => v.replace(/\D/g, "").slice(0, 6);
  const change = (v: string) => {
    const digits = digitsOf(v);
    setCode(digits);
    // A full code goes at once: pasted, typed or filled from the mail by the OS.
    if (digits.length === 6) p.onCode(digits);
  };
  return (
    <Heading
      title="Check your email"
      text={
        <>
          We sent a 6-digit code to <span className="font-medium text-ink">{p.email}</span>. It works for 10 minutes. If you connected Telegram and signed in from this browser before, it is there too.
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const digits = digitsOf(fieldValue(e, "code"));
          if (digits.length === 6 && !p.busy) p.onCode(digits);
        }}
        className="flex flex-col gap-2"
      >
        <Input
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
          required
          pattern="[0-9]{6}"
          title="The 6-digit code from the email"
          aria-label="Sign-in code"
          placeholder="123456"
          value={code}
          onChange={(e) => change(e.target.value)}
          onKeyDown={enterSubmits}
          className="h-10 text-center font-mono text-lg tracking-[0.4em] md:text-lg"
        />
        <Button size="lg" type="submit" disabled={p.busy}>
          Sign in
        </Button>
        <p className="text-caption text-ink-3">If the email has a link instead of a code, open it.</p>
      </form>
      <div className="flex gap-3 text-caption">
        {p.onBack && (
          <Button variant="link" size="sm" onClick={p.onBack}>
            Use another email
          </Button>
        )}
        <Button variant="link" size="sm" disabled={p.busy || !canResend} onClick={p.onResend}>
          {canResend ? "Send a new code" : "Send a new code in a minute"}
        </Button>
      </div>
    </Heading>
  );
}
