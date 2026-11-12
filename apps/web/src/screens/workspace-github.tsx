// Settings › GitHub (PLNR-96), after the GhSettings and GhPhoneSettings artboards: what the integration is doing, read-only.
// Everything is set on the server (`GITHUB_*` in its environment, `apps/server/src/cli/github.ts`), so there is nothing to
// change here; admins see whether it works and why not. A phone draws the tables as cards.
import { CheckCircleIcon, GitMergeIcon, GithubLogoIcon, LockIcon, WarningCircleIcon, WebhooksLogoIcon, XCircleIcon } from "@phosphor-icons/react";
import type { GithubDeliveryView, GithubInstallationView, GithubRepoView, GithubStatus } from "@rsva/protocol";
import { Badge } from "@rsva/ui/components/badge";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { SettingsSection } from "@rsva/ui/components/settings";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useState, type ReactNode } from "react";
import { useIsPhone } from "../lib/phone.ts";
import { viewerCan } from "../lib/roles.ts";
import { exactTime, timeAgo, useNow } from "../lib/time.ts";
import { ProjectChip } from "./project-chip.tsx";
import { LinkedTag } from "./github-parts.tsx";
import { ApiError, peopleApi } from "./people-api.ts";
import { Count } from "./settings-fields.tsx";
import { plural } from "@rsva/schema/util";
import { shortDate } from "@rsva/display/time";

const box = "rounded-lg border bg-panel max-md:overflow-hidden max-md:rounded-xl";
const mono = "font-mono text-[12px]";
const code = "rounded-[4px] border border-rule-soft bg-sidebar px-1.5 py-px font-mono text-[12px] whitespace-nowrap";

/** Beside the page's title. */
export function GithubTags() {
  return (
    <>
      <Badge variant="pill" className="text-ink-2">
        <LockIcon className="size-2.5" />
        Admins only
      </Badge>
      <Badge variant="pill" className="text-ink-2">
        Read-only
      </Badge>
    </>
  );
}

export const GithubSettings = observer(function GithubSettings({ ws }: { ws: string }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = viewerCan("workspace.write");
  useEffect(() => {
    if (!admin) return;
    let live = true;
    peopleApi.github(ws).then(
      (s) => live && setStatus(s),
      (e: unknown) => live && setError(e instanceof ApiError && e.status === 404 ? "This server has no GitHub page yet." : e instanceof ApiError && e.status === 403 ? "Only admins can see this page." : "GitHub’s state could not be loaded."),
    );
    return () => {
      live = false;
    };
  }, [ws, admin]);
  const now = useNow();
  if (!admin) return <p className="m-0 text-ink-3">Only admins can see this page.</p>;
  if (error) return <p className="m-0 text-ink-3">{error}</p>;
  if (!status) return <p className="m-0 text-ink-3">Loading…</p>;
  const { setup } = status;
  const ready = setup.appId && setup.privateKey && setup.webhookSecret && setup.installed;
  return (
    <div className="flex max-w-[980px] flex-col gap-[30px] max-md:gap-[22px]">
      <SettingsSection id="github-status" title="Status" compact>
        {ready ? <Enabled status={status} now={now} /> : <Missing setup={setup} />}
      </SettingsSection>
      {ready && <Installations rows={status.installations} />}
      {ready && <Webhooks last={status.lastDelivery} error={status.lastError} now={now} />}
      {ready && <Repositories rows={status.repositories} now={now} />}
      <Rules />
    </div>
  );
});

function Dot({ className }: { className: string }) {
  return <span className={cn("mt-[5px] size-2.5 shrink-0 rounded-full", className)} />;
}

function Enabled({ status, now }: { status: GithubStatus; now: number }) {
  const { app, repositories: repos } = status;
  const on = repos.filter((r) => r.enabled).length;
  return (
    <div className={cn(box, "flex items-start gap-3.5 px-[18px] py-4 max-md:gap-3 max-md:px-3.5 max-md:py-3", app.error && "border-error-line")}>
      <Dot className={app.error ? "bg-error" : "bg-success"} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold max-md:text-[15px]">{app.error ? "GitHub refused the app" : "Enabled"}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-2 max-md:text-[13px]">
          {app.error ?? (
            <>
              <span className="max-md:hidden">GitHub </span>App <span className={mono}>{app.slug ?? "unknown"}</span> · <span className="max-md:hidden">webhook secret set · {repoCount(repos.length)}, {on} enabled</span>
              <span className="md:hidden">
                {on} of {repos.length} repositories on
              </span>
            </>
          )}
        </div>
      </div>
      {app.checkedAt && (
        <span title={exactTime(app.checkedAt)} className="font-mono text-[11px] whitespace-nowrap text-ink-3 max-md:hidden">
          checked {timeAgo(app.checkedAt, now)}
        </span>
      )}
    </div>
  );
}

function Missing({ setup }: { setup: GithubStatus["setup"] }) {
  const row = (ok: boolean, name: ReactNode, wrong: string) => (
    <div className="flex items-center gap-2 text-[13px] max-md:py-1.5">
      {ok ? <CheckCircleIcon className="size-3.5 text-success" /> : <XCircleIcon className="size-3.5 text-error" />}
      {name}
      <span className={cn("max-md:hidden", ok ? "text-ink-3" : "text-error")}>{ok ? "set" : wrong}</span>
    </div>
  );
  return (
    <div className={cn(box, "flex items-start gap-3.5 border-error-line px-[18px] py-4 max-md:gap-3 max-md:px-3.5 max-md:py-3")}>
      <Dot className="bg-error" />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold max-md:text-[15px]">Not configured</div>
        <div className="mt-0.5 text-[12.5px] text-ink-2 max-md:text-[13px]">
          Set these on the server and restart it.<span className="max-md:hidden"> Nothing links to issues until then.</span>
        </div>
        <div className="mt-2.5 flex flex-col gap-1.5 max-md:mt-1 max-md:gap-0">
          {row(setup.appId, <span className={code}>GITHUB_APP_ID</span>, "missing")}
          {row(setup.privateKey, <span className={code}>GITHUB_APP_PRIVATE_KEY</span>, "missing")}
          {row(setup.webhookSecret, <span className={code}>GITHUB_WEBHOOK_SECRET</span>, "missing")}
          {row(
            setup.installed,
            <>
              <span className="max-md:hidden">App installed on an account or organization</span>
              <span className="md:hidden">No app installation</span>
            </>,
            "no installation",
          )}
        </div>
      </div>
    </div>
  );
}

const th = "h-[34px] border-b px-3.5 text-left text-[11.5px] font-medium whitespace-nowrap text-ink-3";
const td = "h-11 border-b border-rule-soft px-3.5 align-middle in-[tr:last-child]:border-b-0";
const muted = "text-[12.5px] whitespace-nowrap text-ink-3";
const card = "flex flex-col gap-1 border-b border-rule-soft px-3.5 py-3 last:border-b-0";
const cardMeta = "flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-3";

function Table({ heads, children }: { heads: string[]; children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          {heads.map((h) => (
            <th key={h} className={th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function OnOff({ on, label, className }: { on: boolean; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12.5px]", className)}>
      <i className={cn("size-[7px] rounded-full", on ? "bg-success" : "bg-faint")} />
      {label}
    </span>
  );
}

function Account({ row }: { row: GithubInstallationView }) {
  return (
    <span className="inline-flex items-center gap-[9px] font-medium">
      <LetterTile name={row.account} className={cn("size-5 text-[10px]", row.type === "User" ? "rounded-full" : "rounded-[5px]")} />
      {row.account}
    </span>
  );
}

const repoCount = (n: number) => plural(n, "repository", "repositories");

function Installations({ rows }: { rows: GithubInstallationView[] }) {
  const phone = useIsPhone();
  const state = (r: GithubInstallationView) => <OnOff on={!r.suspended} label={r.suspended ? "Suspended" : "Active"} {...(phone ? { className: "ml-auto text-ink-2" } : {})} />;
  const by = (r: GithubInstallationView) => `${shortDate(r.installedAt)}${r.installedBy ? ` · by ${r.installedBy}` : ""}`;
  return (
    <SettingsSection id="github-installations" title="App installations" compact aside={<Count n={rows.length} />}>
      <div className={box}>
        {phone ? (
          rows.map((r) => (
            <div key={r.id} className={card}>
              <span className="flex items-center gap-2 text-[14px]">
                <Account row={r} />
                {state(r)}
              </span>
              <span className={cardMeta}>
                {r.type} · {repoCount(r.repositories)} · {by(r)}
              </span>
            </div>
          ))
        ) : (
          <Table heads={["Account", "Type", "Repositories", "Installed", "Status"]}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <Account row={r} />
                  </td>
                  <td className={cn(td, muted)}>{r.type}</td>
                  <td className={td}>{r.repositories} selected</td>
                  <td className={cn(td, muted)}>{by(r)}</td>
                  <td className={td}>{state(r)}</td>
                </tr>
              ))}
          </Table>
        )}
      </div>
    </SettingsSection>
  );
}

function StatusCode({ code }: { code: number }) {
  const ok = code < 300;
  return (
    <Badge variant="pill" className={cn("h-auto border-0 px-1.5 py-px text-[11px] tracking-normal", ok ? "bg-success/15 text-success" : "bg-error-bg text-error")}>
      {code}
    </Badge>
  );
}

function Webhooks({ last, error, now }: { last: GithubDeliveryView | null; error: GithubDeliveryView | null; now: number }) {
  return (
    <SettingsSection id="github-webhooks" title="Webhooks" compact>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1 max-md:gap-0 max-md:overflow-hidden max-md:rounded-xl max-md:border max-md:bg-panel">
        <div className={cn(box, "flex flex-col gap-1.5 px-4 py-3.5 max-md:rounded-none max-md:border-0 max-md:border-b max-md:border-rule-soft max-md:bg-transparent max-md:px-3.5 max-md:py-3")}>
          <span className="text-[11.5px] text-ink-3 max-md:text-[12.5px]">Last delivery</span>
          {last ? (
            <>
              <span className="flex items-center gap-2 text-[13.5px] font-medium max-md:text-[14px]">
                <WebhooksLogoIcon className="size-[15px] shrink-0 text-ink-2 max-md:hidden" />
                <span className="min-w-0 truncate font-mono text-[12.5px]">{last.event}</span>
                <StatusCode code={last.status} />
              </span>
              <span className="flex flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-3 max-md:text-[12.5px]">
                <span title={exactTime(last.at)}>{timeAgo(last.at, now)}</span>
                {last.repo && <span className="font-mono text-[11px]">{last.repo}</span>}
                <span className="font-mono text-[11px] max-md:hidden">id {last.id.slice(0, 4)}…{last.id.slice(-3)}</span>
              </span>
            </>
          ) : (
            <span className="text-[13px] text-ink-3">No deliveries yet</span>
          )}
        </div>
        <div className={cn(box, "flex flex-col gap-1.5 px-4 py-3.5 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:px-3.5 max-md:py-3", error && "md:border-error-line")}>
          <span className="text-[11.5px] text-ink-3 max-md:text-[12.5px]">Last error</span>
          {error ? (
            <>
              <span className="flex items-center gap-2 text-[13.5px] font-medium text-error max-md:text-[14px]">
                <WarningCircleIcon className="size-[15px] shrink-0 max-md:hidden" />
                <span className="min-w-0">{error.error ?? `Answered ${error.status}`}</span>
                <StatusCode code={error.status} />
              </span>
              <span className="flex flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-3 max-md:text-[12.5px]">
                <span title={exactTime(error.at)}>{exactTime(error.at)}</span>
                <span className="font-mono text-[11px]">
                  {error.repo ? `${error.repo} · ` : ""}
                  {error.event}
                </span>
                {error.status === 401 && (
                  <>
                    <span className="max-md:hidden">The webhook secret on GitHub differs from the server’s.</span>
                    <span className="md:hidden">the secret on GitHub differs from the server’s</span>
                  </>
                )}
              </span>
            </>
          ) : (
            <span className="text-[13px] text-ink-3">None</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function Projects({ keys }: { keys: string[] }) {
  if (!keys.length) return <span className={muted}>No project</span>;
  return keys.map((k) => <ProjectChip key={k} projectKey={k} className="mr-1 max-md:mr-0" />);
}

function RepoError({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-error">
      <WarningCircleIcon className="size-[13px] shrink-0" />
      {text}
    </span>
  );
}

function Repositories({ rows, now }: { rows: GithubRepoView[]; now: number }) {
  const phone = useIsPhone();
  const last = (r: GithubRepoView) => (r.lastDeliveryAt ? timeAgo(r.lastDeliveryAt, now) : "never");
  return (
    <SettingsSection id="github-repositories" title="Repositories" compact aside={<Count n={rows.length} />}>
      <div className={cn(box, "overflow-x-auto")}>
        {!rows.length ? (
          <p className="m-0 px-4 py-3 text-[13px] text-ink-3">No repository feeds this workspace yet.</p>
        ) : phone ? (
          rows.map((r) => (
            <div key={r.name} className={card}>
              <span className="flex items-center gap-2 text-[14px]">
                <span className="min-w-0 truncate font-mono text-[12.5px] text-ink">{r.name}</span>
                <OnOff on={r.enabled} label={r.enabled ? "On" : "Off"} className="ml-auto text-ink-2" />
              </span>
              <span className={cardMeta}>
                <Projects keys={r.projects} />
                <span className="font-mono text-[11.5px]">{r.defaultBranch}</span>
                <span>{last(r)}</span>
              </span>
              {r.error && <RepoError text={r.error} />}
            </div>
          ))
        ) : (
          <Table heads={["Repository", "Projects", "Default branch", "Enabled", "Last delivery", "Error"]}>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className={td}>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <GithubLogoIcon className="size-3.5 text-ink-3" />
                      <span className={cn(mono, "text-ink")}>{r.name}</span>
                    </span>
                  </td>
                  <td className={td}>
                    <Projects keys={r.projects} />
                  </td>
                  <td className={cn(td, mono, "whitespace-nowrap text-ink-2")}>{r.defaultBranch}</td>
                  <td className={td}>
                    <OnOff on={r.enabled} label={r.enabled ? "On" : "Off"} />
                  </td>
                  <td className={cn(td, muted)}>{last(r)}</td>
                  <td className={td}>{r.error ? <RepoError text={r.error} /> : <span className={muted}>—</span>}</td>
                </tr>
              ))}
          </Table>
        )}
      </div>
      <p className="m-0 text-[12px] text-ink-3 max-md:hidden">A repository is matched to projects by the issue keys it mentions. Off means its webhooks are received but ignored.</p>
    </SettingsSection>
  );
}

const CLOSES = (
  <span className="flex items-center gap-2 text-[12.5px] font-medium whitespace-nowrap">
    <GitMergeIcon className="size-3.5 text-success" />
    Links, closes on merge
  </span>
);
const LINKS = (
  <span className="flex items-center gap-2 text-[12.5px] font-medium whitespace-nowrap">
    <LinkedTag className="font-medium" />
    Links only
  </span>
);

const RULES: { text: string; example: string; result: ReactNode }[] = [
  { text: "Issue key in the branch name", example: "infra-246-rotate-keys", result: CLOSES },
  { text: "Issue key in the pull request title", example: "INFRA-246 Rotate keys", result: CLOSES },
  { text: "Fixes, Closes or Resolves in the description or a commit", example: "Fixes INFRA-246", result: CLOSES },
  { text: "Refs, or the key alone, in the description or a commit", example: "Refs INFRA-246", result: LINKS },
];

function Rules() {
  const phone = useIsPhone();
  return (
    <SettingsSection id="github-rules" title="How issues get linked" compact>
      <div className={box}>
        {phone ? (
          <>
            <div className={card}>
              <span className="text-[14px]">Key in the branch or PR title</span>
              <span className={cardMeta}>
                <span className={code}>infra-246-rotate-keys</span>links, closes on merge
              </span>
            </div>
            <div className={card}>
              <span className={code + " w-fit"}>Fixes INFRA-246</span>
              <span className={cardMeta}>Also Closes, Resolves: links, closes on merge</span>
            </div>
            <div className={card}>
              <span className="flex items-center gap-2">
                <span className={code}>Refs INFRA-246</span>
                <LinkedTag />
              </span>
              <span className={cardMeta}>Or the key alone: links only, the state stays</span>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] text-[13px]">
            {RULES.map((r) => (
              <div key={r.text} className="col-span-2 grid grid-cols-subgrid border-b border-rule-soft last:border-b-0">
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <span>{r.text}</span>
                  <span className={code}>{r.example}</span>
                </div>
                <div className="flex items-center px-4 py-2.5">{r.result}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="m-0 text-[12px] text-ink-3 max-md:hidden">“Closes” moves the issue to the project’s first Done state. A closed or reverted pull request does not reopen the issue.</p>
    </SettingsSection>
  );
}
