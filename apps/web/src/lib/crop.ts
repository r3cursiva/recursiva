// The picture editor's arithmetic (PLNR-244, screens/picture-editor.tsx): an image under a round window, moved and
// zoomed. Lengths are CSS pixels of the stage unless they say otherwise; the offset is the image's centre from the
// window's centre. The image always covers the window, so the picture has no empty corner.

/** The image's size in its own pixels and the window's diameter on the stage. */
export interface Frame {
  w: number;
  h: number;
  d: number;
}

export interface View {
  /** 1: the image's shorter side spans the window. */
  zoom: number;
  x: number;
  y: number;
}

export const ZOOM_MAX = 6;
export const CENTRED: View = { zoom: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** CSS pixels per image pixel at `zoom`. */
export const scaleOf = (f: Frame, zoom: number): number => (f.d / Math.min(f.w, f.h)) * zoom;

/** The view with its zoom in [1, ZOOM_MAX] and the image moved back over the window. */
export function clampView(f: Frame, v: View): View {
  const zoom = clamp(v.zoom, 1, ZOOM_MAX);
  const k = scaleOf(f, zoom);
  const mx = Math.max(0, (f.w * k - f.d) / 2);
  const my = Math.max(0, (f.h * k - f.d) / 2);
  // `|| 0`: no play gives -0, which a test or a comparison of views would tell from 0.
  return { zoom, x: clamp(v.x, -mx, mx) || 0, y: clamp(v.y, -my, my) || 0 };
}

/** Zoomed to `zoom` around (px, py), from the window's centre: the image's point there stays there. */
export function zoomAt(f: Frame, v: View, zoom: number, px = 0, py = 0): View {
  const z = clamp(zoom, 1, ZOOM_MAX);
  const r = z / v.zoom;
  return clampView(f, { zoom: z, x: px - (px - v.x) * r, y: py - (py - v.y) * r });
}

/** The square of the image under the window, in the image's pixels. */
export function cropRect(f: Frame, v: View): { x: number; y: number; side: number } {
  const k = scaleOf(f, v.zoom);
  const side = Math.min(f.d / k, f.w, f.h);
  const cx = f.w / 2 - v.x / k;
  const cy = f.h / 2 - v.y / k;
  return { x: clamp(cx - side / 2, 0, f.w - side), y: clamp(cy - side / 2, 0, f.h - side), side };
}
