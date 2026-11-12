// What the engine's modules share for their own reports: the warning they print, and the clock their timings read.

export const warn = (e: unknown) => console.warn("rsva sync:", e);

export const now = () => performance.now();
