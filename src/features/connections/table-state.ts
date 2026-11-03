import type { PgQueryResult } from "../postgres/client";

type Page = { signature: string; result: PgQueryResult };
type State = {
  page: number;
  generation: number;
  signature?: string;
  pages: Map<number, Page>;
  pending: Map<number, Promise<PgQueryResult>>;
};
const scopes = new Map<string, Map<string, State>>();
export function tableState(scope: string, table: string): State {
  let tables = scopes.get(scope);
  if (!tables) {
    tables = new Map();
    scopes.set(scope, tables);
  }
  let state = tables.get(table);
  if (!state) {
    state = { page: 0, generation: 0, pages: new Map(), pending: new Map() };
    tables.set(table, state);
  }
  return state;
}
export function cachedTablePage(
  scope: string,
  table: string,
  page: number,
  signature: string,
) {
  const entry = tableState(scope, table).pages.get(page);
  return entry?.signature === signature ? entry.result : undefined;
}
export function invalidateTable(scope: string, table: string) {
  const state = tableState(scope, table);
  state.generation++;
  state.pages.clear();
  state.pending.clear();
}
export function loadTablePage(
  scope: string,
  table: string,
  page: number,
  signature: string,
  load: () => Promise<PgQueryResult>,
) {
  const state = tableState(scope, table);
  if (state.signature !== undefined && state.signature !== signature)
    invalidateTable(scope, table);
  state.signature = signature;
  const cached = cachedTablePage(scope, table, page, signature);
  if (cached) return Promise.resolve(cached);
  const pending = state.pending.get(page);
  if (pending) return pending;
  const generation = state.generation;
  const request = Promise.resolve()
    .then(load)
    .then((result) => {
      if (state.generation === generation)
        state.pages.set(page, { signature, result });
      return result;
    })
    .finally(() => {
      if (state.pending.get(page) === request) state.pending.delete(page);
    });
  state.pending.set(page, request);
  return request;
}
export function releaseTableSession(sessionId: string) {
  for (const key of scopes.keys())
    if (key.startsWith(sessionId + ":")) scopes.delete(key);
}
