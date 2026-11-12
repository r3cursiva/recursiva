import { cn } from "../lib/utils.ts"
import { CircleNotchIcon, type IconProps } from "@phosphor-icons/react"

function Spinner({ className, ...props }: IconProps) {
  return (
    <CircleNotchIcon data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
