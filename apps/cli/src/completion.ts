// `rsva completion zsh`: a completion script built from the command table, so a new command or flag completes the
// day it is added. Tab asks nothing of the server: commands, the cycle commands, each command's flags, the fixed values
// of flags, arguments and the query language's keys are all in the script. Projects, states and labels would need the
// network on every Tab.
import { STATE_GROUPS } from "@rsva/terminal/issues";

/** What the script knows of a command. */
export interface Completable {
  name: string;
  about: string;
  /** Long names, without dashes. */
  flags: string[];
  /** Takes a query: its words complete to the query language's keys and their fixed values. */
  query: boolean;
  /** Fixed values of the arguments, by position. */
  values: readonly (readonly string[] | undefined)[];
}

/**
 * The query language's keys by their canonical names: the first name of each in QUERY_KEYS of @rsva/query, then
 * ORDER_KEYS' (PLNR-401). Written
 * out, as @rsva/terminal/issues does with the state groups, so the CLI does not load the query package at start; a test keeps the
 * two equal, and the ones below.
 */
export const QUERY_WORDS = ["project", "state", "group", "priority", "assignee", "label", "author", "agent", "cycle", "parent", "is", "has", "start", "due", "created", "updated", "closed", "order"] as const;

/** Priorities as the API and the query name them (PRIORITY_KEYWORDS of @rsva/query). */
export const PRIORITY_WORDS = ["urgent", "high", "medium", "low", "none"] as const;
/** The orders of a list (ORDER_BY_OPTIONS of @rsva/query), the API's default first. */
export const ORDER_WORDS = ["updatedAt", "createdAt", "priority", "dueDate", "startDate", "manual"] as const;
/** The kinds of a relation (RELATION_TYPES of @rsva/schema). */
export const RELATION_WORDS = ["blockedBy", "blocks", "related", "duplicateOf", "duplicates"] as const;
/** Where `cycle complete` moves the open issues besides a cycle. */
export const MOVE_WORDS = ["next", "none"] as const;
/** Relative dates of the query (DATE_PRESETS of @rsva/query). */
const DATE_WORDS = ["today", "yesterday", "tomorrow", "<today", "this-week", "last-week", "next-week", "this-month", "last-month", "next-month", "last-7-days", "last-30-days", "next-7-days", "next-2-weeks", "next-30-days"] as const;

/** What a key of the query takes besides names (`resolve` in parse.ts of @rsva/query); a test parses every one. */
export const QUERY_VALUES: Partial<Record<(typeof QUERY_WORDS)[number], readonly string[]>> = {
  group: STATE_GROUPS,
  priority: PRIORITY_WORDS,
  assignee: ["me", "none"],
  label: ["none"],
  author: ["me"],
  agent: ["any", "none", "me"],
  cycle: ["active", "next", "none"],
  parent: ["none", "any"],
  is: ["blocked", "blocking", "duplicate"],
  has: ["link"],
  start: [...DATE_WORDS, "none"],
  due: [...DATE_WORDS, "none"],
  created: DATE_WORDS,
  updated: DATE_WORDS,
  closed: DATE_WORDS,
  // ORDER_WORDS of @rsva/query: the query's words for the orders, not the --order flag's names.
  order: ["updated", "created", "priority", "due", "start", "manual"],
};

/** A word in single quotes for zsh or any POSIX shell. */
export const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const words = (ws: readonly string[]) => ws.map(quoted).join(" ");
/** The about text up to its first clause: what fits beside a candidate. */
const gist = (about: string) => about.split(/[;.]/)[0]!.trim();
const described = (cs: readonly Completable[]) => cs.map((c) => quoted(`${c.name}:${gist(c.about)}`)).join(" ");

export interface ZshInput {
  commands: readonly Completable[];
  /** The commands under one word, by that word: `cycle`. */
  groups: Record<string, readonly Completable[]>;
  /** A flag's one-letter name, by its long one. */
  shorts: Record<string, string>;
  /** The flags that take a value: the word after one is that value. */
  valued: readonly string[];
  /** Fixed values of a flag, by its long name. */
  flagValues: Record<string, readonly string[]>;
}

export function zsh(o: ZshInput): string {
  const spellings = (f: string) => [`--${f}`, ...(o.shorts[f] ? [`-${o.shorts[f]}`] : [])];
  const all = [...o.commands.map((c) => [c.name, c] as const), ...Object.entries(o.groups).flatMap(([g, cs]) => cs.map((c) => [`${g} ${c.name}`, c] as const))];
  const flagCases = all.map(([name, c]) => `    (${quoted(name)}) flags=(${words(c.flags.flatMap(spellings))}) ;;`).join("\n");
  const argCases = all.flatMap(([name, c]) => c.values.flatMap((vs, n) => (vs?.length ? [`    (${quoted(`${name}:${n}`)}) compadd -- ${words(vs)}; return ;;`] : []))).join("\n");
  const flagValueCases = Object.entries(o.flagValues).map(([f, vs]) => `    (${spellings(f).map(quoted).join("|")}) compadd -- ${words(vs)}; return ;;`).join("\n");
  const groupCases = Object.entries(o.groups)
    .map(
      ([g, cs]) => `    (${quoted(g)})
      sub=(${described(cs)})
      if (( CURRENT == 3 )); then
        _describe -t commands ${quoted(`${g} command`)} sub
        return
      fi
      cmd=${quoted(`${g} `)}$words[3]
      base=3
      ;;`,
    )
    .join("\n");
  const keyed = Object.entries(QUERY_VALUES);
  const keyValueCases = keyed.map(([k, vs]) => `      (${quoted(k)}) compadd -- ${words(vs)} ;;`).join("\n");
  return `#compdef rsva
# Generated by \`rsva completion zsh\`: commands, flags, fixed values and the query's keys; Tab asks nothing of the server.
_rsva() {
  local -a commands sub flags valued query_commands
  local cmd key
  local -i base=2 n=0 i
  commands=(${described(o.commands)})
  valued=(${words(o.valued.flatMap(spellings))})
  query_commands=(${words(all.filter(([, c]) => c.query).map(([name]) => name))})
  if (( CURRENT == 2 )); then
    _describe -t commands 'rsva command' commands
    return
  fi
  cmd=$words[2]
  case $cmd in
${groupCases}
  esac
  # The word after a flag is its value: the fixed ones, or nothing to offer.
  case $words[CURRENT-1] in
${flagValueCases}
  esac
  (( \${valued[(Ie)$words[CURRENT-1]]} )) && return
  case $cmd in
${flagCases}
  esac
  if [[ $PREFIX == --* || $PREFIX == -[a-zA-Z] ]]; then
    compadd -a flags
    return
  fi
  # Which argument this is: the words before it that are neither flags nor their values.
  for (( i = base + 1; i < CURRENT; i++ )); do
    if (( \${valued[(Ie)$words[i]]} )); then (( i++ )); elif [[ $words[i] != -* ]]; then (( n++ )); fi
  done
  case "$cmd:$n" in
${argCases}
  esac
  (( \${query_commands[(Ie)$cmd]} )) || return
  if [[ $PREFIX == (-|)(${keyed.map(([k]) => k).join("|")}):* ]]; then
    key=\${\${PREFIX#-}%%:*}
    compset -P '*[:,]'
    case $key in
${keyValueCases}
    esac
    return
  fi
  compset -P '-'
  compadd -S '' -- ${QUERY_WORDS.map((w) => `${w}:`).join(" ")}
}
if [[ \${zsh_eval_context[-1]} == loadautofunc ]]; then
  _rsva "$@"
else
  compdef _rsva rsva
fi`;
}
