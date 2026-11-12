// Copies that stay for now, each with its reason (RSVA-432). An entry allows exactly `count` copies of a rule in a file:
// one more fails, and so does one fewer, so the entry goes once its copies do.
import type { Allowed } from "./copies.ts";

/** Open pull requests of 2026-11-07/08 change these files; their copies are replaced after those merge (RSVA-483). */
const OPEN_PR = (prs: string) => `the file is changed by open ${prs}: replace after it merges (RSVA-483)`;

export const ALLOWED: Allowed[] = [
  // A word typed into search that may be a key in the making: the digits may be missing ("plnr-").
  { rule: "issue-key", file: "packages/query/src/run.ts", count: 1, reason: "a key prefix as typed, not a whole key" },
  { rule: "issue-key", file: "apps/server/src/mail/inbound.test.ts", count: 1, reason: OPEN_PR("#368") },
  { rule: "plural", file: "apps/server/src/mail/emails.ts", count: 1, reason: OPEN_PR("#368") },
  { rule: "plural", file: "apps/web/src/screens/account-notifications.tsx", count: 1, reason: OPEN_PR("#365") },
  { rule: "plural", file: "apps/web/src/screens/account-telegram.tsx", count: 1, reason: OPEN_PR("#365") },
  { rule: "plural", file: "apps/web/src/screens/create-workspace.tsx", count: 3, reason: OPEN_PR("#365") },
  { rule: "plural", file: "apps/web/src/screens/join-screen.tsx", count: 1, reason: OPEN_PR("#365") },
  { rule: "plural", file: "apps/web/src/screens/no-workspace.tsx", count: 1, reason: OPEN_PR("#365") },
  { rule: "plural", file: "apps/web/src/screens/settings-labels.tsx", count: 2, reason: OPEN_PR("#365") },
  { rule: "plural", file: "apps/web/src/screens/settings-workflow.tsx", count: 1, reason: OPEN_PR("#365") },
  { rule: "plural", file: "apps/web/src/screens/view-tabs.tsx", count: 1, reason: OPEN_PR("#363") },
  { rule: "plural", file: "apps/web/src/screens/workspace-members.tsx", count: 2, reason: OPEN_PR("#354 and #365") },
  { rule: "plural", file: "apps/web/src/screens/workspace-menu.tsx", count: 1, reason: OPEN_PR("#365") },
];
