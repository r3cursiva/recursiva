import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "../lib/utils.ts"
import { inputStyles } from "@rsva/ui/components/native-input"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputStyles, className)}
      {...props}
    />
  )
}

export { Input }
