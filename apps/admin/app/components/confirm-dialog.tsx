import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

/**
 * In-app confirmation for destructive actions (never a browser prompt): a
 * native <dialog> opened with showModal(), so focus is trapped and Escape
 * cancels. Focus starts on Cancel. Optional reason field and type-to-confirm
 * (the confirm button stays disabled until the text matches exactly).
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: (input: { reason: string; typed: string }) => void;
  onCancel: () => void;
  /** Danger styling for the confirm button (default true). */
  danger?: boolean;
  /** Shows a reason textarea with this label. */
  reason?: { label: string; placeholder?: string };
  /** The user must type `expected` before confirming. */
  typeToConfirm?: { expected: string; label: string };
  busy?: boolean;
  error?: string | null;
  dir?: "ltr" | "rtl";
  lang?: string;
}

/** Mounted only while open, so its buttons are never on the page otherwise. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return props.open ? <OpenConfirmDialog {...props} /> : null;
}

function OpenConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = true,
  reason,
  typeToConfirm,
  busy = false,
  error,
  dir = "ltr",
  lang = "en",
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reasonText, setReasonText] = useState("");
  const [typed, setTyped] = useState("");
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const matches = !typeToConfirm || typed.trim() === typeToConfirm.expected.trim();

  return (
    <dialog
      ref={ref}
      dir={dir}
      lang={lang}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="w-[min(32rem,calc(100vw-2rem))] rounded-lg ui-raised p-0 backdrop:bg-black/50"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy) onConfirm({ reason: reasonText.trim(), typed: typed.trim() });
        }}
      >
        <h2 id={`${id}-title`} className={cn("text-lg font-semibold", danger && "text-[var(--color-destructive-text)]")}>
          {title}
        </h2>
        <p id={`${id}-desc`} className="text-sm text-[var(--color-muted-foreground)]">
          {description}
        </p>
        {reason && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-reason`} className="text-sm font-medium">
              {reason.label}
            </label>
            <textarea
              id={`${id}-reason`}
              value={reasonText}
              maxLength={500}
              rows={2}
              placeholder={reason.placeholder}
              onChange={(e) => setReasonText(e.target.value)}
              className="rounded-md border border-[var(--color-input)] bg-transparent px-3 py-2 text-sm"
            />
          </div>
        )}
        {typeToConfirm && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-type`} className="text-sm font-medium">
              {typeToConfirm.label}
            </label>
            <input
              id={`${id}-type`}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              dir="auto"
              onChange={(e) => setTyped(e.target.value)}
              className="h-9 rounded-md border border-[var(--color-input)] bg-transparent px-3 text-sm"
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-[var(--color-destructive-text)]">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="submit" variant={danger ? "destructive" : "default"} disabled={!matches || busy} aria-busy={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
