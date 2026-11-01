import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
export function useDesktopClose(
  canClose: () => Promise<boolean>,
  onError: (error: unknown) => void,
) {
  const callbacks = useRef({ canClose, onError });
  callbacks.current = { canClose, onError };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let checking = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const stop = await getCurrentWindow().onCloseRequested(
          async (event) => {
            if (checking) {
              event.preventDefault();
              return;
            }
            checking = true;
            try {
              if (!(await callbacks.current.canClose())) event.preventDefault();
            } catch (error) {
              event.preventDefault();
              callbacks.current.onError(error);
            } finally {
              checking = false;
            }
          },
        );
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        if (!disposed) callbacks.current.onError(error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
