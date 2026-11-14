import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SqlTab, WorkspaceDefinition } from "../../types/schema";
import { useStore } from "../schema/store";
import { activeSqlTab, setSqlTabs, sqlTabs } from "./tabs";

type QueryFile = Pick<SqlTab, "id" | "name" | "sql" | "filePath" | "fileFolder">;

export function useSqlAutosave(
  workspace: WorkspaceDefinition,
  ready: boolean,
  onError: (error: unknown) => void,
) {
  const desktop = isTauri();
  const [folder, setFolder] = useState<string | null>();
  const [choosing, setChoosing] = useState(false);
  const prompted = useRef(false);
  const pending = useRef(new Map<string, Map<string, QueryFile>>());
  const saved = useRef(new Map<string, Map<string, QueryFile>>());
  const conflicts = useRef(new Set<string>());
  const initialTabs = useRef(new Map<string, Map<string, QueryFile>>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const errorHandler = useRef(onError);
  errorHandler.current = onError;

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void invoke<string | null>("sql_folder").then(
      (path) => {
        if (active) setFolder(path);
      },
      (error) => {
        if (active) errorHandler.current(error);
      },
    );
    return () => {
      active = false;
    };
  }, [desktop]);

  const rememberFile = useCallback((workspaceId: string, file: QueryFile) => {
    let written = saved.current.get(workspaceId);
    if (!written) {
      written = new Map();
      saved.current.set(workspaceId, written);
    }
    written.set(file.id, file);
  }, []);

  const flush = useCallback((readOnly = false) => {
    if (!folder) return Promise.resolve();
    const operation = queue.current.catch(() => {}).then(async () => {
      const current = useStore.getState().workspace;
      if (!pending.current.has(current.id)) pending.current.set(current.id, new Map());
      for (const [workspaceId, tabs] of pending.current) {
        const open = workspaceId === current.id ? sqlTabs(current) : [];

        let written = saved.current.get(workspaceId);
        if (!written) {
          written = new Map();
          saved.current.set(workspaceId, written);
        }
        const baseline = written;
        const candidates = readOnly
          ? open.filter((tab) => !tabs.has(tab.id))
          : [...new Map([...tabs, ...open.map((tab) => [tab.id, tab] as const)]).values()];
        const queries = candidates.filter((tab) => !tab.filePath || tab.fileFolder === folder);
        if (!queries.length) continue;
        const incoming = await invoke<(string | null)[]>("autosave_sql_files", {
          workspaceId,
          readOnly,
          queries: queries.map(({ id, name, sql, filePath }) => ({
            id, name, sql, file_path: filePath, previous_sql: baseline.get(id)?.sql,
          })),
        });
        for (const [index, query] of queries.entries()) {
          const disk = incoming[index];
          const state = useStore.getState();
          const latest = state.workspace.id === workspaceId
            ? sqlTabs(state.workspace).find((tab) => tab.id === query.id)
            : undefined;
          const previous = baseline.get(query.id) ?? initialTabs.current.get(workspaceId)?.get(query.id);
          const conflictKey = JSON.stringify([workspaceId, query.id]);
          if (disk !== null) {
            if (!latest || latest.sql !== query.sql || (previous && previous.sql !== query.sql)) {
              if (!conflicts.current.has(conflictKey)) {
                conflicts.current.add(conflictKey);
                errorHandler.current(`${query.name} also changed on disk. Both versions are preserved. Compare the tab and file before saving.`);
              }
              continue;
            }
            baseline.set(query.id, { ...query, sql: disk });
            state.edit((draft) => {
              const active = activeSqlTab(draft).id;
              const updated = sqlTabs(draft).map((tab) =>
                tab.id === query.id ? { ...tab, sql: disk } : tab,
              );
              setSqlTabs(draft, updated, active);
            });
          } else {
            if (!readOnly) baseline.set(query.id, query);
          }
          conflicts.current.delete(conflictKey);
          if (tabs.get(query.id)?.sql === query.sql) tabs.delete(query.id);
        }
      }
    });
    queue.current = operation;
    return operation;
  }, [folder]);

  const chooseFolder = useCallback(async () => {
    if (choosing) return;
    prompted.current = true;
    setChoosing(true);
    try {
      await queue.current.catch(() => {});
      const path = await invoke<string | null>("choose_sql_folder");
      if (path && path !== folder) {
        saved.current.clear();
        conflicts.current.clear();
        setFolder(path);
      }
    } catch (error) {
      errorHandler.current(error);
    } finally {
      setChoosing(false);
    }
  }, [choosing, folder]);

  useEffect(() => {
    if (!ready || folder !== null || prompted.current) return;
    void chooseFolder();
  }, [ready, folder, chooseFolder]);

  useEffect(() => {
    if (!ready || !folder || choosing) return;
    if (!initialTabs.current.has(workspace.id)) {
      initialTabs.current.set(workspace.id, new Map(sqlTabs(workspace).map((tab) => [tab.id, tab])));
    }
    let staged = pending.current.get(workspace.id);
    if (!staged) {
      staged = new Map();
      pending.current.set(workspace.id, staged);
    }
    const written = saved.current.get(workspace.id);
    for (const { id, name, sql, filePath, fileFolder } of sqlTabs(workspace)) {
      if (filePath && fileFolder !== folder) continue;
      const previous = staged.get(id) ?? written?.get(id);
      if (previous?.name === name && previous.sql === sql) continue;
      if (!previous && !sql.trim()) continue;
      staged.set(id, { id, name, sql, filePath, fileFolder });
    }
    const timer = window.setTimeout(() => {
      void flush().catch((error) => errorHandler.current(error));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [ready, folder, choosing, workspace, flush]);

  useEffect(() => {
    if (!ready || !folder || choosing) return;
    let active = true;
    let timer: number;
    async function sync() {
      try {
        await flush(true);
      } catch (error) {
        if (active) errorHandler.current(error);
      } finally {
        if (active) timer = window.setTimeout(() => void sync(), 1500);
      }
    }
    timer = window.setTimeout(() => void sync(), 1500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [ready, folder, choosing, flush]);

  return { desktop, folder, choosing, chooseFolder, flush, rememberFile };
}
