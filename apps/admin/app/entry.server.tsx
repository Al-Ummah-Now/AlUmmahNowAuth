import type { AppLoadContext, EntryContext, HandleErrorFunction } from "react-router";
import { ServerRouter, isRouteErrorResponse } from "react-router";
import { logger } from "./lib/logger.server";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

/** True for an outcome that is not a server fault: an unknown URL (bots probing /server-status, /telescope/...), a 4xx thrown by a loader, an aborted request. */
export function isExpectedRequestError(error: unknown, request: Request): boolean {
  if (request.signal.aborted) return true;
  if (isRouteErrorResponse(error)) return error.status < 500;
  if (error instanceof Response) return error.status < 500;
  return false;
}

/**
 * React Router's default logs every request error with console.error, including the 404 of an
 * unknown URL (production 2026-11-18: 50 error lines in 72 h from scanners, some printed as
 * "[object Object]"). Expected outcomes are not logged; real faults are logged once with the path
 * and the error's name and message.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (isExpectedRequestError(error, request)) return;
  const err = error instanceof Error ? error : null;
  logger.error("[admin] request failed", {
    path: new URL(request.url).pathname,
    name: err?.name ?? typeof error,
    message: err ? err.message : String(error),
    stack: err?.stack?.split("\n").slice(0, 6).join("\n"),
  });
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell.  Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered && !isExpectedRequestError(error, request)) {
          logger.error("[admin] render failed", { path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}