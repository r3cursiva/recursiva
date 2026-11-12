// Settings › Profile › Picture (PLNR-244): the chosen image under a round window, placed before it is saved. A drag (mouse
// or finger) moves it; the slider, the wheel, a pinch or a trackpad's pinch zoom around the pointer; with the stage
// focused the arrow keys move it, + and − zoom and 0 centres it; a double click centres it too. Under the stage the
// picture shows at three of the sizes the app draws it.
//
// The browser cuts and encodes the result: one PICTURE_SIDE square, WebP, or JPEG on white where the canvas has no WebP
// encoder (Safari; JPEG has no transparency). The server checks it and keeps it (apps/server/src/auth/picture.ts). A big
// photo is scaled down to WORK_SIDE once, when it is read: the stage then redraws a few megabytes on every move, not 48
// megapixels. The view is kept in units of the window's diameter, so a stage that changes size keeps the same crop.
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react";
import { PICTURE_SIDE } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@rsva/ui/components/dialog";
import { Slider } from "@rsva/ui/components/slider";
import { when } from "mobx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { account } from "../account.ts";
import { CENTRED, clampView, cropRect, scaleOf, zoomAt, ZOOM_MAX, type Frame, type View } from "../lib/crop.ts";
import { store } from "../store.ts";
import { useFreshAction } from "./account-menu.tsx";
import { SaveFooter } from "./settings-fields.tsx";

/** Longest side an image is worked on at, pixels: a crop at the largest zoom still has more than PICTURE_SIDE. */
const WORK_SIDE = 2048;
/** The window's margin inside the stage, CSS pixels: the image around it shows dimmed. */
const INSET = 28;
/** Avatar sizes the preview draws: the profile, a comment, a list row. */
const PREVIEWS = [64, 28, 20] as const;
const WEBP_QUALITY = 0.86;
const JPEG_QUALITY = 0.9;
/** One press of a zoom key or button. */
const ZOOM_STEP = 1.25;

/** The image ready to place, at most WORK_SIDE a side, turned as its EXIF says; throws if the browser cannot read it. */
export async function readPicture(file: Blob): Promise<ImageBitmap> {
  const bmp = await createImageBitmap(file);
  const k = WORK_SIDE / Math.max(bmp.width, bmp.height);
  if (k >= 1) return bmp;
  try {
    const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: "high" });
    bmp.close();
    return small;
  } catch {
    return bmp;
  }
}

const blobOf = (c: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((done) => c.toBlob(done, type, quality));

/** The square `r` of the image as the picture to upload. */
async function encodePicture(img: ImageBitmap, r: { x: number; y: number; side: number }): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PICTURE_SIDE;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  const side = Math.max(1, Math.min(Math.round(r.side), img.width - x, img.height - y));
  // createImageBitmap's resize filters a many-times reduction better than one drawImage step does.
  const cut = await createImageBitmap(img, x, y, side, side, { resizeWidth: PICTURE_SIDE, resizeHeight: PICTURE_SIDE, resizeQuality: "high" }).catch(() => null);
  if (cut) {
    ctx.drawImage(cut, 0, 0);
    cut.close();
  } else ctx.drawImage(img, x, y, side, side, 0, 0, PICTURE_SIDE, PICTURE_SIDE);
  const webp = await blobOf(canvas, "image/webp", WEBP_QUALITY);
  if (webp?.type === "image/webp") return webp;
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, PICTURE_SIDE, PICTURE_SIDE);
  const jpeg = await blobOf(canvas, "image/jpeg", JPEG_QUALITY);
  if (!jpeg) throw new Error("This browser could not make the picture.");
  return jpeg;
}

/** A canvas sized `css` pixels, sharp on this screen; returns its context drawing in CSS pixels. */
function sized(canvas: HTMLCanvasElement, css: number): CanvasRenderingContext2D {
  const px = Math.round(css * devicePixelRatio);
  if (canvas.width !== px) canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(px / css, 0, 0, px / css, 0, 0);
  ctx.clearRect(0, 0, css, css);
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

type Point = { x: number; y: number };
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** `onClosed`: the dialog is gone, after its closing animation; the image may go then. */
export function PictureEditor({ image, open, onClose, onClosed, onPickAnother }: { image: ImageBitmap; open: boolean; onClose: () => void; onClosed: () => void; onPickAnother: () => void }) {
  const frame: Frame = useMemo(() => ({ w: image.width, h: image.height, d: 1 }), [image]);
  const [view, setView] = useState<View>(CENTRED);
  const [stage, setStage] = useState(0);
  const { busy, error, run } = useFreshAction();
  // A callback ref: the dialog's portal may mount its content a moment after `open`.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const pointers = useRef(new Map<number, Point>());

  // The stage is as wide as the dialog: a phone's sheet is narrower than a desktop's dialog.
  useLayoutEffect(() => {
    if (!stageEl) return;
    const ro = new ResizeObserver(([e]) => setStage(e!.contentRect.width));
    ro.observe(stageEl);
    return () => ro.disconnect();
  }, [stageEl]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stage) return;
    const d = stage - 2 * INSET;
    const k = scaleOf(frame, view.zoom) * d;
    const ctx = sized(canvas, stage);
    ctx.drawImage(image, stage / 2 + view.x * d - (image.width * k) / 2, stage / 2 + view.y * d - (image.height * k) / 2, image.width * k, image.height * k);
    const r = cropRect(frame, view);
    PREVIEWS.forEach((size, i) => {
      const c = previewRefs.current[i];
      if (c) sized(c, size).drawImage(image, r.x, r.y, r.side, r.side, 0, 0, size, size);
    });
  }, [image, frame, view, stage]);

  /** A point of the stage from the window's centre, in diameters. */
  const at = (clientX: number, clientY: number): Point => {
    const r = stageEl!.getBoundingClientRect();
    const d = r.width - 2 * INSET;
    return { x: (clientX - r.left - r.width / 2) / d, y: (clientY - r.top - r.height / 2) / d };
  };

  // The wheel zooms the picture, not the page: a passive listener could not stop the page's scroll.
  useEffect(() => {
    const el = stageEl;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = at(e.clientX, e.clientY);
      // A trackpad's pinch arrives as the wheel with Ctrl, in small steps; a line is about 16 pixels.
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
      setView((v) => zoomAt(frame, v, v.zoom * f, p.x, p.y));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [frame, stageEl]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, at(e.clientX, e.clientY));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const ps = pointers.current;
    if (!ps.has(e.pointerId)) return;
    const [a0, b0] = [...ps.values()];
    ps.set(e.pointerId, at(e.clientX, e.clientY));
    const [a1, b1] = [...ps.values()];
    if (!b0 || !b1) return setView((v) => clampView(frame, { ...v, x: v.x + a1!.x - a0!.x, y: v.y + a1!.y - a0!.y }));
    // Two fingers: the middle moves the picture, the spread zooms it there.
    const m0 = mid(a0!, b0);
    const m1 = mid(a1!, b1);
    const ratio = dist(a1!, b1) / dist(a0!, b0) || 1;
    setView((v) => zoomAt(frame, { ...v, x: v.x + m1.x - m0.x, y: v.y + m1.y - m0.y }, v.zoom * ratio, m1.x, m1.y));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => void pointers.current.delete(e.pointerId);

  const zoomBy = (f: number) => setView((v) => zoomAt(frame, v, v.zoom * f));
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const arrows: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    const a = arrows[e.key];
    if (a) setView((v) => clampView(frame, { ...v, x: v.x + a.x, y: v.y + a.y }));
    else if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_STEP);
    else if (e.key === "0") setView(CENTRED);
    else return;
    e.preventDefault();
  };

  const save = () =>
    run(async () => {
      const sha = await account.setPicture(await encodePicture(image, cropRect(frame, view)));
      // The avatars change when the log brings the picture back, as a rename does: close on it, so nothing flickers.
      await when(() => store.me?.picture === sha, { timeout: 5000 }).catch(() => {});
      onClose();
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()} onOpenChangeComplete={(o) => !o && onClosed()}>
      <DialogContent className="gap-3.5 sm:max-w-[392px]">
        <DialogHeader>
          <DialogTitle>Your picture</DialogTitle>
          <DialogDescription>
            Drag it into place. <span className="max-md:hidden">Scroll, pinch</span>
            <span className="md:hidden">Pinch</span> or use the slider to zoom.
          </DialogDescription>
        </DialogHeader>
        <div
          ref={setStageEl}
          tabIndex={0}
          role="group"
          aria-roledescription="picture position"
          aria-label="Arrow keys move the picture, plus and minus zoom, 0 centres it"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={() => setView(CENTRED)}
          onKeyDown={key}
          className="relative aspect-square w-full cursor-grab touch-none overflow-hidden rounded-lg bg-sidebar outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <canvas ref={canvasRef} className="absolute inset-0 size-full" />
          <div aria-hidden className="pointer-events-none absolute rounded-full shadow-[0_0_0_9999px_rgb(0_0_0/0.52)] ring-[1.5px] ring-white/75" style={{ inset: INSET }} />
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" disabled={view.zoom <= 1} onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <MagnifyingGlassMinusIcon />
          </Button>
          <Slider aria-label="Zoom" min={1} max={ZOOM_MAX} step={0.01} value={view.zoom} onValueChange={(z) => setView((v) => zoomAt(frame, v, z))} className="flex-1" />
          <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" disabled={view.zoom >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}>
            <MagnifyingGlassPlusIcon />
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div aria-hidden className="flex items-center gap-2.5">
            {PREVIEWS.map((size, i) => (
              <canvas key={size} ref={(c) => void (previewRefs.current[i] = c)} className="rounded-full bg-sidebar ring-1 ring-rule" style={{ width: size, height: size }} />
            ))}
          </div>
          <Button type="button" variant="link" size="lg" className="ml-auto" disabled={busy} onClick={onPickAnother}>
            Choose another…
          </Button>
        </div>
        <SaveFooter busy={busy} error={error} onCancel={onClose} onSave={save} />
      </DialogContent>
    </Dialog>
  );
}
