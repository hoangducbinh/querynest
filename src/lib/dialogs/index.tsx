import { useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../components/ui/button";
type ConfirmOptions = {
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
};
type Request = ConfirmOptions & {
  id: number;
  kind: "confirm" | "prompt";
  message: string;
  initial: string;
  resolve: (value: string | null) => void;
};
let pending: Request | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const emit = () => listeners.forEach((fn) => fn());
function request(
  kind: Request["kind"],
  message: string,
  initial = "",
  options: ConfirmOptions = {},
) {
  return new Promise<string | null>((resolve) => {
    if (pending) {
      resolve(null);
      return;
    }
    pending = { ...options, id: Date.now(), kind, message, initial, resolve };
    emit();
  });
}
export const confirmAction = async (
  message: string,
  options: ConfirmOptions = {},
) => (await request("confirm", message, "", options)) !== null;
export const promptValue = (message: string, initial = "") =>
  request("prompt", message, initial);
function finish(value: string | null) {
  const previous = pending;
  pending = null;
  emit();
  previous?.resolve(value);
}
export function DialogHost() {
  const active = useSyncExternalStore(subscribe, () => pending);
  return active ? <RequestDialog key={active.id} request={active} /> : null;
}
function RequestDialog({ request: r }: { request: Request }) {
  const [value, setValue] = useState(r.initial);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal action-dialog" data-kind={r.kind}>
          <Dialog.Title>
            {r.title ?? (r.kind === "confirm" ? "Continue?" : "Edit value")}
          </Dialog.Title>
          <Dialog.Description>{r.message}</Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              finish(r.kind === "confirm" ? "yes" : value);
            }}
          >
            {r.kind === "prompt" && (
              <textarea
                aria-label="JSON value"
                autoFocus
                rows={5}
                className="action-dialog-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <div className="action-dialog-actions">
              <Button
                autoFocus={r.kind === "confirm"}
                onClick={() => finish(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className={
                  r.destructive ? "action-dialog-destructive" : "primary"
                }
              >
                {r.confirmLabel ?? (r.kind === "confirm" ? "Continue" : "Save")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
