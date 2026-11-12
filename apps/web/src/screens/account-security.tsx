// Settings › Security (PLNR-20; "Security and sessions" until 2026-11-05): the person's passkeys and where they are signed in. There is no artboard for
// the page, only its place in the settings navigation ("Security and sessions", LedgerWorkspace); it is built from the
// settings' parts. The answers come from the server on opening: sessions are server-only and change on other devices.
import { DesktopIcon, FingerprintIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import type { AccountSecurity as Security, PasskeyView, SessionView } from "@rsva/protocol";
import { Badge } from "@rsva/ui/components/badge";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent } from "@rsva/ui/components/dialog";
import { SettingsSection } from "@rsva/ui/components/settings";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useState } from "react";
import { passkeysSupported } from "../lib/signed-in.ts";
import { timeAgo, useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { addPasskey, ConfirmSignIn, leave } from "./account-menu.tsx";
import { notice, reported } from "./notice.ts";
import { ApiError, peopleApi } from "./people-api.ts";
import { ConfirmBar, Count, CredentialRow, listBox, ListNote, SecretOnce } from "./settings-fields.tsx";
import { errorText } from "@rsva/schema/util";
import { shortDate } from "@rsva/display/time";

const METHOD: Record<string, string> = { code: "an email code", passkey: "a passkey", cli: "the command line" };

export const AccountSecurity = observer(function AccountSecurity() {
  const [data, setData] = useState<Security | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    peopleApi.security().then(
      (d) => (setData(d), setFailed(false)),
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);
  if (failed && !data) return <ListNote>Could not load this page. Check the connection and open it again.</ListNote>;
  if (!data) return <p className="m-0 text-label text-ink-3">Loading…</p>;
  return (
    <>
      <Passkeys passkeys={data.passkeys} reload={load} />
      <Sessions sessions={data.sessions} reload={load} />
    </>
  );
});

function Passkeys({ passkeys, reload }: { passkeys: PasskeyView[]; reload: () => void }) {
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const email = store.me?.email;
  return (
    <SettingsSection
      id="passkeys"
      compact
      title="Passkeys"
      aside={
        <>
          <Count n={passkeys.length} />
          {passkeysSupported() && (
            <Button variant="outline" size="sm" className="ml-auto self-center" onClick={() => addPasskey(() => setConfirming(true), reload)}>
              <FingerprintIcon />
              Add a passkey
            </Button>
          )}
        </>
      }
    >
      {passkeys.length === 0 ? (
        <ListNote>No passkeys yet. Touch ID, Face ID or your phone can sign you in without a code from your mail.</ListNote>
      ) : (
        <div className={listBox}>
          {passkeys.map((k) => (
            <CredentialRow
              key={k.id}
              icon={<FingerprintIcon />}
              title={k.name}
              facts={`Added ${shortDate(k.createdAt)} · ${k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt, now)}` : "not used yet"}`}
              action="Remove"
              question={
                <>
                  <span className="font-semibold text-ink">Remove {k.name}?</span> It stops signing you in here. Your device keeps a copy until you delete it there.
                </>
              }
              onConfirm={() => void reported(peopleApi.removePasskey(k.id).then(reload), `Passkey removed: ${k.name}`)}
            />
          ))}
        </div>
      )}
      {confirming && email && <ConfirmSignIn email={email} onClose={() => setConfirming(false)} onDone={reload} />}
    </SettingsSection>
  );
}

function Sessions({ sessions, reload }: { sessions: SessionView[]; reload: () => void }) {
  const now = useNow();
  const [endingOthers, setEndingOthers] = useState(false);
  /** A step that needs a fresh sign-in (routes.ts), to run again after the code, and what the sign-in screen calls it. */
  const [retry, setRetry] = useState<{ purpose: string; run: () => void } | null>(null);
  /** The terminal's sign-in code (PLNR-323), while its dialog is open. */
  const [code, setCode] = useState<string | null>(null);
  const email = store.me?.email;
  const failed = (e: unknown, purpose: string, again: () => void) => {
    if (e instanceof ApiError && e.code === "reauth_required") setRetry({ purpose, run: again });
    else notice.show(errorText(e));
  };
  /** A session newer than this one ends only from a fresh sign-in: after the code the step runs again. */
  const end = (run: () => Promise<string>) => {
    run().then(
      (done) => {
        notice.show(done);
        reload();
      },
      (e: unknown) => {
        reload();
        failed(e, "Signing out a newer session", () => end(run));
      },
    );
  };
  const signTerminalIn = () =>
    void peopleApi.terminalCode().then(
      (c) => setCode(c.code),
      (e: unknown) => failed(e, "Signing a terminal in", signTerminalIn),
    );
  // The one in use first: the list is by last use, and that moves only once an hour.
  const shown = [...sessions].sort((a, b) => Number(b.current) - Number(a.current));
  const others = sessions.filter((s) => !s.current).length;
  return (
    <SettingsSection
      id="sessions"
      compact
      title="Sessions"
      description="API tokens are separate: signing out a device leaves them working."
      aside={
        <>
          <Count n={sessions.length} />
          <Button variant="outline" size="sm" className="ml-auto self-center" onClick={signTerminalIn}>
            <TerminalWindowIcon />
            Sign in a terminal
          </Button>
          {others > 0 && (
            <Button variant="outline" size="sm" className="self-center" aria-expanded={endingOthers} onClick={() => setEndingOthers(!endingOthers)}>
              Sign out other devices
            </Button>
          )}
        </>
      }
    >
      {endingOthers && (
        <ConfirmBar
          action="Sign out"
          onCancel={() => setEndingOthers(false)}
          onConfirm={() => {
            setEndingOthers(false);
            end(() => peopleApi.endOtherSessions().then((r) => (r.ended === 1 ? "1 device signed out" : `${r.ended} devices signed out`)));
          }}
        >
          <span className="font-semibold text-ink">Sign out {others === 1 ? "1 other device" : `${others} other devices`}?</span> Their open tabs stop at once. This one stays signed in.
        </ConfirmBar>
      )}
      <div className={listBox}>
        {shown.map((s) => (
          <CredentialRow
            key={s.id}
            icon={s.method === "cli" ? <TerminalWindowIcon /> : <DesktopIcon />}
            title={s.device}
            tag={
              s.current && (
                <Badge variant="pill" className="text-ink-2">
                  This device
                </Badge>
              )
            }
            facts={`Signed in ${shortDate(s.createdAt)} with ${METHOD[s.method] ?? s.method}${s.current ? "" : ` · active ${timeAgo(s.lastSeenAt, now)}`}`}
            action="Sign out"
            question={
              s.current ? (
                <>
                  <span className="font-semibold text-ink">Sign out here?</span> Local copies on this device are deleted.
                </>
              ) : (
                <>
                  <span className="font-semibold text-ink">Sign out {s.device}?</span> Its open tabs stop at once.
                </>
              )
            }
            onConfirm={() => (s.current ? void leave() : end(() => peopleApi.endSession(s.id).then(() => `${s.device} signed out`)))}
          />
        ))}
      </div>
      {retry && email && <ConfirmSignIn email={email} purpose={retry.purpose} onClose={() => setRetry(null)} onDone={retry.run} />}
      {code !== null && (
        // Only Done closes it: a stray click outside must not lose the code.
        <Dialog open>
          <DialogContent className="sm:max-w-[480px]" showCloseButton={false}>
            <SecretOnce
              title="Sign in a terminal"
              description={
                <>
                  Run <code className="font-mono">rsva login</code> and paste this code. It works once, for 5 minutes. The terminal then works as you, in every workspace you are in, and shows up here as a session.
                </>
              }
              what="code"
              secret={code}
              onDone={() => {
                setCode(null);
                reload();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </SettingsSection>
  );
}
