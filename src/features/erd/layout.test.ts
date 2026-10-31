import { describe, it, expect } from "vitest";
import { createWorkspace } from "../schema/core";
import { newTable } from "../schema/table-edit";
import { relationPositions, restoredPositions } from "./layout";
describe("relationship diagram layout", () => {
  it("lays referenced tables before their dependents without changing saved positions", () => {
    const workspace = createWorkspace();
    const before = structuredClone(workspace.schema);
    const positions = relationPositions(workspace.schema);
    const [customers, orders, items] = workspace.schema.tables;
    expect(positions.get(customers.id)!.x).toBeLessThan(
      positions.get(orders.id)!.x,
    );
    expect(positions.get(orders.id)!.x).toBeLessThan(
      positions.get(items.id)!.x,
    );
    expect(workspace.schema).toEqual(before);
  });
  it("keeps disconnected tables from overlapping existing nodes", () => {
    const workspace = createWorkspace();
    const other = newTable(workspace);
    other.name = "notes";
    workspace.schema.tables.push(other);
    const positions = relationPositions(workspace.schema);
    expect(positions.get(other.id)!.y).toBeGreaterThan(
      positions.get(workspace.schema.tables[0].id)!.y +
        workspace.schema.tables[0].columns.length * 30 +
        40,
    );
  });
  it("handles logical cycles and self references without changing the schema", () => {
    const workspace = createWorkspace();
    const [a, b] = workspace.schema.tables;
    workspace.schema.relationships.push({
      id: "reverse",
      sourceTable: a.id,
      targetTable: b.id,
      sourceColumns: [a.columns[0].id],
      targetColumns: [b.columns[0].id],
      kind: "logical",
    });
    const positions = relationPositions(workspace.schema);
    expect(positions.size).toBe(3);
    expect(
      new Set([...positions.values()].map((p) => `${p.x}:${p.y}`)).size,
    ).toBe(3);
  });
});

describe("saved diagram positions", () => {
  it("opens legacy workspaces with automatic positions", () => {
    const w = createWorkspace();
    expect(restoredPositions(w.schema, undefined)).toEqual(
      relationPositions(w.schema),
    );
  });
  it("restores manual positions without mutating the schema or retaining deleted tables", () => {
    const w = createWorkspace();
    const before = structuredClone(w.schema);
    const table = w.schema.tables[0];
    const saved = { [table.id]: { x: 825, y: -40 }, deleted: { x: 10, y: 10 } };
    const result = restoredPositions(w.schema, saved);
    expect(result.get(table.id)).toEqual({ x: 825, y: -40 });
    expect(result.has("deleted")).toBe(false);
    expect(result.size).toBe(w.schema.tables.length);
    result.get(table.id)!.x = 0;
    expect(saved[table.id].x).toBe(825);
    expect(w.schema).toEqual(before);
  });
});
