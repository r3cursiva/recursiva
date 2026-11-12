import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { beforeReload, handedOver, handover, holdReload, holdReloadFor, watch } from "./new-version.ts";

/** typing.ts asks the focused element whether it sits in a field or a popup; Node has no DOM. */
class Focused {
  readonly inField: boolean;
  constructor(inField: boolean) {
    this.inField = inField;
  }
  closest(): Focused | null {
    return this.inField ? this : null;
  }
}
(globalThis as { Element?: unknown }).Element = Focused;

let holding = false;
holdReload(() => holding);
/** What happened, in order: the handover ("save") and the reloads of every page. */
const log: string[] = [];
beforeReload(() => log.push("save"));

beforeEach(() => mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 }));
afterEach(() => {
  mock.timers.reset();
  holding = false;
  log.length = 0;
});

/** A page on stand-ins: a worker in control (or none, with one registered or none), visible and focused. */
function page({ controller = true, registered = false } = {}) {
  const reg = {
    installing: null as object | null,
    waiting: null,
    active: {},
    updates: 0,
    /** What the next update() finds: a newer worker, nothing, or a failure. */
    finds: "nothing" as "newer" | "nothing" | "failure",
    update: async () => {
      reg.updates++;
      if (reg.finds === "failure") throw new Error("offline");
      if (reg.finds === "newer") reg.installing = {};
    },
  };
  const sw = Object.assign(new EventTarget(), {
    controller: controller ? {} : null,
    getRegistration: async () => (registered ? reg : undefined),
    register: async () => reg,
  });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    activeElement: null as Focused | null,
    focused: true,
    hasFocus: () => doc.focused,
  });
  const win = new EventTarget();
  const p = {
    reg,
    doc,
    reloads: 0,
    updater: watch({ sw: sw as never, document: doc as never, window: win as never, reload: () => void (p.reloads++, log.push("reload")) }),
    /** A new worker takes over. */
    takeover: () => settle(() => sw.dispatchEvent(new Event("controllerchange"))),
    input: () => win.dispatchEvent(new Event("pointerdown")),
    blur: () => {
      doc.focused = false;
      win.dispatchEvent(new Event("blur"));
    },
    hide: () => {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    show: () => {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return p;
}

/** Runs `f` and lets the promises it starts settle. */
async function settle(f: () => unknown = () => {}): Promise<void> {
  f();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test("a page started on the old shell reloads when the new worker takes over, before any input", async () => {
  const p = page();
  mock.timers.tick(2000);
  await p.takeover();
  assert.equal(p.reloads, 1);
});

test("a page in use waits until it is left alone: away, and no input for 30 s (not a file picker opened by a click)", async () => {
  const p = page();
  p.input();
  await p.takeover();
  mock.timers.tick(5000);
  assert.equal(p.reloads, 0, "in front and in use");
  p.blur();
  mock.timers.tick(20_000);
  assert.equal(p.reloads, 0, "away, but clicked 25 s ago");
  mock.timers.tick(5000);
  assert.equal(p.reloads, 1);
  assert.deepEqual(log, ["save", "reload"], "the handover goes first");

  const q = page();
  mock.timers.tick(10_001); // looked at for a while: no longer a fresh start, input or not
  await q.takeover();
  assert.equal(q.reloads, 0);
  q.hide();
  assert.equal(q.reloads, 1, "hidden, and no input ever");
});

test("a page brought back after a real absence counts as fresh until the first input; one left a moment ago does not", async () => {
  const p = page();
  p.input();
  mock.timers.tick(60_000);
  p.hide();
  p.show();
  await p.takeover();
  assert.equal(p.reloads, 1);

  const q = page();
  q.input();
  mock.timers.tick(1000);
  q.hide(); // another tab, or a picker that hides the page
  await q.takeover();
  mock.timers.tick(5000);
  q.show();
  mock.timers.tick(5000);
  assert.equal(q.reloads, 0, "not in front of the person who just came back");
  q.hide();
  mock.timers.tick(30_000);
  assert.equal(q.reloads, 1, "hidden again, and left alone");
});

test("nothing is lost: the focus in a field or popup, a holder and a write on its way each keep the reload back", async () => {
  const p = page();
  holding = true;
  p.doc.activeElement = new Focused(true);
  await p.takeover();
  p.hide();
  holding = false;
  await settle(() => mock.timers.tick(1000));
  assert.equal(p.reloads, 0, "the focus is in a field");
  let sent!: () => void;
  const write = holdReloadFor(new Promise<void>((r) => (sent = r)));
  p.doc.activeElement = new Focused(false);
  await settle(() => mock.timers.tick(1000));
  assert.equal(p.reloads, 0, "the write is on its way");
  sent();
  await write;
  holding = true;
  await settle(() => mock.timers.tick(1000));
  assert.equal(p.reloads, 0, "the holder holds");
  holding = false;
  mock.timers.tick(1000);
  assert.equal(p.reloads, 1);
  mock.timers.tick(5000);
  assert.equal(p.reloads, 1, "once");
});

test("the card: shown while a page in use waits; Reload goes once nothing is lost; Later hides it until the next version", async () => {
  const fresh = page();
  await fresh.takeover();
  assert.equal(fresh.reloads, 1);
  assert.equal(fresh.updater.card, null, "a reload at once shows nothing");
  log.length = 0;

  const p = page();
  p.input();
  await p.takeover();
  assert.equal(p.updater.card, "ready");
  let sent!: () => void;
  const write = holdReloadFor(new Promise<void>((r) => (sent = r)));
  p.updater.reloadNow();
  assert.equal(p.reloads, 0, "a write on its way");
  assert.equal(p.updater.card, "reloading");
  sent();
  await write;
  mock.timers.tick(1000);
  assert.deepEqual(log, ["save", "reload"], "the same reload as the quiet one, handover first");

  const q = page();
  q.input();
  await q.takeover();
  q.updater.later();
  assert.equal(q.updater.card, null);
  q.input();
  mock.timers.tick(5000);
  assert.equal(q.updater.card, null, "stays hidden");
  await q.takeover();
  assert.equal(q.updater.card, "ready", "the next version shows it again");
  q.hide();
  mock.timers.tick(30_000);
  assert.equal(q.reloads, 1, "leaving still reloads");
});

test("a first visit: the first worker to take over is this very version; after a hard reload it is a newer one", async () => {
  const first = page({ controller: false });
  await settle();
  await first.takeover();
  assert.equal(first.reloads, 0);
  await first.takeover();
  assert.equal(first.reloads, 1);

  const hard = page({ controller: false, registered: true });
  await settle();
  await hard.takeover();
  assert.equal(hard.reloads, 1);
});

test("sockets coming back together ask for the new worker once", async () => {
  const p = page();
  await settle(() => [1, 2, 3].forEach(() => p.updater.check()));
  assert.equal(p.reg.updates, 1);
  await settle(() => p.updater.check());
  assert.equal(p.reg.updates, 2);
});

test("another protocol: reload as soon as the new worker is in, even in use; with none coming or no answer, at once", async () => {
  const p = page();
  p.reg.finds = "newer";
  p.input();
  p.doc.activeElement = new Focused(true);
  await settle(() => p.updater.reloadSoon());
  assert.equal(p.reloads, 0, "waits for the takeover");
  await p.takeover();
  assert.equal(p.reloads, 1);

  for (const finds of ["nothing", "failure"] as const) {
    log.length = 0;
    const q = page();
    q.reg.finds = finds;
    await settle(() => q.updater.reloadSoon());
    assert.deepEqual(log, ["save", "reload"], finds);
  }

  const behind = page();
  behind.input();
  await behind.takeover();
  assert.equal(behind.reloads, 0);
  await settle(() => behind.updater.reloadSoon());
  assert.equal(behind.reloads, 1, "already behind: at once");
});

test("what is handed over reaches only the same person's next page", () => {
  const saved = handover("a", [["issue:1", "draft"]]);
  assert.deepEqual(handedOver(saved, "a"), [["issue:1", "draft"]]);
  assert.equal(handedOver(saved, "b"), null, "someone else signed in meanwhile");
  assert.equal(handedOver(saved, null), null, "signed out");
  for (const junk of [null, [["issue:1", "draft"]], { value: 1 }, "x"]) assert.equal(handedOver(junk, "a"), null);
});
