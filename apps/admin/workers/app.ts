import { createRequestHandler } from "react-router";
import { applyLogLevel } from "../../../packages/ui/src/log-level.ts";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  // @ts-expect-error - virtual module
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    applyLogLevel(env.LOG_LEVEL);
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;

interface Env {
  AUTH_STORAGE: KVNamespace;
  ASSETS: Fetcher;
  AUTH_SERVER_URL?: string;
  /** "warn" on QA/stage: console lines below it are dropped */
  LOG_LEVEL?: string;
}
