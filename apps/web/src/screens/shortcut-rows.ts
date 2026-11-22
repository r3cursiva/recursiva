// The rows of the shortcut sheet: every key of the app, by screen. A key added to a screen is added here in the same change;
// shortcut-rows.test.ts compares the table with the handlers.
import { caps } from "@rsva/ui/lib/keys";

/** One way to press it: keys at once ("⌘ K") or one after another ("G I", a chord). */
export interface Press {
  keys: string[];
  chord?: boolean;
}
/** A row: what it does and its presses, any of which does it. */
export type Row = [label: string, ...presses: (string | Press)[]];

const chord = (...keys: string[]): Press => ({ keys, chord: true });
const keys = (...k: string[]): Press => ({ keys: caps(...k) });

export const SECTIONS: { title: string; note?: string; rows: Row[] }[] = [
  {
    title: "Moving around",
    note: "Tab moves between areas, the arrows inside one; Enter goes in, Esc goes out.",
    rows: [
      ["Next area, previous area", "Tab", keys("shift", "Tab")],
      ["Inside an area", keys("↑", "↓"), keys("←", "→")],
      ["Go in: open the issue, then into its pane", "Enter"],
      ["Go out: a field, the pane, then close", "Esc"],
      ["Sidebar, list, pane", "F6", keys("shift", "F6")],
      ["Command palette", keys("mod", "K")],
      ["Collapse the sidebar", keys("mod", "\\")],
      ["This sheet", "?"],
    ],
  },
  {
    title: "Go to",
    rows: [
      ["Inbox", chord("G", "N")],
      ["My work", chord("G", "M")],
      ["Decisions", chord("G", "D")],
      ["Project home", chord("G", "O")],
      ["Issues", chord("G", "I")],
      ["Cycles", chord("G", "C")],
      ["History", chord("G", "H")],
      ["Views", chord("G", "V")],
      ["All projects", chord("G", "P")],
      ["Previous, next project", "[", "]"],
      ["Project settings", ","],
      ["Workspace settings", chord("G", ",")],
    ],
  },
  {
    title: "Create",
    rows: [
      ["New issue", "C", chord("N", "I")],
      ["New project", chord("N", "P")],
      ["New view", keys("shift", "N")],
    ],
  },
  {
    title: "Lists and boards",
    rows: [
      ["Move", "J", "K", keys("↑", "↓")],
      ["Board: another column", keys("←", "→")],
      ["Mark for a bulk action", "X"],
      ["Mark while moving", keys("shift", "J"), keys("shift", "K"), keys("shift", "↑"), keys("shift", "↓")],
      ["Mark all", keys("mod", "A")],
      ["List or board", "V"],
      ["The View panel: filters and display", "F", "E"],
      ["Display", keys("shift", "V")],
      ["Filter with a query", "/"],
      ["View tabs", "1 – 9"],
      ["Move the view tab", keys("alt", "←"), keys("alt", "→")],
    ],
  },
  {
    title: "Issue",
    note: "On the open issue, else on the selected row; on the marked ones while some are marked.",
    rows: [
      ["State", "S"],
      ["Priority", "P"],
      ["Assignees", "A"],
      ["Labels", "L"],
      ["Subscribe", keys("shift", "S")],
      ["Copy the key", keys("mod", ".")],
      ["Copy the branch name", keys("mod", "shift", ".")],
      ["Move to project", keys("mod", "shift", "M")],
      ["Delete", keys("mod", "⌫")],
      ["Undo", keys("mod", "Z")],
    ],
  },
  {
    title: "Inbox",
    rows: [
      ["Archive", "E", "⌫"],
      ["Read, unread", "U"],
      ["Snooze", "H"],
      ["The suggested move", keys("mod", "Enter")],
      ["Mark all read", keys("alt", "U")],
      ["Archive the read ones", keys("shift", "⌫")],
    ],
  },
  {
    title: "My work",
    rows: [
      ["A section", "1 – 9"],
      ["All workspaces", "0"],
      ["Show done", keys("shift", "D")],
      ["Limit to a workspace or project", "F"],
      ["Fold, unfold a project's proposals", "H", "L"],
      ["Open the issue beside the list", "↵"],
      ["Accept, decline a proposal", "A", "D"],
      ["Reply to a mention", "R"],
      ["Start an issue", "S"],
      ["A new assignment: Todo, Later, unassign", "T", "L", "U"],
    ],
  },
  {
    title: "Decisions",
    rows: [
      ["Answer with an option", "1 – 4"],
      ["Take the recommendation", "↵"],
      ["Skip, open the issue", "S", "O"],
      ["Answer in your own words", "R"],
      ["Answer the same way next time", "A"],
      ["Undo the last answer", "Z"],
      ["Another card; in a group, another issue", "J", "K"],
      ["Leave an issue of a group out", "X"],
    ],
  },
  {
    title: "Project home",
    rows: [
      ["Rows of every widget", "J", "K"],
      ["Open the issue", "↵"],
      ["Status, priority, assignees, labels", "S", "P", "A", "L"],
      ["Customize", "E"],
      ["Close a widget's settings, then cancel", "Esc"],
      ["Done", keys("mod", "↵")],
    ],
  },
  {
    title: "History",
    rows: [
      ["Level", "1 – 4", "-", "="],
      ["Agents, people, everyone", "A", "P", "0"],
    ],
  },
  {
    title: "All projects",
    rows: [
      ["Active, archived", "1", "2"],
      ["Find", "/"],
      ["Archive or restore", "E"],
      ["Reorder", keys("alt", "↑"), keys("alt", "↓")],
    ],
  },
];
