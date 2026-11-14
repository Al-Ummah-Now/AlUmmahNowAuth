// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Table, TableBody, TableCell, TableRow } from "./ui/table";

// A table wider than a phone scrolls in its box; keyboard users must be able to scroll it
// (axe scrollable-region-focusable flagged the Audit Logs table at 390px on QA)
const widths = (scroll: number, client: number) => {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => scroll });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => client });
};
const view = () =>
  render(
    <Table aria-label="Audit events">
      <TableBody>
        <TableRow>
          <TableCell>row</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );

afterEach(() => {
  cleanup();
  widths(0, 0);
});

describe("Table scroll box", () => {
  it("takes keyboard focus and is a named region while it scrolls", () => {
    widths(900, 340);
    view();
    const box = screen.getByRole("region", { name: "Audit events" });
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.querySelector("table")).not.toBeNull();
  });

  it("adds no tab stop when the table fits", () => {
    widths(800, 800);
    const { container } = view();
    const box = container.querySelector("table")!.parentElement!;
    expect(box.hasAttribute("tabindex")).toBe(false);
    expect(box.hasAttribute("role")).toBe(false);
  });
});
