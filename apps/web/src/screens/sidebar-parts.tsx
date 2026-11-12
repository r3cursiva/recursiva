// What the sidebar's sections share (sidebar.tsx, sidebar-projects.tsx), and the project mark the rest of the app draws.
import type { Project } from "@rsva/schema/models";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, type ComponentProps, type PointerEvent, type ReactNode } from "react";
import type * as EditChunk from "./edit-chunk.ts";
import { loadEditChunk } from "./load-edit-chunk.ts";

/**
 * Project mark: the key's first letter on a tile, in the project's color or a tone fixed by the key. An observer of its
 * own: menus and lists that draw it do not read the key or the color, so a change from settings must reach it here.
 */
export const ProjectIcon = observer(function ProjectIcon({ project, className, children }: { project: Project; className?: string; children?: ReactNode }) {
  return (
    <LetterTile name={project.key} {...(project.color ? { tone: project.color } : {})} {...(className ? { className } : {})}>
      {children}
    </LetterTile>
  );
});

/** The ledger's navigation item: --nav-item (28px, 32px comfortable), hover tint, the current one on nav-current; collapsed, 36×34 around the icon. */
export const navItem =
  "group/tip relative flex h-(--nav-item) items-center gap-[9px] rounded-[5px] px-2 text-ink outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-nav-current aria-[current=page]:font-medium aria-pressed:bg-nav-current aria-pressed:font-medium max-md:h-12 max-md:gap-3 max-md:text-[15px] strip:h-[34px] strip:w-9 strip:shrink-0 strip:justify-center strip:rounded-[7px] strip:px-0";

/** An item's name and count give way to the icon in the collapsed sidebar. */
export const itemLabel = "min-w-0 flex-1 truncate strip:hidden";

/** A section's heading: Favorites, Projects. */
export const heading =
  "mt-3 mb-1 self-start rounded-[4px] px-2 py-0.5 eyebrow outline-none transition-colors duration-120 hover:bg-row-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-row-hover aria-[current=page]:text-ink strip:hidden";

/** A row's ⋯ or × at its right end, shown on hover or focus of its row. */
export const rowButton = "absolute top-[3px] right-[3px] size-[22px] rounded-[4px] border-0 hover:bg-panel active:scale-100! strip:hidden";

export function Divider() {
  return <span aria-hidden className="my-[7px] hidden h-px w-6 shrink-0 bg-rule first:mt-[3px] strip:block" />;
}

type Attach = (c: typeof EditChunk, root: HTMLElement, scroller: HTMLElement) => () => void;

/**
 * Where rows drag into a new place: the `[data-cell]` lists inside it, each of `[data-card]` rows. The dragging itself
 * is in the lazy chunk, 1.6 KB off the start: a mouse hovers the area before it presses, and the chunk is here by then.
 */
export function DragArea({ attach, ...props }: { attach: Attach } & ComponentProps<"div">) {
  const drag = useRef<Promise<() => void> | null>(null);
  const arm = ({ currentTarget: root }: PointerEvent<HTMLDivElement>) => {
    drag.current ??= loadEditChunk().then((c) => attach(c, root, root.closest("nav") ?? root.closest<HTMLElement>("[data-scroller]")!));
  };
  useEffect(() => () => void drag.current?.then((stop) => stop()), []);
  return <div onPointerEnter={arm} {...props} />;
}

/** A drop cell's layout: rows one under another, centered in the collapsed sidebar. */
export const dropCell = "relative flex flex-col gap-px strip:items-center strip:gap-0.5 strip:self-stretch";

/** One list whose rows drag into a new place: an area that is its own cell. */
export function DragList({ group, attach, children }: { group: string; attach: Attach; children: ReactNode }) {
  return (
    <DragArea attach={attach} data-cell data-group={group} className={dropCell}>
      {children}
    </DragArea>
  );
}

const dragPreview = "rounded-[5px] bg-sidebar opacity-75";
export const attachProjects: Attach = (c, root, scroller) => c.attachProjectDrag(root, scroller, dragPreview);
export const attachPins: Attach = (c, root, scroller) => c.attachPinDrag(root, scroller, dragPreview);
