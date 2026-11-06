import { zoomEditor } from "./editor-zoom";

/** Capture modified wheel events before Monaco or the webview handles zoom. */
export function bindEditorWheelZoom(element: HTMLElement) {
  let accumulated = 0;
  let lastTime = 0;
  const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !event.deltaY) {
      accumulated = 0;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
    if (
      event.timeStamp - lastTime > 250 ||
      Math.sign(delta) !== Math.sign(accumulated)
    )
      accumulated = 0;
    lastTime = event.timeStamp;
    accumulated += delta;
    const steps = Math.trunc(accumulated / 40);
    if (steps) {
      // Limit large wheel impulses while preserving fine trackpad movement.
      zoomEditor(-Math.max(-3, Math.min(3, steps)));
      accumulated %= 40;
    }
  };
  element.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => element.removeEventListener("wheel", onWheel, { capture: true });
}
