// A transaction the server refused: its change is already reverted, tell the user why. In the edit chunk (App.tsx draws
// it through chunkWhen): refusals are rare, and their text needs the editor's plain-text reader (RSVA-497).
import { Toast } from "@rsva/ui/components/toast";
import { observer } from "mobx-react-lite";
import { lostText } from "../lib/lost-text.ts";
import { store } from "../store.ts";

export const Rejection = observer(function Rejection() {
  const r = store.lastRejection;
  if (!r) return null;
  const lost = lostText(r.lost);
  return (
    <Toast
      variant="destructive"
      title={r.count > 1 ? `${r.count} changes not saved` : "Change not saved"}
      description={`${r.message} (${r.code})`}
      {...(lost ? { field: { label: "Your text", value: lost } } : {})}
      onClose={clearRejection}
    />
  );
});

const clearRejection = () => store.clearRejection();
