import { describe, it, expect } from "vitest";
import { parseWorkspace, validateRelationship, validateSchema } from "./core";
import { createWorkspace } from "../../test/fixtures";
import { quote } from "../../lib/sql/identifiers";
import { createWorkspace as createEmptyWorkspace } from "./core";
import { useStore } from "./store";
import "fake-indexeddb/auto";
import { saveWorkspace, storage } from "../../lib/storage/workspaces";
describe("canonical schema", () => {
  it("validates imported legacy schema metadata", () => {
    const w = createWorkspace();
    expect(validateSchema(w.schema)).toEqual([]);
  });
  it("rejects mismatched types and non-unique references", () => {
    const w = createWorkspace();
    const r = w.schema.relationships[0];
    w.schema.tables[0].columns[0].type = "VARCHAR";
    expect(validateRelationship(w.schema, r)).toMatch(/types/);
    w.schema.tables[0].columns[0].type = "INTEGER";
    w.schema.tables[0].primaryKey = [];
    expect(validateRelationship(w.schema, r)).toMatch(/unique/);
  });
  it("checks ordered composite references", () => {
    const w = createWorkspace();
    const [a, b] = w.schema.tables;
    a.columns[1].type = "INTEGER";
    a.primaryKey = [a.columns[0].id, a.columns[1].id];
    b.columns[2].type = "INTEGER";
    const r = {
      ...w.schema.relationships[0],
      sourceColumns: [b.columns[1].id, b.columns[2].id],
      targetColumns: [a.columns[1].id, a.columns[0].id],
    };
    expect(validateRelationship(w.schema, r)).toMatch(/order/);
    r.targetColumns.reverse();
    expect(validateRelationship(w.schema, r)).toBeUndefined();
  });
  it("quotes identifiers safely", () => {
    expect(quote('a"b')).toBe('"a""b"');
    expect(quote("select")).toBe('"select"');
  });
  it("starts with an empty session requiring a real connection", () => {
    const workspace = createEmptyWorkspace();
    expect(workspace.sql).toBe("");
    expect(workspace.schema).toEqual({ tables: [], relationships: [] });
    expect(workspace.data).toEqual({});
    expect(workspace.postgres).toBeUndefined();
    expect(workspace.mssql).toBeUndefined();
  });
  it("undoes and redoes schema edits", () => {
    useStore.getState().load(createWorkspace(false));
    useStore.getState().edit((w) => {
      w.name = "Changed";
    });
    useStore.getState().undo();
    expect(useStore.getState().workspace.name).toBe("Untitled workspace");
    useStore.getState().redo();
    expect(useStore.getState().workspace.name).toBe("Changed");
  });
  it("roundtrips through IndexedDB and JSON", async () => {
    const w = createWorkspace();
    await saveWorkspace(w);
    expect(await storage.workspaces.get(w.id)).toEqual(w);
    expect(parseWorkspace(JSON.stringify(w))).toEqual(w);
    await storage.workspaces.delete(w.id);
  });
});
