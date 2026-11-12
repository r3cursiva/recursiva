import assert from "node:assert/strict";
import { test } from "node:test";
import { CENTRED, clampView, cropRect, zoomAt, ZOOM_MAX, type Frame } from "./crop.ts";

// A landscape photo under a 200 px window: at zoom 1 its 1000 px height spans the window, 5 image pixels a CSS pixel.
const photo: Frame = { w: 2000, h: 1000, d: 200 };

test("centred, the window takes the middle square of the shorter side", () => {
  assert.deepEqual(cropRect(photo, CENTRED), { x: 500, y: 0, side: 1000 });
});

test("the image cannot leave a gap in the window", () => {
  // 400 CSS px wide at zoom 1: 100 px of play either way, none up or down.
  assert.deepEqual(clampView(photo, { zoom: 1, x: 500, y: -50 }), { zoom: 1, x: 100, y: 0 });
  assert.deepEqual(cropRect(photo, { zoom: 1, x: 100, y: 0 }), { x: 0, y: 0, side: 1000 });
  assert.deepEqual(clampView(photo, { zoom: 0.2, x: 0, y: 0 }).zoom, 1);
  assert.equal(clampView(photo, { zoom: 50, x: 0, y: 0 }).zoom, ZOOM_MAX);
});

test("zooming keeps the point under the cursor where it is", () => {
  // Double around a point 40 px right of the centre: the image's point there was 40 px off its centre, now 80.
  const v = zoomAt(photo, CENTRED, 2, 40, 0);
  assert.deepEqual(v, { zoom: 2, x: -40, y: 0 });
  // The window now holds 500 image pixels, its centre 100 image pixels right of the photo's (40 CSS px at 0.4 a pixel).
  assert.deepEqual(cropRect(photo, v), { x: 850, y: 250, side: 500 });
  // Back out, the photo is centred again by the clamp's bounds, not left off to the side.
  assert.deepEqual(zoomAt(photo, v, 1, 40, 0), { zoom: 1, x: 0, y: 0 });
});

test("a picture smaller than the window still crops inside it", () => {
  const icon: Frame = { w: 64, h: 48, d: 240 };
  const r = cropRect(icon, zoomAt(icon, CENTRED, 3, -120, -120));
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.side <= icon.w && r.y + r.side <= icon.h, JSON.stringify(r));
  assert.equal(r.side, 16);
});
