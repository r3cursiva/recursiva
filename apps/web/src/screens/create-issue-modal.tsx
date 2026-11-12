// The new issue panel, after the LedgerNewIssue artboard (LedgerPhoneNew on a phone): project, title, description, property
// chips, files, "Create more", ⌘/Ctrl+Enter. The issue appears in the list at once (createIssue is optimistic) and reads
// "KEY-?" until the server numbers it. What is typed is kept as a draft (create-draft.ts): closing the panel keeps it, Cancel
// drops it. Under the title, similar open issues from the local pool (similar-issues.tsx, PLNR-295). Start date and Parent have
// no chip on the artboard; they stay, after the chips it has.
import { ArrowsClockwiseIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon, CalendarBlankIcon, CalendarCheckIcon, CaretDownIcon, CellSignalFullIcon, PaperclipIcon, TagIcon, TreeStructureIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { TITLE_MAX, cleanName, defaultState, priorityName, type DocJSON, type IssuePatch } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { ColorDot } from "@rsva/ui/components/color-chip";
import { Dialog, DialogContent, DialogTitle } from "@rsva/ui/components/dialog";
import { Kbd } from "@rsva/ui/components/kbd";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { SearchSelect } from "@rsva/ui/components/search-select";
import { Switch } from "@rsva/ui/components/switch";
import { Textarea } from "@rsva/ui/components/textarea";
import { Hint } from "@rsva/ui/components/tooltip";
import { NoAvatar, UserAvatar, UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { faceOf } from "../lib/face.ts";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import type { EditorHandle } from "@rsva/editor/editor";
import { useEffect, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { formatDate } from "@rsva/display/time";
import { useIsPhone } from "../lib/phone.ts";
import type { Uploaded } from "../lib/upload.ts";
import { store } from "../store.ts";
import { DatePopup, DatePresetMenu } from "./date-calendar.tsx";
import { dropDraft, saveDraft } from "./create-draft.ts";
import { createIssue } from "./create-state.ts";
import { submitKeys } from "./form-keys.ts";
import { listView } from "./list-view.ts";
import { notice } from "./notice.ts";
import { RemoveButton } from "./panel-section.tsx";
import { ModalDescription } from "./rich-editors.tsx";
import { SimilarIssues } from "./similar-issues.tsx";
import { AssigneesPicker, CyclePicker, IssuePicker, LabelsPicker, PriorityPicker, StatePicker } from "./pickers.tsx";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { StateGlyph } from "./state-glyph.tsx";
import { useFilePicker } from "./file-picker.tsx";

type Draft = Required<Pick<IssuePatch, "stateId" | "priority" | "assigneeIds" | "labelIds" | "startDate" | "dueDate" | "parentId" | "cycleId">>;

function emptyDraft(projectId: string, defaults: IssuePatch): Draft {
  return {
    stateId: defaultState(store.statesOf(projectId))?.id ?? "",
    priority: 0,
    assigneeIds: [],
    labelIds: [],
    startDate: null,
    dueDate: null,
    parentId: null,
    cycleId: null,
    ...defaults,
  } as Draft;
}

/** A new issue has no sub-issues yet: any issue of the project may be its parent. */
const none = (): ReadonlySet<string> => new Set();

/** The pause in typing before the draft is written. */
const DRAFT_IDLE_MS = 300;

export const CreateIssueModal = observer(function CreateIssueModal() {
  const projectId = createIssue.projectId;
  if (!projectId) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && createIssue.close()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "top-[100px] max-w-[calc(100%-2rem)] translate-y-0 gap-0 p-0 text-sm md:max-h-[calc(100dvh-116px)] md:max-w-[720px] md:overflow-y-auto md:border md:border-rule md:text-[13px] md:leading-[1.4] md:shadow-modal md:ring-0 md:data-open:duration-300 md:data-open:ease-[cubic-bezier(0.3,0.7,0.3,1.2)] md:data-open:zoom-in-98 md:data-open:slide-in-from-bottom-3.5",
          createIssue.expanded && "md:top-8 md:bottom-8 md:max-h-none md:max-w-[min(1080px,calc(100%-4rem))] md:grid-rows-[minmax(0,1fr)]",
        )}
        aria-describedby={undefined}
      >
        <Form projectId={projectId} />
      </DialogContent>
    </Dialog>
  );
});

const Form = observer(function Form({ projectId }: { projectId: string }) {
  const [draft, setDraft] = useState(() => emptyDraft(projectId, createIssue.defaults));
  const [title, setTitle] = useState(() => createIssue.prefill?.title ?? "");
  const [more, setMore] = useState(false);
  const [held, setHeld] = useState<Uploaded[]>(() => createIssue.prefill?.files ?? []);
  const [initialDescription] = useState(() => createIssue.prefill?.description ?? null);
  const [saved, setSaved] = useState(createIssue.restored);
  const [calendar, setCalendar] = useState<{ field: "startDate" | "dueDate"; el: HTMLButtonElement } | null>(null);
  /** The chip whose value just changed flashes. */
  const [flash, setFlash] = useState<string | null>(null);
  /** On a phone Create stays pressable, and an empty title answers with this line and a shake. */
  const [missing, setMissing] = useState(false);
  const [shaking, setShaking] = useState(false);
  const phone = useIsPhone();
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const picker = useFilePicker((files) => description.current?.addFiles(files));
  const dueChip = useRef<HTMLButtonElement>(null);
  const description = useRef<EditorHandle | null>(null);
  const descriptionDoc = useRef<DocJSON | null>(initialDescription);
  const project = store.projects.get(projectId);
  const state = store.states.get(draft.stateId);
  const assignees = draft.assigneeIds.map((id) => faceOf(id));
  const labels = draft.labelIds.map((id) => store.labels.get(id)).filter((l) => l !== undefined);
  const parent = draft.parentId ? store.issues.get(draft.parentId) : undefined;
  const cycle = draft.cycleId ? store.cycles.get(draft.cycleId) : undefined;
  const canCreate = !!cleanName(title);

  const writing = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Only what this panel saved or read: one opened on a preset never read the draft and must not lose it.
  const forget = () => {
    clearTimeout(writing.current);
    writing.current = undefined;
    if (saved) dropDraft();
    setSaved(false);
  };
  const writeDraft = () => {
    if (!title.trim() && !descriptionDoc.current) return forget();
    clearTimeout(writing.current);
    writing.current = undefined;
    saveDraft({ projectId, title, description: descriptionDoc.current, fields: draft, files: held });
    setSaved(true);
  };
  const latestWrite = useRef(writeDraft);
  latestWrite.current = writeDraft;
  const changed = () => {
    clearTimeout(writing.current);
    writing.current = setTimeout(() => latestWrite.current(), DRAFT_IDLE_MS);
  };
  // Closing inside the pause still saves.
  useEffect(() => () => void (writing.current !== undefined && latestWrite.current()), []);

  const set = (patch: Partial<Draft>, chip: string) => {
    setDraft((d) => ({ ...d, ...patch }));
    setFlash(chip);
    changed();
  };
  const hold = (file: Uploaded) => {
    setHeld((h) => (h.some((f) => f.sha256 === file.sha256) ? h : [...h, file]));
    changed();
  };

  /** What belongs to the project starts over; the text, priority, people and dates carry on. */
  const moveTo = (id: string) => {
    createIssue.setProject(id);
    setDraft(({ priority, assigneeIds, startDate, dueDate }) => ({ ...emptyDraft(id, {}), priority, assigneeIds, startDate, dueDate }));
    changed();
  };

  const submit = () => {
    const t = cleanName(title);
    if (!t || !draft.stateId) {
      setMissing(true);
      setShaking(true);
      titleRef.current?.focus();
      return;
    }
    const h = description.current;
    const issue = store.createIssue(projectId, { ...draft, title: t }, h && !h.isEmpty() ? (h.getDoc() as DocJSON) : null);
    for (const file of held) store.addFile(issue.id, file, file.name);
    listView.select(issue.id);
    // The list renders it on top of its group in the same frame; bring it into view.
    requestAnimationFrame(() => document.querySelector(`[data-issue="${issue.id}"]`)?.scrollIntoView({ block: "nearest" }));
    notice.showCreated(t, issue.id);
    forget();
    if (more) {
      setTitle("");
      setHeld([]);
      h?.setDoc(null);
      descriptionDoc.current = null;
      titleRef.current?.focus();
    } else {
      createIssue.close();
    }
  };

  const cancel = () => {
    forget();
    createIssue.close();
  };

  return (
    // On a phone the sheet of the LedgerPhoneNew artboard: Cancel, the project and Create in one bar on top, in reach above
    // the keyboard. The same elements in a grid: their rows dissolve (`contents`) and each takes its place.
    <form {...submitKeys(submit)} className={cn("max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:items-center", createIssue.expanded && "md:flex md:min-h-0 md:flex-col")}>
      <div className="flex items-center gap-2 pt-3 pr-3 pl-4 max-md:contents">
        <div className="flex min-w-0 items-center gap-2 max-md:col-start-2 max-md:row-start-1 max-md:justify-center max-md:gap-1.5">
          <SearchSelect
            placeholder="Project…"
            options={store.projectList().map((p) => ({ value: p.id, label: p.name, icon: <ProjectIcon project={p} className="size-4" /> }))}
            value={projectId}
            onChange={moveTo}
            trigger={
              <ChipButton set className="h-[26px] min-w-0 pr-2 pl-1 max-md:h-11 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:px-1 max-md:text-ink-3">
                {project && <ProjectIcon project={project} className="size-[18px] rounded-[5px] text-[10px]" />}
                <span className="truncate">{project?.name}</span>
                <CaretDownIcon className="size-[11px] max-md:hidden" />
              </ChipButton>
            }
          />
          <span aria-hidden className="text-ink-3">
            ›
          </span>
          <DialogTitle className="text-[13px] whitespace-nowrap">New issue</DialogTitle>
        </div>
        {saved && <span className="ml-2 font-mono text-[11px] text-ink-3 max-md:hidden">draft saved</span>}
        <div className="ml-auto flex items-center gap-2 max-md:hidden">
          <PanelIconButton label={createIssue.expanded ? "Back to the panel" : "Open as full page"} onClick={() => createIssue.toggleExpanded()}>
            {createIssue.expanded ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
          </PanelIconButton>
          <PanelIconButton label="Close" onClick={() => createIssue.close()}>
            <XIcon />
          </PanelIconButton>
        </div>
      </div>
      <div className={cn("flex flex-col gap-1.5 px-4 pt-3.5 pb-1.5 max-md:col-span-3 max-md:row-start-2 max-md:gap-2 max-md:px-5", createIssue.expanded && "md:min-h-0 md:flex-1")}>
        <Textarea
          ref={titleRef}
          autoFocus
          rows={1}
          aria-label="Title"
          aria-invalid={missing}
          aria-describedby={missing ? "new-issue-title-error" : undefined}
          placeholder="Issue title"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => {
            setTitle(e.target.value);
            setMissing(false);
            changed();
          }}
          onKeyDown={(e) => {
            // A title is one line: Enter saves, as in Plane.
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="min-h-[34px] rounded-none border-0 bg-transparent px-0 py-1 text-[19px] leading-[26px] font-semibold tracking-[-0.01em] shadow-none focus-visible:ring-0 aria-invalid:ring-0 md:text-[19px] md:leading-[26px] max-md:min-h-[52px] max-md:rounded-none max-md:px-0 max-md:py-0 max-md:text-[20px] max-md:leading-[1.3] dark:bg-transparent"
        />
        {missing && (
          <p id="new-issue-title-error" className="flex animate-in items-center gap-1.5 text-[13px] text-error duration-200 fade-in-0 slide-in-from-top-1 md:hidden">
            <WarningCircleIcon className="size-3.5 shrink-0" />
            Add a title to create the issue
          </p>
        )}
        <SimilarIssues
          title={title}
          projectId={projectId}
          onOpen={() => {
            // Opening an issue closes the panel; what was typed stays in the draft for the next "new issue".
            latestWrite.current();
            createIssue.close();
          }}
        />
        <ModalDescription
          initial={initialDescription}
          editorRef={description}
          expanded={createIssue.expanded}
          onSubmit={submit}
          onChange={(h) => {
            descriptionDoc.current = h.isEmpty() ? null : (h.getDoc() as DocJSON);
            changed();
          }}
          onFile={hold}
        />
      </div>
      <div
        // Popups are this row's children in React's tree: their animations end here too.
        onAnimationEnd={(e) => e.animationName === "chip-flash" && setFlash(null)}
        className="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-3.5 max-md:no-scrollbar max-md:col-span-3 max-md:row-start-3 max-md:flex-nowrap max-md:gap-2 max-md:overflow-x-auto max-md:px-5 max-md:pb-3"
      >
        <StatePicker
          projectId={projectId}
          value={draft.stateId}
          onChange={(stateId) => set({ stateId }, "state")}
          trigger={
            <ChipButton set flash={flash === "state"}>
              {state && <StateGlyph state={state} />}
              {state?.name ?? "State"}
            </ChipButton>
          }
        />
        <PriorityPicker
          value={draft.priority}
          onChange={(priority) => set({ priority }, "priority")}
          trigger={
            <ChipButton set={draft.priority !== 0} flash={flash === "priority"}>
              {draft.priority ? <PriorityIcon priority={draft.priority} /> : <CellSignalFullIcon aria-hidden weight="bold" className="text-rule-strong" />}
              {priorityName(draft.priority)}
            </ChipButton>
          }
        />
        <AssigneesPicker
          value={draft.assigneeIds}
          onChange={(assigneeIds) => set({ assigneeIds }, "assignees")}
          trigger={
            <ChipButton set={assignees.length > 0} flash={flash === "assignees"}>
              {assignees.length === 0 && <NoAvatar className="size-[18px] border-rule-strong" />}
              {assignees.length === 1 && <UserAvatar {...assignees[0]!} className="size-[18px]" />}
              {assignees.length > 1 ? <UserAvatarStack people={assignees} /> : (assignees[0]?.name ?? "Assignee")}
            </ChipButton>
          }
        />
        <LabelsPicker
          projectId={projectId}
          value={draft.labelIds}
          onChange={(labelIds) => set({ labelIds }, "labels")}
          trigger={
            <ChipButton set={labels.length > 0} flash={flash === "labels"}>
              {labels.length === 0 ? (
                <>
                  <TagIcon className="size-3 text-ink-3" /> Labels
                </>
              ) : (
                labels.map((l) => (
                  <span key={l.id} className="flex items-center gap-1">
                    <ColorDot color={l.color} />
                    {l.name}
                  </span>
                ))
              )}
            </ChipButton>
          }
        />
        {/* Pre-filled when the panel opens from a cycle's page (PLNR-63); shown when the project has cycles at all. */}
        {(cycle || store.cyclesOf(projectId).some((c) => !c.completedAt)) && (
          <CyclePicker
            projectId={projectId}
            value={draft.cycleId}
            onChange={(cycleId) => set({ cycleId }, "cycle")}
            trigger={
              <ChipButton set={!!cycle} flash={flash === "cycle"}>
                <ArrowsClockwiseIcon className="size-3 text-ink-3" /> {cycle?.name ?? "Cycle"}
              </ChipButton>
            }
          />
        )}
        <ChipButton set={!!draft.startDate} flash={flash === "start"} onPick={(el) => setCalendar({ field: "startDate", el })}>
          <CalendarBlankIcon className="size-3 text-ink-3" />
          {draft.startDate ? formatDate(draft.startDate) : "Start date"}
        </ChipButton>
        <DatePresetMenu
          projectId={projectId}
          cycleId={draft.cycleId}
          onPick={(dueDate) => set({ dueDate }, "due")}
          onCalendar={() => dueChip.current && setCalendar({ field: "dueDate", el: dueChip.current })}
          trigger={
            <ChipButton ref={dueChip} set={!!draft.dueDate} flash={flash === "due"}>
              <CalendarCheckIcon className="size-3 text-ink-3" />
              {draft.dueDate ? formatDate(draft.dueDate) : "Due date"}
            </ChipButton>
          }
        />
        {calendar && (
          <DatePopup
            name={calendar.field === "startDate" ? "Start date" : "Due date"}
            anchor={calendar.el}
            value={draft[calendar.field]}
            onChange={(day) => set({ [calendar.field]: day }, calendar.field === "startDate" ? "start" : "due")}
            onClose={() => setCalendar(null)}
          />
        )}
        <IssuePicker
          projectId={projectId}
          exclude={none}
          value={draft.parentId}
          onChange={(parentId) => set({ parentId }, "parent")}
          placeholder="Set parent…"
          trigger={
            <ChipButton set={!!parent} flash={flash === "parent"} className="max-w-64">
              <TreeStructureIcon className="size-3 text-ink-3" />
              {parent ? <span className="truncate">{store.issueKey(parent)} {parent.title}</span> : "Parent"}
            </ChipButton>
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-2.5 border-t border-rule-soft py-2.5 pr-3 pl-4 max-md:contents">
        <div className="flex min-w-0 items-center gap-2.5 max-md:col-span-3 max-md:row-start-4 max-md:flex-wrap max-md:border-t max-md:border-rule max-md:px-5 max-md:pt-1 max-md:text-[13px] max-md:text-ink-3">
          {picker.field}
          <Hint label="Attach files">
            <Button type="button" variant="ghost" size="icon-lg" aria-label="Attach files" className="rounded-[7px] max-md:h-11 max-md:w-auto max-md:gap-2.5 max-md:bg-transparent max-md:px-0 max-md:text-[13px] max-md:font-normal max-md:text-ink-3" onClick={picker.pick}>
              <PaperclipIcon className="size-[15px] max-md:size-4" />
              <span className="md:hidden">Attach</span>
            </Button>
          </Hint>
          {held.length === 0 && <span className="text-[12px] text-ink-3 max-md:hidden">or paste images</span>}
          {held.map((file) => (
            <span key={file.sha256} className="flex min-w-0 items-center gap-1 text-[12px] text-ink-2">
              <span className="max-w-36 truncate">{file.name}</span>
              <RemoveButton
                label={`Remove ${file.name}`}
                className="opacity-100"
                onClick={() => {
                  setHeld((h) => h.filter((f) => f.sha256 !== file.sha256));
                  changed();
                }}
              />
            </span>
          ))}
          {saved && <span className="ml-auto md:hidden">Draft saved</span>}
        </div>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2 select-none max-md:hidden">
          <Switch checked={more} onCheckedChange={setMore} />
          Create more
        </label>
        <Button type="button" variant="outline" className="h-8 rounded-[7px] px-3 text-[13px] max-md:col-start-1 max-md:row-start-1 max-md:ml-2 max-md:h-11 max-md:justify-self-start max-md:border-0 max-md:bg-transparent max-md:px-3 max-md:text-[15px] max-md:font-normal max-md:text-ink-2" onClick={cancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!phone && !canCreate}
          onAnimationEnd={() => setShaking(false)}
          className={cn("h-8 gap-2 rounded-[7px] px-3 text-[13px] disabled:opacity-45 max-md:col-start-3 max-md:row-start-1 max-md:mr-3 max-md:h-11 max-md:justify-self-end max-md:rounded-xl max-md:px-[18px] max-md:text-[15px]", shaking && "motion-safe:animate-shake")}
        >
          <span className="max-md:hidden">Create issue</span>
          <span className="md:hidden">Create</span>
          <span aria-hidden className="flex max-md:hidden">
            <Kbd className="border-0 p-0 text-current opacity-65">{keys("mod", "↵")}</Kbd>
          </span>
        </Button>
      </div>
    </form>
  );
});

function PanelIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Hint label={label}>
      <Button type="button" variant="ghost" aria-label={label} className="h-8 w-[30px] rounded-[7px] p-0" onClick={onClick}>
        {children}
      </Button>
    </Hint>
  );
}

/** A property chip of the panel. `set` when it holds a value: then it reads in full ink. Pickers render it as their trigger and pass their props (handlers, ref) through. */
export function ChipButton({ children, onPick, set, flash, className, ...props }: ComponentProps<typeof Button> & { children: ReactNode; onPick?: (el: HTMLButtonElement) => void; set?: boolean; flash?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn("gap-[7px] rounded-[7px] bg-transparent font-normal text-ink-2 aria-expanded:border-ink max-md:h-9 max-md:shrink-0 max-md:rounded-full max-md:px-3 max-md:text-[13px]", set && "text-ink", flash && "motion-safe:animate-chip-flash", className)}
      {...props}
      {...(onPick ? { onClick: (e: MouseEvent<HTMLButtonElement>) => onPick(e.currentTarget) } : {})}
    >
      {children}
    </Button>
  );
}
