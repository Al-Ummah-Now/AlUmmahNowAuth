import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("users", "routes/users._index.tsx"),
  route("roles", "routes/roles._index.tsx"),
  route("roles/:id", "routes/roles.$id.tsx"),
  route("clients", "routes/clients.tsx"),
  route("sessions", "routes/sessions.tsx"),
  route("audit", "routes/audit.tsx"),
  route("moderation", "routes/moderation._index.tsx"),
  route("moderation/:id", "routes/moderation.$id.tsx"),
  route("themes", "routes/themes._index.tsx"),
  route("themes/:id", "routes/themes.$id.tsx"),
  route("themes/:id/preview", "routes/themes.$id.preview.ts"),
  route("themes/:id/export", "routes/themes.$id.export.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  route("forbidden", "routes/forbidden.tsx"),
  route("debug-m2m", "routes/debug-m2m.tsx"),
] satisfies RouteConfig;
