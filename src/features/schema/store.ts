import { create } from "zustand";
import { produce } from "immer";
import type { WorkspaceDefinition } from "../../types/schema";
import { createWorkspace } from "./core";
interface State {
  workspace: WorkspaceDefinition;
  past: WorkspaceDefinition[];
  future: WorkspaceDefinition[];
  edit: (fn: (w: WorkspaceDefinition) => void) => void;
  load: (w: WorkspaceDefinition) => void;
  undo: () => void;
  redo: () => void;
}
export const useStore = create<State>((set) => ({
  workspace: createWorkspace(),
  past: [],
  future: [],
  edit: (fn) =>
    set((s) => ({
      past: [...s.past.slice(-49), s.workspace],
      future: [],
      workspace: produce(s.workspace, (w) => {
        fn(w);
        w.updatedAt = Date.now();
      }),
    })),
  load: (workspace) => set({ workspace, past: [], future: [] }),
  undo: () =>
    set((s) =>
      s.past.length
        ? {
            workspace: s.past.at(-1)!,
            past: s.past.slice(0, -1),
            future: [s.workspace, ...s.future],
          }
        : {},
    ),
  redo: () =>
    set((s) =>
      s.future.length
        ? {
            workspace: s.future[0],
            past: [...s.past, s.workspace],
            future: s.future.slice(1),
          }
        : {},
    ),
}));
