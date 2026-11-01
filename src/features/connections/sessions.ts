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
  forgetSession(workspaceId);
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
  if (revoked.has(workspaceId)) {
    void value.disconnect(value.sessionId).catch(() => {});
    return;
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
