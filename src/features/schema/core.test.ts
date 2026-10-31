import { describe, it, expect } from "vitest";
import {
  createWorkspace,
  parseWorkspace,
  validateRelationship,
  validateSchema,
} from "./core";
import { generateDDL } from "../../lib/ddl/generate";
import { useStore } from "./store";
import { compareResults } from "../test-cases/compare";
import "fake-indexeddb/auto";
import { saveWorkspace, storage } from "../../lib/storage/workspaces";
describe("canonical schema", () => {
  it("validates the starter schema and generates dependency-ordered DDL", () => {
    const w = createWorkspace();
    expect(validateSchema(w.schema)).toEqual([]);
    const ddl = generateDDL(w.schema);
    expect(ddl.indexOf('CREATE TABLE "customers"')).toBeLessThan(
      ddl.indexOf('CREATE TABLE "orders"'),
    );
    expect(ddl).toContain(
      'FOREIGN KEY ("customer_id") REFERENCES "customers" ("id")',
    );
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
  it("detects cycles without recursively failing", () => {
    const w = createWorkspace();
    w.schema.relationships.push({
      ...w.schema.relationships[0],
      id: "cycle",
      sourceTable: w.schema.tables[0].id,
      sourceColumns: [w.schema.tables[0].columns[0].id],
      targetTable: w.schema.tables[1].id,
      targetColumns: [w.schema.tables[1].columns[0].id],
    });
    expect(() => generateDDL(w.schema)).toThrow(/Cyclic/);
  });
  it("quotes identifiers safely", () => {
    const w = createWorkspace(false);
    w.schema.tables.push({
      id: "a",
      name: 'a"b',
      position: { x: 0, y: 0 },
      columns: [
        {
          id: "c",
          name: "select",
          type: "INTEGER",
          nullable: true,
          unique: false,
          defaultValue: "",
        },
      ],
      primaryKey: [],
    });
    expect(generateDDL(w.schema)).toContain('"a""b"');
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
  it("compares ordered/unordered rows, NULL, and numeric serialization", () => {
    expect(
      compareResults([{ x: 1 }, { x: null }], [{ x: null }, { x: "1" }], false),
    ).toBe(true);
    expect(
      compareResults([{ x: 1 }, { x: null }], [{ x: null }, { x: 1 }], true),
    ).toBe(false);
    expect(compareResults([{ x: null }], [{}], false)).toBe(false);
  });
});
