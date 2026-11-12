// The issue panel's relations, as in Plane: blocked by, blocking, related, duplicate of, duplicates, in that order. One
// list as on the IssuePage artboard: each row says its kind in a column of its own. "+" picks the kind, then any issue of the workspace; picking one that is already related changes the kind (a
// pair has one relation). The store writes each kind on the end that stores it (sync/src/client.ts, addRelation).
import type { Issue, RelationType } from "@rsva/schema/models";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { useRef, useState, type ReactElement, type RefObject } from "react";
import { store } from "../store.ts";
import { notice } from "./notice.ts";
import { LinkedIssueRow, PanelList, PanelPlus, PanelSection } from "./panel-section.tsx";
import { IssuePicker } from "./pickers.tsx";

/** Kinds in the order the block lists them: the row's kind and the "+" menu's item. */
export type RelationKind = { type: RelationType; heading: string; add: string };

export const KINDS: readonly RelationKind[] = [
  { type: "blockedBy", heading: "Blocked by", add: "Blocked by…" },
  { type: "blocks", heading: "Blocking", add: "Blocking…" },
  { type: "related", heading: "Related", add: "Related to…" },
  { type: "duplicateOf", heading: "Duplicate of", add: "Duplicate of…" },
  { type: "duplicates", heading: "Duplicates", add: "Duplicated by…" },
];

/** Picks the other issue of a relation of `kind`. */
export function RelationPicker({ issue, kind, anchor, onClose }: { issue: Issue; kind: RelationKind; anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  return (
    <IssuePicker
      open
      onOpenChange={(o) => !o && onClose()}
      anchor={anchor}
      projectId={null}
      exclude={() => new Set([issue.id])}
      value={null}
      onChange={(id) => {
        store.addRelation(issue.id, kind.type, id);
        onClose();
      }}
      placeholder={kind.add}
    />
  );
}

/** The kinds under `trigger`, wherever that stands; the picker opens at it. */
export function AddRelation({ issue, trigger, align }: { issue: Issue; trigger: ReactElement; align: "start" | "end" }) {
  const [kind, setKind] = useState<RelationKind | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger ref={anchor} render={trigger} />
        <DropdownMenuContent align={align} className="w-44">
          {KINDS.map((k) => (
            <DropdownMenuItem key={k.type} onClick={() => setKind(k)}>
              {k.add}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {kind && <RelationPicker issue={issue} kind={kind} anchor={anchor} onClose={() => setKind(null)} />}
    </>
  );
}

export const Relations = observer(function Relations({ issue }: { issue: Issue }) {
  const r = store.relationsOf(issue.id);
  const rows = KINDS.flatMap((k) => (k.type === "duplicateOf" ? (r.duplicateOf ? [r.duplicateOf] : []) : r[k.type]).map((other) => ({ kind: k, other })));
  return (
    <PanelSection label="Relations" noPhoneHeader empty={rows.length === 0} action={<AddRelation issue={issue} align="end" trigger={<PanelPlus label="Add relation" />} />}>
      {rows.length > 0 && (
        <PanelList>
          {rows.map(({ kind, other }) => (
            <LinkedIssueRow
              key={other.id}
              issue={other}
              why={kind.heading}
              removeLabel={(key) => `Remove the relation with ${key}`}
              onRemove={() => {
                store.removeRelation(issue.id, other.id);
                notice.show(`Relation with ${store.issueKey(other)} removed`, () => store.addRelation(issue.id, kind.type, other.id));
              }}
            />
          ))}
        </PanelList>
      )}
    </PanelSection>
  );
});
