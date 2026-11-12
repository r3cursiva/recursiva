// The View panel's query line (PLNR-74): the list's filter as query text, `priority:high -label:bug due:<today`, tied
// both ways to the panel's filters, and its order as `order:priority` tied to Display's (PLNR-401). Typing applies on every keystroke; an error at the end is a word still being typed
// and gets completions, others say what is wrong and what was meant. Esc puts back the filter from before typing.
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { QueryError } from "@rsva/query";
import { Button } from "@rsva/ui/components/button";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import type { ProjectView } from "../view-state.ts";

export const QueryInput = observer(function QueryInput({ view, autoFocus }: { view: ProjectView; autoFocus: boolean }) {
  return <QueryLine text={view.query} apply={(draft) => view.setQuery(draft)} autoFocus={autoFocus} />;
});

/**
 * A query line over any text: `apply` takes each keystroke and answers with the query's errors. The View panel's ties it to
 * a list; a home widget's settings (RSVA-523) to the widget's query.
 */
export const QueryLine = observer(function QueryLine({ text, apply, autoFocus, id }: { text: string; apply: (draft: string) => QueryError[]; autoFocus: boolean; id?: string }) {
  const [editing, setEditing] = useState<{ draft: string; before: string; errors: QueryError[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const change = (draft: string) => {
    const errors = apply(draft);
    setEditing((e) => ({ draft, errors, before: e?.before ?? text }));
  };
  const draft = editing?.draft ?? text;
  const errors = editing?.errors ?? [];
  const typing = errors.find((e) => e.end === draft.length && !/\s$/.test(draft));
  const problems = errors.filter((e) => e !== typing);
  const replace = (e: QueryError, s: string) => change(`${draft.slice(0, e.start)}${s}${draft.slice(e.end)}${e === typing ? " " : ""}`);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-8 items-center gap-2 rounded-md border border-control-border bg-field px-2 focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring">
        <MagnifyingGlassIcon className="size-3.5 shrink-0 text-ink-3" />
        <input
          ref={input}
          id={id}
          aria-label="Query"
          aria-invalid={problems.length > 0 || undefined}
          spellCheck={false}
          value={draft}
          placeholder='status:"In Review" -label:bug assignee:me'
          onFocus={() => setEditing({ draft: text ? `${text} ` : "", before: text, errors: [] })}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && editing) {
              apply(editing.before);
              setEditing(null);
              input.current?.blur();
            } else if ((e.key === "Enter" || e.key === "Tab") && typing?.suggestions[0]) replace(typing, typing.suggestions[0]);
            else if (e.key === "Enter") input.current?.blur();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onBlur={() => setEditing(null)}
          className="min-w-0 flex-1 bg-transparent font-mono text-id outline-none placeholder:font-sans placeholder:text-ink-3"
        />
      </div>
      {typing && typing.suggestions.length > 0 && <Suggestions error={typing} onPick={replace} label="Complete:" />}
      {problems.map((e) => (
        <div key={`${e.start}:${e.message}`} className="flex flex-wrap items-center gap-1.5 text-caption text-destructive">
          <span>{e.message}.</span>
          {e.suggestions.length > 0 && <Suggestions error={e} onPick={replace} label="Did you mean" />}
        </div>
      ))}
    </div>
  );
});

function Suggestions({ error, onPick, label }: { error: QueryError; onPick: (e: QueryError, s: string) => void; label: string }) {
  return (
    <span className="flex flex-wrap items-center gap-1 text-caption text-ink-3">
      {label}
      {error.suggestions.map((s) => (
        <Button
          key={s}
          variant="outline"
          size="xs"
          // Keep the focus in the input.
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => onPick(error, s)}
          className="h-auto rounded-xs px-1.5 font-mono text-[12px]/[1.4] font-normal text-ink max-md:h-auto max-md:px-1.5 max-md:text-[13px] transition-none active:scale-100!"
        >
          {s}
        </Button>
      ))}
    </span>
  );
}
