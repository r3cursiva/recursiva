// Copies of shared patterns that jscpd cannot see (RSVA-432). jscpd compares token streams, and a regex literal or a long
// class string is one token, so a copy of one never reaches its 50-token threshold. Each rule here names a pattern, the
// module that is its home, and the helper to use instead; a line elsewhere that holds the pattern is a copy. A copy
// that has to stay goes into ALLOWED with its reason.
//
// A rule is a line test, not a parse: a few regexes over every source line take a fraction of a second, where a parser
// would cost a dependency (TypeScript 7 has no JS API) and seconds. A rule that needs another shape of test (a JSX tag,
// RSVA-124's raw <select>) is one more entry with its own `matches` and `scope`.

export interface Rule {
  id: string;
  /** What a copy is, for the message. */
  what: string;
  /** What to use instead, and where it lives. */
  use: string;
  /** The files that may hold the pattern: its home. */
  home: readonly string[];
  /** When set, only files under these path prefixes are checked. */
  scope?: readonly string[];
  /** Whether a source line holds the pattern. */
  matches: (line: string) => boolean;
}

/** A file that may keep this many copies, and why. More fails, and so does fewer: the entry is then out of date. */
export interface Allowed {
  rule: string;
  file: string;
  count: number;
  reason: string;
}

export interface SourceFile {
  path: string;
  text: string;
}

export interface Copy {
  rule: Rule;
  file: string;
  line: number;
  text: string;
}

/** A whole issue key spelled out as a regex: a letter class, maybe a letters-and-digits class, a dash, digits. */
const KEY_SHAPE = /\[(?:A-Z|a-z|A-Za-z)\](?:\[(?:A-Z0-9|a-z0-9|A-Za-z0-9)\])?(?:[*+?]|\{\d*,?\d*\})?(?:\\{1,2})?-(?:\\{1,2}d|\[[0-9]-9\])/;

/** An "s" added by hand: `n === 1 ? "" : "s"` and `n !== 1 ? "s" : ""`. */
const PLURAL_SUFFIX = /===\s*1\s*\?\s*(["'`])\1\s*:\s*(["'`])s\2|!==\s*1\s*\?\s*(["'`])s\3\s*:\s*(["'`])\4/;

/**
 * A count and its word in either form, written out: `${n} ${n === 1 ? "issue" : "issues"}`, the same in JSX, and with
 * words between ("{n} work {n === 1 ? "item" : "items"}"). The count's expression has to be the same on both sides.
 */
const PLURAL_WORD = /\{([^{}]+)\}((?:\s+[A-Za-z]+)*)\s+\$?\{\s*\1\s*===\s*1\s*\?\s*"([^"]*)"\s*:\s*"\3s"\s*\}/;

const SCHEMA_MODELS = "packages/schema/src/models.ts";
const SCHEMA_UTIL = "packages/schema/src/util.ts";
export const MENU = "packages/ui/src/lib/menu.ts";

/** Class names of a line: whatever stands between spaces and quotes. */
const classesOf = (line: string) => new Set(line.split(/[\s"'`]+/));

/** A class string's rule: a line that holds every class of it, in any order and among others, is a copy. */
function classRule(name: string, value: string): Rule {
  const classes = value.split(/\s+/).filter(Boolean);
  return {
    id: name.toLowerCase().replaceAll("_", "-"),
    what: `the ${name} class string`,
    use: `${name} from @rsva/ui (${MENU})`,
    home: [MENU],
    matches: (line) => {
      if (!line.includes(classes[0]!)) return false;
      const has = classesOf(line);
      return classes.every((c) => has.has(c));
    },
  };
}

/** A string constant's value as its home module writes it: `export const NAME = "…"`. */
export function constantOf(source: string, name: string): string {
  const m = new RegExp(`export const ${name} =\\s*"([^"]+)"`).exec(source);
  if (!m) throw new Error(`${MENU} has no string constant ${name}: update tools/copies/src/copies.ts`);
  return m[1]!;
}

/** The rules; the class strings are read from their home, so a change there moves the rule with it. */
export function rules(menuSource: string): Rule[] {
  return [
    {
      id: "issue-key",
      what: "an issue key pattern",
      use: `ISSUE_KEY (a pattern source) or parseIssueKey from @rsva/schema/models (${SCHEMA_MODELS})`,
      home: [SCHEMA_MODELS],
      matches: (line) => line.includes("-") && KEY_SHAPE.test(line),
    },
    {
      id: "plural",
      what: "a plural written by hand",
      use: `plural(n, word) from @rsva/schema/util (${SCHEMA_UTIL})`,
      home: [SCHEMA_UTIL],
      matches: (line) => line.includes("1") && (PLURAL_SUFFIX.test(line) || PLURAL_WORD.test(line)),
    },
    ...["POPUP_SURFACE", "POPUP_MOTION", "POPUP_SIDES"].map((name) => classRule(name, constantOf(menuSource, name))),
  ];
}

/** The copies in `files`, less those ALLOWED, and the allowances that no longer match what the files hold. */
export function findCopies(files: Iterable<SourceFile>, all: readonly Rule[], allowed: readonly Allowed[]) {
  const found: Copy[] = [];
  for (const { path, text } of files) {
    const apply = all.filter((r) => !r.home.includes(path) && (!r.scope || r.scope.some((p) => path.startsWith(p))));
    if (!apply.length) continue;
    text.split("\n").forEach((line, i) => {
      for (const rule of apply) if (rule.matches(line)) found.push({ rule, file: path, line: i + 1, text: line.trim() });
    });
  }
  const byPlace = new Map<string, Copy[]>();
  for (const c of found) {
    const place = `${c.rule.id} ${c.file}`;
    byPlace.set(place, [...(byPlace.get(place) ?? []), c]);
  }
  const copies: Copy[] = [];
  const stale: { allowed: Allowed; found: number }[] = [];
  const allowedAt = new Map(allowed.map((a) => [`${a.rule} ${a.file}`, a]));
  for (const [place, list] of byPlace) {
    const a = allowedAt.get(place);
    if (!a || list.length > a.count) copies.push(...list);
    else if (list.length < a.count) stale.push({ allowed: a, found: list.length });
  }
  for (const [place, a] of allowedAt) if (!byPlace.has(place)) stale.push({ allowed: a, found: 0 });
  return { copies, stale };
}

/** The report, one line per problem: file:line, what, what to use. */
export function report(copies: readonly Copy[], stale: readonly { allowed: Allowed; found: number }[], allowed: readonly Allowed[]): string[] {
  const out = copies.map((c) => {
    const a = allowed.find((x) => x.rule === c.rule.id && x.file === c.file);
    const over = a ? ` (allowed ${a.count} here)` : "";
    return `${c.file}:${c.line}: ${c.rule.what}${over}; use ${c.rule.use} [${c.rule.id}]\n    ${c.text.slice(0, 160)}`;
  });
  for (const { allowed: a, found } of stale) {
    out.push(`tools/copies/src/allowed.ts: ${a.file} is allowed ${a.count} [${a.rule}] but holds ${found}: ${found ? `lower the count to ${found}` : "remove the entry"}`);
  }
  return out;
}
