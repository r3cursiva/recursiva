// How many of a row's labels fit (PLNR-179). The list watches its own width with one ResizeObserver and hands the rows one
// number; a row only adds up cached widths, so it reads no layout. One observer per row would cost hundreds of observers,
// because every row stays in the DOM. Canvas measures a label's text without touching layout, once per name.
import { createContext, useLayoutEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/** Labels may take this much of a row; the title keeps the rest. */
const ROW_SHARE = 0.4;
/** The room moves in steps, so dragging the window's edge does not render every row's labels on each pixel. */
const STEP = 16;
/** `gap-2` of the labels cell. */
const GAP = 8;
/** A LabelTag around its text: border, `px-2`, the color dot and `gap-1.5`. */
const TAG_CHROME = 32;
/** `max-w-28` of a row's tag: a longer name is truncated. */
const TAG_MAX = 112;
/** One character of the "+N" count: JetBrains Mono at 11px advances 0.6em. */
const COUNT_CHAR = 6.6;

/** The width of a list's rows' labels; null where rows keep their default (a phone, a board's cards). */
export const LabelRoom = createContext<number | null>(null);

export function labelRoom(listWidth: number): number {
  return Math.floor((listWidth * ROW_SHARE) / STEP) * STEP;
}

/** How many tags of these widths fit in `room` with the "+N" of the rest; one at least, truncated if it has to be. */
export function fitLabels(widths: readonly number[], room: number): number {
  let used = 0;
  for (const [i, width] of widths.entries()) {
    used += width + (i ? GAP : 0);
    const rest = widths.length - i - 1;
    const count = rest ? GAP + (String(rest).length + 1) * COUNT_CHAR : 0;
    if (used + count > room) return Math.max(i, 1);
  }
  return widths.length;
}

const widths = new Map<string, number>();
let canvas: CanvasRenderingContext2D | undefined;

/** A label's tag width in a row. Measured before the font is in, it is close enough and is not kept. */
export function tagWidth(name: string): number {
  const known = widths.get(name);
  if (known !== undefined) return known;
  canvas ??= document.createElement("canvas").getContext("2d")!;
  canvas.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  const width = Math.min(TAG_MAX, TAG_CHROME + Math.ceil(canvas.measureText(name).width));
  if (document.fonts.status === "loaded") widths.set(name, width);
  return width;
}

/** The last room, so a project switch mounts its list with the right tags at once. */
let lastRoom: number | null = null;

/** The room of `list`'s rows; null when `on` is false. */
export function useLabelRoom(list: RefObject<HTMLElement | null>, on: boolean): number | null {
  const [room, setRoom] = useState(lastRoom);
  useLayoutEffect(() => {
    const el = list.current;
    if (!on || !el) return;
    // The observer runs after layout and before paint: flushSync puts the right tags in that frame, with no layout read.
    const observer = new ResizeObserver(([entry]) => {
      lastRoom = labelRoom(entry!.contentRect.width);
      flushSync(() => setRoom(lastRoom));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [list, on]);
  return on ? room : null;
}
