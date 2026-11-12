// How the viewer looks at My work: which workspace or project it is limited to (F) and how the queue is grouped. Saved per viewer in localStorage,
// like the inbox's view (inbox-view.ts), so a reload opens it as it was left. Which sections are folded is in the account
// settings with the sections themselves (lib/my-work-sections.ts), the same on every device.
import { makeAutoObservable } from "mobx";
import type { Scope } from "./lib/my-work.ts";
import { GROUP_BYS, type MyWorkGroupBy } from "./lib/my-work-groups.ts";
import { persistForViewer } from "./viewer-local.ts";

class MyWorkView {
  scope: Scope = "all";
  /** By the viewer's sections, or by status, priority or project (lib/my-work-groups.ts): this device's own too. */
  groupBy: MyWorkGroupBy = "section";

  constructor() {
    makeAutoObservable(this);
  }

  setScope(scope: Scope): void {
    this.scope = scope;
  }

  setGroupBy(by: MyWorkGroupBy): void {
    this.groupBy = by;
  }

}

export const myWorkView = new MyWorkView();

persistForViewer(
  (me) => `rsva:my-work:${me}`,
  (raw) => {
    const saved = raw as {
      scope?: unknown;
      groupBy?: unknown;
    } | null;
    if (GROUP_BYS.includes(saved?.groupBy as MyWorkGroupBy))
      myWorkView.setGroupBy(saved!.groupBy as MyWorkGroupBy);
    if (typeof saved?.scope === "string") myWorkView.setScope(saved.scope);
  },
  () => ({
    scope: myWorkView.scope,
    groupBy: myWorkView.groupBy,
  }),
);
