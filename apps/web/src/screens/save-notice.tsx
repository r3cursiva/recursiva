// Says out loud that changes have not reached the server. The sidebar's status line is easy to miss and a phone keeps it in
// a menu, while everything on screen looks saved: edits apply at once and only the small dots say otherwise.
import { Toast } from "@rsva/ui/components/toast";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { store } from "../store.ts";

/** A drop this short heals by itself before anyone can do anything about it. */
const DELAY_MS = 2000;
const SAVED_MS = 3000;

const changes = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

export const SaveNotice = observer(function SaveNotice() {
  const state = store.saveState;
  const waiting = state === "offline" || state === "stalled";
  const n = store.pendingCount;
  const [shown, setShown] = useState(false);
  const [saved, setSaved] = useState(false);
  const told = useRef(false);

  useEffect(() => {
    if (waiting) {
      const t = setTimeout(() => {
        told.current = true;
        setShown(true);
      }, DELAY_MS);
      return () => clearTimeout(t);
    }
    setShown(false);
    if (state !== "saved" || !told.current) return;
    told.current = false;
    // Not after a refusal: the queue is empty, but not because everything was saved.
    if (!store.lastRejection) setSaved(true);
  }, [waiting, state]);

  if (shown && waiting) {
    const keep = store.unsafe ? "This device can't keep them: leave this tab open." : n === 1 ? "It is kept on this device." : "They are kept on this device.";
    return (
      <Toast
        title={state === "offline" ? "Not saved: no connection" : "Not saved yet"}
        description={state === "offline" ? `${changes(n)} will go out when the connection is back. ${keep}` : `The server has not confirmed ${changes(n)}. ${keep}`}
        duration={2 ** 31 - 1}
        onClose={() => setShown(false)}
      />
    );
  }
  return saved && state === "saved" ? <Toast title="All changes saved" duration={SAVED_MS} onClose={() => setSaved(false)} /> : null;
});
