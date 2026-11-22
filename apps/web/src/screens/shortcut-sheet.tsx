// Every key of the app on one sheet (PLNR-304): `?`, ⌘K › Keyboard shortcuts, or the account menu. The table here is the
// one list of the keys; a key added to a screen is added here in the same change. Lazy, in the edit chunk.
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogTitle } from "@rsva/ui/components/dialog";
import { Kbd } from "@rsva/ui/components/kbd";
import { observer } from "mobx-react-lite";
import { Fragment, useRef, useState } from "react";
import { shortcutSheet } from "./palette-state.ts";
import { type Press, SECTIONS } from "./shortcut-rows.ts";

function PressKeys({ press }: { press: string | Press }) {
  const p = typeof press === "string" ? { keys: [press] } : press;
  return (
    <span className="inline-flex items-center gap-0.5">
      {p.keys.map((k, i) => (
        <Fragment key={i}>
          {p.chord && i > 0 && <span className="px-0.5 text-overline text-ink-3">then</span>}
          <Kbd className="min-w-[18px] text-center">{k}</Kbd>
        </Fragment>
      ))}
    </span>
  );
}

export const ShortcutSheet = observer(function ShortcutSheet() {
  const [query, setQuery] = useState("");
  // Opened by a key, the sheet has no trigger to give the focus back to: it goes back where it was, a row or the pane.
  const back = useRef(document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
  const q = query.trim().toLowerCase();
  const sections = SECTIONS.map((s) => ({ ...s, rows: q ? s.rows.filter((r) => `${s.title} ${r[0]}`.toLowerCase().includes(q)) : s.rows })).filter((s) => s.rows.length);
  return (
    <Dialog open onOpenChange={(open) => !open && shortcutSheet.close()}>
      <DialogContent finalFocus={back} className="top-[8vh] flex max-h-[84vh] max-w-[calc(100%-2rem)] translate-y-0 flex-col gap-0 p-0 text-sm md:max-w-[780px]" aria-describedby={undefined}>
        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
          <DialogTitle className="shrink-0">Keyboard shortcuts</DialogTitle>
          <label className="ml-auto flex h-8 w-56 items-center gap-2 rounded-md border border-control-border px-2 text-ink-3 focus-within:border-ring max-md:w-full">
            <MagnifyingGlassIcon className="size-3.5 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a key"
              aria-label="Find a key"
              className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-3 max-md:text-base"
            />
          </label>
          <span className="w-6 max-md:hidden" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
          {sections.length === 0 && <p className="py-6 text-center text-ink-3">No key for “{query}”.</p>}
          <div className="gap-8 md:columns-2">
            {sections.map((s) => (
              <section key={s.title} className="mb-5 break-inside-avoid">
                <h3 className="mb-1.5 text-caption font-medium text-ink-3">{s.title}</h3>
                {s.note && !q && <p className="mb-1.5 text-caption text-ink-2">{s.note}</p>}
                <dl className="m-0">
                  {s.rows.map(([label, ...presses]) => (
                    <div key={label} className="flex min-h-7 items-center gap-3 border-b border-rule-soft py-1 last:border-0">
                      <dt className="min-w-0 flex-1 text-ink-2">{label}</dt>
                      <dd className="m-0 flex shrink-0 flex-wrap items-center justify-end gap-1">
                        {presses.map((p, i) => (
                          <Fragment key={i}>
                            {i > 0 && <span className="text-overline text-ink-3">or</span>}
                            <PressKeys press={p} />
                          </Fragment>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
