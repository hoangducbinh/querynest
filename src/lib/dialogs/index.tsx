import { useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../components/ui/button";
type ConfirmOptions = {
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
};
type Request = ConfirmOptions & {
  id: number;
  message: string;
  resolve: (confirmed: boolean) => void;
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
export const confirmAction = (
  message: string,
  options: ConfirmOptions = {},
) =>
  new Promise<boolean>((resolve) => {
    if (pending) {
      resolve(false);
      return;
    }
    pending = { ...options, id: Date.now(), message, resolve };
    emit();
  });
function finish(confirmed: boolean) {
  const previous = pending;
  pending = null;
  emit();
  previous?.resolve(confirmed);
}
export function DialogHost() {
  const active = useSyncExternalStore(subscribe, () => pending);
  return active ? <RequestDialog key={active.id} request={active} /> : null;
}
function RequestDialog({ request: r }: { request: Request }) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) finish(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal action-dialog">
          <Dialog.Title>{r.title ?? "Continue?"}</Dialog.Title>
          <Dialog.Description>{r.message}</Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              finish(true);
            }}
          >
            <div className="action-dialog-actions">
              <Button autoFocus onClick={() => finish(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                className={
                  r.destructive ? "action-dialog-destructive" : "primary"
                }
              >
                {r.confirmLabel ?? "Continue"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
