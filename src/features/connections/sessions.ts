import type { PgCatalog } from "../postgres/model";
import { useSyncExternalStore } from "react";
import type { RemoteConfig } from "./model";

export interface RetainedSession {
  sessionId: string;
  serverVersion: string;
  config: RemoteConfig;
  profileId?: string;
  catalog?: PgCatalog;
  connected?: boolean;
  disconnect: (sessionId: string) => Promise<void>;
}
// One process-wide registry owns live handles. Views only borrow them: changing
// tools, query tabs or workspaces never checks out, expires or evicts a handle.
// Credentials remain exclusively in the native driver's memory.
const sessions = new Map<string, RetainedSession>();
const revoked = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const fingerprint = (value: RemoteConfig) =>
  JSON.stringify([
    value.engine,
    Object.entries(value.config).sort(([a], [b]) => a.localeCompare(b)),
  ]);
export function sameServer(a: RemoteConfig, b: RemoteConfig) {
  return (
    fingerprint({
      ...a,
      config: { ...a.config, database: "" },
    } as RemoteConfig) ===
    fingerprint({ ...b, config: { ...b.config, database: "" } } as RemoteConfig)
  );
}
function lookup(key: string) {
  return (
    sessions.get(key) ??
    (key.endsWith(":source:primary")
      ? sessions.get(key.slice(0, -":source:primary".length))
      : !key.includes(":source:")
        ? sessions.get(key + ":source:primary")
        : undefined)
  );
}
export function getSession(
  key: string,
  config: RemoteConfig,
  includeUnavailable = false,
) {
  const value = lookup(key);
  return value &&
    fingerprint(value.config) === fingerprint(config) &&
    (includeUnavailable || value.connected !== false)
    ? value
    : undefined;
}
export function useConnectionSession(key: string, config: RemoteConfig) {
  return useSyncExternalStore(subscribe, () => getSession(key, config));
}
export function useSessionRevision() {
  return useSyncExternalStore(subscribe, () => revision);
}
export function useConnectionStatus(key: string, config?: RemoteConfig) {
  useSessionRevision();
  return !config
    ? "Local"
    : getSession(key, config)
      ? "Connected"
      : "Disconnected";
}
export function profileSessions(profileId?: string) {
  return profileId
    ? [
        ...new Map(
          [...sessions.values()]
            .filter((s) => s.profileId === profileId)
            .map((s) => [s.sessionId, s]),
        ).values(),
      ]
    : [];
}
export function findProfileSession(
  profileId: string | undefined,
  config: RemoteConfig,
) {
  return profileSessions(profileId).find(
    (s) =>
      s.connected !== false && fingerprint(s.config) === fingerprint(config),
  );
}
function closeIfUnreferenced(value: RetainedSession) {
  if (![...sessions.values()].some((s) => s.sessionId === value.sessionId))
    void value.disconnect(value.sessionId).catch(() => {});
}
export function retainSession(key: string, value: RetainedSession) {
  if (
    [...revoked].some(
      (prefix) => key === prefix || key.startsWith(prefix + ":source:"),
    )
  ) {
    closeIfUnreferenced(value);
    return;
  }
  const previous = sessions.get(key);
  const shared = findProfileSession(value.profileId, value.config);
  const next = shared ?? value;
  sessions.set(key, next);
  if (next.profileId)
    sessions.set(
      `connection-profile:${next.profileId}:${fingerprint(next.config)}`,
      next,
    );
  if (previous && previous.sessionId !== next.sessionId)
    closeIfUnreferenced(previous);
  if (next.sessionId !== value.sessionId) closeIfUnreferenced(value);
  changed();
  return next;
}
export function forgetSession(key: string) {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  closeIfUnreferenced(entry);
  changed();
}
export function discardConnectionSession(key: string) {
  const value = lookup(key);
  if (!value) return;
  for (const [alias, entry] of sessions)
    if (entry.sessionId === value.sessionId) sessions.delete(alias);
  closeIfUnreferenced(value);
  changed();
}
export function markConnectionUnavailable(key: string) {
  const value = lookup(key);
  if (!value) return;
  for (const [alias, entry] of sessions)
    if (entry.sessionId === value.sessionId)
      sessions.set(alias, { ...entry, connected: false });
  changed();
}
export function replaceSession(previousId: string, value: RetainedSession) {
  let old: RetainedSession | undefined;
  for (const [key, entry] of sessions)
    if (entry.sessionId === previousId) {
      old = entry;
      sessions.set(key, value);
    }
  if (old && old.sessionId !== value.sessionId) closeIfUnreferenced(old);
  changed();
}
export function disconnectProfile(
  profileId: string | undefined,
  keys: string[],
) {
  const targets = new Set(
    keys.flatMap((key) => (lookup(key) ? [lookup(key)!.sessionId] : [])),
  );
  if (profileId)
    for (const value of profileSessions(profileId))
      targets.add(value.sessionId);
  const removed = new Map<string, RetainedSession>();
  for (const [key, value] of sessions)
    if (targets.has(value.sessionId)) {
      removed.set(value.sessionId, value);
      sessions.delete(key);
    }
  for (const value of removed.values()) closeIfUnreferenced(value);
  changed();
}
export function invalidateSession(workspaceId: string) {
  revoked.add(workspaceId);
  for (const key of [...sessions.keys()])
    if (key === workspaceId || key.startsWith(workspaceId + ":source:"))
      forgetSession(key);
}
export class NeedsConnection extends Error {
  constructor() {
    super("Open Connections to connect this database.");
  }
}
export async function withConnectionSession<T>(
  key: string,
  config: RemoteConfig,
  fn: (session: RetainedSession) => Promise<T>,
): Promise<T> {
  const value = getSession(key, config);
  if (!value) throw new NeedsConnection();
  try {
    return await fn(value);
  } catch (error) {
    // Keep the native authentication context for a fresh connection. Never replay
    // a failed query or write automatically; reconnect only for a later operation.
    if (error && typeof error === "object" && "closed" in error && error.closed)
      if (lookup(key)?.sessionId === value.sessionId)
        markConnectionUnavailable(key);
    throw error;
  }
}

export interface ConnectionRequest {
  workspaceId: string;
  sourceId: string;
  action:
    | "connect"
    | "new"
    | "edit"
    | "remove"
    | "attach"
    | "delete-profile"
    | "disconnect"
    | "refresh"
    | "reconnect";
  id: number;
}
let request: ConnectionRequest | undefined;
let requestId = 0;
export function requestConnection(
  workspaceId: string,
  sourceId: string,
  action: ConnectionRequest["action"] = "connect",
) {
  request = { workspaceId, sourceId, action, id: ++requestId };
  changed();
}
export function useConnectionRequest() {
  return useSyncExternalStore(subscribe, () => request);
}

export function consumeConnectionRequest(id: number) {
  if (request?.id === id) {
    request = undefined;
    changed();
  }
}

export function connectedProfileCount() {
  return new Set(
    [...sessions.values()]
      .filter((value) => value.connected !== false)
      .map((value) => value.profileId ?? value.sessionId),
  ).size;
}
