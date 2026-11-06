import { afterEach, expect, it, vi } from "vitest";
import { bindEditorWheelZoom } from "./editor-wheel-zoom";
import { useEditorZoom } from "./editor-zoom";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  useEditorZoom.setState({ fontSize: 14 });
  vi.unstubAllGlobals();
});
function setup() {
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  const target = new EventTarget();
  cleanups.push(bindEditorWheelZoom(target as HTMLElement));
  return (deltaY: number, modifiers = {}, deltaMode = 0) => {
    const event = Object.assign(new Event("wheel", { cancelable: true }), {
      deltaY,
      deltaMode,
      ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  };
}
it("zooms with Ctrl or Command and consumes only modified vertical scrolling", () => {
  const wheel = setup();
  expect(wheel(100).defaultPrevented).toBe(false);
  expect(useEditorZoom.getState().fontSize).toBe(14);
  expect(wheel(-40, { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(useEditorZoom.getState().fontSize).toBe(15);
  wheel(40, { metaKey: true });
  expect(useEditorZoom.getState().fontSize).toBe(14);
  expect(wheel(0, { ctrlKey: true }).defaultPrevented).toBe(false);
});
it("accumulates small trackpad deltas and normalizes line scrolling", () => {
  const wheel = setup();
  wheel(-20, { metaKey: true });
  expect(useEditorZoom.getState().fontSize).toBe(14);
  wheel(-20, { metaKey: true });
  expect(useEditorZoom.getState().fontSize).toBe(15);
  wheel(3, { ctrlKey: true }, 1);
  expect(useEditorZoom.getState().fontSize).toBe(14);
});
it("removes the wheel handler when the editor is disposed", () => {
  const wheel = setup();
  cleanups.pop()?.();
  expect(wheel(-40, { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(useEditorZoom.getState().fontSize).toBe(14);
});
