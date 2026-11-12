// Settings › Profile › Picture (PLNR-244): the avatar as the person's picture control. A click on it or Upload picks an
// image, so does dropping one on the row or pasting one anywhere on the page outside a field; the image opens in the
// editor (picture-editor.tsx) to be placed. Remove puts the creature back (PLNR-366), and the toast's Undo brings the
// picture back from this browser's copy, which the address keeps for good. Creature opens the sliders that make it
// (creature-editor.tsx).
import { CameraIcon, SmileyIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { picturePath } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Spinner } from "@rsva/ui/components/spinner";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { account } from "../account.ts";
import { face } from "../lib/face.ts";
import { typing } from "../lib/typing.ts";
import { store } from "../store.ts";
import { CreatureEditor } from "./creature-editor.tsx";
import { useFileDrop } from "./file-drop.ts";
import { notice } from "./notice.ts";
import { PictureEditor, readPicture } from "./picture-editor.tsx";
import { saving } from "./save-status.tsx";
import { useFilePicker } from "./file-picker.tsx";

/** Larger files are not even read: a photo is a few MB. */
const PICK_MAX = 50 * 2 ** 20;


export const AccountPicture = observer(function AccountPicture() {
  const me = store.me!;
  // `n` remounts the editor for each image: its view starts centred.
  const [image, setImage] = useState<{ bmp: ImageBitmap; n: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  // `n` remounts the creature editor on each opening: it starts from what is saved.
  const [creature, setCreature] = useState({ open: false, n: 0 });

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > PICK_MAX) return notice.show(`That image is over ${PICK_MAX / 2 ** 20} MB.`);
    setReading(true);
    try {
      const bmp = await readPicture(file);
      setImage((was) => {
        was?.bmp.close();
        return { bmp, n: (was?.n ?? 0) + 1 };
      });
      setOpen(true);
    } catch {
      notice.show("This browser can't read that image. Try a PNG, JPEG or WebP.");
    } finally {
      setReading(false);
    }
  };
  const { pick: choose, field } = useFilePicker((files) => void pick(files[0]), { multiple: false, accept: "image/*" });
  const { over, drop } = useFileDrop((files) => void pick(files.find((f) => f.type.startsWith("image/")) ?? files[0]));

  // The decoded image is megabytes: it goes once the dialog has closed, or with the page.
  const live = useRef(image);
  live.current = image;
  useEffect(() => () => live.current?.bmp.close(), []);
  const release = () =>
    setImage((was) => {
      was?.bmp.close();
      return null;
    });

  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file || typing(e.target)) return;
      e.preventDefault();
      void pick(file);
    };
    addEventListener("paste", paste);
    return () => removeEventListener("paste", paste);
  }, []);

  const remove = async () => {
    const was = me.picture;
    // The bytes come from the browser's cache: what Undo sends back, though the server forgets them.
    const copy = was ? await fetch(picturePath(was)).then((r) => (r.ok ? r.blob() : null), () => null) : null;
    await account.setPicture(null);
    notice.show("Picture removed.", copy ? () => saving(account.setPicture(copy)) : undefined);
  };

  return (
    <div className="flex items-center gap-4" {...drop}>
      <button
        type="button"
        onClick={choose}
        aria-label={me.picture ? "Change picture" : "Upload a picture"}
        className="group/picture relative size-16 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        <UserAvatar {...face(me)} className="size-16" />
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-150 group-hover/picture:opacity-100",
            (reading || over) && "opacity-100",
          )}
        >
          {reading ? <Spinner className="size-5" /> : <CameraIcon className="size-5" />}
        </span>
        {over && <span aria-hidden className="absolute -inset-1.5 rounded-full border-2 border-dashed border-signal" />}
      </button>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={reading} onClick={choose}>
            <UploadSimpleIcon />
            {me.picture ? "Change…" : "Upload…"}
          </Button>
          <Button type="button" variant="outline" onClick={() => setCreature((c) => ({ open: true, n: c.n + 1 }))}>
            <SmileyIcon />
            Creature…
          </Button>
          {me.picture && (
            <Button type="button" variant="ghost" onClick={() => saving(remove())}>
              Remove
            </Button>
          )}
        </div>
        <p className="m-0 text-caption text-ink-3">{over ? "Drop it to use it." : <>PNG, JPEG or WebP<span className="max-md:hidden">; drop one here or paste it</span>.</>}</p>
      </div>
      {field}
      <CreatureEditor key={creature.n} open={creature.open} onClose={() => setCreature((c) => ({ ...c, open: false }))} onSaved={() => (me.picture ? remove() : Promise.resolve())} />
      {image && <PictureEditor key={image.n} image={image.bmp} open={open} onClose={() => setOpen(false)} onClosed={release} onPickAnother={choose} />}
    </div>
  );
});
