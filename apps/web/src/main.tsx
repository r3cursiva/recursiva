import "./index.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// The account's pane style on <html> as soon as it is known (a new device learns it with the snapshot).
import "./panes.ts";
import { ErrorBoundary } from "./error-boundary.tsx";
import { watchKeyboard } from "./lib/keyboard.ts";
import { watchNewVersion } from "./lib/new-version.ts";
import { keepFocusOnPress } from "./lib/press-focus.ts";
import { router } from "./router.ts";
import { guardFileDrops } from "./screens/file-drop.ts";
import { loadEditChunk } from "./screens/load-edit-chunk.ts";

watchKeyboard();
keepFocusOnPress();
guardFileDrops();
/**
 * The longest the first render waits for the chunk: past 300 ms the fallback would have cost the same, as that is how long
 * React holds a screen behind one. A slow machine needs it: a CI runner takes over 100 ms to compile the chunk.
 */
const CHUNK_WAIT_MS = 400;

function render() {
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
  // Mark for the perf checks (tools/perf): the shell has painted.
  requestAnimationFrame(() => performance.mark("rsva:shell"));
}

// Every screen but the list is in the edit chunk. On a return visit the Service Worker has it a few ms away, and waiting
// for it spares the fallback and the 300 ms React keeps a screen behind one (load-edit-chunk.ts). The first visit has
// no worker yet: the shell paints first.
if (navigator.serviceWorker?.controller && router.route.name !== "issues") {
  void Promise.race([loadEditChunk(), new Promise((r) => setTimeout(r, CHUNK_WAIT_MS))]).catch(() => {}).finally(render);
} else render();

if (import.meta.env.PROD && "serviceWorker" in navigator) watchNewVersion();
