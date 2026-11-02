import { useSyncExternalStore } from "react";
import type { SqlResult } from "./execution";

type Results = Record<string, SqlResult[]>;
type Update = Results | ((previous: Results) => Results);
const states = new Map<
  string,
  { results: Results; contexts: Record<string, string> }
>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function state(key: string) {
  let value = states.get(key);
  if (!value) {
    value = { results: {}, contexts: {} };
    states.set(key, value);
  }
  return value;
}
export function readSqlResults(key: string) {
  return state(key).results;
}
export function updateSqlResults(key: string, update: Update) {
  const value = state(key);
  value.results = typeof update === "function" ? update(value.results) : update;
  for (const listener of listeners) listener();
}
// Runtime-only: tool views can unmount without losing rows. Never saved to disk.
export function useSqlResults(key: string) {
  const results = useSyncExternalStore(subscribe, () => readSqlResults(key));
  return [
    results,
    (update: Update) => updateSqlResults(key, update),
    state(key).contexts,
  ] as const;
}
export function clearWorkspaceResults(workspaceId: string) {
  for (const key of states.keys()) {
    if (key === workspaceId || key.startsWith(workspaceId + ":source:"))
      states.delete(key);
  }
  for (const listener of listeners) listener();
}
