import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) return;
        const window = getCurrentWindow();
        const refresh = () => {
          void window
            .isMaximized()
            .then((value) => {
              if (!disposed) setMaximized(value);
            })
            .catch(() => {});
        };
        refresh();
        const unlisten = await window.onResized(refresh);
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((error) => console.warn("Unable to track window state", error));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  async function act(action: "minimize" | "maximize" | "close") {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      else if (action === "maximize") await window.toggleMaximize();
      // close() dispatches CloseRequested, preserving save/unsaved-change guards.
      else await window.close();
    } catch (error) {
      console.warn("Unable to update window", error);
    }
  }
  return (
    <div
      className="window-controls"
      role="group"
      aria-label="Window controls"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        title="Minimize"
        aria-label="Minimize window"
        onClick={() => void act("minimize")}
      >
        <Minus size={13} />
      </button>
      <button
        type="button"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore window" : "Maximize window"}
        onClick={() => void act("maximize")}
      >
        {maximized ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button
        type="button"
        className="window-close"
        title="Close"
        aria-label="Close window"
        onClick={() => void act("close")}
      >
        <X size={15} />
      </button>
    </div>
  );
}
