// What a run measures and prints on the way out: first frame, data, keystroke to frame, bytes per frame, changes drawn.

const median = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]! : 0);
const ms = (x: number) => `${x.toFixed(1)} ms`;
const bytes = (xs: number[]) => (xs.length ? `${Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)} B` : "—");

export class Stats {
  private firstFrame = 0;
  private ready = 0;
  private keys: number[] = [];
  private keyBytes: number[] = [];
  private remote: number[] = [];
  private remoteBytes: number[] = [];

  /** When the run began (performance.now()): the first frame and the data count from it. */
  private readonly began: number;

  constructor(began: number) {
    this.began = began;
  }

  /** A frame drawn for `why`, `took` ms after what asked for it, writing `size` bytes. */
  frame(why: "key" | "remote" | "start", took: number, size: number): void {
    if (why === "key") this.keys.push(took), this.keyBytes.push(size);
    if (why === "remote" && size) this.remote.push(took), this.remoteBytes.push(size);
    if (why === "start") this.firstFrame = performance.now() - this.began;
  }

  /** The data is in: counted once. */
  loaded(): void {
    if (!this.ready) this.ready = performance.now() - this.began;
  }

  report(): string {
    return [
      `first frame ${ms(this.firstFrame)}, data ${this.ready ? ms(this.ready) : "never"} after the start`,
      `keys: ${this.keys.length}, key to frame p50 ${ms(median(this.keys, 0.5))}, p95 ${ms(median(this.keys, 0.95))}, ${bytes(this.keyBytes)} a frame`,
      `changes from the server drawn: ${this.remote.length}, p50 ${ms(median(this.remote, 0.5))}, ${bytes(this.remoteBytes)} a frame`,
      `memory: ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB heap`,
    ].join("\n");
  }
}
