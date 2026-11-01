import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetSession,
  invalidateSession,
  retainSession,
  takeSession,
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
