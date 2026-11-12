// The phone's main navigation (the Quire phone artboards): Inbox, My work, Projects, Search and More at the bottom, in
// reach of the thumb. It takes the sidebar's place below md; on a wider screen it is not displayed.
// A new version waiting for a reload shows over it (update-card.tsx), as above the sidebar's foot.
import { DotsThreeIcon, ListChecksIcon, MagnifyingGlassIcon, StackIcon, TrayIcon } from "@phosphor-icons/react";
import { Badge } from "@rsva/ui/components/badge";
import { observer } from "mobx-react-lite";
import { type ComponentProps, type ReactNode } from "react";
import { paths, router } from "../router.ts";
import { inboxUnread } from "../store.ts";
import { LazyMenu } from "./lazy-menu.tsx";
import { chunk, chunkWhen, loadEditChunk } from "./load-edit-chunk.ts";
import { palette } from "./palette-state.ts";
import { updateCard } from "../lib/new-version.ts";
import { Link } from "../link.tsx";
import { capCount } from "@rsva/schema/util";

const MoreMenu = chunk("MoreMenu");
// A new version waiting for a reload (update-card.tsx, in the edit chunk).
const UpdateCard = chunkWhen("UpdateCard", updateCard);

const tab =
  "relative flex h-(--tabbar) min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] leading-none text-ink-3 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:font-semibold aria-[current=page]:text-ink active:[&_svg]:scale-[.88] [&_svg]:size-[22px] [&_svg]:transition-transform [&_svg]:duration-150 [&_svg]:ease-bounce";

function TabLink({ href, current, label, children }: { href: string; current: boolean; label: string; children: ReactNode }) {
  return (
    <Link href={href} aria-current={current ? "page" : undefined} aria-label={label} className={tab}>
      {children}
    </Link>
  );
}

/** The route's place in the tabs: every project page is under Projects. */
function tabOf(route: typeof router.route): "inbox" | "myWork" | "projects" | null {
  if (route.name === "inbox") return "inbox";
  if (route.name === "myWork") return "myWork";
  return "projectKey" in route || route.name === "projects" || route.name === "views" || route.name === "view" ? "projects" : null;
}

export const TabBar = observer(function TabBar({ ws }: { ws: string }) {
  const route = router.route;
  const at = tabOf(route);
  const unread = inboxUnread();
  const moreButton = (props: ComponentProps<"button">) => (
    <button type="button" aria-label="More" onPointerDown={() => void loadEditChunk()} className={tab} {...props}>
      <DotsThreeIcon weight="bold" />
      More
    </button>
  );
  return (
    // An open issue has its own bar for the comment (issue-detail.tsx), and a keyboard leaves no room for tabs.
    <nav
      aria-label="Main"
      data-tabbar
      className="relative z-30 flex shrink-0 border-t bg-panel px-1.5 pb-(--safe-bottom) md:hidden in-[[data-keyboard]]:hidden"
      hidden={route.name === "listIssue" || route.name === "browse"}
    >
      <UpdateCard className="inset-x-2.5 bottom-[calc(100%+10px)]" />
      <TabLink href={paths.inbox(ws)} current={at === "inbox"} label={unread ? `Inbox, ${unread} unread` : "Inbox"}>
        <span className="relative grid">
          <TrayIcon />
          {unread > 0 && (
            <Badge variant="count" className="absolute -top-1 -right-2.5">
              {capCount(unread)}
            </Badge>
          )}
        </span>
        Inbox
      </TabLink>
      <TabLink href={paths.myWork(ws)} current={at === "myWork"} label="My work">
        <ListChecksIcon />
        My work
      </TabLink>
      <TabLink href={paths.projects(ws)} current={at === "projects"} label="Projects">
        <StackIcon />
        Projects
      </TabLink>
      <button type="button" aria-label="Search" className={tab} onClick={() => palette.show()}>
        <MagnifyingGlassIcon />
        Search
      </button>
      <LazyMenu menu={MoreMenu} button={moreButton} />
    </nav>
  );
});
