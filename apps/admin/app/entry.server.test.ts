import { describe, expect, it, vi } from "vitest";
import { data } from "react-router";
import { handleError, isExpectedRequestError } from "./entry.server";
import { logger } from "./lib/logger.server";

const req = (path: string, aborted = false) => {
  const c = new AbortController();
  if (aborted) c.abort();
  return new Request(`https://admin.auth.alummahnow.net${path}`, { signal: c.signal });
};

describe("admin request errors (prod 2026-11-18: scanner 404s logged as errors)", () => {
  it("an unknown URL, a 4xx and an aborted request are expected, not logged", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const notFound = { status: 404, statusText: "Not Found", internal: true, data: "No route matches URL \"/server-status\"" };
    // react-router's ErrorResponseImpl shape (isRouteErrorResponse checks these fields)
    expect(isExpectedRequestError(Object.assign(notFound, { error: new Error("x") }), req("/server-status"))).toBe(true);
    expect(isExpectedRequestError(new Response(null, { status: 403 }), req("/telescope/requests"))).toBe(true);
    expect(isExpectedRequestError(new Error("boom"), req("/users", true))).toBe(true);
    handleError(new Response(null, { status: 404 }), { request: req("/telescope/requests"), params: {}, context: {} as never });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a real fault is logged once with the path, name and message (never [object Object])", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    handleError(new TypeError("cannot read x"), { request: req("/users"), params: {}, context: {} as never });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatchObject({ path: "/users", name: "TypeError", message: "cannot read x" });
    handleError(data("x", { status: 500 }) as never, { request: req("/users"), params: {}, context: {} as never });
    spy.mockRestore();
  });
});
