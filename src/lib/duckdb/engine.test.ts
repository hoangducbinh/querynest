import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../../features/schema/core";
const mocks = vi.hoisted(() => ({
  instances: [] as {
    query: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("@duckdb/duckdb-wasm", () => ({
  LogLevel: { ERROR: 1 },
  selectBundle: vi.fn(async () => ({
    mainWorker: "worker",
    mainModule: "wasm",
  })),
  ConsoleLogger: class {},
  AsyncDuckDB: class {
    query = vi.fn(async () => ({ schema: { fields: [] }, toArray: () => [] }));
    close = vi.fn(async () => {});
    terminate = vi.fn(async () => {});
    constructor() {
      mocks.instances.push(this);
    }
    async instantiate() {}
    async connect() {
      return { query: this.query, close: this.close };
    }
  },
}));
beforeEach(() => {
  vi.stubGlobal("Worker", class {});
});
describe("isolated runtime reconstruction", () => {
  it("restores dependency-ordered rows and retains the existing runtime when a rename would discard saved values", async () => {
    const { rebuild, query } = await import("./engine");
    const w = createWorkspace();
    await rebuild(w);
    const previous = mocks.instances.at(-1)!;
    expect(
      previous.query.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("INSERT"))
        .map((s) => s.match(/INSERT INTO "([^"]+)"/)?.[1]),
    ).toEqual([
      "customers",
      "customers",
      "orders",
      "orders",
      "orders",
      "order_items",
    ]);
    w.schema.tables[0].columns[1].name = "full_name";
    await expect(rebuild(w)).rejects.toThrow(/removed or renamed/);
    expect(previous.close).not.toHaveBeenCalled();
    expect(previous.terminate).not.toHaveBeenCalled();
    const failed = mocks.instances.at(-1)!;
    expect(failed.query).toHaveBeenCalledWith("ROLLBACK");
    expect(failed.terminate).toHaveBeenCalled();
    await query("SELECT 1");
    expect(previous.query).toHaveBeenCalledWith("SELECT 1");
  });
});
