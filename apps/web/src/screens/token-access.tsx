// A token's access, for making a token and for changing one: Read, Write (what its member may do) or Custom, with Read or
// Write per resource, as Stripe's restricted keys (ADR 0037). Only what the server would accept is offered: `grantable`
// is the same rule it checks (packages/policy). Rows follow the notifications page's per-workspace rows: a name, then a
// quiet segmented choice.
import { grantable, type Grant } from "@rsva/policy";
import type { ApiTokenView, TokenAccess } from "@rsva/protocol";
import { Segmented } from "@rsva/ui/components/segmented";
import { changeScope, type Holder } from "../lib/token-access.ts";
import { ChoiceRow } from "./settings-fields.tsx";

type Scope = TokenAccess["scope"];

const SCOPES = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "custom", label: "Custom" },
] as const;
const SCOPE_HINT: Record<Scope, string> = {
  read: "Reads the workspace; changes nothing.",
  write: "Does what its member can do.",
  custom: "Reads the workspace; changes only what you pick.",
};
const LEVELS = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
] as const;

/** One row per resource, its Write grant; Read is every token's. */
const RESOURCES: readonly { name: string; hint?: string; write: Grant }[] = [
  { name: "Issues", hint: "fields, descriptions, links, files", write: "issues.write" },
  { name: "Comments", hint: "and reactions", write: "comments.write" },
  { name: "Cycles", write: "cycles.write" },
  { name: "Views", hint: "saved views", write: "views.write" },
  { name: "Labels", hint: "putting one on an issue is Issues", write: "labels.write" },
  { name: "States", write: "states.write" },
  { name: "Projects", hint: "a new one needs States too", write: "projects.write" },
  { name: "Workspace", hint: "name and color", write: "workspace.write" },
];

/** Resources these grants change: "Issues, Labels". */
const named = (grants: readonly string[]) => RESOURCES.filter((r) => grants.includes(r.write)).map((r) => r.name);

/** What the token may change now, in a few words: the row's access fact. */
export function accessSummary(t: Pick<ApiTokenView, "scope" | "held">): string {
  if (t.scope !== "custom") return t.scope === "write" ? "Write" : "Read";
  return `Custom: ${named(t.held).join(", ") || "reads only"}`;
}

/** Grants given that its member may not use now, in a few words; null when all hold. */
export function stoppedSummary(t: Pick<ApiTokenView, "scope" | "grants" | "held">): string | null {
  if (t.scope !== "custom") return null;
  const stopped = named(t.grants.filter((g) => !t.held.includes(g)));
  return stopped.length ? `${stopped.join(", ")} held back: its member may not change them here` : null;
}

export function AccessPicker({ value, onChange, holder }: { value: TokenAccess; onChange: (a: TokenAccess) => void; holder: Holder }) {
  const may = grantable(holder.role, holder.rights);
  const grants = value.grants ?? [];
  const rows = RESOURCES.filter((r) => may.includes(r.write));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Access" options={SCOPES} value={value.scope} onChange={(scope) => onChange(changeScope(value, scope, holder))} />
        <span className="text-xs text-ink-3">{SCOPE_HINT[value.scope]}</span>
      </div>
      {value.scope === "custom" && (
        <div role="group" aria-label="What it may change" className="rounded-lg border px-3 py-1">
          {rows.map((r) => (
            <ChoiceRow key={r.name} name={r.name} hint={r.hint}>
              <Segmented
                variant="quiet"
                label={r.name}
                options={LEVELS}
                value={grants.includes(r.write) ? "write" : "read"}
                onChange={(level) => onChange({ scope: "custom", grants: [...grants.filter((g) => g !== r.write), ...(level === "write" ? [r.write] : [])] })}
              />
            </ChoiceRow>
          ))}
        </div>
      )}
      {value.scope === "custom" && rows.length < RESOURCES.length && (
        <p className="m-0 text-xs text-ink-3">
          {named(RESOURCES.filter((r) => !rows.includes(r)).map((r) => r.write)).join(", ")}: beyond what its member may change. An admin opens labels, states and
          projects to members in Settings › Members.
        </p>
      )}
    </div>
  );
}
