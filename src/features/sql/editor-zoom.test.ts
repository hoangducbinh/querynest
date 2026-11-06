import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  setEditorFontSize,
  useEditorZoom,
  zoomEditor,
} from "./editor-zoom";

afterEach(() => {
  vi.unstubAllGlobals();
  useEditorZoom.setState({ fontSize: DEFAULT_EDITOR_FONT_SIZE });
});

it("bounds zoom, resets it and persists the displayed font size", () => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { setItem });
  zoomEditor(100);
  expect(useEditorZoom.getState().fontSize).toBe(MAX_EDITOR_FONT_SIZE);
  zoomEditor(-100);
  expect(useEditorZoom.getState().fontSize).toBe(MIN_EDITOR_FONT_SIZE);
  setEditorFontSize(DEFAULT_EDITOR_FONT_SIZE);
  expect(useEditorZoom.getState().fontSize).toBe(DEFAULT_EDITOR_FONT_SIZE);
  expect(setItem).toHaveBeenLastCalledWith("sql-editor-font-size", "14");
});

it("keeps zoom working when saving preferences fails", () => {
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("Unavailable");
    },
  });
  expect(() => zoomEditor(1)).not.toThrow();
  expect(useEditorZoom.getState().fontSize).toBe(15);
  setEditorFontSize(Number.NaN);
  expect(useEditorZoom.getState().fontSize).toBe(DEFAULT_EDITOR_FONT_SIZE);
});
