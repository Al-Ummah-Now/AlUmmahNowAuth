import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import { roleLabel } from "../../../../packages/ui/src/role-names.ts";

interface UserRoleBadgeProps {
  role: string;
  /** Page language: Arabic shows the role's Arabic name. */
  lang?: string;
  className?: string;
}

/**
 * Display a role name with appropriate styling based on role type
 * Maps role names to badge variants for visual hierarchy
 */
export function UserRoleBadge({ role, lang = "en", className }: UserRoleBadgeProps) {
  const roleLower = role.toLowerCase();

  // Map roles to badge variants
  let variant: "admin" | "moderator" | "user" = "user";

  if (roleLower === "super_admin" || roleLower === "admin") {
    variant = "admin";
  } else if (roleLower === "moderator") {
    variant = "moderator";
  }

  return (
    <Badge
      variant={variant}
      className={cn(lang === "ar" ? undefined : "uppercase", className)}
    >
      {roleLabel(role, lang)}
    </Badge>
  );
}
