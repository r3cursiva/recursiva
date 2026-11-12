// The saved views' icons (PLNR-74): a short list of Phosphor icons (the protocol's VIEW_ICONS; the server refuses any
// other name). In the lazy edit chunk, drawn through view-icon.tsx: their paths stay out of the startup JS.
import {
  BugIcon,
  CalendarBlankIcon,
  ClockIcon,
  EyeIcon,
  FlagIcon,
  LightningIcon,
  RobotIcon,
  StackIcon,
  StarIcon,
  TagIcon,
  UserIcon,
  WarningIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ViewIcon as ViewIconName } from "@rsva/protocol";
import { cn } from "@rsva/ui/lib/utils";

export const VIEW_ICON: Record<ViewIconName, { icon: Icon; label: string }> = {
  stack: { icon: StackIcon, label: "Stack" },
  eye: { icon: EyeIcon, label: "Eye" },
  robot: { icon: RobotIcon, label: "Robot" },
  flag: { icon: FlagIcon, label: "Flag" },
  tag: { icon: TagIcon, label: "Tag" },
  warning: { icon: WarningIcon, label: "Warning" },
  calendar: { icon: CalendarBlankIcon, label: "Calendar" },
  clock: { icon: ClockIcon, label: "Clock" },
  star: { icon: StarIcon, label: "Star" },
  user: { icon: UserIcon, label: "Person" },
  lightning: { icon: LightningIcon, label: "Lightning" },
  bug: { icon: BugIcon, label: "Bug" },
};

export function ViewIconGlyph({ name, className }: { name: ViewIconName; className?: string }) {
  const I = (VIEW_ICON[name] ?? VIEW_ICON.stack).icon;
  return <I aria-hidden className={cn("size-3.5 shrink-0", name === "warning" ? "text-signal-text" : "text-ink-3", className)} />;
}
