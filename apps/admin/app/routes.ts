import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("users", "routes/users._index.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  route("logs", "routes/logs.tsx"),
] satisfies RouteConfig;
