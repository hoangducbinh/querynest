import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
import { invoke } from "@tauri-apps/api/core";
import { createWorkspace } from "../schema/core";
import {
  attachDatabase,
  attachSource,
  sourceSessionKey,
  workspaceSources,
} from "./sources";
import { defaultRemoteConfig } from "./model";
import {
  ensureDatabaseSession,
  listDatabases,
  withDatabaseSession,
  reconnectDatabase,
} from "./databases";
import {
  invalidateSession,
  NeedsConnection,
  retainSession,
  getSession,
  markConnectionUnavailable,
  disconnectProfile,
} from "./sessions";
const ids: string[] = [];
const profiles: string[] = [];
afterEach(() => {
  ids.forEach(invalidateSession);
  ids.length = 0;
  profiles.forEach((profile) => disconnectProfile(profile, []));
  profiles.length = 0;
  vi.mocked(invoke).mockReset();
});
function setup() {
  const w = createWorkspace(false);
  ids.push(w.id);
  const config = defaultRemoteConfig("postgres");
  const profile = crypto.randomUUID();
  profiles.push(profile);
  const root = attachSource(w, {
    ...config,
    id: profile,
    name: "Server",
    updatedAt: 1,
  });
  const child = attachDatabase(w, root, "other");
  return { w, root, child, config };
}
describe("independent database sessions", () => {
  it("creates one database session for concurrent callers using a live sibling", async () => {
    const { w, root, child, config } = setup();
    retainSession(sourceSessionKey(w.id, root), {
      config,
      sessionId: "root-session",
      serverVersion: "17",
      disconnect: async () => {},
    });
    vi.mocked(invoke).mockResolvedValue({
      sessionId: "child-session",
      serverVersion: "17",
      catalog: { tables: [], relationships: [] },
    });
    await Promise.all([
      ensureDatabaseSession(w, child),
      ensureDatabaseSession(w, child),
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("pg_open_database", {
      sessionId: "root-session",
      database: "other",
    });
    const source = workspaceSources(w).find((s) => s.id === child)!;
    expect(
      await withDatabaseSession(
        w,
        source,
        async (session) => session.sessionId,
      ),
    ).toBe("child-session");
    expect(
      await withDatabaseSession(
        w,
        workspaceSources(w).find((s) => s.id === root)!,
        async (session) => session.sessionId,
      ),
    ).toBe("root-session");
  });
  it("borrows a Data view session for discovery without disconnecting it", async () => {
    const { w, root, config } = setup();
    const disconnect = vi.fn(async () => {});
    retainSession(sourceSessionKey(w.id, root), {
      config,
      sessionId: "grid-session",
      serverVersion: "17",
      disconnect,
    });
    try {
      vi.mocked(invoke).mockResolvedValue(["postgres", "other"]);
      expect(
        await listDatabases(
          w,
          workspaceSources(w).find((s) => s.id === root)!,
        ),
      ).toEqual(["postgres", "other"]);
      expect(invoke).toHaveBeenCalledWith("pg_databases", {
        sessionId: "grid-session",
      });
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      /* Registry owns the session across view lifetimes. */
    }
  });
  it("does not borrow another connection's credentials or swallow permission failures", async () => {
    const { w, root, child, config } = setup();
    const unrelated = attachSource(w, {
      ...config,
      id: "unrelated",
      name: "Other server",
      updatedAt: 1,
    });
    retainSession(sourceSessionKey(w.id, unrelated), {
      config,
      sessionId: "unrelated",
      serverVersion: "17",
      disconnect: async () => {},
    });
    await expect(ensureDatabaseSession(w, child)).rejects.toBeInstanceOf(
      NeedsConnection,
    );
    expect(invoke).not.toHaveBeenCalled();
    retainSession(sourceSessionKey(w.id, root), {
      config,
      sessionId: "root",
      serverVersion: "17",
      disconnect: async () => {},
    });
    vi.mocked(invoke).mockRejectedValue({ message: "database access denied" });
    await expect(ensureDatabaseSession(w, child)).rejects.toMatchObject({
      message: "database access denied",
    });
  });
});

it("reuses the same saved profile across workspaces without a new login or native call", async () => {
  const { w, root, config } = setup();
  const profileId = workspaceSources(w).find(
    (source) => source.id === root,
  )!.connectionId!;
  retainSession(sourceSessionKey(w.id, root), {
    config,
    profileId,
    sessionId: "shared-profile",
    serverVersion: "17",
    disconnect: async () => {},
  });
  const other = createWorkspace(false);
  ids.push(other.id);
  const attached = attachSource(other, {
    ...config,
    id: profileId,
    name: "Same server",
    updatedAt: 1,
  });
  await ensureDatabaseSession(other, attached);
  expect(
    getSession(sourceSessionKey(other.id, attached), config)?.sessionId,
  ).toBe("shared-profile");
  expect(invoke).not.toHaveBeenCalled();
});

it("recovers an unavailable transport using its native authentication context without replaying SQL", async () => {
  const { w, root, config } = setup();
  const key = sourceSessionKey(w.id, root);
  const disconnect = vi.fn(async () => {});
  retainSession(key, {
    config,
    sessionId: "lost-socket",
    serverVersion: "17",
    disconnect,
  });
  markConnectionUnavailable(key);
  vi.mocked(invoke).mockResolvedValue({
    sessionId: "fresh-socket",
    serverVersion: "17",
    catalog: { tables: [], relationships: [] },
  });
  await ensureDatabaseSession(w, root);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("pg_open_database", {
    sessionId: "lost-socket",
    database: config.config.database,
  });
  expect(getSession(key, config)?.sessionId).toBe("fresh-socket");
  expect(disconnect).toHaveBeenCalledWith("lost-socket");
});

it("keeps the current session if an explicit reconnect fails", async () => {
  const { w, root, config } = setup();
  const key = sourceSessionKey(w.id, root);
  const disconnect = vi.fn(async () => {});
  retainSession(key, {
    config,
    sessionId: "still-live",
    serverVersion: "17",
    disconnect,
  });
  vi.mocked(invoke).mockRejectedValue({ message: "server unavailable" });
  await expect(
    reconnectDatabase(
      w,
      workspaceSources(w).find((source) => source.id === root)!,
    ),
  ).rejects.toMatchObject({ message: "server unavailable" });
  expect(getSession(key, config)?.sessionId).toBe("still-live");
  expect(disconnect).not.toHaveBeenCalled();
});
