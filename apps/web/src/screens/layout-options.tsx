// The layout's choices, worded once for Settings › Appearance (theme-picker.tsx) and the command palette: the pane
// style and the density (panes.ts applies them). Not in panes.ts: that file is in the startup chunk, these icons and
// words are only for the screens that offer the choice, both loaded on demand.
import { GridFourIcon, RowsIcon, SquaresFourIcon, TextAlignJustifyIcon } from "@phosphor-icons/react";
import type { Density, PaneStyle } from "@rsva/protocol";
import type { ReactNode } from "react";

export const PANES: readonly { value: PaneStyle; label: string; icon: ReactNode }[] = [
  { value: "framed", label: "Framed", icon: <SquaresFourIcon /> },
  { value: "flat", label: "Flat", icon: <GridFourIcon /> },
];

export const PANES_HINT: Record<PaneStyle, string> = {
  framed: "The sidebar and each pane apart on a frame; rows, cards and sections as rounded plates.",
  flat: "The sidebar and each pane side by side; lines between rows, columns and sections.",
};

export const DENSITY: readonly { value: Density; label: string; icon: ReactNode }[] = [
  { value: "comfortable", label: "Comfortable", icon: <RowsIcon /> },
  { value: "compact", label: "Compact", icon: <TextAlignJustifyIcon /> },
];

export const DENSITY_HINT: Record<Density, string> = {
  compact: "List rows 32px tall: more of them on screen.",
  comfortable: "List rows 40px tall, with more air between them.",
};
