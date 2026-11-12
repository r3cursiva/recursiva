// Project › Settings, after the "A · Ledger — project settings" artboard: a page of its own since PLNR-58 (the header
// leads back to the issues, as Esc does), a section nav on the left, the sections on the right, every change saved
// at once through the sync engine (no Save buttons), reverted with a toast if refused.
//
// Only what works is here (owner's decision 2026-10-28): General (name, key, color), Workflow, Labels, Cycles (rollover,
// PLNR-64, after the CyclesAuto artboard's "When a cycle ends"), Archive. The artboard's lead, status, dates, teams,
// members, visibility, estimates, cycle cadence, WIP limits, automations, integrations and delete wait for the features
// behind them; docs/features.md lists them.
import { issueKey, type Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Input } from "@rsva/ui/components/input";
import { tileTone } from "@rsva/ui/components/letter-tile";
import { SettingRow, SettingsSection } from "@rsva/ui/components/settings";
import { Switch } from "@rsva/ui/components/switch";
import { TileColorPicker } from "@rsva/ui/components/tile-color-picker";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useRef, useState } from "react";
import { keyProblem } from "../lib/project-settings.ts";
import { store } from "../store.ts";
import { archiveProject, restoreProject } from "./project-actions.ts";
import { ProjectHeader } from "./project-header.tsx";
import { SaveStatus } from "./save-status.tsx";
import { CommitInput, fieldClass } from "./settings-fields.tsx";
import { LabelsSection } from "./settings-labels.tsx";
import { WorkflowSection } from "./settings-workflow.tsx";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "workflow", label: "Workflow" },
  { id: "labels", label: "Labels" },
  { id: "cycles", label: "Cycles" },
  { id: "archive", label: "Archive" },
] as const;

export const ProjectSettings = observer(function ProjectSettings({ ws, project }: { ws: string; project: Project }) {
  const scroller = useRef<HTMLDivElement>(null);
  const getScroller = useCallback(() => scroller.current, []);
  const current = useCurrentSection(scroller, !!project.archivedAt);
  return (
    <div ref={scroller} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ProjectHeader ws={ws} project={project} page="Settings">
        <SaveStatus page={project.id} className="max-md:hidden" />
      </ProjectHeader>
      {project.archivedAt && (
        <div role="status" className="flex flex-wrap items-center gap-3 border-b bg-group px-8 py-2.5 text-label text-ink-2 max-md:px-4">
          This project is archived: it is not in the sidebar, and its issues stay reachable by key and link.
          <Button variant="outline" className="ml-auto" onClick={() => restoreProject(project)}>
            Restore
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-start gap-x-10 px-8 pt-7 pb-16 max-md:px-4 max-md:pt-5 max-md:pb-10">
        <nav aria-label="Settings sections" className="sticky top-[calc(var(--topbar)+28px)] flex flex-[0_1_180px] flex-col gap-px pt-0.5 max-md:hidden">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              aria-current={current === s.id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                history.replaceState(history.state, "", `#${s.id}`);
              }}
              className="flex h-7 items-center rounded-[5px] px-2.5 text-ink-2 outline-none transition-colors duration-120 hover:bg-row-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-nav-current aria-[current=true]:font-medium aria-[current=true]:text-ink"
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="flex max-w-[780px] min-w-0 flex-[999_1_520px] flex-col gap-10 max-md:flex-[1_1_100%] max-md:gap-8">
          <GeneralSection project={project} />
          <WorkflowSection project={project} scroller={getScroller} />
          <LabelsSection project={project} />
          <CyclesSection project={project} />
          <ArchiveSection project={project} />
        </div>
      </div>
    </div>
  );
});

/**
 * The section the reader is in: the last one whose top has passed the top of the scroller. A scroll listener read in a
 * frame, not an IntersectionObserver: with four sections of very different heights a band of the viewport misses the
 * short ones, and "the last title above the line" is what the nav should say.
 */
function useCurrentSection(scroller: React.RefObject<HTMLDivElement | null>, bannerShown: boolean): string {
  const [current, setCurrent] = useState<string>(SECTIONS[0].id);
  // Opened with #workflow: go there once the sections are drawn.
  useEffect(() => {
    const hash = location.hash.slice(1);
    if (SECTIONS.some((s) => s.id === hash)) document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top + 96;
      let at: string = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const node = document.getElementById(s.id);
        if (node && node.getBoundingClientRect().top <= top) at = s.id;
      }
      // At the very bottom the last section is current even if it is too short to reach the top.
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) at = SECTIONS.at(-1)!.id;
      setCurrent(at);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(update));
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    // Sections also move without a scroll: a state added above (resize) or the archived banner (the effect reruns).
    const resized = new ResizeObserver(onScroll);
    for (const s of SECTIONS) {
      const node = document.getElementById(s.id);
      if (node) resized.observe(node);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      resized.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller, bannerShown]);
  return current;
}

const GeneralSection = observer(function GeneralSection({ project }: { project: Project }) {
  return (
    <SettingsSection id="general" title="General" description="Visible to everyone in the workspace.">
      <SettingRow label="Color" hint="The project's tile in the sidebar and menus.">
        <TileColorPicker
          name={project.key}
          value={project.color}
          autoTone={tileTone(project.key)}
          label="Project color"
          onChange={(color) => store.updateProject(project.id, { color })}
        />
      </SettingRow>
      <SettingRow label="Name" htmlFor="project-name">
        <CommitInput id="project-name" value={project.name} className="max-w-[420px]" onCommit={(name) => store.updateProject(project.id, { name })} />
      </SettingRow>
      <KeyRow project={project} />
    </SettingsSection>
  );
});

/**
 * The key starts every issue key, so a change is a deliberate step (a button), not a save on blur. The old key stays
 * an alias: links and agents that use it keep working (as in Linear; Plane breaks them).
 */
const KeyRow = observer(function KeyRow({ project }: { project: Project }) {
  const [draft, setDraft] = useState(project.key);
  // Follows a rename from elsewhere while there is no edit in progress.
  const [base, setBase] = useState(project.key);
  if (base !== project.key) {
    setBase(project.key);
    if (draft === base) setDraft(project.key);
  }
  const problem = draft === project.key ? null : keyProblem(draft, project, store.projects.values());
  const changed = draft !== project.key;
  const sample = Math.max(1, project.issueCounter);
  const save = () => {
    if (changed && !problem) store.updateProject(project.id, { key: draft });
  };
  return (
    <SettingRow label="Key" hint="Starts every issue key." htmlFor="project-key" top>
      <div className="flex flex-col gap-2">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            id="project-key"
            value={draft}
            maxLength={12}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
            aria-describedby="project-key-note"
            onChange={(e) => setDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(project.key);
            }}
            className={cn(fieldClass, "w-[132px] font-mono text-[13px] tracking-[0.04em] uppercase md:text-[13px] dark:bg-field aria-invalid:ring-0 aria-invalid:ring-ring aria-invalid:focus-visible:ring-2 dark:aria-invalid:border-signal-text dark:aria-invalid:ring-ring")}
          />
          {changed && (
            <>
              <Button type="submit" disabled={!!problem}>
                Change key
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDraft(project.key)}>
                Cancel
              </Button>
            </>
          )}
        </form>
        <p id="project-key-note" className={cn("m-0 text-caption", problem ? "text-signal-text" : "text-ink-3")}>
          {problem ??
            (changed ? (
              <>
                Issues become <span className="font-mono text-ink">{issueKey(draft, sample)}</span>. Links with{" "}
                <span className="font-mono">{issueKey(project.key, sample)}</span> keep working.
              </>
            ) : (
              <>
                Issues read <span className="font-mono text-ink-2">{issueKey(project.key, sample)}</span>
                {project.formerKeys.length > 0 && (
                  <>
                    ; old links with <span className="font-mono">{project.formerKeys.join(", ")}</span> lead here too
                  </>
                )}
                .
              </>
            ))}
        </p>
      </div>
    </SettingRow>
  );
});

/** Rollover: the server completes a cycle once its last day is over and moves its open issues on (sync/rollover.ts). */
const CyclesSection = observer(function CyclesSection({ project }: { project: Project }) {
  const on = !!project.cycleRollover;
  return (
    <SettingsSection id="cycles" title="Cycles" description="When a cycle ends.">
      <SettingRow
        label="Automatic rollover"
        htmlFor="cycle-rollover"
        hint={
          on
            ? "After its last day (UTC) a cycle completes itself and its open issues move to the next cycle; done and canceled ones stay as its record. With no next cycle they wait for one."
            : "Open issues stay in an ended cycle until someone completes it and moves them on."
        }
      >
        <Switch id="cycle-rollover" checked={on} onCheckedChange={(cycleRollover) => store.updateProject(project.id, { cycleRollover })} />
      </SettingRow>
    </SettingsSection>
  );
});

const ArchiveSection = observer(function ArchiveSection({ project }: { project: Project }) {
  const archived = !!project.archivedAt;
  return (
    <SettingsSection id="archive" title="Archive">
      <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2.5 rounded-lg border px-4 py-3.5">
        <span className="flex flex-col gap-[3px]">
          <span className="font-medium">{archived ? "Restore project" : "Archive project"}</span>
          <span className="text-caption text-ink-3">
            {archived
              ? "Puts it back in the sidebar and the project menus."
              : "Hides it from the sidebar and the project menus. Its issues stay reachable by key and link, and you can restore it any time."}
          </span>
        </span>
        <Button variant="outline" onClick={() => (archived ? restoreProject : archiveProject)(project)}>
          {archived ? "Restore" : "Archive"}
        </Button>
      </div>
    </SettingsSection>
  );
});
