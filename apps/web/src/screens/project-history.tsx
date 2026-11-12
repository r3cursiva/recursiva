// The project's History (PLNR-71, PLNR-120; named Timeline 2026-10-30 to 2026-11-08, RSVA-498): one chronology of
// everything that happened to its issues at the level of detail the viewer picks. Drawn after the Timeline artboards of
// the design canvas: a dial of levels with their signal pips, Everyone / Agents / People and a chip per actor, then the
// feed (timeline-feed.tsx) or the cycles at Milestones (timeline-milestones.tsx). The lanes of "As it happened" were
// removed in RSVA-498. The data is the project feed
// (packages/sync/src/project-feed.ts), folded in lib/project-history.ts; creations and cycles come from what the client
// already has. What was taken from the artboards and what was not: docs/research/timeline-artboards-2026-11-01.md.
import { CaretDownIcon } from "@phosphor-icons/react";
import { HISTORY_LEVELS, type HistoryLevel } from "@rsva/protocol";
import type { Project, User } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Segmented } from "@rsva/ui/components/segmented";
import { Separator } from "@rsva/ui/components/separator";
import { Skeleton } from "@rsva/ui/components/skeleton";
import { SearchSelect, SearchSelectAction } from "@rsva/ui/components/search-select";
import { AgentAvatar, UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { cn } from "@rsva/ui/lib/utils";
import { Hint } from "@rsva/ui/components/tooltip";
import { makeAutoObservable, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useRef, type ReactNode, type RefObject } from "react";
import { localToday } from "@rsva/query";
import { formatDate } from "@rsva/display/time";
import { face } from "../lib/face.ts";
import { readLocal, writeLocal } from "../lib/local-storage.ts";
import { cycleDays } from "../lib/project-milestones.ts";
import { foldHistory, stepsOf, type Who } from "../lib/project-history.ts";
import { typing } from "../lib/typing.ts";
import { store } from "../store.ts";
import { PersonFace } from "./actor.tsx";
import { SettingsLink } from "./layout-switch.tsx";
import { stepIn, stepKey } from "../lib/step-keys.ts";
import { useWindowKeys } from "./list-keys.ts";
import { ProjectHeader } from "./project-header.tsx";
import { AgentMark, Chronology, PersonMark, isAgent, stateKind } from "./timeline-feed.tsx";
import { Milestones } from "./timeline-milestones.tsx";

/** The page's levels: Milestones comes from the cycles in the pool, the others from the feed of the same name. */
type Level = "milestones" | HistoryLevel;
const ALL_LEVELS: readonly Level[] = ["milestones", ...HISTORY_LEVELS];

const LEVELS: readonly { value: Level; label: string; hint: string }[] = [
  { value: "milestones", label: "Milestones", hint: "Cycle starts and ends" },
  { value: "outcomes", label: "Outcomes", hint: "Issues created and closed, pull requests merged, reviews and approvals. An issue's day folds into one line." },
  { value: "steps", label: "Steps", hint: "Every move, assignment, comment and pull request, by issue" },
  { value: "everything", label: "Everything", hint: "The full log, every field change too" },
];

const WHO = [
  { value: "all", label: "Everyone" },
  { value: "agents", label: "Agents", icon: <AgentMark /> },
  { value: "people", label: "People", icon: <PersonMark /> },
] as const satisfies readonly { value: Who; label: string; icon?: ReactNode }[];

/** The viewer's choice, the same in every project, kept in this browser; hidden actors last while the page is open. */
class HistoryView {
  level: Level = "outcomes";
  who: Who = "all";
  hidden: ReadonlySet<string> = new Set();
  constructor() {
    makeAutoObservable(this);
    const saved = readLocal(KEY) as { level?: unknown; who?: unknown } | null;
    if ((ALL_LEVELS as readonly unknown[]).includes(saved?.level)) this.level = saved!.level as Level;
    if (WHO.some((w) => w.value === saved?.who)) this.who = saved!.who as Who;
    reaction(
      () => ({ level: this.level, who: this.who }),
      (v) => writeLocal(KEY, v),
    );
  }
  setLevel(level: Level): void {
    this.level = level;
  }
  setWho(who: Who): void {
    this.who = who;
  }
  /** A or P again goes back to everyone. */
  flipWho(who: Who): void {
    this.who = this.who === who ? "all" : who;
  }
  everyone(): void {
    this.who = "all";
    this.hidden = new Set();
  }
  /** Of `actors`, only `shown` stay; the hidden ones outside `actors` (another Who) stay hidden. */
  showOnly(actors: readonly string[], shown: readonly string[]): void {
    const next = new Set(this.hidden);
    for (const a of actors) next.delete(a);
    for (const a of actors) if (!shown.includes(a)) next.add(a);
    this.hidden = next;
  }
}
const KEY = "rsva:history";
const view = new HistoryView();

/** J and K move over the rows on screen, whichever feed drew them; the mark is an attribute, so a step redraws nothing. */
function useRowKeys(area: RefObject<HTMLElement | null>): (e: KeyboardEvent) => boolean {
  const selected = useRef<string | null>(null);
  return (e) => {
    const rows = [...(area.current?.querySelectorAll<HTMLElement>("[data-timeline-row]") ?? [])];
    const at = rows.findIndex((r) => r.dataset.timelineRow === selected.current);
    const row = rows[at];
    const toggle = row?.querySelector<HTMLElement>("[data-timeline-toggle]");
    const open = toggle?.getAttribute("aria-expanded") === "true";
    const by = stepKey(e.key);
    if (by) {
      const next = stepIn(rows, at, by);
      if (!next) return false;
      row?.removeAttribute("data-selected");
      next.setAttribute("data-selected", "");
      selected.current = next.dataset.timelineRow ?? null;
      next.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (!toggle || (e.key === "ArrowRight") === open) return false;
      toggle.click();
    } else if (e.key === "Enter" && row) {
      if (toggle && !open) toggle.click();
      else row.querySelector("a")?.click();
    } else return false;
    return true;
  };
}

export const ProjectHistory = observer(function ProjectHistory({ ws, project }: { ws: string; project: Project }) {
  const milestones = view.level === "milestones";
  const feed = milestones ? null : store.projectHistory(project.id, view.level as HistoryLevel);
  const now = new Date();
  const area = useRef<HTMLElement>(null);
  const rowKeys = useRowKeys(area);

  useWindowKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    const at = ALL_LEVELS.indexOf(view.level);
    const k = e.key.toLowerCase();
    const next = /^[1-4]$/.test(k) ? Number(k) - 1 : k === "=" ? at + 1 : k === "-" ? at - 1 : -1;
    if (ALL_LEVELS[next]) view.setLevel(ALL_LEVELS[next]);
    else if (k === "a" && !e.shiftKey) view.flipWho("agents");
    else if (k === "p" && !e.shiftKey) view.flipWho("people");
    else if (k === "0" && !e.shiftKey) view.everyone();
    else if (!rowKeys(e)) return;
    e.preventDefault();
  });

  // Archived and deleted issues were created in the project too.
  const issues = feed ? [...store.issuesOf(project.id), ...store.issuesOf(project.id, "archived"), ...store.issuesOf(project.id, "deleted")] : [];
  const steps = feed ? stepsOf(issues, feed.entries, feed.comments, feed.older) : [];
  const ready = feed?.status === "ready";
  // The switch means something only when people and agents both acted (or while it is not known yet); else "All" is the view.
  const kinds = steps.flatMap((s) => (s.by ? [isAgent(s.by)] : []));
  const mixed = !ready || (kinds.includes(true) && kinds.includes(false));
  const who = mixed ? view.who : "all";
  const shown = steps.filter((s) => !s.by || !view.hidden.has(s.by));
  const day = localToday();
  const cycles = milestones ? cycleDays(store.cyclesOf(project.id), day) : [];
  const settings = feed ? feed.settings.filter((e) => !e.by || !view.hidden.has(e.by)) : [];
  const days = ready ? foldHistory(shown, { level: view.level as HistoryLevel, who, isAgent, stateKind }, settings) : [];
  const rows = milestones ? cycles.reduce((n, d) => n + d.rows.length, 0) : days.reduce((n, d) => n + d.rows.length, 0);
  const actors = [...new Set(steps.map((s) => s.by).filter((x): x is string => !!x))].filter((a) => who === "all" || (who === "agents") === isAgent(a));
  const counts = new Map<string, number>();
  for (const s of steps) if (s.by) counts.set(s.by, (counts.get(s.by) ?? 0) + 1);
  const span = cycles.length > 1 ? `${formatDate(cycles.at(-1)!.key)} – ${formatDate(cycles[0]!.key)}` : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ground">
      <ProjectHeader ws={ws} project={project}>
        <SettingsLink ws={ws} project={project} />
      </ProjectHeader>
      <div role="toolbar" aria-label="History controls" className="no-scrollbar flex shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2 border-b bg-ground px-[22px] py-2 max-md:flex-nowrap max-md:gap-x-2.5 max-md:overflow-x-auto max-md:bg-panel max-md:px-4">
        <Dial level={view.level} />
        {!milestones && (
          <>
            <Separator aria-hidden orientation="vertical" className="h-[22px] data-vertical:self-center max-md:hidden" />
            {mixed && <Segmented label="Who" variant="quiet" options={WHO} value={view.who} onChange={(w) => view.setWho(w)} />}
            {actors.length > 1 && <ActorFilter actors={actors} counts={counts} />}
          </>
        )}
        <span className="flex-auto max-md:hidden" />
        {span && <span className="font-mono text-[11px] whitespace-nowrap text-ink-3 max-md:hidden">{span}</span>}
        {(milestones || ready) && <span className="font-mono text-[11px] whitespace-nowrap text-ink-3 tabular-nums">{rowCount(view.level, rows)}</span>}
      </div>
      <main ref={area} className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[1060px] pr-7 pb-12 pl-[22px] max-md:px-4">
          {feed?.status === "loading" && <Skeleton className="mt-5 h-4 w-64" />}
          {feed?.status === "error" && <p className="mt-5 text-[13px] text-ink-3">The history could not be loaded. It will retry when you come back to this page.</p>}
          {ready && days.length === 0 && <p className="mt-5 text-[13px] text-ink-3">Nothing has happened in this project yet.</p>}
          {milestones && cycles.length === 0 && (
            <p className="mt-5 text-[13px] text-ink-3">
              No cycles in this project yet.<span className="pointer-coarse:hidden"> Press = for more detail.</span>
            </p>
          )}
          {milestones ? <Milestones days={cycles} today={day} now={now} ws={ws} project={project} /> : <Chronology days={days} now={now} ws={ws} project={project} level={view.level} />}
          {feed?.hasOlder && (
            <Button variant="ghost" size="sm" className="mt-3 ml-[84px] text-ink-3 max-md:ml-0" disabled={feed.loadingOlder} onClick={() => feed.loadOlder()}>
              {feed.loadingOlder ? "Loading older history…" : "Show older history"}
            </Button>
          )}
        </div>
      </main>
      <footer className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t bg-panel px-[22px] py-2 font-mono text-[10.5px] text-ink-3 max-md:hidden">
        <span>1–4 detail</span>
        <span>− = coarser, finer</span>
        <span>A agents · P people · 0 everyone</span>
        <span>J K move</span>
        <span>→ ← expand, collapse</span>
        <span>↵ open issue</span>
      </footer>
    </div>
  );
});

/** The lines on screen in the level's word: "425 outcomes"; the dial no longer carries it, so it keeps one width (RSVA-499). */
function rowCount(level: Level, n: number): string {
  const [one, many] = LEVEL_WORDS[level];
  return `${n} ${n === 1 ? one : many}`;
}
const LEVEL_WORDS: Record<Level, readonly [string, string]> = {
  milestones: ["milestone", "milestones"],
  outcomes: ["outcome", "outcomes"],
  steps: ["step", "steps"],
  everything: ["entry", "entries"],
};

/** The levels as a dial: signal pips that fill up with the detail, the chosen one in ink. */
function Dial({ level }: { level: Level }) {
  const options = LEVELS.map((l, i) => ({
    value: l.value,
    label: l.label,
    icon: (
      <span aria-hidden className="inline-flex items-end gap-0.5">
        {[4, 7, 10, 13].map((h, j) => (
          <i key={h} className="block w-[3px] rounded-[1px] bg-current" style={{ height: h, opacity: j <= i ? 1 : 0.3 }} />
        ))}
      </span>
    ),
  }));
  return (
    <Segmented
      label="Detail"
      variant="dial"
      options={options}
      value={level}
      onChange={(l) => view.setLevel(l)}
      wrap={(radio, i) => <Hint label={`${LEVELS[i]!.hint} (${i + 1})`}>{radio}</Hint>}
    />
  );
}

/**
 * Whose lines show (RSVA-502): one button with up to three faces, opening the actors of the loaded history with a search
 * and a check each, grouped and counted. It stays one control however many there are; a chip per actor wrapped into
 * rows on a wide screen and scrolled sideways on a phone.
 */
const ActorFilter = observer(function ActorFilter({ actors, counts }: { actors: readonly string[]; counts: ReadonlyMap<string, number> }) {
  const users = actors
    .map((id) => store.users.get(id))
    .filter((u): u is User => !!u)
    .sort((a, b) => GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b)) || a.name.localeCompare(b.name));
  const ids = users.map((u) => u.id);
  const hidden = ids.filter((id) => view.hidden.has(id)).length;
  const faces = users.filter((u) => !view.hidden.has(u.id)).map((u) => (u.kind === "human" ? face(u) : { name: u.name, mark: <ActorFace user={u} className="size-5" /> }));
  return (
    <SearchSelect
      multiple
      className="w-64"
      placeholder="Show lines by…"
      options={users.map((u) => ({ value: u.id, label: u.name, icon: <ActorFace user={u} className="size-4" />, group: groupOf(u), meta: counts.get(u.id) ?? 0 }))}
      value={ids.filter((id) => !view.hidden.has(id))}
      onChange={(shown) => view.showOnly(ids, shown)}
      footer={hidden > 0 && <SearchSelectAction onClick={() => view.showOnly(ids, ids)}>Show everyone</SearchSelectAction>}
      trigger={
        <Button variant="outline" size="sm" aria-label={hidden ? `Actors, ${hidden} hidden` : "Actors"} className="shrink-0 rounded-full pl-2 max-md:rounded-full max-md:pl-2.5">
          {faces.length > 0 && <UserAvatarStack people={faces} max={3} />}
          <span className={cn("tabular-nums", hidden ? "text-ink" : "text-ink-2")}>{hidden ? `${hidden} hidden` : users.length}</span>
          <CaretDownIcon className="text-ink-3" />
        </Button>
      }
    />
  );
});

const GROUP_ORDER = ["Agents", "People", "Bots"] as const;
const groupOf = (u: User): (typeof GROUP_ORDER)[number] => (u.kind === "agent" ? "Agents" : u.kind === "bot" ? "Bots" : "People");

/** An actor's face: an agent's square, a bot's mark, a person's avatar. */
function ActorFace({ user, className }: { user: User; className: string }) {
  return user.kind === "agent" ? <AgentAvatar name={user.name} className={className} /> : <PersonFace user={user} className={className} />;
}
