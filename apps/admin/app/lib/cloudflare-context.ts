import { createContext, RouterContextProvider } from "react-router";

/**
 * The Worker's bindings and execution context, handed to every loader and action.
 *
 * React Router 8 passes loaders a `RouterContextProvider` instead of a plain load-context
 * object, so the Worker (workers/app.ts) stores these under `cloudflareContext` and routes
 * read them with `getCloudflare(context)`. Each route casts `env` to the bindings it uses.
 */
export interface CloudflareLoadContext {
  env: unknown;
  ctx: ExecutionContext | undefined;
}

export const cloudflareContext = createContext<CloudflareLoadContext>();

/** The request's router context, holding the Worker's env and ctx. */
export function cloudflareLoadContext(env: unknown, ctx: ExecutionContext | undefined): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx });
  return context;
}

/** The Worker's env and ctx for this request. */
export function getCloudflare(context: Readonly<RouterContextProvider>): CloudflareLoadContext {
  return context.get(cloudflareContext);
}
