import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetSession,
  findProfileSession,
  invalidateSession,
  retainSession,
  getSession,
  disconnectProfile,
  replaceSession,
  markConnectionUnavailable,
  withConnectionSession,
  sameServer,
  fingerprint,
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
  for (const profile of ["alias-profile", "same-profile"])
    disconnectProfile(profile, []);
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("workspace sessions", () => {
  it("reclaims the same live handle without reconnecting or keeping credentials", () => {
    retainSession("a", entry("session-a"));
    expect(getSession("a", config)?.sessionId).toBe("session-a");
    expect(getSession("a", config)?.sessionId).toBe("session-a");
    expect(disconnect).not.toHaveBeenCalled();
  });
  it("does not reuse changed settings or permissions, and does not close other views' session", () => {
    retainSession("a", entry("old"));
    const changed = structuredClone(config);
    changed.config.readOnly = !changed.config.readOnly;
    expect(getSession("a", changed)).toBeUndefined();
    expect(disconnect).not.toHaveBeenCalled();
    expect(getSession("a", config)?.sessionId).toBe("old");
  });
  it("keeps connected handles until explicit disconnect, including after idle periods", () => {
    vi.useFakeTimers();
    retainSession("a", entry("a"));
    retainSession("b", entry("b"));
    getSession("b", config);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(disconnect).not.toHaveBeenCalled();
    expect(getSession("a", config)?.sessionId).toBe("a");
  });
  it("opening a fifth context does not evict earlier connections", () => {
    for (const id of ["a", "b", "c", "d", "e"]) retainSession(id, entry(id));
    expect(disconnect).not.toHaveBeenCalled();
    expect(getSession("a", config)?.sessionId).toBe("a");
    expect(getSession("e", config)?.sessionId).toBe("e");
  });
  it("cannot retain a deleted workspace during component teardown", () => {
    invalidateSession("deleted");
    retainSession("deleted", entry("late"));
    expect(getSession("deleted", config)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith("late");
  });
});

describe("shared connection registry", () => {
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
    expect(getSession("a", config)?.sessionId).toBe("leased");
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
    expect(getSession("a", config)?.sessionId).toBe("new");
    expect(disconnect).toHaveBeenCalledWith("old");
  });
  it("marks transport failures unavailable without dropping the native authentication context", async () => {
    retainSession("a", entry("legacy"));
    await expect(
      withConnectionSession("a:source:primary", config, async (s) => {
        expect(s.sessionId).toBe("legacy");
        throw { closed: true };
      }),
    ).rejects.toEqual({ closed: true });
    expect(getSession("a:source:primary", config)).toBeUndefined();
    expect(disconnect).not.toHaveBeenCalled();
    expect(getSession("a:source:primary", config, true)?.sessionId).toBe(
      "legacy",
    );
  });
  it("deleting a workspace closes all its connection sessions", () => {
    retainSession("multi-deleted:source:one", entry("one"));
    retainSession("multi-deleted:source:two", entry("two"));
    invalidateSession("multi-deleted");
    expect(getSession("multi-deleted:source:one", config)).toBeUndefined();
    expect(getSession("multi-deleted:source:two", config)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith("one");
    expect(disconnect).toHaveBeenCalledWith("two");
  });
});

it("Data borrows the live session without waiting for background validation or checking it out", async () => {
  retainSession("a", entry("shared"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const validation = withConnectionSession("a", config, async () => {
    await gate;
  });
  expect(getSession("a", config)?.sessionId).toBe("shared");
  expect(
    await withConnectionSession("a", config, async (value) => value.sessionId),
  ).toBe("shared");
  release();
  await validation;
  expect(disconnect).not.toHaveBeenCalled();
});

it("shares the same live session across SQL, Data, discovery and back to SQL", async () => {
  const key = "shared-views:source:database";
  retainSession(key, entry("one-login"));
  await withConnectionSession(key, config, async (s) =>
    expect(s.sessionId).toBe("one-login"),
  );
  const data = getSession(key, config);
  expect(data?.sessionId).toBe("one-login");
  await withConnectionSession(key, config, async (s) =>
    expect(s.sessionId).toBe("one-login"),
  );
  retainSession(key, data!);
  await withConnectionSession(key, config, async (s) =>
    expect(s.sessionId).toBe("one-login"),
  );
  expect(disconnect).not.toHaveBeenCalled();
  forgetSession(key);
});

it("shares a profile across workspaces and disconnects it only once", () => {
  const first = "cross-a:source:one",
    second = "cross-b:source:two";
  const shared = {
    ...entry("same-physical-session"),
    profileId: "same-profile",
  };
  retainSession(first, shared);
  retainSession(second, shared);
  expect(getSession(first, config)).toBe(getSession(second, config));
  invalidateSession("cross-a");
  expect(getSession(second, config)?.sessionId).toBe("same-physical-session");
  expect(disconnect).not.toHaveBeenCalled();
  disconnectProfile("same-profile", [second]);
  expect(getSession(second, config)).toBeUndefined();
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("same-physical-session");
});

it("reconnect updates every alias, and a stale old failure cannot invalidate the new session", async () => {
  const original = { ...entry("before"), profileId: "alias-profile" };
  retainSession("a", original);
  retainSession("b", original);
  let reject!: (error: unknown) => void;
  const old = withConnectionSession(
    "a",
    config,
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  replaceSession("before", { ...entry("after"), profileId: "alias-profile" });
  const assertion = expect(old).rejects.toEqual({ closed: true });
  reject({ closed: true });
  await assertion;
  expect(getSession("a", config)?.sessionId).toBe("after");
  expect(getSession("b", config)?.sessionId).toBe("after");
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("before");
});

it("an acknowledged SQL stop keeps the same registered session", async () => {
  retainSession("a", entry("kept"));
  await expect(
    withConnectionSession("a", config, async () => {
      throw { closed: false, message: "Query stopped" };
    }),
  ).rejects.toMatchObject({ closed: false });
  expect(getSession("a", config)?.sessionId).toBe("kept");
  expect(disconnect).not.toHaveBeenCalled();
  markConnectionUnavailable("a");
  expect(getSession("a", config)).toBeUndefined();
  expect(getSession("a", config, true)?.sessionId).toBe("kept");
});

it("keeps a saved profile available after its last workspace releases it", () => {
  retainSession("a", { ...entry("global-session"), profileId: "same-profile" });
  forgetSession("a");
  const shared = findProfileSession("same-profile", config);
  expect(shared?.sessionId).toBe("global-session");
  expect(disconnect).not.toHaveBeenCalled();
  retainSession("b", shared!);
  expect(getSession("b", config)?.sessionId).toBe("global-session");
  disconnectProfile("same-profile", []);
  expect(getSession("b", config)).toBeUndefined();
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("global-session");
});

it("compares server identities without ignoring credentials, TLS or read-only settings", () => {
  const otherDatabase = structuredClone(config);
  otherDatabase.config.database = "another_database";
  expect(sameServer(config, otherDatabase)).toBe(true);
  expect(fingerprint(config)).not.toBe(fingerprint(otherDatabase));
  for (const patch of [
    { host: "another-host" },
    { port: 55439 },
    { user: "another-user" },
    { sslMode: "disable" },
    { readOnly: !config.config.readOnly },
  ]) {
    expect(
      sameServer(config, {
        engine: "postgres",
        config: { ...config.config, ...patch },
      } as typeof config),
    ).toBe(false);
  }
  const reordered = {
    ...config,
    config: Object.fromEntries(Object.entries(config.config).reverse()),
  } as typeof config;
  expect(fingerprint(reordered)).toBe(fingerprint(config));
});
