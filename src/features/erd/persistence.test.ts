import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { createWorkspace, parseWorkspace } from "../schema/core";
import { useStore } from "../schema/store";
import { saveWorkspace, storage } from "../../lib/storage/workspaces";
describe("diagram layout persistence", () => {
  it("roundtrips layout independently of schema and supports undo/redo", async () => {
    const w = createWorkspace();
    const schema = structuredClone(w.schema);
    useStore.getState().load(w);
    const tableId = w.schema.tables[0].id;
    useStore.getState().edit((workspace) => {
      workspace.diagramPositions = { [tableId]: { x: 450, y: 275 } };
    });
    const saved = useStore.getState().workspace;
    expect(saved.schema).toEqual(schema);
    await saveWorkspace(saved);
    const restored = await storage.workspaces.get(saved.id);
    expect(restored?.diagramPositions?.[tableId]).toEqual({ x: 450, y: 275 });
    expect(parseWorkspace(JSON.stringify(restored)).diagramPositions).toEqual(
      saved.diagramPositions,
    );
    useStore.getState().undo();
    expect(useStore.getState().workspace.diagramPositions).toBeUndefined();
    useStore.getState().redo();
    expect(useStore.getState().workspace.diagramPositions?.[tableId]).toEqual({
      x: 450,
      y: 275,
    });
    await storage.workspaces.delete(w.id);
  });
  it("rejects malformed layout coordinates while accepting existing workspace exports", () => {
    const w = createWorkspace();
    expect(() => parseWorkspace(JSON.stringify(w))).not.toThrow();
    for (const positions of [
      null,
      [],
      { table: { x: "450", y: 0 } },
      { table: { x: null, y: 0 } },
      { table: { x: 0 } },
    ])
      expect(() =>
        parseWorkspace(JSON.stringify({ ...w, diagramPositions: positions })),
      ).toThrow(/diagram positions/);
  });
});
