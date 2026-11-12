// The commands: each is a thin call of the agent API (docs/agents-api.md). Names, keys and refusals are the server's, so
// nothing here knows a state, a label or a rule. A value of "none" clears a field, as `cycle:none` means no cycle.
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import { ApiError, Client, failure, NetworkError, SESSION_SERVICE, UsageError, type Query } from "@rsva/terminal/client";
import { MY_WORK, STATE_GROUPS, type IssueRow } from "@rsva/terminal/issues";
import { scratchFile } from "@rsva/terminal/programs";
import { plural } from "@rsva/schema/util";
import { clean, escaped, plain } from "@rsva/terminal/text";
import { MOVE_WORDS, ORDER_WORDS, PRIORITY_WORDS, quoted, RELATION_WORDS, zsh, type Completable } from "./completion.ts";
import {
  commentList,
  cycleCard,
  cycleList,
  handle,
  inboxList,
  issueCard,
  issueList,
  labelList,
  memberList,
  projectCard,
  projectList,
  similarLine,
  stateList,
  viewList,
  workspaceCard,
  type CommentRow,
  type CycleRow,
  type InboxLine,
  type IssueFull,
  type LabelRow,
  type Links,
  type MemberRow,
  type ProjectFull,
  type ProjectRow,
  type SimilarRow,
  type StateRow,
  type ViewRow,
  type WorkspaceInfo,
} from "./format.ts";
import { styleFor, type Style, type Terminal } from "./style.ts";

export interface Io {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  /** What `-` stands for: the text on stdin. */
  stdin(): Promise<string>;
  /** Set when the output is a terminal: a person may be reading it. */
  terminal?: Terminal | undefined;
  /** Errors go to a terminal. */
  errTerminal?: boolean;
  /** Output taller than the window, for a person: through a pager. */
  page?(text: string): Promise<void>;
  /** Opens a URL in the browser: false when nothing could. */
  open?(url: string): Promise<boolean>;
  /** Opens a file in the person's editor and waits for it: the editor's exit code. */
  edit?(file: string): Promise<number>;
  /** Runs the TUI (apps/tui) on this terminal until the person quits: its exit code. */
  tui?(): Promise<number>;
  /** A line typed at the terminal after the prompt; missing when stdin is not a terminal. */
  ask?: ((prompt: string) => Promise<string>) | undefined;
  /** Where `rsva login` keeps the session: the macOS Keychain. Missing elsewhere. `read` is null when it keeps none. */
  keychain?: { read(service: string): Promise<string | null>; write(service: string, account: string, secret: string): Promise<void>; remove(service: string): Promise<boolean> } | undefined;
  /** Deletes the TUI's copies made with a credential (copies.ts), at `rsva logout`. */
  copies?: ((authorization: string) => Promise<void>) | undefined;
}

/** A flag: `boolean` takes no value, `multiple` gathers every one given, `values` are what Tab offers after it. */
interface FlagSpec {
  short?: string;
  boolean?: true;
  multiple?: true;
  values?: readonly string[];
}

const FLAGS = {
  project: { short: "p" },
  json: { boolean: true },
  help: { short: "h", boolean: true },
  plain: { boolean: true },
  color: { boolean: true },
  view: {},
  order: { values: ORDER_WORDS },
  limit: {},
  title: {},
  name: {},
  state: { short: "s" },
  priority: { values: PRIORITY_WORDS },
  label: { multiple: true },
  assignee: { multiple: true },
  "add-label": { multiple: true },
  "remove-label": { multiple: true },
  "add-assignee": { multiple: true },
  "remove-assignee": { multiple: true },
  delegate: {},
  parent: {},
  cycle: {},
  start: {},
  end: {},
  due: {},
  description: { short: "d" },
  lead: {},
  "move-to": { values: MOVE_WORDS },
  keep: { multiple: true },
  all: { boolean: true },
  until: {},
  "reply-to": {},
  edit: {},
  key: {},
  hue: {},
  rollover: { values: ["on", "off"] },
  group: { values: STATE_GROUPS },
  before: {},
  after: {},
  default: { boolean: true },
  force: { boolean: true },
  to: {},
  "sub-issues": { boolean: true },
} as const satisfies Record<string, FlagSpec>;

type Flag = keyof typeof FLAGS;
type Values = { [K in Flag]?: (typeof FLAGS)[K] extends { multiple: true } ? string[] : (typeof FLAGS)[K] extends { boolean: true } ? boolean : string };

interface Ctx {
  /** Made on first use: help, completion and a mistake in the call need no server. */
  readonly api: Client;
  args: string[];
  v: Values;
  io: Io;
  style: Style;
}

interface Command {
  /** The arguments, as the help shows them; `<x>` is required, `[x]` is not, `[x...]` takes the rest. */
  args: string;
  /** The flags, as the help shows them: the command takes these and no others. */
  flags?: string;
  about: string;
  /** No answer of the server to give: --json is refused, not ignored. */
  json?: false;
  /** What Tab offers for each argument, by position. */
  complete?: readonly (readonly string[] | undefined)[];
  run(c: Ctx): Promise<string>;
}

/** Commands under one word: `cycle show`, `cycle create`… */
interface Group {
  about: string;
  commands: Record<string, Command>;
}

/** The most issues one answer holds (api.ts). */
const LIMIT_MAX = 500;

/** A given value as the API takes it: "none" is null, "-" the text on stdin. */
const clearable = (v: string | undefined) => (v === undefined ? undefined : v === "none" ? null : v);
const onOff = (v: string | undefined): boolean | undefined => {
  if (v !== undefined && v !== "on" && v !== "off") throw new UsageError(`on or off, not ${v}`);
  return v === undefined ? undefined : v === "on";
};
const text = async (c: Ctx, v: string | undefined) => (v === "-" ? (await c.io.stdin()).trimEnd() : v);
/** Descriptions clear to an empty text, not to null. */
const description = (c: Ctx) => (c.v.description === "none" ? "" : text(c, c.v.description));

const project = (c: Ctx): string => {
  const p = c.v.project ?? c.io.env.RSVA_PROJECT;
  if (!p) throw new UsageError("which project? -p KEY, or set RSVA_PROJECT");
  return p;
};

/** `--label none` empties a list: "none" is no label's name, as it is no cycle's. */
const clearableList = (v: string[] | undefined) => (v?.length === 1 && v[0] === "none" ? [] : v);

const given = (b: Record<string, unknown>) => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));

/** A change with nothing in it is a mistake in the call: refused before it is sent. */
const changes = (body: Record<string, unknown>, name: string) => {
  if (!Object.keys(body).length) throw new UsageError(`${name}: nothing to change; rsva help ${name} lists the fields`);
  return body;
};

async function issueBody(c: Ctx): Promise<Record<string, unknown>> {
  const { v } = c;
  return given({
    title: v.title,
    state: v.state,
    priority: v.priority,
    labels: clearableList(v.label),
    assignees: clearableList(v.assignee),
    delegate: clearable(v.delegate),
    parent: clearable(v.parent),
    cycle: clearable(v.cycle),
    startDate: clearable(v.start),
    dueDate: clearable(v.due),
    description: await description(c),
  });
}

async function cycleBody(c: Ctx): Promise<Record<string, unknown>> {
  const { v } = c;
  return given({ name: v.name, startDate: clearable(v.start), endDate: clearable(v.end), lead: clearable(v.lead), description: await description(c) });
}

const key = (c: Ctx, i = 0) => c.args[i]!.toUpperCase();
const issuePath = (c: Ctx, tail = "") => `/issues/${encodeURIComponent(key(c))}${tail}`;
const cyclePath = (c: Ctx, tail = "") => `/cycles/${encodeURIComponent(c.args[0]!)}${tail}`;
const inProject = (c: Ctx) => ({ project: project(c) });

/** An id as the server makes them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON in one line for a pipe or an agent, which pay for every byte; indented for a person. Escaped either way. */
const json = (c: Ctx, data: unknown) => escaped(JSON.stringify(data, null, c.style.on ? 2 : undefined));

/**
 * A command's answer: --json as it came, otherwise the text. In colour the data is cleaned before it is drawn, since the
 * colour itself must reach the terminal; plain text is cleaned whole, as before.
 */
const shown = <T>(c: Ctx, data: T, render: (d: T) => string) => (c.v.json ? json(c, data) : c.style.on ? render(clean(data)) : plain(render(data)));

/** A write that went through. In colour, a tick before it; the words come from the call, so they are cleaned here. */
const done = (c: Ctx, text: string) => (c.style.on ? `${c.style.green("✓")} ${plain(text)}` : text);

/** A write: the answer as JSON with --json, else the words that say it went through, from the answer when they need it. */
const wrote = async <T>(c: Ctx, answer: T | Promise<T>, says: string | ((d: T) => string)) => shown(c, await answer, (d) => done(c, typeof says === "string" ? says : says(d)));

const links = (c: Ctx): Links => ({ issue: (k) => c.api.browse(k), url: (h) => c.api.resolve(h) });

interface IssueList {
  total: number;
  issues: IssueRow[];
}

const limit = (v: string | undefined) => {
  if (v !== undefined && !(/^\d+$/.test(v) && +v >= 1 && +v <= LIMIT_MAX)) throw new UsageError(`--limit: a whole number from 1 to ${LIMIT_MAX}`);
  return v;
};

/** A list of issues: the query given, after `base` when there is one. */
async function issueQuery(c: Ctx, base?: string) {
  const { view, order } = c.v;
  // `my` is every project unless -p says otherwise: RSVA_PROJECT would narrow it without a word.
  const p = c.v.project ?? (base ? undefined : c.io.env.RSVA_PROJECT);
  const q = [base, ...c.args].filter(Boolean).join(" ") || undefined;
  const data = await c.api.request<IssueList>("GET", "/issues", { query: { project: p, q, view, order, limit: limit(c.v.limit) } });
  const more = data.issues.length < LIMIT_MAX ? "more with --limit" : `${LIMIT_MAX} at most: narrow the query`;
  return shown(c, data, (d) => issueList(d.issues, d.total, c.style, links(c), more));
}

/**
 * The description in the person's editor. The text is read again before it is written: an edit made meanwhile, in the
 * app or by an agent, is not overwritten, and the person's text stays in the file.
 */
async function editDescription(c: Ctx): Promise<string> {
  if (!c.io.edit || !c.io.terminal) throw new UsageError("edit needs a terminal; update KEY -d - takes the text on stdin");
  const read = async () => (await c.api.request<IssueFull>("GET", issuePath(c))).description;
  const before = await read();
  const file = scratchFile(key(c).replace(/[^A-Z0-9-]/g, "_"), before ? `${before}\n` : "", c.io.env);
  const code = await c.io.edit(file);
  const after = (await readFile(file, "utf8")).trimEnd();
  if (code !== 0) throw new UsageError(`the editor ended with ${code}: nothing saved, the text is in ${file}`);
  if (after === before.trimEnd()) {
    await rm(file);
    return done(c, `no change to ${key(c)}`);
  }
  if ((await read()) !== before) throw new ApiError(`the description of ${key(c)} changed while you edited: nothing saved, your text is in ${file}`, 409);
  await c.api.request("PATCH", issuePath(c), { body: { description: after } });
  await rm(file);
  return done(c, `updated the description of ${key(c)}`);
}

/** A comment's id, or its handle as `comments` shows it, found on the newest page; `what` names it in a mistake. */
async function commentOf(c: Ctx, ref: string, what: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const { comments } = await c.api.request<{ comments: CommentRow[] }>("GET", issuePath(c, "/comments"));
  const hits = comments.filter((x) => handle(x.id) === ref.toLowerCase());
  if (hits.length !== 1) throw new UsageError(`${what} ${ref}: ${hits.length ? "more than one comment" : "no comment"} with that handle on the newest page of ${key(c)}; the full id is in rsva comments ${key(c)} --json`);
  return hits[0]!.id;
}

/** The newest page of an issue's comments, or the one before `--until`. */
const commentPage = (c: Ctx) => c.api.request<{ comments: CommentRow[]; older: string | null }>("GET", issuePath(c, "/comments"), { query: { until: c.v.until } });

/** How to read the page before, when there is one: from the cleaned answer, quoted for the shell, a command to paste. */
const olderPage = (c: Ctx, older: string | null) => (older ? `rsva comments ${plain(key(c))} --until ${quoted(older)}` : undefined);

/** `unlink` and `detach`: a link's or file's id, or what `show` prints of it: a link's address, a file's name. */
async function attachmentOf(c: Ctx, kind: "links" | "files"): Promise<string> {
  const target = c.args[1]!;
  if (UUID.test(target)) return target;
  const issue = await c.api.request<IssueFull>("GET", issuePath(c));
  const hits = kind === "links" ? issue.links.filter((l) => l.url === target) : issue.files.filter((f) => f.name === target);
  const one = kind === "links" ? "link" : "file";
  if (hits.length !== 1) throw new UsageError(hits.length ? `${hits.length} ${kind} ${target} on ${key(c)}: give the id, from rsva show ${key(c)} --json` : `no ${one} ${target} on ${key(c)}`);
  return hits[0]!.id;
}

/** File types by extension, for the upload's Content-Type. Images are left out: the server takes an image type only from the bytes. */
const FILE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

/** `attach`: the file's bytes go up under their SHA-256 (a file the workspace has is not stored twice), then onto the issue. */
async function attach(c: Ctx): Promise<string> {
  const path = c.args[1]!;
  const bytes = await readFile(path).catch(() => {
    throw new UsageError(`cannot read ${path}`);
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = c.v.name ?? basename(path);
  await c.api.upload(sha256, bytes, FILE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
  return wrote(c, c.api.request("POST", issuePath(c, "/files"), { body: { sha256, name } }), `attached ${name} to ${key(c)}`);
}

/** A 409 "similar" (PLNR-295) says which issues the new one looks like and how to create it anyway; any other error goes on. */
function refusedAsSimilar(e: unknown): never {
  const similar = e instanceof ApiError && e.status === 409 ? (e.body as { error?: string; similar?: SimilarRow[] } | null) : null;
  if (!similar || similar.error !== "similar" || !similar.similar?.length) throw e;
  throw new ApiError(`not created: it looks like an open issue\n${similar.similar.map(similarLine).join("\n")}\nRerun with --force to create it anyway.`, 409);
}

const ISSUE_FLAGS = "[-s STATE] [--priority P] [--label L]... [--assignee A]... [--delegate A] [--parent KEY] [--cycle C] [--start D] [--due D] [-d TEXT|-]";

const issueCommands: Record<string, Command> = {
  issues: {
    args: "[query...]",
    flags: "[-p KEY] [--view NAME] [--order FIELD] [--limit N]",
    about: `list; the query is the language of the app's / field: state:"In Review" label:bug -label:security cycle:active parent:INFRA-300 is:blocked has:link order:priority text; ${LIMIT_MAX} at most`,
    run: (c) => issueQuery(c),
  },
  my: {
    args: "[query...]",
    flags: "[-p KEY] [--order FIELD] [--limit N]",
    about: "open issues assigned to the token's person, every project; a query narrows it. The agent token's person is the agent: yours need your own token",
    run: (c) => issueQuery(c, MY_WORK),
  },
  show: {
    args: "<key>",
    about: "one issue with its description and the newest page of its comments; a deleted or archived one says so",
    async run(c) {
      // The comments too: a comment can change what the description asks, and an agent that read only the description
      // missed one (PLNR-272). Both requests at once, so they cost no wait; a failure of the issue's is the one reported.
      const comments = commentPage(c);
      comments.catch(() => {});
      const issue = await c.api.request<IssueFull>("GET", issuePath(c));
      const { comments: rows, older } = await comments;
      return shown(c, { ...issue, comments: rows, olderComments: older }, (d) =>
        [issueCard(d, c.style, links(c)).trimEnd(), c.style.on ? c.style.bold("Comments") : "comments:", commentList(d.comments, olderPage(c, d.olderComments), c.style, links(c))].join("\n\n"),
      );
    },
  },
  open: {
    args: "<key>",
    about: "the issue in the browser; where nothing can open it, its address",
    json: false,
    async run(c) {
      await c.api.workspaceSlug();
      const url = c.api.browse(key(c));
      return c.style.on && c.io.open && (await c.io.open(url)) ? done(c, `opened ${key(c)}`) : url;
    },
  },
  edit: {
    args: "<key>",
    about: "the description in $VISUAL or $EDITOR, saved when it changed; refused if it changed on the server meanwhile",
    json: false,
    run: editDescription,
  },
  create: {
    args: "<title>",
    flags: `[-p KEY] ${ISSUE_FLAGS} [--force]`,
    about: "new issue; open issues that look like it go to stderr, and a strong match refuses it unless --force",
    async run(c) {
      const body = { ...(await issueBody(c)), project: project(c), title: c.args[0], ...(c.v.force ? { force: true } : {}) };
      const r = await c.api.request<{ key: string; similar?: SimilarRow[] }>("POST", "/issues", { body }).catch(refusedAsSimilar);
      // stdout stays the key, which scripts read; the matches are for whoever is watching. --json carries them in the answer.
      if (!c.v.json) for (const m of r.similar ?? []) c.io.err(plain(similarLine(m)));
      const s = c.style;
      return shown(c, r, (d) => (s.on ? `${s.green("✓")} created ${s.link(c.api.browse(d.key), d.key)}  ${s.gray(plain(c.args[0]!))}` : d.key));
    },
  },
  update: {
    args: "<key...>",
    flags: `[--title T] [-p KEY] ${ISSUE_FLAGS} [--add-label L]... [--remove-label L]... [--add-assignee A]... [--remove-assignee A]...`,
    about:
      "change the fields given, on one issue or many in one call; none clears a field, --label and --assignee replace the list, --add-… and --remove-… change each issue's own; -p moves one issue to that project, with -s, --label and --cycle of that project",
    async run(c) {
      const { v } = c;
      const lists = given({ addLabels: v["add-label"], removeLabels: v["remove-label"], addAssignees: v["add-assignee"], removeAssignees: v["remove-assignee"] });
      if (c.args.length === 1 && !Object.keys(lists).length) {
        // Only a -p given here moves the issue: RSVA_PROJECT is where new issues go, not a change.
        const body = changes({ ...(await issueBody(c)), ...given({ project: v.project }) }, "update");
        return wrote(c, c.api.request<{ key?: string }>("PATCH", issuePath(c), { body }), (d) => d.key ? `moved ${key(c)} to ${d.key}` : `updated ${key(c)}`);
      }
      if (v.project !== undefined) throw new UsageError("update: -p moves one issue; rsva move KEY... --to P moves many");
      const body = { keys: c.args.map((_, i) => key(c, i)), ...changes({ ...(await issueBody(c)), ...lists }, "update") };
      const r = await c.api.request<{ changed: number }>("PATCH", "/issues", { body });
      return wrote(c, r, (d) => d.changed ? `updated ${plural(d.changed, "issue")}` : "nothing to change: the issues have it already");
    },
  },
  move: {
    args: "<key...>",
    flags: "--to KEY [--sub-issues]",
    about: "to another project in one change, keeping history, comments, links and pull requests; each gets the next number there and its old key still finds it. State and labels go by name; the cycle is cleared. --sub-issues takes their sub-issues too",
    async run(c) {
      if (!c.v.to) throw new UsageError("move: which project? --to KEY");
      const body = { issues: c.args.map((a) => a.toUpperCase()), project: c.v.to, ...(c.v["sub-issues"] ? { subIssues: true } : {}) };
      const r = await c.api.request<{ moved: { key: string; was: string }[] }>("POST", "/issues/move", { body });
      return shown(c, r, (d) => (d.moved.length ? d.moved.map((m) => done(c, `${m.was} → ${m.key}`)).join("\n") : done(c, `nothing to move: already in ${c.v.to!.toUpperCase()}`)));
    },
  },
  archive: { args: "<key>", about: "to the archive; only finished or cancelled issues", run: async (c) => wrote(c, c.api.request("PATCH", issuePath(c), { body: { archived: true } }), `archived ${key(c)}`) },
  delete: { args: "<key>", about: "to the project's trash", run: async (c) => wrote(c, c.api.request("DELETE", issuePath(c)), `deleted ${key(c)}`) },
  restore: { args: "<key>", about: "out of the trash", run: async (c) => wrote(c, c.api.request("PATCH", issuePath(c), { body: { deleted: false } }), `restored ${key(c)}`) },
  comments: {
    args: "<key>",
    flags: "[--until T]",
    about: "the newest page of comments, a reply under its comment; the last line says how to read the page before",
    run: async (c) => shown(c, await commentPage(c), (x) => commentList(x.comments, olderPage(c, x.older), c.style, links(c))),
  },
  comment: {
    args: "<key> <text>",
    flags: "[--reply-to ID] [--edit ID]",
    about: "add a comment in Markdown; - reads it from stdin; --reply-to answers a comment, --edit replaces your own, by the handle comments shows",
    async run(c) {
      const { "reply-to": to, edit } = c.v;
      if (to !== undefined && edit !== undefined) throw new UsageError("comment: --reply-to or --edit, not both");
      const body = await text(c, c.args[1]);
      if (edit !== undefined) {
        const id = await commentOf(c, edit, "--edit");
        return wrote(c, c.api.request("PATCH", issuePath(c, `/comments/${id}`), { body: { body } }), `edited the comment on ${key(c)}`);
      }
      const parentId = to === undefined ? undefined : await commentOf(c, to, "--reply-to");
      return wrote(c, c.api.request("POST", issuePath(c, "/comments"), { body: given({ body, parentId }) }), `commented on ${key(c)}`);
    },
  },
  uncomment: {
    args: "<key> <id>",
    about: "delete your own comment, by the handle comments shows; its replies stay",
    async run(c) {
      const id = await commentOf(c, c.args[1]!, "uncomment");
      return wrote(c, c.api.request("DELETE", issuePath(c, `/comments/${id}`)), `deleted the comment on ${key(c)}`);
    },
  },
  link: {
    args: "<key> <url>",
    flags: "[--title T]",
    about: "attach a link; a GitHub PR or commit is recognised",
    run: async (c) => wrote(c, c.api.request("POST", issuePath(c, "/links"), { body: given({ url: c.args[1], title: c.v.title }) }), `linked ${key(c)}`),
  },
  unlink: {
    args: "<key> <url|id>",
    about: "remove a link, by its address as show prints it",
    run: async (c) => wrote(c, c.api.request("DELETE", issuePath(c, `/links/${encodeURIComponent(await attachmentOf(c, "links"))}`)), `unlinked ${key(c)}`),
  },
  attach: { args: "<key> <file>", flags: "[--name N]", about: "upload a file, 25 MiB at most, and attach it; --name is the name it shows", run: attach },
  detach: {
    args: "<key> <name|id>",
    about: "remove a file, by its name as show prints it; its bytes stay for a picture in the text",
    run: async (c) => wrote(c, c.api.request("DELETE", issuePath(c, `/files/${encodeURIComponent(await attachmentOf(c, "files"))}`)), `detached ${c.args[1]} from ${key(c)}`),
  },
  relate: {
    args: "<key> <type> <other>",
    about: `${RELATION_WORDS.slice(0, -1).join(", ")} or ${RELATION_WORDS.at(-1)}`,
    complete: [undefined, RELATION_WORDS],
    run: async (c) => wrote(c, c.api.request("POST", issuePath(c, "/relations"), { body: { type: c.args[1], issue: key(c, 2) } }), `${key(c)} ${c.args[1]} ${key(c, 2)}`),
  },
  unrelate: { args: "<key> <other>", about: "remove the link between two issues", run: async (c) => wrote(c, c.api.request("DELETE", issuePath(c, `/relations/${encodeURIComponent(key(c, 1))}`)), `unrelated ${key(c)} ${key(c, 1)}`) },
};

const cycleCommands: Record<string, Command> = {
  show: {
    args: "<cycle>",
    flags: "[-p KEY]",
    about: `a cycle (C12 or its name) and its issues, ${LIMIT_MAX} at most`,
    async run(c) {
      // One after the other: in a new process fetch queues the second request on the connection the first is still
      // opening, so asking both at once saved nothing (ADR 0015, 2026-11-04).
      const query = inProject(c);
      const cycle = await c.api.request<CycleRow>("GET", cyclePath(c), { query });
      const issues = await c.api.request<IssueList>("GET", "/issues", { query: { ...query, q: `cycle:${cycle.short}`, order: "priority", limit: String(LIMIT_MAX) } });
      return shown(c, { cycle, issues }, (d) => cycleCard(d.cycle, issueList(d.issues.issues, d.issues.total, c.style, links(c)), c.style, links(c)));
    },
  },
  create: {
    args: "<name>",
    flags: "[-p KEY] [--start D --end D] [--lead A] [-d TEXT|-]",
    about: "new cycle; no dates makes a draft",
    async run(c) {
      const r = await c.api.request<{ short: string; name: string }>("POST", "/cycles", { body: { ...(await cycleBody(c)), project: project(c), name: c.args[0] } });
      return wrote(c, r, (d) => `${d.short}  ${d.name}`);
    },
  },
  update: {
    args: "<cycle>",
    flags: "[-p KEY] [--name N] [--start D] [--end D] [--lead A] [-d TEXT|-]",
    about: "change the fields given; none clears a field",
    run: async (c) => wrote(c, c.api.request("PATCH", cyclePath(c), { query: inProject(c), body: changes(await cycleBody(c), "cycle update") }), `updated ${c.args[0]}`),
  },
  complete: {
    args: "<cycle>",
    flags: "--move-to <cycle|next|none> [--keep KEY]... [-p KEY]",
    about: "complete it and move its open issues on; --keep leaves an issue in the completed cycle",
    async run(c) {
      if (c.v["move-to"] === undefined) throw new UsageError("where do the open issues go? --move-to <cycle|next|none>");
      const r = await c.api.request<{ moved: number; kept: number }>("POST", cyclePath(c, "/complete"), { query: inProject(c), body: given({ moveTo: clearable(c.v["move-to"]), keep: c.v.keep?.map((k) => k.toUpperCase()) }) });
      return wrote(c, r, (d) => `completed ${c.args[0]}: ${d.moved} moved, ${d.kept} kept`);
    },
  },
  delete: {
    args: "<cycle>",
    flags: "[-p KEY]",
    about: "take its issues out and delete it; a completed cycle is kept",
    async run(c) {
      const r = await c.api.request<{ moved: number }>("DELETE", cyclePath(c), { query: inProject(c) });
      return wrote(c, r, (d) => `deleted ${c.args[0]}: ${d.moved} issues left it`);
    },
  },
};

const MARK = ["read", "unread", "archive"] as const;

const inbox: Command = {
  args: "[read|unread|archive] [key...]",
  flags: "[--all]",
  about: "the token's person's notifications, newest first; read, unread or archive the keys given, or --all; --all lists the snoozed too",
  complete: [MARK],
  async run(c) {
    const [what, ...keys] = c.args;
    if (what === undefined) {
      const data = await c.api.request<{ unread: number; lines: InboxLine[] }>("GET", "/inbox", { query: { all: c.v.all ? "1" : undefined } });
      return shown(c, data, (d) => inboxList(d.lines, d.unread, c.style, links(c)));
    }
    if (!(MARK as readonly string[]).includes(what)) throw new UsageError(`inbox what? ${MARK.join(", ")}, or nothing for the list`);
    if (!keys.length === !c.v.all) throw new UsageError(`inbox ${what}: the issue keys, or --all`);
    const r = await c.api.request<{ marked: number }>("POST", "/inbox", { body: { [what]: c.v.all ? "all" : keys.map((k) => k.toUpperCase()) } });
    return wrote(c, r, (d) => `${what === "archive" ? "archived" : `marked ${what}`}: ${d.marked}`);
  },
};

const cycles: Command = {
  args: "",
  flags: "[-p KEY]",
  about: "a project's cycles in time order",
  run: async (c) => shown(c, await c.api.request<CycleRow[]>("GET", "/cycles", { query: inProject(c) }), (d) => cycleList(d, c.style)),
};

// ── The workspace's settings (PLNR-239) ─────────────────────────────────────────────────────────────────────────
// Read with any token. Changing projects, states, labels and the workspace needs an admin: the agent's token is refused
// by the server (an agent is a member at most), a person runs these with their own token.

const projectPath = (c: Ctx) => `/projects/${encodeURIComponent(key(c))}`;
const statePath = (c: Ctx) => `/states/${encodeURIComponent(c.args[0]!)}`;
const labelPath = (c: Ctx) => `/labels/${encodeURIComponent(c.args[0]!)}`;
/** `--before` and `--after` place a state among the states of its group. */
const placed = (c: Ctx) => given({ before: c.v.before, after: c.v.after });

const projectCommands: Record<string, Command> = {
  show: { args: "<key>", about: "a project with its states and labels", run: async (c) => shown(c, await c.api.request<ProjectFull>("GET", projectPath(c)), (d) => projectCard(d, c.style)) },
  create: {
    args: "<key> <name>",
    flags: "[--hue C]",
    about: "new project with the app's workflow: Backlog, Todo, In Progress, Done, Cancelled; --hue is its tile color",
    async run(c) {
      const r = await c.api.request<{ key: string }>("POST", "/projects", { body: given({ key: c.args[0], name: c.args[1], color: c.v.hue }) });
      return wrote(c, r, (d) => `created ${d.key}`);
    },
  },
  update: {
    args: "<key>",
    flags: "[--key K] [--name N] [--hue C] [--rollover on|off]",
    about: "change the fields given; the old key stays an alias, --hue none clears the color; --rollover on: a cycle that is over completes itself and its open issues move to the next",
    run: async (c) => wrote(c, c.api.request("PATCH", projectPath(c), { body: changes(given({ key: c.v.key, name: c.v.name, color: clearable(c.v.hue), rollover: onOff(c.v.rollover) }), "project update") }), `updated ${key(c)}`),
  },
  archive: { args: "<key>", about: "to the archive", run: async (c) => wrote(c, c.api.request("PATCH", projectPath(c), { body: { archived: true } }), `archived ${key(c)}`) },
  unarchive: { args: "<key>", about: "back from the archive", run: async (c) => wrote(c, c.api.request("PATCH", projectPath(c), { body: { archived: false } }), `unarchived ${key(c)}`) },
};

const stateCommands: Record<string, Command> = {
  create: {
    args: "<name>",
    flags: "--group G [--before S] [--after S] [-p KEY]",
    about: "new state; last in its group unless placed",
    async run(c) {
      if (c.v.group === undefined) throw new UsageError(`which group? --group ${STATE_GROUPS.join("|")}`);
      const r = await c.api.request<{ name: string }>("POST", "/states", { body: { project: project(c), name: c.args[0], group: c.v.group, ...placed(c) } });
      return wrote(c, r, (d) => `created ${d.name}`);
    },
  },
  update: {
    args: "<state>",
    flags: "[--name N] [--group G] [--before S] [--after S] [--default] [-p KEY]",
    about: "change the fields given; a new group puts it last there unless placed; --default makes it the project's default",
    async run(c) {
      const body = changes(given({ name: c.v.name, group: c.v.group, ...placed(c), default: c.v.default || undefined }), "state update");
      return wrote(c, c.api.request("PATCH", statePath(c), { query: inProject(c), body }), `updated ${c.args[0]}`);
    },
  },
  delete: {
    args: "<state>",
    flags: "[--move-to S] [-p KEY]",
    about: "delete it; its issues, archived ones too, move to --move-to first, which becomes the default if this one was",
    async run(c) {
      const r = await c.api.request<{ moved: number }>("DELETE", statePath(c), { query: { ...inProject(c), moveTo: c.v["move-to"] } });
      return wrote(c, r, (d) => `deleted ${c.args[0]}${d.moved ? `: ${d.moved} issues moved to ${c.v["move-to"]}` : ""}`);
    },
  },
};

const labelCommands: Record<string, Command> = {
  create: {
    args: "<name>",
    flags: "[--hue C] [--parent L] [-p KEY]",
    about: "new label; --hue is #rrggbb or one of the app's colors by name (red, blue…), else the app's next",
    async run(c) {
      const r = await c.api.request<{ name: string; color: string }>("POST", "/labels", { body: given({ project: project(c), name: c.args[0], color: c.v.hue, parent: c.v.parent }) });
      return wrote(c, r, (d) => `created ${d.name} ${d.color}`);
    },
  },
  update: {
    args: "<label>",
    flags: "[--name N] [--hue C] [--parent L] [-p KEY]",
    about: "change the fields given; --parent none takes it to the top level",
    async run(c) {
      const body = changes(given({ name: c.v.name, color: c.v.hue, parent: clearable(c.v.parent) }), "label update");
      return wrote(c, c.api.request("PATCH", labelPath(c), { query: inProject(c), body }), `updated ${c.args[0]}`);
    },
  },
  delete: {
    args: "<label>",
    flags: "[-p KEY]",
    about: "take it off every issue and delete it; the labels inside it move up a level",
    async run(c) {
      const r = await c.api.request<{ removedFrom: number }>("DELETE", labelPath(c), { query: inProject(c) });
      return wrote(c, r, (d) => `deleted ${c.args[0]}: taken off ${d.removedFrom} issues`);
    },
  },
};

const workspaceCommands: Record<string, Command> = {
  show: { args: "", about: "the workspace, and whose token this is: its person, role, scope and what it may change", run: async (c) => shown(c, await c.api.request<WorkspaceInfo>("GET", "/workspace"), (d) => workspaceCard(d, c.style)) },
  update: {
    args: "",
    flags: "[--name N] [--hue C]",
    about: "change the fields given; --hue none clears the color",
    run: async (c) => wrote(c, c.api.request("PATCH", "/workspace", { body: changes(given({ name: c.v.name, color: clearable(c.v.hue) }), "workspace update") }), "updated the workspace"),
  },
};

/** A list with no arguments: the path, and whether the project comes with it. */
const listOf = <T>(path: string, about: string, render: (d: T, s: Style) => string, perProject = false): Command => ({
  args: "",
  ...(perProject ? { flags: "[-p KEY]" } : {}),
  about,
  run: async (c) => shown(c, await c.api.request<T>("GET", path, perProject ? { query: inProject(c) } : {}), (d) => render(d, c.style)),
});

const settingsCommands: Record<string, Command | Group> = {
  projects: listOf<ProjectRow[]>("/projects", "the workspace's projects, archived ones too", projectList),
  project: { about: "a project: show, create, update, archive, unarchive", commands: projectCommands },
  states: listOf<StateRow[]>("/states", "a project's workflow states in the app's order, with their issues", stateList, true),
  state: { about: "a workflow state: create, update, delete", commands: stateCommands },
  labels: listOf<LabelRow[]>("/labels", "the labels a project's issues can use, as a tree, with their issues", labelList, true),
  label: { about: "a label: create, update, delete", commands: labelCommands },
  members: listOf<MemberRow[]>("/members", "the workspace's people and agents, by role: the emails --assignee and mentions take", memberList),
  views: listOf<ViewRow[]>("/views", "saved views you see, shared and your own: the names --view takes", viewList),
  workspace: { about: "the workspace: show, update", commands: workspaceCommands },
};

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/** `rsva api`: any call of the agent API, for what has no command; `rsva api` from a script. */
const api: Command = {
  args: "<method> <path> [arg...]",
  about: "any call of the agent API, the answer as JSON; the path is under /api/v1/workspaces/:ws, name=value goes in its query, a JSON body (- reads it from stdin) in the request",
  json: false,
  complete: [METHODS],
  async run(c) {
    const method = c.args[0]!.toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) throw new UsageError(`api: the method is one of ${METHODS.join(", ")}`);
    const path = c.args[1]!;
    if (!path.startsWith("/")) throw new UsageError("api: the path starts with /, as /issues/PLNR-9");
    const query: Query = {};
    let body: unknown;
    for (const arg of c.args.slice(2)) {
      const param = /^([\w.-]+)=([\s\S]*)$/.exec(arg);
      if (param) {
        query[param[1]!] = param[2];
        continue;
      }
      if (body !== undefined) throw new UsageError("api: one body at most; a query parameter is name=value");
      try {
        body = JSON.parse(arg === "-" ? await c.io.stdin() : arg);
      } catch {
        throw new UsageError("api: the body is not JSON");
      }
    }
    const data = await c.api.request(method, path, { query, body });
    return data === null ? "" : json(c, data);
  },
};

const cycleGroup: Group = { about: "a cycle: show, create, update, complete, delete", commands: cycleCommands };

const completion: Command = {
  args: "<shell>",
  about: "a completion script; zsh: source <(rsva completion zsh), or save it as _rsva in $fpath",
  json: false,
  complete: [["zsh"]],
  async run(c) {
    if (c.args[0] !== "zsh") throw new UsageError("completion for zsh only, so far");
    const of = (name: string, cmd: Command | Group): Completable =>
      isGroup(cmd)
        ? { name, about: cmd.about, flags: [], query: false, values: [] }
        : { name, about: cmd.about, flags: [...flagsOf(cmd), ...globalsOf(cmd)], query: cmd.args.includes("query"), values: cmd.complete ?? [] };
    const flagSpecs = Object.entries(FLAGS) as [Flag, FlagSpec][];
    return zsh({
      commands: Object.entries(COMMANDS).map(([n, cmd]) => of(n, cmd)),
      groups: Object.fromEntries(Object.entries(COMMANDS).flatMap(([n, cmd]) => (isGroup(cmd) ? [[n, Object.entries(cmd.commands).map(([sub, x]) => of(sub, x))]] : []))),
      shorts: Object.fromEntries(flagSpecs.flatMap(([name, f]) => (f.short ? [[name, f.short]] : []))),
      valued: flagSpecs.filter(([, f]) => !f.boolean).map(([name]) => name),
      flagValues: Object.fromEntries(flagSpecs.flatMap(([name, f]) => (f.values ? [[name, f.values]] : []))),
    });
  },
};

const tui: Command = {
  args: "",
  about: "the live app in the terminal (apps/tui): your work from a copy on this Mac; tui dispatch KEY starts Claude on an issue (--model, --effort, --agent, --context, --dry-run), tui agents lists them",
  json: false,
  async run(c) {
    if (!c.io.tui || !c.io.terminal) throw new UsageError("tui needs a terminal");
    const code = await c.io.tui();
    if (code) throw new UsageError(`the TUI exited with ${code}`);
    return "";
  },
};

// The terminal as the person (PLNR-323): for the TUI, which then opens every workspace they are in. The commands above
// keep the token, as agents and scripts run them.
const login: Command = {
  args: "",
  about: "sign this Mac's terminal in as you, for rsva tui: a code from Settings › Security, pasted here (or on stdin); agents and scripts keep their token",
  json: false,
  async run(c) {
    const keychain = c.io.keychain;
    if (!keychain) throw new UsageError("login keeps its session in the macOS Keychain");
    let code: string;
    if (c.io.ask) {
      const page = `${c.api.origin}/settings/security`;
      c.io.err(`In ${page}, choose Sign in a terminal and paste the code here.`);
      await c.io.open?.(page);
      code = await c.io.ask("Code: ");
    } else code = await c.io.stdin();
    if (!code.trim()) throw new UsageError("no code: rsva login, then paste the code from Settings › Security");
    const s = await c.api.signIn(code.trim());
    // The session before (an earlier login, this account's or another's) is ended on the server and its copies here: once
    // replaced, nothing would hold it, and it would stay live. Then its item goes: a second account under the service
    // would be a second item, and the Keychain hands out the first. A session the Keychain did not keep is ended too.
    const before = await keychain.read(SESSION_SERVICE);
    if (before) await endSession(c, new Client({ ...c.io.env, RSVA_SESSION: before }, { session: true }));
    await keychain.remove(SESSION_SERVICE);
    try {
      await keychain.write(SESSION_SERVICE, s.user.email, s.session);
    } catch (e) {
      await new Client({ ...c.io.env, RSVA_SESSION: s.session }, { session: true }).signOut().catch(() => undefined);
      throw new UsageError(`${(e as Error).message}; the session was ended again`);
    }
    return `Signed in as ${s.user.email}: rsva tui opens every workspace you are in.`;
  },
};

const logout: Command = {
  args: "",
  about: "end the terminal's session (rsva login) here and on the server",
  json: false,
  async run(c) {
    const keychain = c.io.keychain;
    if (!keychain) throw new UsageError("login keeps its session in the macOS Keychain");
    // The copies' folder is named by the credential (copies.ts): read before the Keychain forgets it.
    const away = await endSession(c, new Client(c.io.env, { session: true }));
    await keychain.remove(SESSION_SERVICE);
    return `Signed out${away}.`;
  },
};

/**
 * Ends a terminal's session on the server and deletes the TUI's copies made with it here (copies.ts). Ended on the
 * server already (401), or no server to say so: forgotten here all the same, and the answer's tail says which.
 */
async function endSession(c: Ctx, client: Client): Promise<string> {
  let away = "";
  const authorization = await client.authorization().catch(() => null);
  await client.signOut().catch((e: unknown) => {
    if (e instanceof NetworkError) away = `; the server was not reached (${e.message}): end the session in Settings › Security`;
    else if (!(e instanceof ApiError)) throw e;
  });
  if (authorization) await c.io.copies?.(authorization);
  return away;
}

const help: Command = {
  args: "[command...]",
  about: "this list, or one command's",
  json: false,
  get complete() {
    return [Object.keys(COMMANDS)];
  },
  async run(c) {
    if (!c.args.length) return helpText(c.style);
    const found = find(c.args);
    if (found.rest.length) throw new UsageError(`no command ${c.args.join(" ")}; rsva help lists them`);
    return isGroup(found.cmd) ? groupText(found.name, found.cmd, c.style) : line(found.name, found.cmd, c.style);
  },
};

/** Every command, in the order the help lists them. */
const COMMANDS: Record<string, Command | Group> = { ...issueCommands, inbox, cycles, cycle: cycleGroup, ...settingsCommands, tui, login, logout, completion, api, help };

const isGroup = (x: Command | Group): x is Group => "commands" in x;

const line = (name: string, c: Command, s: Style) => `  ${[s.bold(name), c.args, s.gray(c.flags ?? "")].filter(Boolean).join(" ")}\n      ${c.about}`;
const groupText = (name: string, g: Group, s: Style) => Object.entries(g.commands).map(([n, c]) => line(`${name} ${n}`, c, s)).join("\n");

const ENV: [string, string][] = [
  ["RSVA_URL", "server (default https://app.rsva.dev)"],
  ["RSVA_WS", "workspace (default the token's own, asked once a run; setting it saves the request)"],
  ["RSVA_PROJECT", "project when -p is left out"],
  ["RSVA_TOKEN", "token; otherwise the macOS Keychain, service RSVA_KEYCHAIN (default rsva-bot)"],
  ["RSVA_PAGER", "pager for a person's long output, the tui's too (default $PAGER, else less); cat or empty: none, less in the tui"],
  ["RSVA_SESSION", "tui: your session; otherwise the one rsva login keeps in the Keychain (service rsva-session)"],
  ["RSVA_OWN_KEYCHAIN", "tui without rsva login: the Keychain service of your own token (default rsva-own); without one the TUI runs on rsva-bot's"],
  ["RSVA_TUI_IMAGES", "tui: 1 draws images, 0 shows their captions (default: drawn in Rex, Ghostty and kitty, not inside tmux)"],
  ["RSVA_AGENT", "tui dispatch: the agent's email issues are delegated to (default the workspace's one agent)"],
  ["NO_COLOR", "plain text at a terminal too; FORCE_COLOR: colour into a pipe"],
];

const helpText = (s: Style) => `rsva: recursiva from a terminal, for people and agents (docs/agents-api.md)

${Object.entries(COMMANDS).map(([n, c]) => (isGroup(c) ? groupText(n, c, s) : line(n, c, s))).join("\n")}

Every command that asks the server takes --json: its answer, in one line for a pipe or an agent; cycle show gives both
of its answers, {cycle, issues}. After -- everything is an argument: rsva comment KEY -- -x. At a terminal the output
is for a person: colour, the window's width, the list by state; a pipe, a file or an agent (CLAUDECODE) gets plain
text. --plain and --color choose. A GET the server is too busy for is asked once more after its wait, up to 5 s.

${ENV.map(([k, v]) => `${s.bold(k.padEnd(16))} ${v}`).join("\n")}`;

const shortFlags = Object.fromEntries((Object.entries(FLAGS) as [Flag, FlagSpec][]).flatMap(([name, f]) => (f.short ? [[f.short, name]] : []))) as Record<string, Flag>;

/** What a command takes besides its own flags: all of them --help, --plain and --color, and --json when there is an answer. */
const globalsOf = (c: Command) => new Set<string>(["help", "plain", "color", ...(c.json === false ? [] : ["json"])]);

/** The flags in a command's help: the one list of what it takes. */
const flagsOf = (c: Command) => new Set<string>([...(c.flags ?? "").matchAll(/(?<![\w-])--([a-z-]+)|(?<![\w-])-([a-zA-Z])(?![\w-])/g)].map((m) => m[1] ?? shortFlags[m[2]!]!));

/**
 * A word that is a flag: `--word`, `--word=value`, `-x` or `-x=value`, known or not, so that a typo is refused rather than
 * posted as text or searched for. `-label:bug` and `- item` are arguments.
 */
const FLAG = /^(?:--([^\s=]+)|-([a-zA-Z]))(?:=([\s\S]*))?$/;

/**
 * The command's flags and arguments. Written out rather than node:util's parseArgs: that one takes `-label:bug`, the "is
 * not" of the query language, for a cluster of short flags, and refuses a value that starts with a dash.
 */
function parse(cmd: Command, argv: string[]): { v: Values; args: string[] } {
  const known = new Set([...flagsOf(cmd), ...globalsOf(cmd)]);
  const v: Record<string, string | string[] | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    const m = FLAG.exec(word);
    if (!m) {
      args.push(word);
      continue;
    }
    const name = (m[1] ?? shortFlags[m[2]!]) as Flag | undefined;
    if (!name || !known.has(name)) throw new UsageError(`${word}: not a flag of this command; after -- it is an argument`);
    const flag: FlagSpec = FLAGS[name];
    if (flag.boolean) {
      v[name] = true;
      continue;
    }
    const value = m[3] ?? argv[++i];
    if (value === undefined) throw new UsageError(`${word} needs a value`);
    if (flag.multiple) ((v[name] ??= []) as string[]).push(value);
    else v[name] = value;
  }
  return { v: v as Values, args };
}

/** How many arguments a command takes, from its `<x>`s and `[x]`s; `...` takes any number. */
function arity(c: Command): [number, number] {
  const slots = c.args.match(/<[^>]*>|\[[^\]]*\]/g) ?? [];
  return [slots.filter((s) => s.startsWith("<")).length, slots.some((s) => s.includes("...")) ? Infinity : slots.length];
}

/** The entry of that name: `constructor` is not one. */
const own = <T>(table: Record<string, T>, name: string) => (Object.hasOwn(table, name) ? table[name] : undefined);

const isHelp = (word: string | undefined) => word === undefined || word === "help" || word === "--help" || word === "-h";

/** The command the words name, and the words after it; a group without a command of its own, for its help. */
function find(argv: readonly string[]): { cmd: Command | Group; name: string; rest: string[] } {
  const [first = "", ...rest] = argv;
  const entry = own(COMMANDS, first);
  if (!entry) throw new UsageError(`no command ${first}; rsva help lists them`);
  if (!isGroup(entry) || isHelp(rest[0])) return { cmd: entry, name: first, rest: isGroup(entry) ? [] : rest };
  const cmd = own(entry.commands, rest[0]!);
  if (!cmd) throw new UsageError(`${first} what? ${Object.keys(entry.commands).join(", ")}`);
  return { cmd, name: `${first} ${rest[0]}`, rest: rest.slice(1) };
}

async function dispatch(argv: string[], io: Io, style: Style): Promise<string> {
  const { cmd, name, rest } = find(argv[0] === undefined || argv[0] === "--help" || argv[0] === "-h" ? ["help"] : argv);
  if (isGroup(cmd)) return groupText(name, cmd, style);
  const { v, args } = parse(cmd, rest);
  if (v.help) return line(name, cmd, style);
  const [min, max] = arity(cmd);
  if (args.length < min || args.length > max) throw new UsageError(`usage: rsva ${[name, cmd.args, cmd.flags].filter(Boolean).join(" ")}${args.length > max ? "\nquote text with spaces" : ""}`);
  let client: Client | undefined;
  return cmd.run({
    get api() {
      return (client ??= new Client(io.env));
    },
    args,
    v,
    io,
    style,
  });
}

/**
 * Runs one call of the CLI: its exit code. 1 is a refusal by the server or a failure on the way, 2 a mistake in the call.
 * Anything else is a bug and is thrown, with its stack.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  // Chosen before the words are parsed, so that help and a mistake in the call are drawn the same way; after -- a word is text.
  const end = argv.indexOf("--");
  const words = end < 0 ? argv : argv.slice(0, end);
  const flags = { plain: words.includes("--plain"), color: words.includes("--color") };
  const style = styleFor(io.env, io.terminal, flags);
  const errStyle = styleFor(io.env, io.errTerminal ? {} : undefined, flags);
  try {
    const text = await dispatch(argv, io, style);
    const rows = io.terminal?.rows;
    if (style.on && io.page && rows && text.split("\n").length >= rows) await io.page(text);
    else io.out(text);
    return 0;
  } catch (e) {
    const f = failure(e);
    if (!f) throw e;
    io.err(`${errStyle.red("rsva:")} ${f.text}`);
    return f.code;
  }
}
