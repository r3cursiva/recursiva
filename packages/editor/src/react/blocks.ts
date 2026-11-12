// The selection toolbar's text styles, lists and blocks (toolbar.tsx), and what "/" offers of them (caret-menu.tsx). A .ts
// file, icons made with createElement, so the tests import the lists without a JSX step.
import {
  CodeBlockIcon,
  ColumnsPlusLeftIcon,
  ColumnsPlusRightIcon,
  RowsPlusBottomIcon,
  RowsPlusTopIcon,
  TableIcon,
  TrashIcon,
  CodeIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  TextTIcon,
} from "@phosphor-icons/react";
import { createElement, type ReactNode } from "react";
import { keys } from "@rsva/ui/lib/keys";
import type { Cmd } from "../view/commands.ts";

interface Block {
  cmd: Cmd;
  label: string;
  icon: ReactNode;
  keys?: string;
}

const icon = createElement;

export const STYLES: Block[] = [
  { cmd: "paragraph", label: "Text", icon: icon(TextTIcon), keys: keys("mod", "alt", "0") },
  { cmd: "h1", label: "Heading 1", icon: icon(TextHOneIcon), keys: keys("mod", "alt", "1") },
  { cmd: "h2", label: "Heading 2", icon: icon(TextHTwoIcon), keys: keys("mod", "alt", "2") },
  { cmd: "h3", label: "Heading 3", icon: icon(TextHThreeIcon), keys: keys("mod", "alt", "3") },
];
export const LISTS: Block[] = [
  { cmd: "bullet_list", label: "Bulleted list", icon: icon(ListBulletsIcon), keys: keys("mod", "shift", "8") },
  { cmd: "ordered_list", label: "Numbered list", icon: icon(ListNumbersIcon), keys: keys("mod", "shift", "7") },
  { cmd: "task_list", label: "Checklist", icon: icon(ListChecksIcon), keys: keys("mod", "shift", "9") },
];
export const BLOCKS: Block[] = [
  { cmd: "quote", label: "Quote", icon: icon(QuotesIcon), keys: keys("mod", "shift", "B") },
  { cmd: "code", label: "Inline code", icon: icon(CodeIcon), keys: keys("mod", "E") },
  { cmd: "code_block", label: "Code block", icon: icon(CodeBlockIcon) },
];
/** What "/" offers: the text styles, lists and blocks above, without inline code, which is not a block, and a table. */
export const SLASH_BLOCKS = [...STYLES, ...LISTS, ...BLOCKS.filter((b) => b.cmd !== "code"), { cmd: "table", label: "Table", icon: icon(TableIcon) } satisfies Block];
/** What "/" offers in a table cell (view/table.ts). */
const TABLE_ACTIONS: Block[] = [
  { cmd: "row_above", label: "Row above", icon: icon(RowsPlusTopIcon) },
  { cmd: "row_below", label: "Row below", icon: icon(RowsPlusBottomIcon) },
  { cmd: "col_left", label: "Column left", icon: icon(ColumnsPlusLeftIcon) },
  { cmd: "col_right", label: "Column right", icon: icon(ColumnsPlusRightIcon) },
  { cmd: "delete_row", label: "Delete row", icon: icon(TrashIcon) },
  { cmd: "delete_col", label: "Delete column", icon: icon(TrashIcon) },
  { cmd: "delete_table", label: "Delete table", icon: icon(TrashIcon) },
];

/** "/head", "/h2", "/list", "/codeblock": a word of the block's name or command, or the name without its spaces. */
export function matchBlocks(query: string, inTable = false): Block[] {
  const q = query.toLowerCase();
  return (inTable ? TABLE_ACTIONS : SLASH_BLOCKS).filter((b) => {
    const name = b.label.toLowerCase();
    return name.replace(/\s/g, "").startsWith(q) || `${b.cmd} ${name}`.split(/[\s_]+/).some((w) => w.startsWith(q));
  });
}
