// The sidebar's foot: the account, the theme and, at the right, the connection; above it, a new version waiting for a
// reload (update-card.tsx). Collapsed: the views and the account, the theme moves into the account's menu, the connection
// shows only when it is lost, and the new version is a button.
import { MonitorIcon, MoonIcon, SunIcon, UserCircleIcon } from "@phosphor-icons/react";
import { Button } from "@rsva/ui/components/button";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { type ComponentProps, type ReactNode } from "react";
import { store } from "../store.ts";
import { theme, type ThemeMode } from "../theme.ts";
import { LazyMenu } from "./lazy-menu.tsx";
import { chunk, chunkWhen, loadEditChunk } from "./load-edit-chunk.ts";
import { Tip, TipNote } from "./sidebar-tip.tsx";
import { updateCard } from "../lib/new-version.ts";

const CONNECTION = { connecting: "Connecting…", online: "Online", offline: "Offline" } as const;

export const THEME: Record<ThemeMode, { label: string; icon: typeof SunIcon }> = {
  system: { label: "As the system", icon: MonitorIcon },
  light: { label: "Light", icon: SunIcon },
  dark: { label: "Dark", icon: MoonIcon },
};

const footButton = "group/tip relative grid place-items-center rounded-[5px] border-0 text-ink-3 active:scale-94! strip:hidden";

/** Shows the theme in use; a click moves to the next one (system → light → dark). */
const ThemeButton = observer(function ThemeButton() {
  const { label, icon: Icon } = THEME[theme.mode];
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={`Theme: ${label}. Switch to ${THEME[theme.next].label.toLowerCase()}`} className={footButton} onClick={() => theme.cycle()}>
      <Icon className="size-4" />
      <Tip>Theme: {label}</Tip>
    </Button>
  );
});

const AccountMenu = chunk("AccountMenu");
const ConnectionPanel = chunk("ConnectionPanel");
// A new version waiting for a reload, and the collapsed sidebar's button for it (update-card.tsx, in the edit chunk).
const UpdateCard = chunkWhen("UpdateCard", updateCard);
const UpdateButton = chunkWhen("UpdateButton", updateCard);

/**
 * The viewer's avatar; a click opens the account menu (account-menu.tsx), from the lazy chunk (lazy-menu.tsx): hovering
 * starts loading it.
 */
const AccountButton = observer(function AccountButton() {
  const me = store.me;
  const button = (props: ComponentProps<"button">, open: boolean) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={me ? `Account: ${me.name}` : "Account"}
      onPointerEnter={() => void loadEditChunk()}
      className="group/tip relative grid size-[30px] place-items-center rounded-full border-0 strip:order-last hover:bg-transparent active:scale-94! aria-expanded:bg-transparent strip:h-[34px] strip:w-9 strip:rounded-[7px] strip:text-ink-2 strip:hover:bg-row-hover strip:hover:text-ink strip:data-popup-open:bg-row-hover"
      {...props}
    >
      <UserAvatar
        {...face(me, "")}
        className="size-[26px] bg-inverse text-[10px] text-inverse-ink transition group-hover/tip:ring-2 group-hover/tip:ring-rule-strong group-data-popup-open/tip:ring-2 group-data-popup-open/tip:ring-rule-strong strip:hidden"
      />
      <UserCircleIcon className="hidden size-[18px] strip:block" />
      {!open && (
        <Tip>
          {me?.name ?? "Account"}
          <TipNote>account, theme, sign out</TipNote>
        </Tip>
      )}
    </Button>
  );
  return <LazyMenu menu={AccountMenu} button={button} />;
});

function connectionLabel(): string {
  return `${CONNECTION[store.connection]}${store.pendingCount > 0 ? ` · ${store.pendingCount} unsaved` : ""}`;
}

/** Connected is success, offline a warning (Quire Ledger's feedback colors); the signal is not spent here. */
const ConnectionDot = observer(function ConnectionDot() {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full transition-transform duration-150 group-hover/tip:scale-133",
        store.saveState === "stalled" ? "bg-warning" : store.connection === "online" ? "bg-success" : store.connection === "offline" ? "bg-warning strip:size-2 strip:shadow-[0_0_0_3px_var(--color-warning-bg)]" : "animate-pulse bg-rule-strong",
      )}
    />
  );
});

/** The connection's dot and word: in the foot, in the phone's More menu and at the head of the panel they both open. */
export const SyncStatus = observer(function SyncStatus() {
  return (
    <>
      <ConnectionDot />
      <span className="min-w-0 truncate strip:hidden">{connectionLabel()}</span>
    </>
  );
});

/** The foot's connection. Collapsed it says nothing while all is well: only a lost connection takes a place there. */
const FootStatus = observer(function FootStatus() {
  // Read here, not in `button`: LazyMenu calls that from its own render, which no observer watches.
  const label = connectionLabel();
  const quiet = store.connection !== "offline";
  const button = (props: ComponentProps<"button">) => (
    <button
      {...props}
      type="button"
      aria-label={`${label}: connection details`}
      className={cn("group/tip relative -mr-2 flex h-7 min-w-0 flex-1 items-center justify-end gap-2 rounded-[5px] px-2 text-caption text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-ring strip:mr-0 strip:h-[26px] strip:flex-none strip:justify-center", quiet && "strip:hidden")}
    >
      <SyncStatus />
      <Tip>{label}</Tip>
    </button>
  );
  return <LazyMenu menu={ConnectionPanel} button={button} />;
});

/** `children`: what the sidebar adds to the foot. */
export function SidebarFoot({ children }: { children?: ReactNode }) {
  return (
    <div className="relative -mx-2 flex h-11 shrink-0 items-center gap-1 self-stretch border-t px-2 strip:mx-0 strip:h-auto strip:flex-col strip:gap-0.5 strip:px-0 strip:pt-1.5 strip:pb-2">
      <UpdateCard className="inset-x-2.5 bottom-[calc(100%+8px)] strip:hidden" />
      <UpdateButton />
      <AccountButton />
      <ThemeButton />
      <FootStatus />
      {children}
    </div>
  );
}
