// /new: create a workspace or join one you were invited to, after the "Create or join a workspace" artboard (ADR 0011).
// Three steps: name, address and color; the first projects (each gets Plane's default workflow); invites. Then the
// workspace opens with a full load, so the sidebar and its engine start with it.
//
// Changed from the artboard on the owner's decisions: projects instead of teams, no "What is it for?" (it only seeded
// team names), and Join lists the invites to you: workspaces are not found by email domain. Only the people the server
// lists create workspaces (RSVA_WORKSPACE_CREATORS, owner's decision 2026-10-29): for anyone else the page is Join
// alone, with a line saying why.
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import type { AssignableRole, TileColor } from "@rsva/schema/models";
import { NAME_MAX, PROJECT_KEY, WORKSPACE_SLUG, cleanName } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { EmailInput } from "@rsva/ui/components/email-input";
import { Input } from "@rsva/ui/components/input";
import { InputGroup, InputGroupInput, InputGroupText } from "@rsva/ui/components/input-group";
import { Label } from "@rsva/ui/components/label";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { Segmented } from "@rsva/ui/components/segmented";
import { TileColorPicker } from "@rsva/ui/components/tile-color-picker";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { keyFrom, latin } from "../lib/project-settings.ts";
import { navigateOnClick, paths } from "../router.ts";
import { workspacePath, workspaces } from "../workspaces.ts";
import { MyInvites } from "./no-workspace.tsx";
import { peopleApi } from "./people-api.ts";
import { fieldClass } from "./settings-fields.tsx";
import { ROLE_OPTIONS } from "./workspace-members.tsx";
import { errorText } from "@rsva/schema/util";
import { ErrorLine, useAction } from "./action.tsx";

/** "Мой отдел" → "moy-otdel": an address from a name, Cyrillic spelled out. */
const toSlug = (name: string) => latin(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");

const SUGGESTED = [
  { name: "Design", key: "DES" },
  { name: "Product", key: "PRD" },
  { name: "Support", key: "SUP" },
  { name: "Infrastructure", key: "INF" },
];
const STEPS = ["Name", "Projects", "Invite"] as const;

interface Draft {
  name: string;
  slug: string;
  slugEdited: boolean;
  color: TileColor | null;
  projects: { name: string; key: string; keyEdited?: boolean }[];
  emails: string[];
  role: AssignableRole;
}

export const CreateWorkspace = observer(function CreateWorkspace() {
  const [mode, setMode] = useState<"create" | "join">("create");
  // The saved answer shows at once; the server's settles it (a list changed since the last sign-in).
  useEffect(() => void peopleApi.me().catch(() => {}), []);
  if (!workspaces.mayCreate) return <JoinOnly />;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-y-auto bg-ground px-4 py-12">
      <section aria-labelledby="new-ws-h" className="flex w-[560px] max-w-full flex-col rounded-xl border bg-panel shadow-pop">
        <h1 id="new-ws-h" className="sr-only">
          Create or join a workspace
        </h1>
        <div className="flex items-center gap-3 px-5 pt-4">
          <Segmented<"create" | "join">
            label="Mode"
            variant="quiet"
            fill
            options={[
              { value: "create", label: "Create new" },
              { value: "join", label: "Join existing" },
            ]}
            value={mode}
            onChange={setMode}
            className="w-[226px] gap-0 rounded-lg [&>button]:h-7 [&>button]:rounded-md [&>button]:text-[13px] [&>button]:font-medium [&>button]:text-ink-3 [&>button]:duration-200 [&>button]:aria-checked:shadow-xs max-md:[&>button]:text-[14px]"
          />
          <CloseLink />
        </div>
        {mode === "create" ? <Create /> : <div className="p-5"><MyInvites /></div>}
      </section>
    </main>
  );
});

/** /new for someone who may not create workspaces: why, then the invites to them and the link field. */
function JoinOnly() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-y-auto bg-ground px-4 py-12">
      <section aria-labelledby="join-ws-h" className="flex w-[560px] max-w-full flex-col gap-4 rounded-xl border bg-panel p-5 shadow-pop">
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-1">
            <h1 id="join-ws-h" className="m-0 text-[15px] font-semibold">
              Join a workspace
            </h1>
            <p className="m-0 text-label text-ink-2">New workspaces are made by this server's admins. Ask one for a workspace, or join one you were invited to.</p>
          </div>
          <CloseLink />
        </div>
        <MyInvites />
      </section>
    </main>
  );
}

/** Back where the person came from, or to their first workspace. */
function CloseLink() {
  const href = workspaces.list?.[0] ? workspacePath(workspaces.list[0].slug) : "/";
  return (
    <Button
      variant="ghost"
      size="icon"
      nativeButton={false}
      role="link"
      render={<a href={href} aria-label="Close" onClick={(e) => (history.length > 1 ? (e.preventDefault(), history.back()) : navigateOnClick(e, href))} />}
      className="ml-auto size-[30px] rounded-md border-0 active:scale-100! max-md:size-10 max-md:rounded-md"
    >
      <XIcon className="size-3.5" />
    </Button>
  );
}

function Create() {
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>({ name: "", slug: "", slugEdited: false, color: null, projects: [{ name: "Engineering", key: "ENG" }], emails: [], role: "member" });
  const [slugState, setSlugState] = useState<{ slug: string; ok: boolean; reason?: string } | null>(null);
  const [draftEmail, setDraftEmail] = useState(false);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<{ slug: string; invited: number; inviteError?: string } | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  // The address is checked as it is typed, a moment after the last key.
  useEffect(() => {
    if (!WORKSPACE_SLUG.test(d.slug)) return setSlugState(null);
    const t = setTimeout(() => {
      peopleApi.slug(d.slug).then(
        (r) => setSlugState({ slug: d.slug, ok: r.available, ...(r.reason ? { reason: r.reason } : {}) }),
        () => setSlugState(null),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [d.slug]);

  const slugOk = slugState?.slug === d.slug && slugState.ok;
  const keys = d.projects.map((p) => p.key);
  const projectsOk = d.projects.every((p) => cleanName(p.name) && PROJECT_KEY.test(p.key)) && new Set(keys).size === keys.length;
  const canNext = step === 0 ? cleanName(d.name) !== "" && slugOk : step === 1 ? projectsOk : !draftEmail;

  const create = () =>
    run(async () => {
      const { slug } = await peopleApi.create({ name: cleanName(d.name), slug: d.slug, color: d.color, projects: d.projects.map(({ name, key }) => ({ name: cleanName(name), key })) });
      // The workspace exists from here on: an invite that fails is reported on the done screen, never by creating again.
      let invited = 0;
      let inviteError: string | undefined;
      if (d.emails.length)
        await peopleApi.invite(slug, d.emails, d.role).then(
          (r) => void (invited = r.invited.length),
          (e: unknown) => void (inviteError = `Invites not sent: ${errorText(e)}. Send them from Settings › Members.`),
        );
      await workspaces.load(); // the workspace menu shows it at once
      setDone({ slug, invited, ...(inviteError ? { inviteError } : {}) });
    });
  const next = () => {
    if (!canNext || busy) return;
    if (step < 2) setStep(step + 1);
    else void create();
  };

  const name = cleanName(d.name) || "Your workspace";
  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 px-7 pt-9 pb-7 text-center">
        <LetterTile name={name} tone={d.color ?? "ink"} className="size-[72px] animate-in rounded-[18px] text-3xl duration-500 ease-spring zoom-in-75" />
        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{name} is ready</h2>
          <p className="m-0 text-ink-2">It is in your workspace menu now.</p>
        </div>
        <div className="flex gap-5 font-mono text-xs text-ink-2">
          <span>
            {d.projects.length} {d.projects.length === 1 ? "project" : "projects"}
          </span>
          <span>
            {done.invited} {done.invited === 1 ? "invite" : "invites"}
          </span>
          <span>
            {location.host}/{done.slug}
          </span>
        </div>
        <ErrorLine error={done.inviteError} />
        <div className="mt-1.5 flex gap-2">
          <Button variant="outline" size="lg" onClick={() => location.assign(paths.workspaceSettings(done.slug))}>
            Workspace settings
          </Button>
          <Button size="lg" onClick={() => location.assign(`/${done.slug}/`)}>
            Open {name}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        next();
      }}
    >
      <div className="flex flex-col gap-2 px-5 pt-4">
        <ol className="m-0 flex list-none gap-[18px] p-0">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-1.5 text-[12.5px]", i <= step ? "text-ink" : "text-ink-3", i === step && "font-semibold")}>
              <span
                className={cn(
                  "grid size-[18px] place-items-center rounded-full border-[1.5px] font-mono text-[10px]",
                  i < step ? "border-ink bg-ink text-ground" : i === step ? "border-ink" : "border-rule-strong",
                )}
              >
                {i < step ? <CheckIcon weight="bold" className="size-2.5" /> : i + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
        <span aria-hidden className="relative h-0.5 overflow-hidden rounded-full bg-rule-soft">
          <span className="absolute inset-y-0 left-0 bg-ink transition-[width] duration-500 ease-spring" style={{ width: `${((step + 1) / 3) * 100}%` }} />
        </span>
      </div>

      <div key={step} className="flex animate-in flex-col gap-4 p-5 duration-300 fade-in-0 slide-in-from-right-4">
        {step === 0 && (
          <>
            <div className="flex items-center gap-3.5">
              <LetterTile name={name} tone={d.color ?? "ink"} className="size-[52px] rounded-[13px] text-[22px]" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 className="m-0 truncate text-xl font-semibold tracking-[-0.02em]">{name}</h2>
                <span className="truncate font-mono text-[11.5px] text-ink-3">
                  {location.host}/{d.slug || "your-workspace"}
                </span>
              </div>
            </div>
            <Field label="Workspace name" htmlFor="new-ws-name">
              <Input
                id="new-ws-name"
                autoFocus
                autoComplete="off"
                value={d.name}
                maxLength={NAME_MAX}
                placeholder="Company, team or project"
                onChange={(e) => set({ name: e.target.value, ...(d.slugEdited ? {} : { slug: toSlug(e.target.value) }) })}
                className={cn(fieldClass, "h-9 text-sm md:text-sm dark:bg-field")}
              />
            </Field>
            <Field label="Address" htmlFor="new-ws-slug">
              <InputGroup className={cn(fieldClass, "h-9 overflow-hidden p-0 has-[[data-slot=input-group-control]:focus-visible]:border-ink-3 dark:bg-field")}>
                <InputGroupText className="h-full border-r border-control-border bg-sidebar px-2.5 font-mono text-xs text-ink-3">{location.host}/</InputGroupText>
                <InputGroupInput
                  id="new-ws-slug"
                  autoComplete="off"
                  spellCheck={false}
                  value={d.slug}
                  aria-describedby="new-ws-slug-state"
                  onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32), slugEdited: true })}
                  className="h-full px-2.5 font-mono text-[12.5px] md:text-[12.5px] max-md:h-full max-md:px-2.5"
                />
              </InputGroup>
              <span id="new-ws-slug-state" role="status" className={cn("text-xs", slugOk ? "text-success" : slugState && slugState.slug === d.slug ? "text-signal-text" : "text-ink-3")}>
                {slugOk ? (
                  <span className="inline-flex items-center gap-1">
                    <CheckIcon weight="bold" className="size-3" />
                    Available
                  </span>
                ) : slugState && slugState.slug === d.slug ? slugState.reason : "Lower-case letters, digits and hyphens, 3 to 32."}
              </span>
            </Field>
            <Field label="Color">
              <TileColorPicker name={name} value={d.color} autoTone="ink" label="Workspace color" onChange={(color) => set({ color })} />
            </Field>
          </>
        )}

        {step === 1 && (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">Add your first projects</h2>
              <p className="m-0 text-[12.5px] text-ink-3">Each project has its own issues, statuses and labels. The key starts every issue ID, like ENG-1.</p>
            </div>
            {d.projects.length === 0 && <p className="m-0 rounded-[7px] border border-dashed p-3 text-[12.5px] text-ink-3">No projects yet. You can add them now or later.</p>}
            <div className="flex flex-col gap-1.5">
              {d.projects.map((p, i) => {
                const patch = (q: Partial<Draft["projects"][number]>) => set({ projects: d.projects.map((x, j) => (j === i ? { ...x, ...q } : x)) });
                const dup = keys.indexOf(p.key) !== i;
                return (
                  <div key={i} className="grid animate-in grid-cols-[minmax(0,1fr)_76px_64px_28px] items-center gap-2 fade-in-0">
                    <Input
                      aria-label="Project name"
                      value={p.name}
                      placeholder="Project name"
                      maxLength={NAME_MAX}
                      onChange={(e) => patch({ name: e.target.value, ...(p.keyEdited ? {} : { key: keyFrom(e.target.value) }) })}
                      className={cn(fieldClass, "md:text-[13.5px] dark:bg-field")}
                    />
                    <Input
                      aria-label="Project key"
                      value={p.key}
                      aria-invalid={(p.key !== "" && !PROJECT_KEY.test(p.key)) || dup || undefined}
                      onChange={(e) => patch({ key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12), keyEdited: true })}
                      className={cn(fieldClass, "text-center font-mono text-[12.5px] md:text-[12.5px] dark:bg-field aria-invalid:ring-0 aria-invalid:ring-ring aria-invalid:focus-visible:ring-2 dark:aria-invalid:border-signal-text dark:aria-invalid:ring-ring")}
                    />
                    <span className="truncate font-mono text-[11.5px] text-ink-3">{(p.key || "—") + "-1"}</span>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove project" onClick={() => set({ projects: d.projects.filter((_, j) => j !== i) })}>
                      <XIcon />
                    </Button>
                  </div>
                );
              })}
            </div>
            <Button type="button" variant="ghost" className="self-start" onClick={() => set({ projects: [...d.projects, { name: "", key: "" }] })}>
              + Add project
            </Button>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-rule-soft pt-3">
              <span className="mr-1 text-xs text-ink-3">Suggested</span>
              {SUGGESTED.filter((g) => !keys.includes(g.key))
                .slice(0, 3)
                .map((g) => (
                  <Button
                    key={g.key}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => set({ projects: [...d.projects, { ...g }] })}
                    className="h-[26px] rounded-md border-dashed border-rule-strong bg-transparent bg-clip-border text-xs font-normal active:scale-100! max-md:h-[26px] max-md:rounded-md max-md:px-2 max-md:text-xs"
                  >
                    + {g.name}
                    <span className="font-mono text-[10.5px] text-ink-3">{g.key}</span>
                  </Button>
                ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">Invite people</h2>
              <p className="m-0 text-[12.5px] text-ink-3">Paste emails separated by commas, or press Enter after each. You can skip this and invite later.</p>
            </div>
            <Label htmlFor="new-ws-invites" className="sr-only">
              Emails
            </Label>
            <EmailInput id="new-ws-invites" value={d.emails} onChange={(emails) => set({ emails })} onDraftChange={setDraftEmail} />
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[12.5px] text-ink-2">Invite as</span>
              <Segmented label="Role" options={ROLE_OPTIONS} value={d.role} onChange={(role) => set({ role })} />
            </div>
            <p className="m-0 text-xs text-ink-3">Each person gets an email with a link that works for 7 days.</p>
          </>
        )}
        <ErrorLine error={error} />
      </div>

      <div className="flex items-center gap-2.5 border-t border-rule-soft px-5 pt-3.5 pb-[18px]">
        {step > 0 && (
          <Button type="button" variant="ghost" size="lg" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-3">{step + 1} of 3</span>
        <Button type="submit" size="lg" disabled={!canNext || busy}>
          {step < 2 ? "Continue" : d.emails.length ? `Create and send ${d.emails.length} ${d.emails.length === 1 ? "invite" : "invites"}` : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="font-medium">
          {label}
        </label>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      {children}
    </div>
  );
}
