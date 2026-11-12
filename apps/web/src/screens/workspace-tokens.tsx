// Settings › API tokens (PLNR-20): the tokens of the workspace the viewer may see, a new one, changing one's access
// (PLNR-271) and revoking. Everyone holds tokens of their own; admins also see the others' and make and change them for
// the workspace's agents. The server decides all of it
// (apps/server/src/api.ts): this page only offers what it would allow. No artboard for the page, only its place in the
// navigation ("API keys" under Developer, LedgerWorkspace); the agents' tokens read as tokens in the API, the CLI and the
// Members page, so the page does too.
//
// The secret lives in this dialog's state, for as long as the dialog is open: never in a toast, the URL or storage.
import { KeyIcon, PlusIcon } from "@phosphor-icons/react";
import type { ApiTokenView, NewApiToken, TokenAccess } from "@rsva/protocol";
import { Badge } from "@rsva/ui/components/badge";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@rsva/ui/components/dialog";
import { Input } from "@rsva/ui/components/input";
import { Select } from "@rsva/ui/components/select";
import { SettingsSection } from "@rsva/ui/components/settings";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { shortDate } from "@rsva/display/time";
import { viewerCan } from "../lib/roles.ts";
import { timeAgo, useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { useFreshAction } from "./account-menu.tsx";
import { notice, reported } from "./notice.ts";
import { peopleApi } from "./people-api.ts";
import { Count, CredentialRow, Field, FormEnd, inputFieldClass, listBox, ListNote, SecretOnce } from "./settings-fields.tsx";
import { accessReady, startAccess, type Holder } from "../lib/token-access.ts";
import { AccessPicker, accessSummary, stoppedSummary } from "./token-access.tsx";

const EXPIRY = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

/** The token's own member, in the owner field: anything else is an agent's email. */
const YOU = "you";

export const ApiTokens = observer(function ApiTokens({ ws }: { ws: string }) {
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [changing, setChanging] = useState<ApiTokenView | null>(null);
  const now = useNow();
  const load = useCallback(() => {
    peopleApi.tokens(ws).then(
      (t) => (setTokens(t), setFailed(false)),
      () => setFailed(true),
    );
  }, [ws]);
  useEffect(load, [load]);
  return (
    <SettingsSection
      id="tokens"
      compact
      title="Tokens"
      aside={
        <>
          {tokens && <Count n={tokens.length} />}
          <Button size="sm" className="ml-auto self-center" onClick={() => setCreating(true)}>
            <PlusIcon />
            New token
          </Button>
        </>
      }
    >
      {tokens === null ? (
        failed ? <ListNote>Could not load the tokens. Check the connection and open the page again.</ListNote> : <p className="m-0 text-label text-ink-3">Loading…</p>
      ) : tokens.length === 0 ? (
        <ListNote>No tokens yet. Make one for a script or the CLI: it is shown once, then only its name stays here.</ListNote>
      ) : (
        <div className={listBox}>
          {tokens.map((t) => (
            <TokenRow key={t.id} token={t} now={now} onChange={() => setChanging(t)} onRevoke={() => void reported(peopleApi.revokeToken(ws, t.id).then(load), `Token revoked: ${t.name}`)} />
          ))}
        </div>
      )}
      <TokenDialog ws={ws} open={creating} onClose={() => setCreating(false)} onCreated={load} />
      {changing && <AccessDialog ws={ws} token={changing} onClose={() => setChanging(null)} onChanged={load} />}
    </SettingsSection>
  );
});

/** Whose token it is, as its access is judged: the token's member, in this workspace. Null for one the viewer cannot change. */
function holderOf(email: string): Holder | null {
  const rights = store.workspace?.memberRights ?? [];
  if (email === store.me?.email) return store.role ? { role: store.role, rights } : null;
  const agent = [...store.users.values()].find((u) => u.email === email && u.kind === "agent");
  return agent?.role && viewerCan("agents.manage") ? { role: agent.role, rights } : null;
}

const TokenRow = observer(function TokenRow({ token: t, now, onChange, onRevoke }: { token: ApiTokenView; now: number; onChange: () => void; onRevoke: () => void }) {
  const member = [...store.users.values()].find((u) => u.email === t.user);
  const mine = t.user === store.me?.email;
  const expired = t.expiresAt !== null && Date.parse(t.expiresAt) <= now;
  const stopped = stoppedSummary(t);
  const giver = t.scope === "custom" && t.grantedBy && t.grantedBy !== t.user ? [...store.users.values()].find((u) => u.email === t.grantedBy) : undefined;
  const facts: ReactNode[] = [
    mine ? "Yours" : (member?.name ?? t.user),
    accessSummary(t),
    ...(giver ? [`set by ${giver.email === store.me?.email ? "you" : giver.name}`] : []),
    ...(stopped ? [<span className="text-signal-text">{stopped}</span>] : []),
    expired ? <span className="text-signal-text">Ran out {shortDate(t.expiresAt!)}</span> : t.expiresAt ? `Runs out ${shortDate(t.expiresAt)}` : "Never runs out",
    t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt, now)}` : "not used yet",
  ];
  return (
    <CredentialRow
      icon={<KeyIcon />}
      title={t.name}
      tag={member?.kind === "agent" && <Badge className="border-border font-mono leading-[1.4]">agent</Badge>}
      facts={facts.map((f, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {f}
        </span>
      ))}
      extra={
        holderOf(t.user) && (
          <Button variant="ghost" size="sm" className="shrink-0" aria-label={`Access: ${t.name}`} onClick={onChange}>
            Access
          </Button>
        )
      }
      action="Revoke"
      question={
        <>
          <span className="font-semibold text-ink">Revoke {t.name}?</span> Whatever uses it stops at once, its open connections too. This cannot be undone.
        </>
      }
      onConfirm={onRevoke}
    />
  );
});

/** A form, then the secret once. Only "Done" leaves the secret: a stray click outside must not lose it. */
const TokenDialog = observer(function TokenDialog({ ws, open, onClose, onCreated }: { ws: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState<string>(YOU);
  const [access, setAccess] = useState<TokenAccess>({ scope: "read" });
  const [expiry, setExpiry] = useState<Expiry>("90");
  const { busy, error, setError, gate, run } = useFreshAction();
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => {
    if (open) (setName(""), setOwner(YOU), setAccess({ scope: "read" }), setExpiry("90"), setError(null), setSecret(null));
  }, [open]);

  const agents = viewerCan("agents.manage") ? [...store.users.values()].filter((u) => u.kind === "agent" && u.role) : [];
  const holder = holderOf(owner === YOU ? (store.me?.email ?? "") : owner);
  const ready = !!name.trim() && accessReady(access);
  const create = () =>
    run(async () => {
      const body: NewApiToken = { name: name.trim(), ...access, ...(owner === YOU ? {} : { user: owner }), ...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }) };
      setSecret((await peopleApi.createToken(ws, body)).secret);
      onCreated();
    });
  // The sign-in screen takes the place of this dialog; the form waits in this component's state.
  const signIn = gate(store.me?.email, "Making a token", create);
  if (signIn) return signIn;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && secret === null && onClose()}>
      <DialogContent className="sm:max-w-[480px]" showCloseButton={false}>
        {secret === null ? (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready && !busy) void create();
            }}
          >
            <DialogHeader>
              <DialogTitle>New token</DialogTitle>
              <DialogDescription>It works in {store.workspace?.name ?? ws} only. You will see the secret once.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <Field label="Name" htmlFor="token-name">
                <Input id="token-name" autoFocus autoComplete="off" maxLength={100} value={name} placeholder="Laptop CLI" className={inputFieldClass} onChange={(e) => setName(e.target.value)} />
              </Field>
              {agents.length > 0 && (
                <Field label="For">
                  <Select
                    aria-label="For"
                    options={[{ value: YOU, label: "You" }, ...agents.map((a) => ({ value: a.email, label: `${a.name} (agent)` }))]}
                    value={owner}
                    onChange={(o) => (setOwner(o), setAccess({ scope: access.scope }))}
                    className="w-full"
                  />
                </Field>
              )}
              <Field label="Access">{holder && <AccessPicker value={access} onChange={setAccess} holder={holder} />}</Field>
              <Field label="Runs out in">
                <Select aria-label="Runs out in" options={EXPIRY} value={expiry} onChange={setExpiry} className="w-40" />
              </Field>
            </div>
            <FormEnd error={error} onCancel={onClose} disabled={busy || !ready}>
              Create token
            </FormEnd>
          </form>
        ) : (
          <SecretOnce
            title="Copy your token"
            description="This is the only time it is shown. Keep it in a password manager; the rsva CLI reads it from RSVA_TOKEN."
            what="token"
            secret={secret}
            onDone={() => {
              setSecret(null);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
});

/** A token's access, changed in place. Widening it asks for a fresh sign-in, as making one does; the server decides when. */
const AccessDialog = observer(function AccessDialog({ ws, token: t, onClose, onChanged }: { ws: string; token: ApiTokenView; onClose: () => void; onChanged: () => void }) {
  const holder = holderOf(t.user);
  // Grants its member may not use now start at Read: sending them back would be refused.
  const [access, setAccess] = useState<TokenAccess>(() => startAccess(t, holder));
  const { busy, error, gate, run } = useFreshAction();
  const save = () =>
    run(async () => {
      await peopleApi.setTokenAccess(ws, t.id, access);
      onChanged();
      onClose();
      notice.show(`Access changed: ${t.name}`);
    });
  const signIn = gate(store.me?.email, "Widening a token", save);
  if (signIn) return signIn;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (accessReady(access) && !busy) void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Access of {t.name}</DialogTitle>
            <DialogDescription>Whatever uses it keeps working: its open connections reconnect with the new access.</DialogDescription>
          </DialogHeader>
          {holder && <AccessPicker value={access} onChange={setAccess} holder={holder} />}
          <FormEnd error={error} onCancel={onClose} disabled={busy || !accessReady(access)}>
            Save
          </FormEnd>
        </form>
      </DialogContent>
    </Dialog>
  );
});

