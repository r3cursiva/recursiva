// The View panel (PLNR-74, the ViewsEdit and ViewsSaveDialog artboards): the one place a view is made and saved. It
// slides in at the right, which follows every change at once: on a wide screen beside the list, as a pane of its own
// in the place the screen gives up for it (App.tsx, PLNR-305), narrower over the list. Name and icon, filters (is / is not, with
// counts), the query they make (the same text the URL and agents take), where the view shows, who sees it. Display is a
// popover of its own (ADR 0045), its button in the footer too, as the panel covers the tab row. Save puts it all into
// the view, Display's edits included; closing keeps the edits, marked on the tab, until they are saved or reverted here:
// the panel is the one place a view is saved (owner's call, 2026-10-30). List or Board is no part of a view: it is the
// viewer's own in the tab row (PLNR-78), so it is not here.
// It leaves the same way, drawing what it had while answering nothing, so a press goes straight through it.
// A press outside closes it and still reaches what is under it; so does leaving the page (owner's call, 2026-10-31). A
// new view stays open: closing drops the draft, there is no tab to carry a dot. Scrolling the list keeps it open.
// In the lazy edit chunk; opened from the tab row's View, E, a tab's menu and the views page.
import { CopyIcon, DotsThreeIcon, LinkIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { pinRef, VIEW_ICONS, VIEW_NAME_MAX } from "@rsva/protocol";
import { runQueryRows } from "@rsva/query";
import { cleanName } from "@rsva/schema/models";
import { plural } from "@rsva/schema/util";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Input } from "@rsva/ui/components/input";
import { Kbd, KeyHint } from "@rsva/ui/components/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@rsva/ui/components/popover";
import { Segmented } from "@rsva/ui/components/segmented";
import { Switch } from "@rsva/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@rsva/ui/components/toggle-group";
import { Hint } from "@rsva/ui/components/tooltip";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useState, type ReactNode } from "react";
import { mayEdit, viewLink } from "../lib/views.ts";
import { router } from "../router.ts";
import { store } from "../store.ts";
import { listIssues, queryContext, WS_SCOPE } from "../view-state.ts";
import { copy } from "./issue-actions.ts";
import { FieldRow } from "./menu-parts.tsx";
import { QueryInput } from "./query-input.tsx";
import { createFromPanel, deleteView, revertList, saveList } from "./view-actions.ts";
import { VIEW_ICON, ViewIconGlyph } from "./view-icons.tsx";
import { viewPanel } from "./view-panel-state.ts";
import { FilterLines } from "./view-panel-filters.tsx";
import { DisplayTool } from "./view-tabs.tsx";

export const ViewPanel = observer(function ViewPanel() {
  const panel = viewPanel.leaving ?? viewPanel;
  const leaving = !!viewPanel.leaving;
  const list = panel.list!;
  const project = panel.project;
  const saved = panel.saved;
  const creating = panel.mode === "new";
  const builtIn = !creating && !saved;
  const editable = creating || (saved ? mayEdit(saved) : false);
  const meta = panel.meta;
  const [nameError, setNameError] = useState(false);
  const wsName = store.workspace?.name ?? "the workspace";
  const matched = runQueryRows(listIssues(project?.id ?? null), list.filter, list.display, queryContext(project?.id ?? list.scope)).length;
  // The projects the view would be a tab in: those its Project filter names ("is").
  const named = (list.scope === WS_SCOPE ? (list.filter.project ?? []) : []).map((id) => store.projects.get(id)?.name).filter(Boolean);
  const metaChanged = !!saved && (meta.name !== saved.name || meta.icon !== saved.icon || meta.shared !== saved.shared || meta.tab !== saved.tab);
  // Clear on All issues takes the filters only: Display has its own Reset.
  const dirty = builtIn ? list.filtered : list.edited || metaChanged;

  useEffect(() => {
    if (leaving) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !e.defaultPrevented && !popupOpen()) viewPanel.close();
      else if (creating && mod && e.key === "Enter") submit();
      else if (mod && e.key.toLowerCase() === "s" && e.shiftKey && !creating) viewPanel.create(list, project, saved ?? undefined);
      else if (mod && e.key.toLowerCase() === "s" && !creating && !builtIn && editable && dirty) saveList(list, project);
      else if (mod && e.key.toLowerCase() === "s") {
        // Nothing to save here: no browser "save page" either.
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (creating) return;
    // [role=dialog]: this panel, and the palette or a modal opened over it. [data-view-tools]: List or Board, View and
    // Display in the header, beside the docked panel: the panel follows what they change, as with its own (PLNR-347,
    // RSVA-385); View toggles the panel itself. Capture: a screen may stop the press.
    const onPress = (e: PointerEvent) => {
      if (e.target instanceof Element && !e.target.closest("[role=dialog], [data-view-panel-opener], [data-view-tools]") && !popupOpen()) viewPanel.close();
    };
    addEventListener("pointerdown", onPress, true);
    const offRoute = reaction(
      () => router.path,
      () => viewPanel.close(),
    );
    return () => {
      removeEventListener("pointerdown", onPress, true);
      offRoute();
    };
  }, [creating]);

  const submit = () => {
    if (!cleanName(meta.name)) return setNameError(true);
    createFromPanel();
  };

  const title = creating ? "New view" : builtIn ? "All issues" : "Edit view";
  const sub = creating ? (panel.from?.saved ? `from ${panel.from.saved.name}` : "from what is on screen") : builtIn ? "changes here are temporary" : saved!.name;
  const saveAsNew = () => viewPanel.create(list, project, saved ?? undefined);
  return (
    <aside
      role="dialog"
      aria-label={title}
      data-slot="view-panel"
      data-leaving={leaving || undefined}
      inert={leaving}
      onAnimationEnd={(e) => leaving && e.target === e.currentTarget && viewPanel.left()}
      className="fixed inset-y-0 right-0 z-30 flex w-[min(var(--view-panel-width),100vw)] flex-col bg-panel shadow-pop dock:border-(length:--pane-edge) dock:shadow-none md:inset-y-(--pane-inset) md:right-(--pane-inset) md:overflow-clip md:rounded-(--pane-radius) md:border md:border-frame-line max-md:bottom-(--keyboard) max-md:pt-(--safe-top) max-md:shadow-none"
    >
      <header className="flex h-(--topbar) shrink-0 items-center gap-1 border-b pr-2 pl-4 max-md:h-13 max-md:pr-1">
        <span className="text-label font-semibold max-md:text-[16px]">{title}</span>
        <span className="ml-1 min-w-0 truncate text-caption text-ink-3">{sub}</span>
        {!creating && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon" aria-label="More view actions" className="ml-auto border-0 text-ink-3 max-md:rounded-md transition-none active:scale-100!">
                  <DotsThreeIcon weight="bold" className="size-4 max-md:size-5" />
                </Button>
              }
            />
            <DropdownMenuContent className="w-56" align="end">
              <DropdownMenuItem onClick={saveAsNew}>
                <CopyIcon />
                Save as new view
                <DropdownMenuShortcut>{keys("mod", "shift", "S")}</DropdownMenuShortcut>
              </DropdownMenuItem>
              {saved && (
                <DropdownMenuItem onClick={() => void copy(viewLink(saved, project), "Link")}>
                  <LinkIcon />
                  Copy link
                </DropdownMenuItem>
              )}
              {saved && mayEdit(saved) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => deleteView(saved)}>
                    <TrashIcon />
                    Delete view
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Hint label={<KeyHint label="Close, keep changes" keys="Esc" />}>
          <Button variant="ghost" size="icon" aria-label="Close panel, keep changes (Esc)" onClick={() => viewPanel.close()} className={cn("border-0 text-ink-3 max-md:rounded-md transition-none active:scale-100!", creating && "ml-auto")}>
            <XIcon className="size-4 max-md:size-5" />
          </Button>
        </Hint>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto">
        {builtIn ? (
          <p className="m-0 border-b px-4 py-3 text-caption text-ink-2">All issues is built in, so changes here are temporary. Save them as a new view to keep them.</p>
        ) : (
          <div className="flex flex-col gap-1.5 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <IconPicker disabled={!editable} />
              <Input
                aria-label="Name"
                autoFocus={creating}
                value={meta.name}
                maxLength={VIEW_NAME_MAX}
                disabled={!editable}
                placeholder="View name"
                aria-invalid={nameError || undefined}
                onChange={(e) => (viewPanel.setMeta({ name: e.target.value }), setNameError(false))}
                className="min-w-0 flex-1"
              />
            </div>
            {nameError && <span className="text-caption text-signal-text">Give the view a name.</span>}
          </div>
        )}
        <Part title="Filters" aside={`${plural(matched, "issue")} match`}>
          <FilterLines view={list} project={project} />
          <QueryInput view={list} autoFocus={viewPanel.focusQuery} />
        </Part>
        {!builtIn && (
          <Part title="Sharing">
            <div className="flex flex-col">
              <FieldRow label="Visible to" group>
                <Segmented
                  variant="quiet"
                  label="Who sees it"
                  value={meta.shared ? "everyone" : "me"}
                  onChange={(v) => viewPanel.setMeta({ shared: v === "everyone" })}
                  options={[
                    // Only its owner makes a view private: an admin's edit keeps someone else's shared view shared.
                    { value: "me", label: "Only me", disabled: !editable || (!creating && saved!.ownerId !== store.me?.id) },
                    { value: "everyone", label: "Everyone", title: `Everyone in ${wsName}`, disabled: !editable },
                  ]}
                />
              </FieldRow>
              <FieldRow label={named.length ? `Tab in ${named.join(", ")}` : "Project tab"}>
                <Hint label={named.length === 0 ? "Add a Project filter with “is” to pick the projects it shows in." : named.length > 1 ? `One tab in each of these ${named.length} projects.` : `Next to All issues in ${named[0]}.`}>
                  <span className="flex">
                    <Switch size="sm" aria-label="Show as a project tab" checked={meta.tab && named.length > 0} disabled={!editable || named.length === 0} onCheckedChange={(tab) => viewPanel.setMeta({ tab })} className="disabled:opacity-50" />
                  </span>
                </Hint>
              </FieldRow>
              <FieldRow label="In my favorites">
                <Switch size="sm" checked={creating ? panel.pin : store.views.pinned(pinRef("view", saved!.id))} onCheckedChange={(on) => (creating ? viewPanel.setPin(on) : store.views.pin(pinRef("view", saved!.id), on))} />
              </FieldRow>
            </div>
            {meta.shared && <span className="text-caption text-ink-3">Everyone in {wsName} can open it; you and admins change it.</span>}
          </Part>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2.5 max-md:pb-[calc(10px+var(--safe-bottom))] in-[[data-keyboard]]:hidden">
        <DisplayTool list={list} project={project} iconOnly />
        <span className="mr-auto min-w-0 truncate text-caption text-ink-2">
          {creating ? "Not created yet" : builtIn ? (dirty ? "Filtered for now" : "No filters") : dirty ? "Changed, not saved" : "No changes"}
        </span>
        {creating ? (
          <>
            <Button variant="ghost" onClick={() => viewPanel.close()}>
              Cancel
            </Button>
            <Button onClick={submit}>
              Create view
              <Kbd inverse>{keys("mod", "↵")}</Kbd>
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={!dirty} onClick={() => revertList(list)}>
              {builtIn ? "Clear" : "Revert"}
            </Button>
            {!builtIn && editable ? (
              <Button disabled={!dirty} onClick={() => saveList(list, project)}>
                Save
                <Kbd inverse>{keys("mod", "S")}</Kbd>
              </Button>
            ) : (
              <Button variant="outline" onClick={saveAsNew}>
                Save as new view
                <Kbd>{keys("mod", "shift", "S")}</Kbd>
              </Button>
            )}
          </>
        )}
      </footer>
    </aside>
  );
});

/** A menu, select or popover the panel opened is open (portalled out of it), or Display's from the header: a press or Esc
 * closes that first, the panel stays. The trigger still says so while the key or press is handled. */
const popupOpen = () => !!document.querySelector("[data-slot=view-panel] [aria-expanded=true], [data-display-tool][aria-expanded=true]");

/** The view's icon, a button that opens the icons to pick from. */
const IconPicker = observer(function IconPicker({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const icon = viewPanel.meta.icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Icon: ${VIEW_ICON[icon].label}`}
        render={<Button variant="outline" size="icon-lg" className="shrink-0 bg-field transition-none active:scale-100! max-md:size-11" />}
      >
        <ViewIconGlyph name={icon} className="size-4 text-ink max-md:size-5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-1.5">
        <ToggleGroup aria-label="Icon" value={[icon]} className="grid w-auto grid-cols-6 gap-1">
          {VIEW_ICONS.map((i) => (
            <ToggleGroupItem
              key={i}
              value={i}
              aria-label={VIEW_ICON[i].label}
              onClick={() => (viewPanel.setMeta({ icon: i }), setOpen(false))}
              className="grid size-8 place-items-center border border-transparent px-0 transition-colors duration-120 hover:bg-row-hover hover:text-inherit focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-control-border aria-pressed:bg-ground aria-pressed:hover:bg-row-hover max-md:size-11 max-md:rounded-lg"
            >
              <ViewIconGlyph name={i} className={cn("size-4", icon === i && "text-ink")} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  );
});

function Part({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <h3 className="m-0 text-label font-semibold max-md:text-[14px]">{title}</h3>
        {aside && <span className="ml-auto font-mono text-meta text-ink-3">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
