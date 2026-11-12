// Project settings › Labels: add, rename, recolor, delete (taken off its issues first). Not on the artboard; Plane
// has it in project settings, and without it a label could only come from an import. Labels inside another one show
// indented under it; moving them between parents waits for the label groups UI.
import { mayManage } from "@rsva/policy";
import { NAME_MAX, cleanName, type Label, type Project } from "@rsva/schema/models";
import { LABEL_COLORS, labelTree } from "@rsva/schema/settings";
import { Button } from "@rsva/ui/components/button";
import { ColorDot } from "@rsva/ui/components/color-chip";
import { Input } from "@rsva/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@rsva/ui/components/popover";
import { SettingsSection } from "@rsva/ui/components/settings";
import { ToggleGroup, ToggleGroupItem } from "@rsva/ui/components/toggle-group";
import { Hint } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { store } from "../store.ts";
import { CommitInput, ConfirmBar, DeleteButton, OnlyPeopleButton, inputFieldClass } from "./settings-fields.tsx";

/** Issues per label across the workspace: deleting a workspace label touches every project. */
function countByLabel(): Map<string, number> {
  const n = new Map<string, number>();
  for (const i of store.issues.values()) for (const l of i.labelIds) n.set(l, (n.get(l) ?? 0) + 1);
  return n;
}

export const LabelsSection = observer(function LabelsSection({ project }: { project: Project }) {
  const all = store.labelsOf(project.id);
  const own = labelTree(all.filter((l) => l.projectId === project.id));
  const shared = labelTree(all.filter((l) => l.projectId === null));
  const counts = countByLabel();
  return (
    <SettingsSection
      id="labels"
      title="Labels"
      aside={<span className="font-mono text-meta text-ink-3">{all.length}</span>}
      description="Labels this project's issues can carry."
    >
      <NewLabel project={project} labels={all} />
      <LabelList rows={own} counts={counts} />
      {shared.length > 0 && (
        <>
          <h3 className="m-0 mt-5 mb-1 eyebrow">Workspace labels · shared by every project</h3>
          <LabelList rows={shared} counts={counts} />
        </>
      )}
    </SettingsSection>
  );
});

function LabelList({ rows, counts }: { rows: { label: Label; depth: number }[]; counts: Map<string, number> }) {
  if (!rows.length) return <p className="m-0 py-3 text-label text-ink-3">No labels yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map(({ label, depth }) => (
        <LabelRow key={label.id} label={label} depth={depth} count={counts.get(label.id) ?? 0} />
      ))}
    </ul>
  );
}

const LabelRow = observer(function LabelRow({ label, depth, count }: { label: Label; depth: number; count: number }) {
  const [deleting, setDeleting] = useState(false);
  const inside = [...store.labels.values()].filter((l) => l.parentId === label.id).length;
  return (
    <li className="group/row flex flex-col gap-2 border-b border-rule-soft py-1.5 last:border-b-0">
      <div className="flex min-h-8 items-center gap-2" style={{ paddingLeft: depth * 22 }}>
        <ColorPicker color={label.color} name={label.name} onPick={(color) => store.updateLabel(label.id, { color })} />
        <CommitInput inline value={label.name} aria-label={`Name of ${label.name}`} className="max-w-[360px]" onCommit={(name) => store.updateLabel(label.id, { name })} />
        <span className="ml-auto font-mono text-meta text-ink-3 tabular-nums" title={`${count} issues`}>
          {count}
        </span>
        <OnlyPeopleButton
          name={label.name}
          on={label.onlyPeople}
          editable={!!store.role && mayManage(store.role)}
          hint="Only people rename or delete it"
          onChange={(onlyPeople) => store.updateLabel(label.id, { onlyPeople })}
        />
        <DeleteButton name={label.name} open={deleting} onToggle={() => setDeleting(!deleting)} />
      </div>
      {deleting && (
        <ConfirmBar
          action={`Delete ${label.name}`}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            store.deleteLabel(label.id);
          }}
        >
          {[
            count > 0 ? `It comes off ${count} ${count === 1 ? "issue" : "issues"}.` : "No issue carries it.",
            inside > 0 && `${inside} ${inside === 1 ? "label" : "labels"} inside it move up a level.`,
          ]
            .filter(Boolean)
            .join(" ")}
        </ConfirmBar>
      )}
    </li>
  );
});

function ColorPicker({ color, name, onPick }: { color: string; name: string; onPick: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  // The stored color may differ from the palette's in case; a press on the chosen swatch reports no value and only closes.
  const chosen = LABEL_COLORS.filter((c) => c.value.toLowerCase() === color.toLowerCase()).map((c) => c.value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label="Color">
        <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label={`Color of ${name}`} className="border-0 aria-expanded:not-hover:bg-transparent max-md:size-7 max-md:rounded-md" />}>
          <ColorDot color={color} className="size-2.5" />
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="w-auto p-2">
        <ToggleGroup
          aria-label={`Color of ${name}`}
          value={chosen}
          onValueChange={([picked]: string[]) => {
            if (picked) onPick(picked);
            setOpen(false);
          }}
          className="grid grid-cols-6 gap-1"
        >
          {LABEL_COLORS.map((c) => (
            <Hint key={c.value} label={c.name}>
              <ToggleGroupItem value={c.value} aria-label={c.name} className="size-7 px-0 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-nav-current">
                <span className="size-3.5 rounded-full" style={{ backgroundColor: c.value }} />
              </ToggleGroupItem>
            </Hint>
          ))}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  );
}

function NewLabel({ project, labels }: { project: Project; labels: Label[] }) {
  const [name, setName] = useState("");
  // A new label's color goes round the palette, so a few added in a row are told apart.
  const [color, setColor] = useState<string>(() => LABEL_COLORS[labels.length % LABEL_COLORS.length]!.value);
  const v = cleanName(name);
  const taken = v !== "" && labels.some((l) => l.name.toLowerCase() === v.toLowerCase());
  const add = () => {
    if (!v || taken) return;
    store.createLabel(project.id, v, color);
    setName("");
    setColor(LABEL_COLORS[(labels.length + 1) % LABEL_COLORS.length]!.value);
  };
  return (
    <form
      className="mt-2 mb-1 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <ColorPicker color={color} name="the new label" onPick={setColor} />
      <Input
        value={name}
        maxLength={NAME_MAX}
        aria-label="New label"
        aria-invalid={taken || undefined}
        aria-describedby={taken ? "new-label-taken" : undefined}
        placeholder="New label"
        onChange={(e) => setName(e.target.value)}
        className={cn(inputFieldClass, "max-w-[320px] flex-1")}
      />
      <Button type="submit" variant="outline" className="h-8" disabled={!v || taken}>
        Add label
      </Button>
      {taken && (
        <span id="new-label-taken" className="basis-full pl-9 text-caption text-signal-text">
          {v} exists in this project
        </span>
      )}
    </form>
  );
}
