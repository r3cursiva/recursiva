// The text query language, shared by the filter bar, the URL (?q=), the CLI and MCP:
//
//   state:"In Review" assignee:me priority:high,urgent label:security due:<2026-11-01 dark mode
//
// - key:value[,value…] filters; a comma means "any of", separate keys must all match (AND).
// - Values with spaces, commas or colons go in double quotes; a quoted value is always a name, so label:"none" is the
//   label called "none" while label:none means "no labels".
// - Everything else is free text matched against the title and the key; "quoted phrases" stay together.
// - Dates take the expressions of dates.ts: due:today, due:<today (overdue), created:last-7-days, due:2026-11-01..
// - order:priority (or sort:) says in which order the list goes, not which issues (PLNR-401): one line describes a
//   list, as GitHub's search takes sort:. Without it each screen keeps its own order.
//
// - Short forms (PLNR-359; everywhere since RSVA-368): `#INFRA` is project:INFRA, `@me` assignee:me, `!high`
//   priority:high and `+bug` label:bug, at a word's start (SHORT_FORMS). A word of free text that starts with one of the
//   signs goes in quotes ("#123"); formatQuery writes it so, and writes the long keys, never the signs.
//
// Names resolve through the QueryContext. Unknown keys and names become errors with suggestions; the rest of the
// query still applies, so a typo in one value does not blank the list.
import { PRIORITIES, projectsByKey, UUID, type Project } from "@rsva/schema/models";
import { DATE_PRESETS, formatDateRange, resolveDateExpr, todayOf } from "./dates.ts";
import type { DateRange, Filter, OrderBy, QueryContext } from "./index.ts";
import { STATE_GROUP_ORDER } from "./run.ts";

export interface QueryError {
  message: string;
  /** Offsets of the offending part in the query text, for underlining. */
  start: number;
  end: number;
  /** Replacements for the offending part, best first (may be empty). */
  suggestions: string[];
}

export interface ParsedQuery {
  filter: Filter;
  errors: QueryError[];
  /** The order the query asks for (`order:`); absent when it names none or names one wrongly. */
  order?: OrderBy;
}

/** Text names of the order key, canonical first: `sort:` is what a hand used to GitHub types. */
export const ORDER_KEYS = ["order", "sort"] as const;

/** The words `order:` takes, canonical first: what formatQuery writes. The OrderBy names are taken too. */
export const ORDER_WORDS: Record<OrderBy, string> = { updatedAt: "updated", createdAt: "created", priority: "priority", dueDate: "due", startDate: "start", manual: "manual" };
/** Every order by its name, the one `?order=` of the agent API and a view's display take. */
export const ORDER_BYS = Object.keys(ORDER_WORDS) as readonly OrderBy[];
const ORDER_BY_WORD = new Map<string, OrderBy>();
for (const [o, w] of Object.entries(ORDER_WORDS) as [OrderBy, string][]) ORDER_BY_WORD.set(w, o).set(o.toLowerCase(), o);

type ListKey = "project" | "state" | "stateGroup" | "priority" | "assignee" | "label" | "createdBy" | "delegate" | "cycle" | "parent" | "is" | "has";
type DateKey = "startDate" | "dueDate" | "createdAt" | "updatedAt" | "completedAt";
type Key = ListKey | DateKey;

/** Text names of the keys, canonical first. The canonical name is what formatQuery writes. */
export const QUERY_KEYS: Record<Key, readonly string[]> = {
  project: ["project"],
  state: ["state", "status"],
  stateGroup: ["group", "stategroup"],
  priority: ["priority"],
  assignee: ["assignee", "assignees"],
  label: ["label", "labels"],
  createdBy: ["author", "createdby", "creator"],
  delegate: ["agent", "delegate"],
  cycle: ["cycle", "cycles"],
  parent: ["parent"],
  is: ["is"],
  has: ["has"],
  startDate: ["start", "startdate"],
  dueDate: ["due", "duedate"],
  createdAt: ["created", "createdat"],
  updatedAt: ["updated", "updatedat"],
  completedAt: ["closed", "completed", "completedat"],
};

const KEY_BY_NAME = new Map<string, Key>();
for (const [k, names] of Object.entries(QUERY_KEYS) as [Key, readonly string[]][]) for (const n of names) KEY_BY_NAME.set(n, k);

/** Order in which formatQuery writes keys. */
const KEY_ORDER: readonly Key[] = ["project", "state", "stateGroup", "priority", "assignee", "label", "createdBy", "delegate", "cycle", "parent", "is", "has", "startDate", "dueDate", "createdAt", "updatedAt", "completedAt"];
const DATE_KEYS = new Set<Key>(["startDate", "dueDate", "createdAt", "updatedAt", "completedAt"]);
/** The dates an issue may lack: `due:none` and `start:none` find those without one, `closed:none` those never closed. */
const OPTIONAL_DATES = new Set<Key>(["startDate", "dueDate", "completedAt"]);

/** Each priority code's word in the query and the API (PRIORITIES of @rsva/schema). */
export const PRIORITY_KEYWORDS: Record<number, string> = Object.fromEntries(PRIORITIES.map((p) => [p.code, p.keyword]));

// ── Tokenizer ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Value {
  text: string;
  quoted: boolean;
  start: number;
  end: number;
}

interface Token {
  start: number;
  end: number;
  raw: string;
  /** The key as typed (lowercase), or null for free text. */
  key: string | null;
  /** `-key:values`: "is not". */
  neg: boolean;
  keyEnd: number;
  values: Value[];
}

/** The short forms: a sign at a word's start, followed by more than a space, stands for a key. */
export const SHORT_FORMS = { "#": "project", "@": "assignee", "!": "priority", "+": "label" } as const;

/** Splits on unquoted whitespace; inside a key:value token also splits values on unquoted commas. */
function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let k = 0;
  const n = q.length;
  while (k < n) {
    while (k < n && /\s/.test(q[k]!)) k++;
    if (k >= n) break;
    const start = k;
    // key: letters (and _) right before a colon, at the start of the token.
    const m = /^(-?)([A-Za-z_]+):/.exec(q.slice(k, k + 32));
    let key: string | null = null;
    let keyEnd = k;
    const sign = SHORT_FORMS[q[k] as keyof typeof SHORT_FORMS];
    if (m) {
      key = m[2]!.toLowerCase().replace(/_/g, "");
      k += m[0].length;
      keyEnd = k;
    } else if (sign && k + 1 < n && !/\s/.test(q[k + 1]!)) {
      key = sign;
      k += 1;
      keyEnd = k;
    }
    const values: Value[] = [];
    let buf = "";
    let quoted = false;
    let vStart = k;
    const push = () => {
      if (buf || quoted) values.push({ text: buf, quoted, start: vStart, end: k });
      buf = "";
      quoted = false;
    };
    while (k < n && !/\s/.test(q[k]!)) {
      const c = q[k]!;
      if (c === '"') {
        quoted = true;
        k++;
        while (k < n && q[k] !== '"') {
          if (q[k] === "\\" && k + 1 < n) k++;
          buf += q[k]!;
          k++;
        }
        k++; // closing quote (or end of input)
      } else if (c === "," && key !== null) {
        push();
        k++;
        vStart = k;
      } else {
        buf += c;
        k++;
      }
    }
    k = Math.min(k, n);
    push();
    out.push({ start, end: k, raw: q.slice(start, k), key, neg: !!m?.[1], keyEnd, values });
  }
  return out;
}

// ── Suggestions ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Edit distance with transpositions (optimal string alignment): "hihg" is one step from "high". */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row = (rows[i] = [i] as number[]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        row[j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      row[j] = d;
    }
  }
  return rows[a.length]![b.length]!;
}

/** Up to three candidates close to `input`: names it begins or is part of; failing that, near typos. */
export function suggest(input: string, candidates: Iterable<string>): string[] {
  const q = input.toLowerCase();
  const near: [number, string][] = [];
  const containing: [number, string][] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, Math.floor(q.length / 3));
  for (const c of candidates) {
    const l = c.toLowerCase();
    if (seen.has(l)) continue;
    seen.add(l);
    if (q && l.startsWith(q)) containing.push([0, c]);
    else if (q && l.includes(q)) containing.push([1, c]);
    else {
      const d = distance(q, l);
      if (d <= limit) near.push([d, c]);
    }
  }
  return (containing.length ? containing : near)
    .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length)
    .slice(0, 3)
    .map(([, c]) => c);
}

// ── Values ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** name (lowercase) → ids; several objects may share a name (states across projects, namesakes). */
function nameIndex<T extends { id: string }>(items: Iterable<T>, names: (t: T) => string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of items) {
    for (const n of names(t)) {
      const l = n.toLowerCase();
      const ids = m.get(l);
      if (!ids) m.set(l, [t.id]);
      else if (!ids.includes(t.id)) ids.push(t.id);
    }
  }
  return m;
}

/**
 * Projects by key and name, and by a key a project had before a rename (PLNR-455): `project:PLNR` in a saved view still
 * finds the project now called RSVA, as PLNR-448 does. Which project a former key means is projectsByKey's rule, the one
 * issue keys follow, so a key handed to another project means its new owner; and a former key never shadows a project's
 * current key or name.
 */
function projectIndex(list: readonly Project[]): Map<string, string[]> {
  const m = nameIndex(list, (p) => [p.key, p.name]);
  for (const [k, p] of projectsByKey(list)) if (!m.has(k.toLowerCase())) m.set(k.toLowerCase(), [p.id]);
  return m;
}

function quote(s: string): string {
  return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

/** A name as a query value: bare when it is safe, quoted otherwise. */
export function formatValue(name: string, reserved: readonly string[] = []): string {
  return /^[^\s,":]+$/.test(name) && !reserved.includes(name.toLowerCase()) ? name : quote(name);
}

const KIND_NAMES: Record<ListKey, string> = {
  project: "project",
  state: "state",
  stateGroup: "state group",
  priority: "priority",
  assignee: "member",
  label: "label",
  createdBy: "member",
  delegate: "agent",
  cycle: "cycle",
  parent: "issue",
  is: "condition",
  has: "attachment kind",
};

/** Words `cycle:` takes besides names (PLNR-63); a quoted one is a cycle's name. */
const CYCLE_WORDS = ["active", "next", "none"];
/** Words `parent:` takes besides issue keys (PLNR-173). */
const PARENT_WORDS = ["none", "any"];
/** What `is:` can say about an issue (PLNR-51, RSVA-174). */
const IS_WORDS = ["blocked", "blocking", "duplicate"];
/** The `is:` words a field of the issue answers, with no other issues loaded. */
const IS_OWN_WORDS = ["duplicate"];
/** What `has:` can ask of an issue (RSVA-174). */
const HAS_WORDS = ["link"];

/**
 * Builds the resolver for one key: value text → filter values, or an error. Indexes are built lazily, so a query
 * that only uses priority does not index users.
 */
function resolvers(ctx: QueryContext) {
  let states: Map<string, string[]> | undefined;
  let labels: Map<string, string[]> | undefined;
  let users: Map<string, string[]> | undefined;
  let projects: Map<string, string[]> | undefined;
  let cycles: Map<string, string[]> | undefined;
  // "C12" as well as "Cycle 12": the short form the sidebar and the chips show.
  const cycleIdx = () => (cycles ??= nameIndex(ctx.cycles?.values() ?? [], (c) => [c.name, `c${c.number}`]));
  const projectIdx = () => (projects ??= projectIndex([...(ctx.projects?.values() ?? [])]));
  const stateIdx = () => (states ??= nameIndex(ctx.states.values(), (s) => [s.name]));
  const labelIdx = () => (labels ??= nameIndex(ctx.labels.values(), (l) => [l.name]));
  const userIdx = () =>
    (users ??= nameIndex(ctx.users.values(), (u) => {
      const local = u.email.split("@")[0] ?? "";
      return [u.name, u.email, local];
    }));
  const names = (key: ListKey): string[] => {
    switch (key) {
      case "project":
        return [...(ctx.projects?.values() ?? [])].map((p) => p.key);
      case "state":
        return [...ctx.states.values()].map((s) => s.name);
      case "stateGroup":
        return [...STATE_GROUP_ORDER];
      case "priority":
        return PRIORITIES.map((p) => p.keyword);
      case "assignee":
        return ["me", "none", ...[...ctx.users.values()].map((u) => u.name)];
      case "label":
        return ["none", ...[...ctx.labels.values()].map((l) => l.name)];
      case "createdBy":
        return ["me", ...[...ctx.users.values()].map((u) => u.name)];
      case "delegate":
        return ["any", "none", "me", ...[...ctx.users.values()].map((u) => u.name)];
      case "cycle":
        return [...CYCLE_WORDS, ...[...(ctx.cycles?.values() ?? [])].map((c) => c.name)];
      case "parent":
        return PARENT_WORDS;
      case "is":
        return IS_WORDS;
      case "has":
        return HAS_WORDS;
    }
  };
  /** Values for one typed value, or null if it names nothing. */
  const resolve = (key: ListKey, v: Value): (string | number)[] | null => {
    const l = v.text.toLowerCase();
    const special = !v.quoted;
    switch (key) {
      case "project":
        if (UUID.test(l) && ctx.projects?.has(l)) return [l];
        return projectIdx().get(l) ?? null;
      case "state":
        if (UUID.test(l) && ctx.states.has(l)) return [l];
        return stateIdx().get(l) ?? null;
      case "stateGroup":
        return (STATE_GROUP_ORDER as readonly string[]).includes(l) ? [l] : null;
      case "priority": {
        const p = PRIORITIES.find((x) => x.keyword === l);
        return p ? [p.code] : null;
      }
      case "assignee":
      case "createdBy":
        if (special && l === "me") return ["me"];
        if (special && l === "none" && key === "assignee") return ["none"];
        if (UUID.test(l) && ctx.users.has(l)) return [l];
        return userIdx().get(l) ?? null;
      case "label":
        if (special && l === "none") return ["none"];
        if (UUID.test(l) && ctx.labels.has(l)) return [l];
        return labelIdx().get(l) ?? null;
      case "delegate":
        if (special && (l === "any" || l === "none" || l === "me")) return [l];
        if (UUID.test(l) && ctx.users.has(l)) return [l];
        return userIdx().get(l) ?? null;
      case "cycle":
        if (special && CYCLE_WORDS.includes(l)) return [l];
        if (UUID.test(l) && ctx.cycles?.has(l)) return [l];
        return cycleIdx().get(l) ?? null;
      case "parent": {
        if (special && PARENT_WORDS.includes(l)) return [l];
        const parent = UUID.test(l) ? ctx.issues?.get(l) : ctx.issues?.byKey(v.text.toUpperCase());
        return parent ? [parent.id] : null;
      }
      case "is":
        return IS_WORDS.includes(l) ? [l] : null;
      case "has":
        return HAS_WORDS.includes(l) ? [l] : null;
    }
  };
  return { resolve, names };
}

// ── parse ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Parses query text into a Filter. Never throws: problems come back as errors and the valid parts still apply. */
export function parseQuery(text: string, ctx: QueryContext): ParsedQuery {
  const filter: Filter = {};
  const errors: QueryError[] = [];
  const words: string[] = [];
  const today = todayOf(ctx);
  const r = resolvers(ctx);
  let order: OrderBy | undefined;

  for (const t of tokenize(text)) {
    if (t.key === null) {
      words.push(t.raw);
      continue;
    }
    if ((ORDER_KEYS as readonly string[]).includes(t.key)) {
      const got = orderOf(t, text);
      if ("error" in got) errors.push(got.error);
      else order = got.order;
      continue;
    }
    const key = KEY_BY_NAME.get(t.key);
    if (!key) {
      const keyText = text.slice(t.start + (t.neg ? 1 : 0), t.keyEnd - 1);
      errors.push({
        message: `Unknown filter "${keyText}:"`,
        start: t.start,
        end: t.keyEnd,
        suggestions: suggest(t.key, [...KEY_ORDER.map((k) => QUERY_KEYS[k][0]!), ORDER_KEYS[0]]).map((s) => `${s}:`),
      });
      continue;
    }
    const keyName = text.slice(t.start + (t.neg ? 1 : 0), t.keyEnd - 1);
    if (t.values.length === 0 || t.values.every((v) => !v.text && !v.quoted)) {
      errors.push({ message: `"${keyName}:" needs a value`, start: t.start, end: t.end, suggestions: [] });
      continue;
    }
    if (t.neg && DATE_KEYS.has(key)) {
      errors.push({ message: `"-${keyName}:" is not supported: dates take a range instead`, start: t.start, end: t.keyEnd, suggestions: [] });
      continue;
    }
    if (DATE_KEYS.has(key)) {
      const expr = text.slice(t.keyEnd, t.end).replace(/"/g, "");
      const res = resolveDateExpr(expr, today, ctx.weekStart);
      if ("error" in res) {
        errors.push({ message: res.error, start: t.keyEnd, end: t.end, suggestions: suggest(expr, DATE_PRESETS) });
      } else if (res.range.none && !OPTIONAL_DATES.has(key)) {
        errors.push({ message: `"${keyName}:none" finds nothing: every issue has one`, start: t.keyEnd, end: t.end, suggestions: [] });
      } else {
        filter[key as DateKey] = res.range;
      }
      continue;
    }
    const lk = key as ListKey;
    for (const v of t.values) {
      if (!v.text && !v.quoted) continue;
      const got = r.resolve(lk, v);
      if (!got) {
        errors.push({
          message: `No ${KIND_NAMES[lk]} named "${v.text}"`,
          start: v.start,
          end: v.end,
          suggestions: suggest(v.text, r.names(lk)).map((s) => formatValue(s)),
        });
        continue;
      }
      const into = t.neg ? (filter.not ??= {}) : filter;
      const list = ((into as Record<ListKey, (string | number)[] | undefined>)[lk] ??= []);
      for (const x of got) if (!list.includes(x)) list.push(x);
    }
  }
  const free = words.join(" ").trim();
  if (free) filter.text = free;
  return { filter, errors, ...(order ? { order } : {}) };
}

/** One `order:` token's order, or what is wrong with it. The last one in a query wins, as a later word overrides. */
function orderOf(t: Token, text: string): { order: OrderBy } | { error: QueryError } {
  const keyName = text.slice(t.start + (t.neg ? 1 : 0), t.keyEnd - 1);
  const values = t.values.filter((v) => v.text || v.quoted);
  if (t.neg) return { error: { message: `"-${keyName}:" is not supported: an order is one of ${Object.values(ORDER_WORDS).join(", ")}`, start: t.start, end: t.keyEnd, suggestions: [] } };
  // Bare `order:` offers every order: there are few, and none is a name to remember.
  if (!values.length) return { error: { message: `"${keyName}:" needs a value`, start: t.keyEnd, end: t.end, suggestions: Object.values(ORDER_WORDS) } };
  if (values.length > 1) return { error: { message: `"${keyName}:" takes one order`, start: values[1]!.start, end: t.end, suggestions: [] } };
  const v = values[0]!;
  const order = ORDER_BY_WORD.get(v.text.toLowerCase());
  if (order) return { order };
  return { error: { message: `No order named "${v.text}"`, start: v.start, end: v.end, suggestions: suggest(v.text, Object.values(ORDER_WORDS)) } };
}

/** The query names an order (`order:` or `sort:`), right or wrong: a screen keeps its order while one is being typed. */
export function namesOrder(text: string): boolean {
  return tokenize(text).some((t) => t.key !== null && (ORDER_KEYS as readonly string[]).includes(t.key));
}

/** The query with its order set to `order`, or taken out with null: the other words stay as they were typed. */
export function withOrder(text: string, order: OrderBy | null): string {
  const kept = tokenize(text)
    .filter((t) => !(t.key !== null && (ORDER_KEYS as readonly string[]).includes(t.key)))
    .map((t) => t.raw);
  return [...kept, ...(order ? [`${ORDER_KEYS[0]}:${ORDER_WORDS[order]}`] : [])].join(" ");
}

// ── format ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A Filter as query text, keys in canonical order, then the order if one is given, the free text last.
 * parseQuery(formatQuery(f, ctx, o)) gives f and o back.
 */
export function formatQuery(filter: Filter, ctx: QueryContext, order?: OrderBy): string {
  const parts: string[] = [];
  for (const key of KEY_ORDER) {
    const name = QUERY_KEYS[key][0]!;
    if (DATE_KEYS.has(key)) {
      const range = filter[key as DateKey];
      const s = range ? formatDateRange(range) : "";
      if (s) parts.push(`${name}:${s}`);
      continue;
    }
    for (const [prefix, from] of [["", filter], ["-", filter.not]] as const) {
      const values = from?.[key as ListKey] as (string | number)[] | undefined;
      if (!values || values.length === 0) continue;
      const out: string[] = [];
      for (const v of values) {
        const s = formatListValue(key as ListKey, v, ctx);
        if (!out.includes(s)) out.push(s);
      }
      parts.push(`${prefix}${name}:${out.join(",")}`);
    }
  }
  if (order) parts.push(`${ORDER_KEYS[0]}:${ORDER_WORDS[order]}`);
  if (filter.text?.trim()) parts.push(formatText(filter.text));
  return parts.join(" ");
}

/** Free text as it reads back as free text: a word that starts with a short form's sign goes in quotes ("#123"). */
function formatText(text: string): string {
  return tokenize(text)
    .map((t) => (t.key !== null && !t.raw.includes('"') ? `"${t.raw}"` : t.raw))
    .join(" ");
}

function formatListValue(key: ListKey, v: string | number, ctx: QueryContext): string {
  switch (key) {
    case "project":
      return ctx.projects?.get(v as string)?.key ?? String(v);
    case "priority":
      return PRIORITY_KEYWORDS[v as number] ?? String(v);
    case "stateGroup":
      return String(v);
    case "state": {
      const s = ctx.states.get(v as string);
      return s ? formatValue(s.name) : String(v);
    }
    case "label": {
      if (v === "none") return "none";
      const l = ctx.labels.get(v as string);
      return l ? formatValue(l.name, ["none"]) : String(v);
    }
    case "assignee":
    case "createdBy":
    case "delegate": {
      if (v === "me" || v === "none" || v === "any") return v;
      const u = ctx.users.get(v as string);
      return u ? formatValue(u.name, ["me", "none", "any"]) : String(v);
    }
    case "cycle": {
      if (CYCLE_WORDS.includes(v as string)) return String(v);
      const c = ctx.cycles?.get(v as string);
      return c ? formatValue(c.name, CYCLE_WORDS) : String(v);
    }
    case "parent": {
      const parent = PARENT_WORDS.includes(v as string) ? undefined : ctx.issues?.get(v as string);
      return parent ? ctx.issueKey(parent) : String(v);
    }
    case "is":
    case "has":
      return String(v);
  }
}

/**
 * The query names `parent:`, `has:` or an `is:` that reads other issues: a caller that loads other issues (and their
 * links) only on demand has to load them first. `is:duplicate` reads the issue's own field and needs nothing.
 */
export function needsIssueIndex(text: string): boolean {
  return tokenize(text).some((t) => {
    const key = t.key && KEY_BY_NAME.get(t.key);
    if (key === "is") return t.values.some((v) => !IS_OWN_WORDS.includes(v.text.toLowerCase()));
    return key === "parent" || key === "has";
  });
}

/** True when the filter filters nothing. */
export function isEmptyFilter(f: Filter): boolean {
  for (const k of KEY_ORDER) {
    const v = f[k] as unknown[] | DateRange | undefined;
    if (Array.isArray(v) ? v.length > 0 : v && (v.from || v.to || v.preset)) return false;
    if ((f.not?.[k as ListKey]?.length ?? 0) > 0) return false;
  }
  return !f.text?.trim();
}
