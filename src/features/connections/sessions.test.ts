import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetSession,
  invalidateSession,
  retainSession,
  takeSession,
  withConnectionSession,
  checkoutConnectionSession,
} from "./sessions";
import { defaultRemoteConfig } from "./model";
const config = defaultRemoteConfig("postgres");
const disconnect = vi.fn(async () => {});
const entry = (sessionId: string) => ({
  sessionId,
  serverVersion: "17",
  config,
  disconnect,
});
afterEach(() => {
  for (const id of ["a", "b", "c", "d", "e", "deleted"]) forgetSession(id);
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("workspace sessions", () => {
  it("reclaims the same live handle without reconnecting or keeping credentials", () => {
    retainSession("a", entry("session-a"));
    expect(takeSession("a", config)?.sessionId).toBe("session-a");
    expect(takeSession("a", config)).toBeUndefined();
    expect(disconnect).not.toHaveBeenCalled();
  });
  it("closes handles if connection settings or permissions change", () => {
    retainSession("a", entry("old"));
    const changed = structuredClone(config);
    changed.config.readOnly = !changed.config.readOnly;
    expect(takeSession("a", changed)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith("old");
  });
  it("expires inactive connections but cancels expiry when reclaimed", () => {
    vi.useFakeTimers();
    retainSession("a", entry("a"));
    retainSession("b", entry("b"));
    takeSession("b", config);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("a");
    expect(takeSession("a", config)).toBeUndefined();
  });
  it("limits inactive connections to four and closes the oldest", () => {
    for (const id of ["a", "b", "c", "d", "e"]) retainSession(id, entry(id));
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("a");
    expect(takeSession("a", config)).toBeUndefined();
    expect(takeSession("e", config)?.sessionId).toBe("e");
  });
  it("cannot retain a deleted workspace during component teardown", () => {
    invalidateSession("deleted");
    retainSession("deleted", entry("late"));
    expect(takeSession("deleted", config)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith("late");
  });
});

describe("multiple connection session leases", () => {
  it("does not expire a connection while a query is using it", async () => {
    vi.useFakeTimers();
    retainSession("a", entry("leased"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = withConnectionSession("a", config, async (value) => {
      expect(value.sessionId).toBe("leased");
      await gate;
    });
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(disconnect).not.toHaveBeenCalled();
    release();
    await running;
    expect(takeSession("a", config)?.sessionId).toBe("leased");
  });
  it("keeps two connection identities separate during overlapping operations", async () => {
    retainSession("a", entry("first"));
    retainSession("b", entry("second"));
    const values = await Promise.all([
      withConnectionSession("a", config, async (s) => s.sessionId),
      withConnectionSession("b", config, async (s) => s.sessionId),
    ]);
    expect(values).toEqual(["first", "second"]);
  });
  it("does not resurrect an old session after reconnecting during validation", async () => {
    retainSession("a", entry("old"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validation = withConnectionSession("a", config, async () => {
      await gate;
    });
    retainSession("a", entry("new"));
    release();
    await validation;
    expect(takeSession("a", config)?.sessionId).toBe("new");
    expect(disconnect).toHaveBeenCalledWith("old");
  });
  it("does not retain closed sessions and migrates a legacy primary session", async () => {
    retainSession("a", entry("legacy"));
    await expect(
      withConnectionSession("a:source:primary", config, async (s) => {
        expect(s.sessionId).toBe("legacy");
        throw { closed: true };
      }),
    ).rejects.toEqual({ closed: true });
    expect(takeSession("a:source:primary", config)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith("legacy");
  });
  it("deleting a workspace closes all its connection sessions", () => {
    retainSession("multi-deleted:source:one", entry("one"));
    retainSession("multi-deleted:source:two", entry("two"));
    invalidateSession("multi-deleted");
    expect(takeSession("multi-deleted:source:one", config)).toBeUndefined();
    expect(takeSession("multi-deleted:source:two", config)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith("one");
    expect(disconnect).toHaveBeenCalledWith("two");
  });
});

it("waits for background validation before handing the same session to Data", async () => {
  retainSession("checkout-qa", entry("shared"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const validation = withConnectionSession("checkout-qa", config, async () => {
    await gate;
  });
  let checked = false;
  const checkout = checkoutConnectionSession("checkout-qa", config).then(
    (value) => {
      checked = true;
      return value;
    },
  );
  await Promise.resolve();
  expect(checked).toBe(false);
  release();
  await validation;
  expect((await checkout)?.sessionId).toBe("shared");
});
