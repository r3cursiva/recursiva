// A person or an agent as a small face: an agent's mark is square. The project home's rows and the issue's review bar.
import { AgentAvatar, UserAvatar } from "@rsva/ui/components/user-avatar";
import { observer } from "mobx-react-lite";
import { faceOf } from "../lib/face.ts";
import { store } from "../store.ts";

export const Face = observer(function Face({ id }: { id: string | null }) {
  const u = id ? store.users.get(id) : undefined;
  if (u?.kind === "agent") return <AgentAvatar name={u.name} className="size-[18px]" />;
  return <UserAvatar {...faceOf(id)} className="size-[18px] text-[8px]" />;
});
