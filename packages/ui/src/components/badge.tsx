import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/utils.ts"

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap",
  {
    variants: {
      variant: {
        /** A small boxed word: "agent", "Default", a linked tag. */
        tag: "rounded-[4px] border border-rule-strong px-1 text-[10.5px] leading-4 font-normal text-ink-3",
        /** The GitHub page's round-ended label. */
        pill: "h-[18px] rounded-[9px] border border-rule-soft bg-sidebar px-[7px] font-mono text-[10px] tracking-[0.03em] text-ink-3",
        /** An unread count on an icon, placed by the caller. */
        count: "h-4 min-w-4 rounded-full border-2 border-panel bg-signal px-[3px] font-mono text-[9.5px] leading-none font-medium text-signal-ink",
      },
    },
    defaultVariants: {
      variant: "tag",
    },
  }
)

function Badge({
  className,
  variant = "tag",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge }
