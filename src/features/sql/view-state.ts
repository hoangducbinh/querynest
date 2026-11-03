import { useSyncExternalStore } from "react";
import type { editor } from "monaco-editor/editor/editor.api";
export type SqlTabView = {
  selection: string;
  resultIndex: number;
  ratio: number;
  resultsVisible: boolean;
  resultsMode: "tabs" | "all" | "messages";
  expandedResults: number[];
};
const defaults: SqlTabView = {
  selection: "",
  resultIndex: 0,
  ratio: 0.7,
  resultsVisible: true,
  resultsMode: "tabs",
  expandedResults: [0, 1],
};
const tabs = new Map<string, SqlTabView>();
const editors = new Map<string, editor.ICodeEditorViewState>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const sqlTabView = (key: string) => tabs.get(key) ?? defaults;
export function updateSqlTabView(key: string, patch: Partial<SqlTabView>) {
  const previous = sqlTabView(key);
  if (
    Object.entries(patch).every(
      ([name, value]) => previous[name as keyof SqlTabView] === value,
    )
  )
    return;
  tabs.set(key, { ...previous, ...patch });
  for (const listener of listeners) listener();
}
export function useSqlTabView(key: string) {
  return [
    useSyncExternalStore(subscribe, () => sqlTabView(key)),
    (patch: Partial<SqlTabView>) => updateSqlTabView(key, patch),
  ] as const;
}
export const sqlEditorView = (key: string) => editors.get(key);
export function rememberSqlEditorView(
  key: string,
  view: editor.ICodeEditorViewState | null,
) {
  if (view) editors.set(key, view);
}
export function releaseSqlTabView(key: string) {
  tabs.delete(key);
  editors.delete(key);
  for (const listener of listeners) listener();
}
