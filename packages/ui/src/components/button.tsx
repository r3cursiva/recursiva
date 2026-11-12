import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/utils.ts"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-[background-color,color,opacity,transform] duration-120 outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring active:not-aria-[haspopup]:scale-[.97] max-md:active:scale-[.94] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/88",
        outline:
          "border-control-border bg-panel hover:bg-row-hover hover:text-ink aria-expanded:bg-row-hover aria-expanded:text-ink",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "text-ink-2 hover:bg-row-hover hover:text-ink aria-expanded:bg-row-hover aria-expanded:text-ink",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary hover:opacity-75",
      },
      size: {
        default:
          "h-7 gap-2 px-2.5 text-[12.5px]/[1.4] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 max-md:h-10 max-md:rounded-lg max-md:px-3.5 max-md:text-[14px] [&_svg:not([class*='size-'])]:size-3.5 max-md:[&_svg:not([class*='size-'])]:size-[17px]",
        xs: "h-5 gap-1 rounded-sm px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 max-md:h-8 max-md:px-2.5 max-md:text-[12.5px] [&_svg:not([class*='size-'])]:size-2.5 max-md:[&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-6 gap-1.5 rounded-[5px] px-2 text-xs/[1.4] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 max-md:h-9 max-md:rounded-lg max-md:px-3 max-md:text-[13.5px] [&_svg:not([class*='size-'])]:size-3 max-md:[&_svg:not([class*='size-'])]:size-4",
        lg: "h-8 gap-1 px-2.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 max-md:h-11 max-md:rounded-lg max-md:px-4 max-md:text-[15px] [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 max-md:size-11 max-md:rounded-[10px] [&_svg:not([class*='size-'])]:size-3.5 max-md:[&_svg:not([class*='size-'])]:size-5",
        "icon-xs": "size-5 rounded-sm max-md:size-9 max-md:rounded-lg [&_svg:not([class*='size-'])]:size-2.5 max-md:[&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-6 max-md:size-10 max-md:rounded-[10px] [&_svg:not([class*='size-'])]:size-3 max-md:[&_svg:not([class*='size-'])]:size-[18px]",
        "icon-lg": "size-8 max-md:size-11 max-md:rounded-[10px] [&_svg:not([class*='size-'])]:size-4 max-md:[&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
