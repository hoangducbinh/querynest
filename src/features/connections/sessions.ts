import type { RemoteConfig } from "./model";

export interface RetainedSession {
  sessionId: string;
  serverVersion: string;
  config: RemoteConfig;
  disconnect: (sessionId: string) => Promise<void>;
}
// Session handles only. Passwords and query data never enter this cache.
const sessions = new Map<
  string,
  RetainedSession & { timer: ReturnType<typeof setTimeout> }
>();
const revoked = new Set<string>();
export function invalidateSession(workspaceId: string) {
  revoked.add(workspaceId);
  for (const key of sessions.keys())
    if (key === workspaceId || key.startsWith(workspaceId + ":source:"))
      forgetSession(key);
  for (const [key, lease] of leases)
    if (key === workspaceId || key.startsWith(workspaceId + ":source:"))
      void lease.value.disconnect(lease.value.sessionId).catch(() => {});
}
const fingerprint = (value: RemoteConfig) =>
  JSON.stringify([
    value.engine,
    Object.entries(value.config).sort(([a], [b]) => a.localeCompare(b)),
  ]);
export function forgetSession(workspaceId: string) {
  const entry = sessions.get(workspaceId);
  if (!entry) return;
  sessions.delete(workspaceId);
  clearTimeout(entry.timer);
  void entry.disconnect(entry.sessionId).catch(() => {});
}
export function retainSession(workspaceId: string, value: RetainedSession) {
  if (
    [...revoked].some(
      (key) => key === workspaceId || workspaceId.startsWith(key + ":source:"),
    )
  ) {
    void value.disconnect(value.sessionId).catch(() => {});
    return;
  }
  const leased = leases.get(workspaceId);
  if (leased && leased.value.sessionId !== value.sessionId) {
    leased.discard = true;
    leases.delete(workspaceId);
  }
  forgetSession(workspaceId);
  while (sessions.size >= 4) forgetSession(sessions.keys().next().value!);
  const timer = setTimeout(() => forgetSession(workspaceId), 30 * 60 * 1000);
  sessions.set(workspaceId, { ...value, timer });
}
export function takeSession(
  workspaceId: string,
  config: RemoteConfig,
): RetainedSession | undefined {
  const entry = sessions.get(workspaceId);
  if (!entry) return;
  if (fingerprint(entry.config) !== fingerprint(config)) {
    forgetSession(workspaceId);
    return;
  }
  sessions.delete(workspaceId);
  clearTimeout(entry.timer);
  return entry;
}

const leases = new Map<
  string,
  {
    value: RetainedSession;
    users: number;
    discard?: boolean;
    settled: Promise<void>;
    resolve: () => void;
  }
>();
export class NeedsConnection extends Error {
  constructor() {
    super("Connect to this database before running SQL.");
  }
}
export async function withConnectionSession<T>(
  key: string,
  config: RemoteConfig,
  fn: (session: RetainedSession) => Promise<T>,
): Promise<T> {
  const owned =
    ownedSessions.get(key) ??
    (key.endsWith(":source:primary")
      ? ownedSessions.get(key.slice(0, -":source:primary".length))
      : undefined);
  if (owned && fingerprint(owned.config) === fingerprint(config))
    return fn(owned);
  let lease = leases.get(key);
  if (lease?.discard) {
    leases.delete(key);
    lease = undefined;
  }
  if (lease && fingerprint(lease.value.config) !== fingerprint(config))
    throw new NeedsConnection();
  if (!lease) {
    const value =
      takeSession(key, config) ??
      (key.endsWith(":source:primary")
        ? takeSession(key.slice(0, -":source:primary".length), config)
        : undefined);
    if (!value) throw new NeedsConnection();
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    lease = { value, users: 0, settled, resolve };
    leases.set(key, lease);
  }
  lease.users++;
  try {
    return await fn(lease.value);
  } catch (error) {
    if (error && typeof error === "object" && "closed" in error && error.closed)
      lease.discard = true;
    throw error;
  } finally {
    lease.users--;
    if (!lease.users) {
      if (leases.get(key) === lease) leases.delete(key);
      if (lease.discard)
        void lease.value.disconnect(lease.value.sessionId).catch(() => {});
      else retainSession(key, lease.value);
      lease.resolve();
    }
  }
}

export function discardConnectionSession(key: string) {
  const lease = leases.get(key);
  if (lease) lease.discard = true;
  forgetSession(key);
}

export async function checkoutConnectionSession(
  key: string,
  config: RemoteConfig,
) {
  const lease = leases.get(key);
  if (lease) await lease.settled;
  return takeSession(key, config);
}

// Data views own a checked-out session; discovery can borrow its handle without
// taking ownership or shortening the lifetime of the grid connection.
const ownedSessions = new Map<string, RetainedSession>();
export function registerOwnedSession(key: string, value: RetainedSession) {
  ownedSessions.set(key, value);
  return () => {
    if (ownedSessions.get(key) === value) ownedSessions.delete(key);
  };
}
