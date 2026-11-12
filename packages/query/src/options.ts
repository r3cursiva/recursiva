// Labels of the display options, in Plane's order: one list for the Display panel, the CLI and MCP help.
import type { DisplayProperty, GroupBy, OrderBy } from "./index.ts";

export const GROUP_BY_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { value: "state", label: "States" },
  { value: "stateGroup", label: "State groups" },
  { value: "priority", label: "Priority" },
  { value: "label", label: "Labels" },
  { value: "assignee", label: "Assignees" },
  { value: "createdBy", label: "Created by" },
  { value: "delegate", label: "Agent" },
  { value: "project", label: "Projects" },
  { value: "cycle", label: "Cycles" },
  { value: "parent", label: "Parent" },
  { value: "none", label: "None" },
];

export const ORDER_BY_OPTIONS: readonly { value: OrderBy; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "createdAt", label: "Last created" },
  { value: "updatedAt", label: "Last updated" },
  { value: "startDate", label: "Start date" },
  { value: "dueDate", label: "Due date" },
  { value: "priority", label: "Priority" },
];

export const DISPLAY_PROPERTY_OPTIONS: readonly { value: DisplayProperty; label: string }[] = [
  { value: "key", label: "ID" },
  { value: "assignees", label: "Assignees" },
  { value: "startDate", label: "Start date" },
  { value: "dueDate", label: "Due date" },
  { value: "labels", label: "Labels" },
  { value: "priority", label: "Priority" },
  { value: "state", label: "State" },
  { value: "cycle", label: "Cycle" },
  { value: "subIssueCount", label: "Sub-issue count" },
  { value: "createdAt", label: "Created on" },
  { value: "updatedAt", label: "Updated on" },
];
