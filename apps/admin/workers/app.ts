import { createRequestHandler } from "react-router";
import { applyLogLevel } from "../../../packages/ui/src/log-level.ts";
import { noIndexWorker } from '../../../packages/ui/src/crawlers.ts';
import { streetResponse } from "../../../packages/ui/src/fanous-street/index.ts";

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

const worker = {
  async fetch(request, env, ctx) {
    applyLogLevel(env.LOG_LEVEL);
    // The Fanous lantern street's files (shared module), served from this origin
    if (request.method === "GET") {
      const street = streetResponse(new URL(request.url).pathname);
      if (street) return street;
    }
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;

/** Nothing on this host is for search engines: robots.txt Disallow: / and X-Robots-Tag: noindex (packages/ui/src/crawlers.ts) */
export default noIndexWorker(worker);

interface Env {
  AUTH_STORAGE: KVNamespace;
  ASSETS: Fetcher;
  AUTH_SERVER_URL?: string;
  /** "warn" on QA/stage: console lines below it are dropped */
  LOG_LEVEL?: string;
}
