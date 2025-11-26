import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[rgb(var(--color-ring))] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[rgb(var(--color-primary))] text-[rgb(var(--color-primary-foreground))] shadow hover:bg-[rgb(var(--color-primary))]/80",
        secondary:
          "border-transparent bg-[rgb(var(--color-secondary))] text-[rgb(var(--color-secondary-foreground))] hover:bg-[rgb(var(--color-secondary))]/80",
        destructive:
          "border-transparent bg-[rgb(var(--color-destructive))] text-[rgb(var(--color-destructive-foreground))] shadow hover:bg-[rgb(var(--color-destructive))]/80",
        outline:
          "text-[rgb(var(--color-foreground))] border-[rgb(var(--color-border))]",
        admin:
          "border-transparent bg-[rgb(var(--color-primary))] text-[rgb(var(--color-primary-foreground))] shadow",
        moderator:
          "border-transparent bg-amber-500 text-white shadow",
        user:
          "border-transparent bg-[rgb(var(--color-secondary))] text-[rgb(var(--color-secondary-foreground))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
