import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./root";

/** React Router's ErrorResponseImpl (isRouteErrorResponse checks these fields). */
const response = (status: number, statusText: string) => ({ status, statusText, internal: true, data: "No route matches URL \"/wp-login.php\"" });

describe("the root error boundary", () => {
  it("shows the status of an unknown URL and logs nothing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const html = renderToString(<ErrorBoundary error={response(404, "Not Found")} />);
    expect(html).toContain("404 Not Found");
    expect(html).not.toContain("wp-login");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never shows a fault's own text", () => {
    const html = renderToString(<ErrorBoundary error={new Error("secret in D1")} />);
    expect(html).toContain("Application Error");
    expect(html).not.toContain("secret");
  });
});
