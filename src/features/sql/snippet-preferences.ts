import { useEffect } from "react";
import { create } from "zustand";
import { liveQuery } from "dexie";
import { storage } from "../../lib/storage/workspaces";
import type { SqlAbbreviationSettings } from "../../types/schema";
import { DEFAULT_SNIPPETS, validateSnippets } from "./snippets";
export const ABBREVIATIONS_KEY = "sql-abbreviations";
const defaults: SqlAbbreviationSettings = {
  enabled: true,
  snippets: DEFAULT_SNIPPETS,
};
export const useSnippetPreferences = create<{
  settings: SqlAbbreviationSettings;
  loading: boolean;
  error: string;
}>(() => ({ settings: defaults, loading: true, error: "" }));
export function useLoadSnippetPreferences() {
  useEffect(() => {
    const subscription = liveQuery(() =>
      storage.settings.get(ABBREVIATIONS_KEY),
    ).subscribe({
      next(value) {
        if (
          value &&
          (typeof value.enabled !== "boolean" ||
            validateSnippets(value.snippets).length)
        ) {
          useSnippetPreferences.setState({
            settings: defaults,
            loading: false,
            error: "Invalid global abbreviation settings.",
          });
          return;
        }
        useSnippetPreferences.setState({
          settings: value
            ? { enabled: value.enabled, snippets: value.snippets }
            : defaults,
          loading: false,
          error: "",
        });
      },
      error(error) {
        useSnippetPreferences.setState({
          loading: false,
          error: String(error),
        });
      },
    });
    return () => subscription.unsubscribe();
  }, []);
}
export async function saveGlobalAbbreviations(
  value: SqlAbbreviationSettings,
  replaceOverrides = false,
) {
  const errors = validateSnippets(value.snippets);
  if (errors.length || typeof value.enabled !== "boolean")
    throw Error(errors[0] ?? "Invalid abbreviation settings.");
  await storage.transaction(
    "rw",
    storage.settings,
    storage.workspaces,
    async () => {
      await storage.settings.put({
        id: ABBREVIATIONS_KEY,
        ...structuredClone(value),
      });
      if (replaceOverrides)
        await storage.workspaces.toCollection().modify((workspace) => {
          delete workspace.sqlSnippets;
          delete workspace.sqlAbbreviationsEnabled;
        });
    },
  );
  useSnippetPreferences.setState({
    settings: structuredClone(value),
    loading: false,
    error: "",
  });
}
