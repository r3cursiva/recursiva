// Who did something, in a row of My work or the project's history: an agent as its name in mono, a person with their
// avatar. `boxed` (the history) frames an agent's name like a tag and makes a person's name medium, as the Timeline
// artboards draw them.
import { RobotIcon } from "@phosphor-icons/react";
import { APP_BOT, type User } from "@rsva/schema/models";
import type { SyncStore } from "@rsva/sync";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { cn } from "@rsva/ui/lib/utils";
import { face } from "../lib/face.ts";
import { GithubMark } from "./github-parts.tsx";
import { Mark } from "./mark.tsx";

/** A bot's mark: the app's own for its changes (cycle rollover), GitHub's for GitHub's. */
export function BotMark({ user, className = "" }: { user: Pick<User, "name" | "email">; className?: string }) {
  if (user.email !== APP_BOT.email) return <GithubMark title={user.name} className={className} />;
  return (
    <span title={user.name} className={cn("grid size-5 shrink-0 place-items-center rounded-full border border-rule-strong bg-panel", className)}>
      <Mark size={10} />
    </span>
  );
}

/** A person's avatar, or a bot's mark. */
export function PersonFace({ user, className }: { user: Pick<User, "kind" | "name" | "email" | "picture" | "avatar">; className: string }) {
  return user.kind === "bot" ? <BotMark user={user} className={className} /> : <UserAvatar {...face(user)} className={className} />;
}

export function Actor({ engine, id, boxed = false }: { engine: Pick<SyncStore, "users">; id: string; boxed?: boolean }) {
  const u = engine.users.get(id);
  if (!u) return null;
  return u.kind === "agent" ? (
    <span
      className={cn(
        "flex shrink-0 items-center gap-[5px] font-mono whitespace-nowrap text-ink",
        boxed ? "rounded-[4px] border border-rule-strong bg-panel py-px pr-1.5 pl-1 text-[11.5px]" : "text-meta",
      )}
    >
      <RobotIcon className={boxed ? "size-3" : "size-[13px]"} />
      {u.name}
    </span>
  ) : (
    <span className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap", boxed && "text-[12.5px] font-medium")}>
      <PersonFace user={u} className={boxed ? "size-[18px]" : "size-4"} />
      <span className="text-ink">{u.name}</span>
    </span>
  );
}
