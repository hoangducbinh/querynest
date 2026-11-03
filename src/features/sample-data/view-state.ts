// Runtime only; never persisted with credentials or exported database data.
type View = { top: number; left: number; page: number; filter: string };
const positions = new Map<string, View>();
export const gridPosition = (key: string): View =>
  positions.get(key) ?? { top: 0, left: 0, page: 0, filter: "" };
export const rememberGridPosition = (
  key: string,
  top: number,
  left: number,
) => {
  positions.set(key, { ...gridPosition(key), top, left });
};
export const rememberGridView = (key: string, page: number, filter: string) => {
  positions.set(key, { ...gridPosition(key), page, filter });
};
export function releaseGridSession(sessionId: string) {
  for (const key of positions.keys())
    if (key.startsWith(sessionId + ":")) positions.delete(key);
}
