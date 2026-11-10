// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(cleanup);

function setup(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ConfirmDialog
      open
      title="Rotate the client secret?"
      description="The current secret stops working at once."
      confirmLabel="Rotate secret"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel, view, dialog: view.container.querySelector("dialog") as HTMLDialogElement };
}

describe("ConfirmDialog", () => {
  it("renders nothing while closed, so no hidden buttons stay on the page", () => {
    const { view } = setup({ open: false });
    expect(view.container.innerHTML).toBe("");
  });

  it("is a modal dialog labelled by its title and described by its text", () => {
    const { dialog } = setup();
    expect(dialog.open).toBe(true);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Rotate the client secret?");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("The current secret stops working at once.");
  });

  it("starts on Cancel, the safe choice", () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("confirms only from the confirming button", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel and Esc cancel without acting", () => {
    const { onConfirm, onCancel, dialog } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("type-to-confirm: the action stays disabled until the exact text is typed", () => {
    const { onConfirm } = setup({ typeToConfirm: { expected: "user@example.com", label: "Type the email" } });
    const action = screen.getByRole("button", { name: "Rotate secret" }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type the email"), { target: { value: "user@example" } });
    expect(action.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type the email"), { target: { value: "user@example.com" } });
    expect(action.disabled).toBe(false);
    fireEvent.click(action);
    expect(onConfirm).toHaveBeenCalledWith({ reason: "", typed: "user@example.com" });
  });
});
