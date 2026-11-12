// A page with only the editor, for tools/perf/src/editor.ts (pnpm perf:editor): mounts the real RichEditor (toolbar
// included) on a fixture document and reports the time to a laid-out DOM. Fixtures are invented (test/fixtures).
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { fromHtml } from "../src/html.ts";
import { RichEditor } from "../src/react/rich-editor.tsx";
import "../src/content.css";
import desc from "../test/fixtures/desc-3k5.html";
import big from "../test/fixtures/doc-50k.html";

const fixtures: Record<string, string> = { "desc-3k5": desc, "doc-50k": big };
const name = new URLSearchParams(location.search).get("doc") ?? "doc-50k";
const doc = fromHtml(fixtures[name]!);
const host = document.getElementById("editor")!;
// As the description editor in the app: "@", "#" and "/" tracked on every keystroke (the people and issue lists stay empty here).
const mentions = { search: () => [] };
const issues = { open: () => () => [] };
// Issue keys scanned in every block on mount and in the touched block on every keystroke; any key resolves.
const issueHref = (key: string) => `/w/browse/${key}`;

const t0 = performance.now();
flushSync(() => createRoot(host).render(<RichEditor initial={doc} placeholder="Add description…" mentions={mentions} issues={issues} blocks issueHref={issueHref} />));
host.getBoundingClientRect(); // style and layout
const mountMs = performance.now() - t0;
requestAnimationFrame(() => {
  (window as unknown as { bench: unknown }).bench = { mountMs, paintMs: performance.now() - t0 };
  document.title = "ready";
});
