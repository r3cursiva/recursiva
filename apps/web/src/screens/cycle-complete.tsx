// Complete a cycle (PLNR-63, the CycleComplete artboard): its numbers, where its unfinished issues go (the next
// cycle, another upcoming one, or none), and a tick per item: an unticked one stays in the completed cycle, unfinished,
// as in Plane. Done items stay as the cycle's record. The server freezes the summary first, then the items move, in one
// transaction (store.completeCycle).
import { FlagCheckeredIcon, RobotIcon } from "@phosphor-icons/react";
import { cyclesAhead, localToday } from "@rsva/query";
import { isClosedGroup, type Cycle, type Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Checkbox } from "@rsva/ui/components/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@rsva/ui/components/dialog";
import { Kbd } from "@rsva/ui/components/kbd";
import { RadioGroup, RadioGroupItem } from "@rsva/ui/components/radio-group";
import { SearchSelect } from "@rsva/ui/components/search-select";
import { UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { faceOf } from "../lib/face.ts";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { countIssues, cycleRange, cycleWhen, percentDone } from "../lib/cycles.ts";
import { store } from "../store.ts";
import { StateGlyph } from "./state-glyph.tsx";
import { plural } from "@rsva/schema/util";

type Dest = "next" | "other" | "none";

export const CompleteCycleDialog = observer(function CompleteCycleDialog({ project, cycle, onClose }: { project: Project; cycle: Cycle; onClose: () => void }) {
  const issues = store.issuesInCycle(cycle.id);
  const counts = countIssues(issues, store.states, (p) => store.statesOf(p));
  const open = issues.filter((i) => !isClosedGroup(store.states.get(i.stateId)?.group));
  const ahead = cyclesAhead(store.cyclesOf(project.id), cycle.id, localToday());
  const next = ahead.find((c) => c.startDate) ?? null;
  const [dest, setDest] = useState<Dest>(next ? "next" : "none");
  const [other, setOther] = useState<string | null>(ahead.find((c) => c.id !== next?.id)?.id ?? next?.id ?? null);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const target = dest === "next" ? next : dest === "other" ? (ahead.find((c) => c.id === other) ?? null) : null;
  const moving = open.filter((i) => !off.has(i.id));
  const all = moving.length === open.length;
  const where = target ? target.name : "no cycle";

  const complete = () => {
    store.completeCycle(cycle.id, target?.id ?? null, [...off]);
    onClose();
  };
  const toggle = (id: string) =>
    setOff((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const dests: { value: Dest; label: string; note: string; disabled: boolean }[] = [
    { value: "next", label: "Next cycle", note: next ? `${next.name} · ${cycleRange(next)}, ${cycleWhen(next)}` : "No cycle is planned after this one", disabled: !next },
    { value: "other", label: "Another upcoming cycle", note: "Pick one of the planned cycles", disabled: ahead.length < 2 },
    { value: "none", label: "No cycle", note: "Back to the project, outside any cycle", disabled: false },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[8vh] max-w-[calc(100%-2rem)] translate-y-0 gap-0 p-0 text-sm md:max-w-[680px]"
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            complete();
          }
        }}
      >
        <div className="flex items-center gap-2 px-5 pt-5">
          <FlagCheckeredIcon className="size-4" />
          <DialogTitle className="text-base font-semibold">Complete {cycle.name}</DialogTitle>
          <span className="font-mono text-meta text-ink-3">
            {cycleRange(cycle)} · {cycleWhen(cycle)}
          </span>
        </div>
        <dl className="mx-5 mt-4 grid grid-cols-4 divide-x border-y py-3">
          {[
            [String(counts.completed), `done, stay in ${cycle.name}`],
            [String(open.length), "unfinished"],
            [`${percentDone(counts)}%`, `of ${counts.total - counts.cancelled} done`],
            [String(counts.cancelled), "canceled"],
          ].map(([n, label]) => (
            <div key={label} className="px-3 first:pl-0">
              <dt className="font-mono text-lg">{n}</dt>
              <dd className="m-0 text-caption text-ink-3">{label}</dd>
            </div>
          ))}
        </dl>
        {open.length > 0 && (
          <>
            <p className="px-5 pt-4 text-label font-semibold">Move the unfinished issues to</p>
            <RadioGroup aria-label="Move the unfinished issues to" value={dest} onValueChange={(v) => setDest(v as Dest)} className="grid-cols-1 gap-2 px-5 pt-2 sm:grid-cols-3">
              {dests.map((d) => (
                <label
                  key={d.value}
                  className={cn(
                    "flex flex-col gap-1 rounded-md border p-3 text-left outline-none select-none has-disabled:opacity-50 has-focus-visible:ring-2 has-focus-visible:ring-ring",
                    dest === d.value && "border-ink ring-1 ring-ink",
                  )}
                >
                  {/* The card is the control: the radio stays for the keyboard and the screen reader, its label names it. */}
                  <RadioGroupItem value={d.value} disabled={d.disabled} className="absolute size-px border-0 opacity-0" />
                  <span className="text-label font-medium">{d.label}</span>
                  <span className="text-caption text-ink-3">{d.note}</span>
                </label>
              ))}
            </RadioGroup>
            {dest === "other" && (
              <div className="px-5 pt-2">
                <SearchSelect
                  placeholder="Cycle…"
                  options={ahead.map((c) => ({ value: c.id, label: `${c.name} · ${cycleRange(c)}` }))}
                  value={other}
                  onChange={setOther}
                  trigger={
                    <Button type="button" variant="outline" size="sm">
                      {ahead.find((c) => c.id === other)?.name ?? "Pick a cycle"}
                    </Button>
                  }
                />
              </div>
            )}
            <div className="mx-5 mt-3 max-h-[40vh] overflow-y-auto rounded-md border">
              <label className="flex items-center gap-2.5 border-b bg-group px-3 py-2">
                <Checkbox checked={all} indeterminate={!all && moving.length > 0} onCheckedChange={() => setOff(all ? new Set(open.map((i) => i.id)) : new Set())} />
                <span className="text-label font-semibold">Unfinished</span>
                <span className="font-mono text-meta text-ink-3">
                  {moving.length} of {open.length} selected
                </span>
                <span className="ml-auto text-caption text-ink-3">Unticked items stay in {cycle.name}, unfinished.</span>
              </label>
              {open.map((i) => {
                const s = store.states.get(i.stateId);
                const on = !off.has(i.id);
                const agent = i.delegateId ? store.users.get(i.delegateId) : undefined;
                return (
                  <label key={i.id} className="flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0">
                    <Checkbox checked={on} onCheckedChange={() => toggle(i.id)} aria-label={`Move ${store.issueKey(i)}`} />
                    {s && <StateGlyph state={s} />}
                    <span className="font-mono text-meta text-ink-3">{store.issueKey(i)}</span>
                    <span className="min-w-0 flex-1 truncate text-label">{i.title}</span>
                    {agent && (
                      <span className="flex items-center gap-1 font-mono text-meta text-ink-2" title={`${agent.name} keeps working on it; a review it waits for moves with it`}>
                        <RobotIcon className="size-3" />
                        {agent.name}
                      </span>
                    )}
                    {i.assigneeIds.length > 0 && <UserAvatarStack people={i.assigneeIds.map((id) => faceOf(id))} />}
                    <span className={cn("w-28 text-right font-mono text-meta", on ? "text-ink" : "text-ink-3")}>{on ? `→ ${where}` : `stays in ${cycle.name}`}</span>
                  </label>
                );
              })}
            </div>
          </>
        )}
        <div className="mt-4 flex items-center gap-2 border-t px-5 py-3 max-md:sticky max-md:-bottom-[calc(10px+var(--safe-bottom))] max-md:z-10 max-md:-mb-[calc(10px+var(--safe-bottom))] max-md:bg-panel max-md:pb-[calc(12px+var(--safe-bottom))]">
          <span className="flex-1 text-caption text-ink-3">
            {open.length
              ? `${plural(moving.length, "issue")} move to ${where}${open.length - moving.length ? ` · ${open.length - moving.length} stay${open.length - moving.length === 1 ? "s" : ""} unfinished in ${cycle.name}` : ""}`
              : "Every issue is done or canceled."}
          </span>
          <Button type="button" variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button type="button" onClick={complete}>
            {moving.length ? `Complete and move ${moving.length}` : "Complete"}
            <Kbd inverse>{keys("mod", "↵")}</Kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});
