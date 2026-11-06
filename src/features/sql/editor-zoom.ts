import { create } from "zustand";

export const DEFAULT_EDITOR_FONT_SIZE = 14;
export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 32;
const STORAGE_KEY = "sql-editor-font-size";

export function normalizeEditorFontSize(value: number) {
  return Number.isFinite(value)
    ? Math.max(
        MIN_EDITOR_FONT_SIZE,
        Math.min(MAX_EDITOR_FONT_SIZE, Math.round(value)),
      )
    : DEFAULT_EDITOR_FONT_SIZE;
}
function readFontSize() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null
      ? DEFAULT_EDITOR_FONT_SIZE
      : normalizeEditorFontSize(Number(stored));
  } catch {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
}
export const useEditorZoom = create<{ fontSize: number }>(() => ({
  fontSize: readFontSize(),
}));
export function setEditorFontSize(value: number) {
  const fontSize = normalizeEditorFontSize(value);
  useEditorZoom.setState({ fontSize });
  try {
    localStorage.setItem(STORAGE_KEY, String(fontSize));
  } catch {
    /* Keep zoom usable when storage is unavailable. */
  }
}
export function zoomEditor(delta: number) {
  setEditorFontSize(useEditorZoom.getState().fontSize + delta);
}
