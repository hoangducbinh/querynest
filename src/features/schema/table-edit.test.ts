import { describe, it, expect } from "vitest";
import { createWorkspace } from "./core";
import { newColumn, newTable, planTableEdit } from "./table-edit";
describe("staged table editing", () => {
  it("creates a draft without inserting a phantom table", () => {
    const w = createWorkspace();
    const t = newTable(w);
    expect(w.schema.tables).toHaveLength(3);
    expect(t.columns[0].name).toBe("id");
    expect(planTableEdit(w, t, true).errors).toContain(
      "Table names must be nonempty and unique.",
    );
    t.name = "payments";
    expect(planTableEdit(w, t, true).schema.tables).toHaveLength(4);
  });
  it("renames columns by stable ID while preserving saved rows", () => {
    const w = createWorkspace();
    const draft = structuredClone(w.schema.tables[0]);
    draft.name = "clients";
    draft.columns[1].name = "full_name";
    const plan = planTableEdit(w, draft, false);
    expect(plan.errors).toEqual([]);
    expect(plan.data[draft.id][0]).toEqual({
      id: 1,
      full_name: "Alex Morgan",
      email: "alex@example.com",
    });
    expect(w.data[draft.id][0]).toHaveProperty("name", "Alex Morgan");
    expect(w.schema.tables[0].name).toBe("customers");
    expect(plan.schema.relationships).toEqual(w.schema.relationships);
  });
  it("can swap column names without overwriting either column value", () => {
    const w = createWorkspace();
    const draft = structuredClone(w.schema.tables[0]);
    draft.columns[1].name = "email";
    draft.columns[2].name = "name";
    const plan = planTableEdit(w, draft, false);
    expect(plan.data[draft.id][0]).toEqual({
      id: 1,
      email: "Alex Morgan",
      name: "alex@example.com",
    });
  });
  it("preserves saved values when reordering columns or adding a defaulted column", () => {
    const w = createWorkspace();
    const draft = structuredClone(w.schema.tables[0]);
    draft.columns.reverse();
    draft.columns.push({
      ...newColumn("active"),
      type: "BOOLEAN",
      nullable: false,
      defaultValue: "TRUE",
    });
    const plan = planTableEdit(w, draft, false);
    expect(plan.errors).toEqual([]);
    expect(plan.data[draft.id]).toEqual(w.data[draft.id]);
    expect(plan.data[draft.id][0]).not.toHaveProperty("active");
  });
  it("lists removed columns and relationships for confirmation before commit", () => {
    const w = createWorkspace();
    const draft = structuredClone(w.schema.tables[1]);
    draft.columns = draft.columns.filter((c) => c.name !== "customer_id");
    const plan = planTableEdit(w, draft, false);
    expect(plan.removed.map((c) => c.name)).toEqual(["customer_id"]);
    expect(plan.removedRelationships).toHaveLength(1);
    expect(plan.schema.relationships).toHaveLength(1);
    expect(plan.data[draft.id][0]).toEqual({ id: 1, total: 149.5 });
    expect(w.schema.relationships).toHaveLength(2);
  });
  it("validates duplicate column names and foreign-key type changes before applying", () => {
    const w = createWorkspace();
    const draft = structuredClone(w.schema.tables[1]);
    draft.columns[1].type = "VARCHAR";
    expect(planTableEdit(w, draft, false).errors).toContain(
      "Related columns must have matching types.",
    );
    draft.columns[1].type = "INTEGER";
    draft.columns[1].name = "id";
    expect(
      planTableEdit(w, draft, false).errors.some((e) => e.includes("unique")),
    ).toBe(true);
  });
  it("enforces non-nullable primary keys and retains composite key order", () => {
    const w = createWorkspace(false);
    const draft = newTable(w);
    draft.name = "pairs";
    const other = newColumn("other_id");
    draft.columns.push(other);
    draft.primaryKey = [other.id, draft.columns[0].id];
    const plan = planTableEdit(w, draft, true);
    expect(plan.table.columns.every((c) => !c.nullable)).toBe(true);
    expect(plan.table.primaryKey).toEqual(draft.primaryKey);
  });
  it("does not silently discard runtime-only columns", () => {
    const w = createWorkspace();
    const table = w.schema.tables[0];
    w.data[table.id][0].extra = "keep me";
    const plan = planTableEdit(w, structuredClone(table), false);
    expect(plan.data[table.id][0].extra).toBe("keep me");
    const draft = structuredClone(table);
    draft.columns[1].name = "extra";
    expect(
      planTableEdit(w, draft, false).errors.some((e) => e.includes("unmapped")),
    ).toBe(true);
  });
});
