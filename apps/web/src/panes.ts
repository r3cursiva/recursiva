// The interface's own settings on a wide screen (Settings › Appearance › Layout): the panes, framed (apart on a frame
// with rounded corners) or flat (side by side with a line between them), and the density of a list's rows.
// They are attributes on <html> that globals.css reads (data-panes for .pane, data-density for --row). The choice is on
// the account (account.settings.ui), so every device looks the same.
//
// localStorage "rsva:ui" holds it for index.html, which sets the attributes before the first paint, so the window
// never jumps from one layout to the other. Sign-out keeps it (auth.ts), as it keeps the theme.
//
// The same object holds where the app opens (Settings › Preferences › Navigation, RSVA-527): `projectPath` below and
// the start in App.tsx read it.
import { UI_DEFAULTS, uiFrom, type UiChoice } from "@rsva/protocol";
import { autorun } from "mobx";
import { account } from "./account.ts";
import { readLocal, writeLocal } from "./lib/local-storage.ts";
import { paths } from "./router.ts";

const KEY = "rsva:ui";

const saved = (): UiChoice => uiFrom(readLocal(KEY)) ?? UI_DEFAULTS;

/** The account's choice once it has one, else what this device saw last. */
const device = saved();
// Read as this build knows it: a copy saved by an older one may hold a value since renamed (comfortable → framed).
export const uiChoice = (): UiChoice => uiFrom(account.settings.ui) ?? device;

/** Shown at once, saved to the account; a refusal puts back what the account holds and is thrown. */
export const setUi = (patch: Partial<UiChoice>): Promise<void> => account.update({ ui: { ...uiChoice(), ...patch } });

/** Where a project opens from the sidebar, All projects and ⌘K: its home or its issues, as the person chose. */
export const projectPath = (ws: string, key: string): string => (uiChoice().project === "issues" ? paths.issues : paths.projectHome)(ws, key);

autorun(() => {
  const c = uiChoice();
  document.documentElement.dataset.panes = c.panes;
  document.documentElement.dataset.density = c.density;
  writeLocal(KEY, c);
});
