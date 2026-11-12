// Saved views on the client (PLNR-74): the shared ones and the viewer's own, and the viewer's pins. They come from the
// server's `views` frames, not the log (packages/protocol/src/views.ts). A change shows at once and goes out as a
// write; the server's echo confirms it. Kept with the snapshot copy, so a warm start draws the sidebar's views before
// any network and asks only for what changed meanwhile. The rest of the viewer's sidebar comes along: their order of
// projects (ADR 0020), their pins, the projects they hid (PLNR-292) and their groups of projects (RSVA-566). Theirs alone, each a whole list written at once,
// and a start must draw the sidebar as they left it.
import { NO_GROUPS, type ClientFrame, type PinRef, type SavedView, type SidebarGroups, type ViewFields, type ViewsFrame, type ViewWrite } from "@rsva/protocol";
import { computed, makeObservable, observable, observableRef, runInAction } from "mobx";
import type { ViewsStore } from "./store.ts";

/** What the snapshot copy in IndexedDB keeps of the views. */
export interface SavedViews {
  v: SavedView[];
  /** The pinned views of a copy saved before PLNR-292, which has no `s`. */
  p?: [string, boolean][];
  /** The server's order of projects; missing in a copy saved before it. */
  o?: string[];
  /** The server's pins, and the projects hidden from the sidebar. */
  s?: PinRef[];
  h?: string[];
  /** The server's groups of projects; missing in a copy saved before RSVA-566. */
  g?: SidebarGroups;
  at: string | null;
  /** Writes the server has not echoed yet: sent again on the next connection. */
  w: ViewWrite[];
}

export class Views implements ViewsStore {
  status: ViewsStore["status"] = "loading";
  /** The server's views; what the viewer sees is these with the unconfirmed writes on top (`shown`). */
  private readonly server = observable.map<string, SavedView>({}, { deep: false });
  /** The server's lists: the order of projects, the pins, the hidden projects. */
  private order: string[] = [];
  private pinList: PinRef[] = [];
  private hiddenList: string[] = [];
  private groupSet: SidebarGroups = NO_GROUPS;
  /** Writes sent and not echoed yet, oldest first. */
  private outbox: ViewWrite[] = [];
  private at: string | null = null;
  private readonly me: () => string;
  private readonly send: (f: ClientFrame) => void;
  private readonly changed: () => void;

  constructor(me: () => string, send: (f: ClientFrame) => void, changed: () => void) {
    this.me = me;
    this.send = send;
    this.changed = changed;
    makeObservable<Views, "outbox" | "order" | "pinList" | "hiddenList" | "groupSet" | "shown">(this, {
      status: observable,
      outbox: observableRef,
      order: observableRef,
      pinList: observableRef,
      hiddenList: observableRef,
      groupSet: observableRef,
      shown: computed,
      list: computed,
      homes: computed,
      projectOrder: computed,
      pins: computed,
      hiddenProjects: computed,
      groups: computed,
    });
  }

  /** The server's views with the writes still in flight applied, as the viewer expects them to end up. */
  private get shown(): Map<string, SavedView> {
    const out = new Map(this.server);
    const now = new Date().toISOString();
    for (const w of this.outbox) {
      if (w.op === "delete") out.delete(w.id);
      else if (w.op === "save") {
        const was = out.get(w.id);
        if (was) out.set(w.id, { ...was, ...w.set });
        else if (isFull(w.set)) out.set(w.id, { id: w.id, ownerId: this.me(), createdAt: now, updatedAt: now, ...w.set });
      }
    }
    return out;
  }

  private sorted(): SavedView[] {
    return [...this.shown.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  get list(): SavedView[] {
    return this.sorted().filter((v) => v.layout !== "home");
  }

  get homes(): SavedView[] {
    return this.sorted().filter((v) => v.layout === "home");
  }

  get(id: string): SavedView | undefined {
    return this.shown.get(id);
  }

  /** A list as the viewer expects it to end up: the latest write of it still in flight, or the server's. */
  private latest<O extends "order" | "pins" | "hidden" | "groups", T>(op: O, server: T, of: (w: Extract<ViewWrite, { op: O }>) => T): T {
    for (let k = this.outbox.length - 1; k >= 0; k--) {
      const w = this.outbox[k]!;
      if (w.op === op) return of(w as Extract<ViewWrite, { op: O }>);
    }
    return server;
  }

  get projectOrder(): string[] {
    return this.latest("order", this.order, (w) => w.ids);
  }

  get pins(): PinRef[] {
    return this.latest("pins", this.pinList, (w) => w.refs);
  }

  get hiddenProjects(): string[] {
    return this.latest("hidden", this.hiddenList, (w) => w.ids);
  }

  get groups(): SidebarGroups {
    return this.latest("groups", this.groupSet, (w) => w.groups);
  }

  pinned(ref: PinRef): boolean {
    return this.pins.includes(ref);
  }

  save(id: string, set: Partial<ViewFields>): void {
    this.write({ op: "save", id, set });
  }

  remove(id: string): void {
    this.write({ op: "delete", id });
  }

  /** A new pin goes last. */
  pin(ref: PinRef, pinned: boolean): void {
    if (pinned === this.pinned(ref)) return;
    this.setPins(pinned ? [...this.pins, ref] : this.pins.filter((r) => r !== ref));
  }

  setPins(refs: PinRef[]): void {
    this.write({ op: "pins", refs });
  }

  /** Puts `ref` right before `next` (undefined: last). */
  movePin(ref: PinRef, next: PinRef | undefined): void {
    const was = this.pins;
    const out = was.filter((r) => r !== ref);
    const at = next === undefined ? -1 : out.indexOf(next);
    out.splice(at < 0 ? out.length : at, 0, ref);
    if (out.some((r, i) => r !== was[i])) this.setPins(out);
  }

  setProjectOrder(ids: string[]): void {
    this.write({ op: "order", ids });
  }

  setGroups(groups: SidebarGroups): void {
    this.write({ op: "groups", groups });
  }

  hideProject(id: string, hidden: boolean): void {
    const was = this.hiddenProjects;
    if (hidden === was.includes(id)) return;
    this.write({ op: "hidden", ids: hidden ? [...was, id] : was.filter((p) => p !== id) });
  }

  // ── Engine side ─────────────────────────────────────────────────────────────────────────────────────────────

  /** A write the server has not echoed: it reaches the disk only with the snapshot (persistDelay later). */
  get unconfirmed(): boolean {
    return this.outbox.length > 0;
  }

  /** After `sub`: everything, or what changed since the last frame; then the writes still unconfirmed. */
  request(): void {
    this.send(this.at ? { t: "views", at: this.at } : { t: "views" });
    for (const w of this.outbox) this.send({ t: "view", w });
  }

  load(saved: SavedViews): void {
    runInAction(() => {
      this.server.replace(saved.v.map((v) => [v.id, v] as const));
      this.order = saved.o ?? [];
      this.pinList = saved.s ?? (saved.p ?? []).filter(([, on]) => on).map(([id]) => `view:${id}` as const);
      this.hiddenList = saved.h ?? [];
      this.groupSet = saved.g ?? NO_GROUPS;
      this.outbox = saved.w;
      this.at = saved.at;
      this.status = "ready";
    });
  }

  persisted(): SavedViews | undefined {
    return this.status === "ready" ? { v: [...this.server.values()], o: this.order, s: this.pinList, h: this.hiddenList, g: this.groupSet, at: this.at, w: this.outbox } : undefined;
  }

  onViews(f: ViewsFrame): void {
    runInAction(() => {
      if (f.full) this.server.replace(f.v.map((v) => [v.id, v] as const));
      else {
        for (const v of f.v) this.server.set(v.id, v);
        for (const id of f.gone) this.server.delete(id);
      }
      if (f.o) this.order = f.o;
      if (f.s) this.pinList = f.s;
      if (f.h) this.hiddenList = f.h;
      if (f.g) this.groupSet = f.g;
      // The echo of the oldest write of each id this frame answers (our socket gets frames in the order it wrote).
      const answered = new Set([...f.v.map((v) => v.id), ...f.gone]);
      // A list has no id: the frame carrying it answers the oldest write of it. A whole frame answers a request, not a write.
      const lists = new Set(f.full ? [] : [f.o && "order", f.s && "pins", f.h && "hidden", f.g && "groups"]);
      this.outbox = this.outbox.filter((w) => {
        if (w.op === "save" || w.op === "delete" || w.op === "pin") return !answered.delete(w.id);
        return !lists.delete(w.op);
      });
      if (f.at && (!this.at || f.at > this.at)) this.at = f.at;
      this.status = "ready";
    });
    this.changed();
  }

  /** A refused write: drop what is in flight and start over from the server's views. */
  onRejected(): void {
    runInAction(() => (this.outbox = []));
    this.at = null;
    this.send({ t: "views" });
  }

  private write(w: ViewWrite): void {
    runInAction(() => (this.outbox = [...this.outbox, w]));
    this.send({ t: "view", w });
    this.changed();
  }
}

const isFull = (set: Partial<ViewFields>): set is ViewFields =>
  !!set.name && !!set.icon && set.query !== undefined && !!set.display && !!set.layout && set.shared !== undefined && set.tab !== undefined && set.position !== undefined;
