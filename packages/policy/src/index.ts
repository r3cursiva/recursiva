// Who may do what in a workspace: one table for the server, which enforces it on every request, delta subscription and
// transaction, and for the browser, which uses it only to decide what to offer. docs/decisions/0009-sign-in.md.
//
// A viewer is a member's role and what the workspace opened to members (MEMBER_RIGHTS), plus, for a request made with an
// API token, the token's scope. Guests can do nothing yet: a guest sees only their own issues, which needs per-viewer
// snapshots and deltas (the plan's p:{id}:own:{user} group), and until that exists the safe answer is no access rather
// than the whole workspace. ADR 0037: tokens after Stripe's restricted keys, member rights after Linear's team permissions.

export const ROLES = ["guest", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

/**
 * A token's access. read: GET only. write: everything the token's member may do, following the member's role.
 * custom: reads, plus the changes its grants allow (PLNR-271).
 */
export const SCOPES = ["read", "write", "custom"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * What a custom token may be allowed to change: Read or Write per resource, as Stripe's restricted keys (ADR 0037). Reads
 * stay workspace-wide: a member's snapshot is the whole workspace, and a narrower read needs per-viewer snapshots
 * (PLNR-19). Managing members and tokens is never a grant: people manage people, and a token that could make tokens
 * could widen itself.
 */
export const GRANTS = ["issues.write", "comments.write", "cycles.write", "views.write", "labels.write", "states.write", "projects.write", "workspace.write"] as const;
export type Grant = (typeof GRANTS)[number];

/** A grant as screens, the CLI and refusals name it. */
export const GRANT_NAMES: Record<Grant, string> = {
  "issues.write": "Issues: write",
  "comments.write": "Comments: write",
  "cycles.write": "Cycles: write",
  "views.write": "Views: write",
  "labels.write": "Labels: write",
  "states.write": "States: write",
  "projects.write": "Projects: write",
  "workspace.write": "Workspace: write",
};

/**
 * What an admin may open to every member of the workspace, as Linear's team permissions ("team owners only" or "all
 * members"): labels, workflow states, projects. Agents are members, so this is also how an agent gets them; a token never
 * goes past its member's role (ADR 0037).
 */
export const MEMBER_RIGHTS = ["labels.write", "states.write", "projects.write"] as const;
export type MemberRight = (typeof MEMBER_RIGHTS)[number];

export interface Viewer {
  role: Role;
  /** Set for a request made with an API token; a browser session has no scope limit. */
  scope?: Scope;
  /** A custom token's grants as they hold now: the server narrows the stored ones by `tokenGrants`. */
  grants?: ReadonlySet<Grant>;
  /** The workspace's member rights (MEMBER_RIGHTS); none given reads as none opened. */
  rights?: readonly string[];
}

export type Capability =
  /** Open the workspace: snapshot, deltas, issue history, API reads. */
  | "read"
  /** Issues, comments, cycles, labels, states, projects and the workspace's name and color: see GRANTS. */
  | Grant
  /** API tokens for the workspace's agents (one's own tokens need only "read"). */
  | "agents.manage"
  /** Invites, members' roles, removing members. Leaving needs only "read". */
  | "members.manage";

const MIN_ROLE: Record<Capability, Role> = {
  read: "member",
  "issues.write": "member",
  "comments.write": "member",
  /** Cycles are planning, as in Plane: every member creates and completes them (PLNR-63). */
  "cycles.write": "member",
  /** Saved views: one's own, and the shared ones an admin manages (protocol, mayChangeView). */
  "views.write": "member",
  "labels.write": "admin",
  "states.write": "admin",
  "projects.write": "admin",
  "workspace.write": "admin",
  "agents.manage": "admin",
  "members.manage": "admin",
};

const rank = (r: Role) => ROLES.indexOf(r);

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
export const isScope = (v: unknown): v is Scope => typeof v === "string" && (SCOPES as readonly string[]).includes(v);
export const isGrant = (v: unknown): v is Grant => typeof v === "string" && (GRANTS as readonly string[]).includes(v);
const isMemberRight = (v: unknown): v is MemberRight => typeof v === "string" && (MEMBER_RIGHTS as readonly string[]).includes(v);

/** The lowest role that may do this in a workspace with these member rights. */
function minRole(cap: Capability, rights: readonly string[]): Role {
  return isMemberRight(cap) && rights?.includes(cap) ? "member" : MIN_ROLE[cap];
}

export function can(viewer: Viewer, cap: Capability): boolean {
  if (cap === "read") return rank(viewer.role) >= rank(MIN_ROLE.read);
  if (viewer.scope === "read") return false;
  if (viewer.scope === "custom") return rank(viewer.role) >= rank(MIN_ROLE.read) && (viewer.grants?.has(cap as Grant) ?? false);
  return rank(viewer.role) >= rank(minRole(cap, viewer.rights ?? []));
}

/** Why the viewer may not do this: the token's limit, or the role's. `what` finishes "a member cannot …". */
export function refusal(viewer: Viewer, cap: Capability, what: string): string {
  if (viewer.scope === "read") return "the token is read-only";
  if (viewer.scope === "custom" && isGrant(cap) && can({ role: viewer.role, rights: viewer.rights ?? [] }, cap)) return `the token lacks ${GRANT_NAMES[cap]}`;
  const open = isMemberRight(cap) && rank(viewer.role) >= rank("member") ? `; an admin can open ${GRANT_NAMES[cap].split(":")[0]} to members in Settings › Members` : "";
  return `a ${viewer.role} cannot ${what}${open}`;
}

/**
 * The grants a custom token holds now: the stored ones its member may have, by role and the workspace's member rights. A
 * token never goes past its member, an agent's included (an agent's role is at most member, capRole). Grants nobody may
 * hold are dropped, never kept.
 */
export function tokenGrants(stored: readonly string[], role: Role, rights: readonly string[]): Set<Grant> {
  return new Set(stored.filter((g): g is Grant => isGrant(g) && can({ role, rights }, g)));
}

/** What a token can change now, as grants: none for read, everything its member may do for write, the grants that hold for custom. */
export function tokenReach(scope: Scope, grants: readonly string[], role: Role, rights: readonly string[]): Set<Grant> {
  if (scope === "read") return new Set();
  if (scope === "write") return new Set(GRANTS.filter((g) => can({ role, rights }, g)));
  return tokenGrants(grants, role, rights);
}

/**
 * Whether changing a token's access from `was` to `to` lets it do anything it could not, now or later: a widening, which
 * needs a fresh sign-in and is mailed (ADR 0036, RSVA-507). Not judged by what it reaches today: write follows its
 * member, every capability their role allows, and grows with a promotion, rights opened to members or a grant added
 * later, so a change to write from anything else always widens, however many grants a custom token had (RSVA-606).
 * Otherwise read holds nothing and custom its stored grants: a grant it did not hold widens. Narrowing, and a change
 * that adds nothing, is not.
 */
export function widens(was: { scope: Scope; grants: readonly string[] }, to: { scope: Scope; grants: readonly string[] }): boolean {
  if (to.scope === "write") return was.scope !== "write";
  if (to.scope === "read" || was.scope === "write") return false;
  const held = new Set(was.scope === "custom" ? was.grants : []);
  return to.grants.some((g) => isGrant(g) && !held.has(g));
}

/** Grants a token of a member of this role may hold in a workspace with these member rights; the rest is refused. */
export function grantable(role: Role, rights: readonly string[]): Grant[] {
  return GRANTS.filter((g) => can({ role, rights }, g));
}

/**
 * What a transaction op needs, by model and kind of op. A model missing here is refused: an op added to the write
 * pipeline is forbidden to everyone until it gets a row, never allowed by default.
 */
const OP_CAPABILITY: Record<string, Capability> = {
  Issue: "issues.write",
  Document: "issues.write",
  Attachment: "issues.write",
  Comment: "comments.write",
  Reaction: "comments.write",
  Cycle: "cycles.write",
  Workspace: "workspace.write",
  Project: "projects.write",
  WorkflowState: "states.write",
  Label: "labels.write",
  /** A member's role or membership; the write pipeline adds the rules about the owner and oneself (sync/members.ts). */
  User: "members.manage",
};

function opCapability(op: unknown): Capability | null {
  const m = ((op ?? {}) as { m?: unknown }).m;
  return typeof m === "string" && Object.hasOwn(OP_CAPABILITY, m) ? OP_CAPABILITY[m]! : null;
}

/**
 * What only a signed-in admin changes, never a token or a member the workspace opened settings to: who may do what (the
 * workspace's member rights) and which states and labels only people set (a guard switched on when a state or label is
 * made is fine: it only takes away). These are the rules agents work under (ADR 0037).
 */
function rulesChange(op: { m?: unknown; op?: unknown; set?: unknown }): string | null {
  const set = (op.set ?? {}) as Record<string, unknown>;
  if (op.m === "Workspace" && set.memberRights !== undefined) return "member rights are set by a signed-in admin";
  if (op.m === "Workspace" && set.triagers !== undefined) return "who triages is set by a signed-in admin";
  if ((op.m === "WorkflowState" || op.m === "Label") && set.onlyPeople !== undefined && !(op.op === "create" && set.onlyPeople === true))
    return "Only people is switched by a signed-in admin";
  return null;
}

/** Projects these ops create: a state made for one of them in the same ops is its default workflow (newProjectOps). */
function newProjects(ops: unknown[]): Set<unknown> {
  return new Set(ops.flatMap((op) => (isOp(op) && op.m === "Project" && op.op === "create" ? [op.id] : [])));
}
const isOp = (op: unknown): op is { m?: unknown; op?: unknown; id?: unknown; set?: { projectId?: unknown } } => typeof op === "object" && op !== null;

/**
 * Why the viewer may not apply these ops, or null if every op is allowed. Ops are checked before validation. A project
 * comes with its states in the same transaction: those states are the project's creation, so Projects alone makes one
 * (a member the workspace opened projects to, or a token with Projects: write).
 */
export function deniedOps(viewer: Viewer, ops: unknown): string | null {
  if (!Array.isArray(ops)) return null; // the write pipeline rejects the shape
  const created = newProjects(ops);
  for (const op of ops) {
    const ofNew = isOp(op) && op.m === "WorkflowState" && op.op === "create" && created.has(op.set?.projectId);
    const cap = ofNew ? "projects.write" : opCapability(op);
    const m = (op as { m?: unknown } | null)?.m;
    if (!cap) return `changes to ${typeof m === "string" ? m : "this model"} are not allowed`;
    // People are managed by people: a token, even an admin's, neither changes roles nor removes members.
    if (cap === "members.manage" && viewer.scope) return "members are managed by a signed-in person, not a token";
    // Nothing brings back an issue deleted for good (RSVA-457): that is a person's step in the app, not a token's.
    if (isOp(op) && op.m === "Issue" && op.op === "delete" && viewer.scope) return "an issue is deleted permanently by a signed-in person, not a token";
    if (!can(viewer, cap)) return refusal(viewer, cap, `change ${String(m)}`);
    const rules = rulesChange(op as object);
    if (rules && (viewer.scope || !mayManage(viewer.role))) return rules;
  }
  return null;
}

/**
 * Admins and the owner: they manage what members made, shared saved views among them (PLNR-74), members and invites.
 * Takes a role as stored (a member row's text, or none): anything that is not a role manages nothing.
 */
export function mayManage(role: unknown): boolean {
  return isRole(role) && rank(role) >= rank("admin");
}

/**
 * Whether a member with this role (as stored, or none) may open their workspace, and so be listed it or told about it:
 * a guest may not yet, a row with no known role is no membership (the server's roleIn reads it as none).
 */
export function mayRead(role: unknown): boolean {
  return isRole(role) && can({ role }, "read");
}

/** The role an account of this kind gets for the one asked: an agent's is at most member, so it cannot change the rules agents work under. */
export function capRole(role: string, kind: string): string {
  return kind === "agent" && mayManage(role) ? "member" : role;
}

/** Deleting an issue, or restoring it from the trash: its creator, or an admin (Plane's rule). */
export function mayDeleteIssue(role: Role | null, isCreator: boolean): boolean {
  return role !== null && (isCreator ? can({ role }, "issues.write") : mayManage(role));
}

/**
 * A state or a label as the process rules read it (ADR 0037): its name, and whether only people set it. A state with
 * the switch on is one agents never move an issue into (Todo — "start this", Approved — "ship it" in the /tasks
 * process); a label with it on is one agents put on issues but never rename or delete (proposed, security, owner). The
 * switch is on the row, not a list of names: renaming a guarded state keeps it guarded.
 */
export interface Guarded {
  name: string;
  onlyPeople: boolean;
}

/** The names guarded where nobody chose otherwise: what the migration switched on, an import and a new project's Todo. */
export const PEOPLE_STATES: readonly string[] = ["Todo", "Approved"];
export const PEOPLE_LABELS: readonly string[] = ["proposed", "security", "owner"];

/** The label of a proposal, in any case: agents propose, people accept or decline. It means that only in Backlog (PLNR-125). */
export const isProposalLabel = (labelName: string): boolean => labelName.toLowerCase() === "proposed";

/** Letters of other scripts that look like the Latin ones of these names, and digits that pass for letters. */
const LOOKALIKES: Record<string, string> = { а: "a", е: "e", о: "o", р: "p", т: "t", в: "b", α: "a", ο: "o", ρ: "p", τ: "t", ν: "v", "0": "o" };

/**
 * What a name looks like, for comparing with the guarded names: compatibility forms folded (NFKC: fullwidth letters),
 * accents, invisible characters and spaces dropped, case folded, and lookalike letters of other scripts read as Latin,
 * so "Аpproved" with a Cyrillic А, "Todo\u200b" or "T o d o" is still Todo. Only agents are held to it.
 */
function skeleton(name: string): string {
  const folded = name.normalize("NFKC").normalize("NFKD").replace(/[\p{M}\p{Cf}\s]/gu, "").toLowerCase();
  return [...folded].map((c) => LOOKALIKES[c] ?? c).join("");
}

/** Whether a state or label of this name reads as one of these names, however it is written ("APPROVED", "todo ", "Тodo"). */
export function readsAs(name: string, names: Iterable<string>): string | null {
  const k = skeleton(name);
  for (const n of names) if (skeleton(n) === k) return n;
  return null;
}

/** Why an agent may not move an issue into this state, or null if it may. */
export function deniedState(kind: string, state: Guarded): string | null {
  return kind === "agent" && state.onlyPeople ? `agents cannot move issues to "${state.name}": people set this state` : null;
}

/**
 * Why an agent may not make this state its project's default or move it to another group, or null. Made the default, a
 * state only people set would take every issue made without a state (a person's quick add, a Telegram /new); moved to
 * another group, it would complete or reopen the issues in it.
 */
export function deniedStateUpdate(kind: string, state: Guarded): string | null {
  return kind === "agent" && state.onlyPeople ? `agents cannot make "${state.name}" the default state or move it to another group: people set it` : null;
}

/**
 * Who changes a state or a label, as the guards read it: an agent; a person who is not a signed-in admin (a member the
 * workspace opened labels or states to, or anyone's token, an admin's too); or a signed-in admin, who sets the guards.
 */
export type GuardActor = "agent" | "person" | "admin";

/**
 * Why this change to a state or a label is refused, or null. `before` is the row as it is (none for a create), `after`
 * its name and switch as the op leaves them (none for a delete), `guarded` the names of the workspace's guarded states
 * or labels.
 *
 * A guard comes off only by a signed-in admin: switched off (deniedOps), and the guarded row renamed or deleted, or an
 * unguarded row given a guarded one's name — else "delete Approved, make a new Approved" or "rename Approved away, make
 * a new Approved" would drop it. A new row made guarded may take such a name: it only takes away. Agents also name rows
 * from the agents' alphabet (an "Аpproved" with a Cyrillic А would look like the one people set).
 */
export function deniedGuardedChange(actor: GuardActor, what: "state" | "label", before: Guarded | undefined, after: Guarded | undefined, guarded: Iterable<string>): string | null {
  if (actor === "admin") return null;
  const subject = actor === "agent" ? "agents cannot" : "only a signed-in admin can";
  if (before?.onlyPeople && (!after || after.name !== before.name)) return `${subject} rename or delete the ${what} "${before.name}": only people change it`;
  if (!after || after.name === before?.name) return null;
  if (actor === "agent" && disguised(after.name)) return `agents name ${what}s with ASCII or Russian letters, digits and common punctuation, not mixed: "${after.name}"`;
  const like = after.onlyPeople ? null : readsAs(after.name, guarded);
  return like === null ? null : `${subject} name a ${what} "${after.name}" without Only people: it reads as "${like}", which only people set`;
}

/**
 * A name an agent could pass off as another. Agents name states from a fixed alphabet: ASCII letters, the Russian
 * alphabet, digits, spaces and common punctuation, and never Latin and Cyrillic in one name. Lookalikes live in many
 * scripts (Lisu and Cherokee have whole Latin-looking alphabets, Cyrillic has ԁ and ѵ outside the Russian letters),
 * so an allow-list is what closes them without a confusables table; the Russian letters alone cannot spell Todo or
 * Approved (no d, no v). People name states freely.
 */
function disguised(name: string): boolean {
  if (/[^A-Za-z0-9\u0410-\u044f\u0401\u0451 .,:;!?()'"&+\-/#_]/u.test(name)) return true;
  return /[A-Za-z]/.test(name) && /[\u0410-\u044f\u0401\u0451]/u.test(name);
}
