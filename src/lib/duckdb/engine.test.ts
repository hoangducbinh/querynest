import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../../features/schema/core";
const mocks = vi.hoisted(() => ({
  instances: [] as {
    query: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    cancelSent: ReturnType<typeof vi.fn>;
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
    send = vi.fn(async () => ({
      schema: { fields: [] },
      open: async () => {},
      async *[Symbol.asyncIterator]() {},
    }));
    cancelSent = vi.fn(async () => true);
    close = vi.fn(async () => {});
    terminate = vi.fn(async () => {});
    constructor() {
      mocks.instances.push(this);
    }
    async instantiate() {}
    async connect() {
      return {
        query: this.query,
        send: this.send,
        cancelSent: this.cancelSent,
        close: this.close,
      };
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

it("cancels the pending worker query and allows a subsequent query without rebuilding", async () => {
  const { rebuild, queryCancelable, cancelLocalQuery } =
    await import("./engine");
  await rebuild(createWorkspace(false));
  const instance = mocks.instances.at(-1)!;
  let interrupt!: (error: Error) => void;
  instance.send.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        interrupt = reject;
      }),
  );
  instance.cancelSent.mockImplementationOnce(async () => {
    interrupt(new Error("interrupted"));
    return true;
  });
  const pending = queryCancelable("SELECT expensive_work");
  const stopped = expect(pending).rejects.toThrow(/Query stopped/);
  await cancelLocalQuery();
  await stopped;
  expect(instance.cancelSent).toHaveBeenCalledOnce();
  await expect(queryCancelable("SELECT 1")).resolves.toEqual({
    columns: [],
    rows: [],
  });
});

it("converts rows from the pending-query reader with the same value rules", async () => {
  const { rebuild, queryCancelable } = await import("./engine");
  await rebuild(createWorkspace(false));
  const instance = mocks.instances.at(-1)!;
  const schema = { fields: [{ name: "n", type: { toString: () => "Int32" } }] };
  instance.send.mockResolvedValueOnce({
    schema,
    open: async () => {},
    async *[Symbol.asyncIterator]() {
      yield { schema, toArray: () => [{ toJSON: () => ({ n: 42 }) }] };
    },
  });
  await expect(queryCancelable("SELECT 42 AS n")).resolves.toEqual({
    columns: ["n"],
    rows: [{ n: 42 }],
  });
});

it("preserves column metadata after the Arrow stream clears it at EOF", async () => {
  const { rebuild, queryCancelable } = await import("./engine");
  await rebuild(createWorkspace(false));
  const schema = {
    fields: [{ name: "answer", type: { toString: () => "Int32" } }],
  };
  const reader = {
    schema: schema as typeof schema | undefined,
    open: async () => {},
    async *[Symbol.asyncIterator]() {
      yield { schema, toArray: () => [{ toJSON: () => ({ answer: 42 }) }] };
      this.schema = undefined;
    },
  };
  mocks.instances.at(-1)!.send.mockResolvedValueOnce(reader);
  await expect(queryCancelable("SELECT 42 AS answer")).resolves.toEqual({
    columns: ["answer"],
    rows: [{ answer: 42 }],
  });
});

it("inspects Arrow column types once and preserves date, decimal and bigint conversion", async () => {
  const { rebuild, query } = await import("./engine");
  await rebuild(createWorkspace());
  const dateType = vi.fn(() => "Date32<DAY>");
  const decimalType = vi.fn(() => "Decimal[18e+2]");
  const rows = [1, 2].map((id) => ({
    toJSON: () => ({
      id: BigInt(id),
      date: 0,
      amount: new Uint32Array([12345, 0, 0, 0]),
    }),
  }));
  mocks.instances.at(-1)!.query.mockResolvedValueOnce({
    schema: {
      fields: [
        { name: "id", type: { toString: () => "Int64" } },
        { name: "date", type: { toString: dateType } },
        { name: "amount", type: { toString: decimalType, scale: 2 } },
      ],
    },
    toArray: () => rows,
  });
  expect((await query("SELECT * FROM values_table")).rows).toEqual([
    { id: "1", date: "1970-01-01", amount: "123.45" },
    { id: "2", date: "1970-01-01", amount: "123.45" },
  ]);
  expect(dateType).toHaveBeenCalledTimes(1);
  expect(decimalType).toHaveBeenCalledTimes(1);
});
