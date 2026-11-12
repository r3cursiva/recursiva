// Saved views (PLNR-74) over the socket. A view is not a log model: a member's private views must not reach the others,
// and the log and the snapshot go to every member alike. So the server answers each viewer with the shared views and
// their own, and sends a change to the people who can see the view (or could before it: they get its id as gone).
//
// Considered (2026-10-30): views as a snapshot model (like Attachment) put private views into everyone's snapshot; a
// model in the log plus per-viewer filtering is the guests' per-viewer snapshot work (PLNR-19), not built. The inbox
// marks (inbox.ts) already travel this way, per person and outside the log, so views follow them.
import { mayManage, type Role } from "@rsva/policy";
import { NAME_MAX } from "@rsva/schema/models";

/** A list or a board of issues; "home" is a project's home (home.ts, ADR 0053), kept as a view but never shown as one. */
export const VIEW_LAYOUTS = ["list", "board", "home"] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];
export const isHome = (v: Pick<SavedView, "layout">): boolean => v.layout === "home";

/** Icons a view may have: Phosphor names the client maps to components (one short list, so the bundle stays small). */
export const VIEW_ICONS = ["stack", "eye", "robot", "flag", "tag", "warning", "calendar", "clock", "star", "user", "lightning", "bug"] as const;
export type ViewIcon = (typeof VIEW_ICONS)[number];

/** Longest query text of a view, and the most bytes its display options take as JSON. */
export const VIEW_QUERY_MAX = 2000;
export const VIEW_DISPLAY_MAX = 2048;
/** A home's display holds its widgets (home.ts): up to 24 of them, each with a query. */
export const HOME_DISPLAY_MAX = 8192;
export const VIEW_NAME_MAX = NAME_MAX;
/** Most project ids a person's order holds. */
export const PROJECT_ORDER_MAX = 1000;
/** Most things a person pins to their sidebar (PLNR-292). */
export const PINS_MAX = 100;
/** Most groups of projects a person makes in their sidebar, and the longest name of one (RSVA-566). */
export const GROUPS_MAX = 50;
export const GROUP_NAME_MAX = 60;

/** A group of projects in the viewer's sidebar (RSVA-566): its own name, its projects, folded or open. */
export interface ProjectGroup {
  id: string;
  name: string;
  /** Its projects; a project is in one group at most. Their order is the viewer's order of projects. */
  ids: string[];
  folded?: true;
}

/**
 * The viewer's grouping of their sidebar, written whole. `keep`: projects never folded into Quiet. `quiet`: projects
 * the viewer marked quiet, each with the time: it stays quiet until something changes in it after that. After how
 * many days Quiet takes a project by itself is the person's own setting (`UiChoice.quiet`, Settings › Preferences).
 */
export interface SidebarGroups {
  groups: ProjectGroup[];
  keep: string[];
  quiet: [string, string][];
}

export const NO_GROUPS: SidebarGroups = { groups: [], keep: [], quiet: [] };

/** What the sidebar's Pinned section holds: a saved view, an issue or a cycle, by id. */
export const PIN_KINDS = ["view", "issue", "cycle"] as const;
export type PinKind = (typeof PIN_KINDS)[number];
/** One pin as stored and sent: `view:<id>`, `issue:<id>`, `cycle:<id>`. */
export type PinRef = `${PinKind}:${string}`;
export const pinRef = (kind: PinKind, id: string): PinRef => `${kind}:${id}`;

/**
 * A saved view as a viewer receives it: a query over the whole workspace, a project being one of its filters. `display`
 * is DisplayOptions of packages/query, filled in by the client. With `tab` it is a tab in each project its query names
 * with `project:`, in `position` order.
 */
export interface SavedView {
  id: string;
  ownerId: string;
  name: string;
  icon: ViewIcon;
  query: string;
  display: Record<string, unknown>;
  layout: ViewLayout;
  shared: boolean;
  tab: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** What a client sends to create a view (a new id) or change one (the fields it changes). */
export type ViewFields = Pick<SavedView, "name" | "icon" | "query" | "display" | "layout" | "shared" | "tab" | "position">;
export type ViewWrite =
  | { op: "save"; id: string; set: Partial<ViewFields> }
  | { op: "delete"; id: string }
  /** A client before PLNR-292 keeps a view in its sidebar or not; the server puts it in or out of `pins`. */
  | { op: "pin"; id: string; pinned: boolean }
  /** The viewer's own order of the workspace's projects (ADR 0020), whole: it travels with the pins, as theirs alone. */
  | { op: "order"; ids: string[] }
  /** The viewer's Pinned section, whole and in order (PLNR-292). */
  | { op: "pins"; refs: PinRef[] }
  /** The projects the viewer took out of their sidebar, whole. */
  | { op: "hidden"; ids: string[] }
  /** The viewer's groups of projects and their Quiet choices, whole (RSVA-566). */
  | { op: "groups"; groups: SidebarGroups };

/** Who may change or delete a view: its owner; a shared one also an admin. Anyone may pin what they see. */
export function mayEditView(view: Pick<SavedView, "ownerId" | "shared">, me: string, role: Role | null): boolean {
  return role !== null && role !== "guest" && (view.ownerId === me || (view.shared && mayManage(role)));
}

// ── Frames ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Client → server: every view the viewer sees (no `at`), or only what changed after `at`. */
export interface ViewsRequestFrame {
  t: "views";
  at?: string;
}

/** Client → server: one change. The server answers with a `views` frame to everyone it concerns, or a `rej` "view". */
export interface ViewWriteFrame {
  t: "view";
  w: ViewWrite;
}

/**
 * Server → client: views to put in place, ids that are gone (deleted, or no longer visible to this viewer), and the
 * viewer's pins. `full`: the whole set, the client drops what is not in it. `at`: the latest change it covers.
 */
export interface ViewsFrame {
  t: "views";
  full?: true;
  v: SavedView[];
  gone: string[];
  /** For a client before PLNR-292: [view id, pinned] of the views in `s`, when `full` or when one was pinned or unpinned. */
  p: [string, boolean][];
  /** The viewer's order of projects: when `full`, and when it changed. */
  o?: string[];
  /** The viewer's Pinned section: when `full`, and when it changed. */
  s?: PinRef[];
  /** The projects the viewer hid from their sidebar: when `full`, and when it changed. */
  h?: string[];
  /** The viewer's groups of projects: when `full`, and when they changed. */
  g?: SidebarGroups;
  at: string | null;
}
