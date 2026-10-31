import { useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../components/ui/button";
type Request = {
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
function request(kind: Request["kind"], message: string, initial = "") {
  return new Promise<string | null>((resolve) => {
    if (pending) {
      resolve(null);
      return;
    }
    pending = { id: Date.now(), kind, message, initial, resolve };
    emit();
  });
}
export const confirmAction = async (message: string) =>
  (await request("confirm", message)) !== null;
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
        <Dialog.Content className="modal">
          <Dialog.Title>
            {r.kind === "confirm" ? "Confirm action" : "Edit data"}
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
                style={{ width: "100%", marginBottom: 16 }}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <div className="row">
              <Button onClick={() => finish(null)}>Cancel</Button>
              <Button type="submit" className="primary">
                {r.kind === "confirm" ? "Confirm" : "Save value"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
