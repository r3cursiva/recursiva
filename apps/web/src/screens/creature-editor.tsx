// Settings › Profile › Picture › Creature (PLNR-366): the avatar drawn without a picture, made with sliders. It opens on
// the person's own creature (the one they saved, or their name's); Shuffle draws a new one, "From your name" goes back to
// the name's. Under the stage it shows at three of the sizes the app draws it. Saved, it is a short string on the user,
// which reaches every workspace as a name does (account.setAvatar); a picture, when there is one, is taken away for it.
import { DiceFiveIcon } from "@phosphor-icons/react";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@rsva/ui/components/dialog";
import { Slider } from "@rsva/ui/components/slider";
import { CreatureAvatar } from "@rsva/ui/components/user-avatar";
import { TONES_BY_HUE } from "@rsva/display/avatar";
import { CREATURE_FIELDS, creatureOfName, decodeCreature, encodeCreature, randomCreature, type Creature } from "@rsva/ui/lib/creature";
import { seeded } from "@rsva/schema/util";
import { cn } from "@rsva/ui/lib/utils";
import { when } from "mobx";
import { useState } from "react";
import { account } from "../account.ts";
import { store } from "../store.ts";
import { useFreshAction } from "./account-menu.tsx";
import { SaveFooter } from "./settings-fields.tsx";

/** Avatar sizes the preview draws: the profile, a comment, a list row. */
const PREVIEWS = [64, 28, 20] as const;

const LABELS: Record<(typeof CREATURE_FIELDS)[number]["key"], string> = {
  petals: "Petals",
  spike: "Round ↔ Spiky",
  lobes: "Lobes",
  wobble: "Wobble",
  size: "Size",
  eyes: "Eyes",
  gap: "Eye gap",
  look: "Look",
  mood: "Mood",
};

export function CreatureEditor({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const me = store.me!;
  const own = creatureOfName(me.name);
  const [creature, setCreature] = useState<Creature>(() => (me.avatar && decodeCreature(me.avatar)) || own);
  const { busy, error, run } = useFreshAction();
  const fromName = encodeCreature(creature) === encodeCreature(own);

  const set = <K extends keyof Creature>(key: K, value: Creature[K]) => setCreature((c) => ({ ...c, [key]: value }));
  const shuffle = () => setCreature((c) => randomCreature(seeded(crypto.getRandomValues(new Uint32Array(1))[0]!), c.tone));

  const save = () =>
    run(async () => {
      // The name's own is kept as none: a new name then brings its creature along.
      const avatar = fromName ? null : encodeCreature(creature);
      await account.setAvatar(avatar);
      // The avatars change when the log brings it back, as a rename does: close on it, so nothing flickers.
      await when(() => (store.me?.avatar ?? null) === avatar, { timeout: 5000 }).catch(() => {});
      await onSaved();
      onClose();
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="gap-3.5 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Your creature</DialogTitle>
          <DialogDescription>Drawn when there is no picture.{me.picture && " Saving it takes your picture away."}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-4">
          <CreatureAvatar creature={creature} className="size-28" />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
            <div aria-hidden className="flex items-end gap-2.5">
              {PREVIEWS.map((size) => (
                <CreatureAvatar key={size} creature={creature} style={{ width: size, height: size }} />
              ))}
            </div>
            <div role="radiogroup" aria-label="Tone" className="flex gap-1.5 max-md:grid max-md:grid-cols-4">
              {TONES_BY_HUE.map((tone) => (
                <button
                  key={tone}
                  type="button"
                  role="radio"
                  aria-checked={creature.tone === tone}
                  aria-label={tone}
                  title={tone}
                  onClick={() => set("tone", tone)}
                  className={cn(
                    "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:p-1.5",
                    creature.tone === tone && "ring-2 ring-ink ring-offset-2 ring-offset-panel",
                  )}
                >
                  <CreatureAvatar creature={{ ...creature, tone }} className="size-6 max-md:size-8" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
          {CREATURE_FIELDS.map((f) => (
            <label key={f.key} className="flex min-w-0 flex-col text-caption text-ink-2">
              <span className="flex justify-between gap-2">
                {LABELS[f.key]}
                <span className="font-mono text-ink-3 tabular-nums">{creature[f.key]}</span>
              </span>
              <Slider min={f.min} max={f.max} step={1} value={creature[f.key]} onValueChange={(v) => set(f.key, v)} />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={shuffle}>
            <DiceFiveIcon />
            Shuffle
          </Button>
          <Button type="button" variant="ghost" disabled={fromName} onClick={() => setCreature(own)}>
            From your name
          </Button>
        </div>
        <SaveFooter busy={busy} error={error} onCancel={onClose} onSave={save} />
      </DialogContent>
    </Dialog>
  );
}
