// /#email-revert=<secret>: the link in the mail to an address an account left (PLNR-197, ADR 0033). It works signed in
// or out: whoever changed the address may have locked its owner out. The secret leaves the address bar at once, and the
// page posts it only on a click: a mail scanner or a preview that opens the link changes nothing.
import { Button } from "@rsva/ui/components/button";
import { useEffect, useState } from "react";
import { call } from "../lib/api.ts";
import { AuthFrame, Heading } from "./sign-in.tsx";
import { useAction } from "./action.tsx";
import { plural } from "@rsva/schema/util";

const home = () => location.assign("/");

interface Reverted {
  email: string;
  removed: { passkeys: number; tokens: number; telegram: number };
}

/** "1 passkey and 2 API tokens": what the link took away, or null for nothing. */
function removedText({ passkeys, tokens, telegram }: Reverted["removed"]): string | null {
  const parts = ([
    [passkeys, "passkey"],
    [tokens, "API token"],
    [telegram, "Telegram link"],
  ] as const).flatMap(([n, what]) => (n ? [plural(n, what)] : []));
  return parts.length ? parts.join(", ").replace(/, ([^,]*)$/, " and $1") : null;
}

export function EmailRevert({ secret }: { secret: string }) {
  const [restored, setRestored] = useState<Reverted | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => history.replaceState(null, "", location.pathname + location.search), []);

  const revert = () => run(async () => setRestored(await call<Reverted>("POST", "/auth/email/revert", { secret })));

  return (
    <AuthFrame>
      {restored === null ? (
        <Heading
          title="Change your email back?"
          text="This puts back the address this link was sent to, signs out every device, this one too, and removes the passkeys, API tokens and Telegram links added since the change. Then sign in with that address."
        >
          <div className="flex gap-2">
            <Button size="lg" disabled={busy} onClick={() => void revert()}>
              Change it back
            </Button>
            <Button size="lg" variant="ghost" onClick={home}>
              Not now
            </Button>
          </div>
        </Heading>
      ) : (
        <Heading
          title="Your email is changed back"
          text={
            <>
              The account signs in with <span className="font-medium text-ink">{restored.email}</span> again. Every device was signed out.
              {removedText(restored.removed) && ` Removed what was added since the change: ${removedText(restored.removed)}.`}
            </>
          }
        >
          <div className="flex">
            <Button size="lg" onClick={home}>
              Sign in
            </Button>
          </div>
        </Heading>
      )}
      {error && (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      )}
    </AuthFrame>
  );
}
