import { validSqlLayout } from "../sql/panes";
import { sqlTabs } from "../sql/tabs";
import { parseRemoteConfig } from "../connections/model";
import { parseMssqlConfig } from "../connections/model";
import { parsePostgresConfig } from "../postgres/model";
import { validateSnippets } from "../sql/snippets";
import {
  type DatabaseSchema,
  type RelationshipDefinition,
  type WorkspaceDefinition,
  type WorkspaceSource,
} from "../../types/schema";
export const id = () => crypto.randomUUID();
export function validateRelationship(
  s: DatabaseSchema,
  r: RelationshipDefinition,
): string | undefined {
  const a = s.tables.find((t) => t.id === r.sourceTable),
    b = s.tables.find((t) => t.id === r.targetTable);
  if (!a || !b) return "Both tables must exist.";
  if (
    !r.sourceColumns.length ||
    r.sourceColumns.length !== r.targetColumns.length
  )
    return "Map the same number of columns in order.";
  if (
    new Set(r.sourceColumns).size !== r.sourceColumns.length ||
    new Set(r.targetColumns).size !== r.targetColumns.length
  )
    return "Columns cannot be repeated.";
  for (let i = 0; i < r.sourceColumns.length; i++) {
    const x = a.columns.find((c) => c.id === r.sourceColumns[i]),
      y = b.columns.find((c) => c.id === r.targetColumns[i]);
    if (!x || !y) return "Referenced columns must exist.";
    if (x.type !== y.type) return "Related columns must have matching types.";
  }
  if (
    r.kind === "physical" &&
    !(
      JSON.stringify(b.primaryKey) === JSON.stringify(r.targetColumns) ||
      (r.targetColumns.length === 1 &&
        b.columns.some((c) => c.id === r.targetColumns[0] && c.unique))
    )
  )
    return "Physical foreign keys must reference a primary or unique key in the same order.";
  if (r.kind === "physical" && r.sourceTable === r.targetTable)
    return "Use a logical relationship for self references in this MVP.";
  return undefined;
}
export function validateSchema(s: DatabaseSchema): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const entity of [
    ...s.tables,
    ...s.tables.flatMap((t) => t.columns),
    ...s.relationships,
  ]) {
    if (!entity.id || ids.has(entity.id))
      errors.push("Schema IDs must be nonempty and globally unique.");
    ids.add(entity.id);
  }
  for (const t of s.tables) {
    if (!t.name.trim() || names.has(t.name.toLowerCase()))
      errors.push("Table names must be nonempty and unique.");
    names.add(t.name.toLowerCase());
    const cols = new Set<string>();
    if (!t.columns.length) errors.push(`${t.name}: add at least one column.`);
    for (const c of t.columns) {
      if (!c.name.trim() || cols.has(c.name.toLowerCase()))
        errors.push(`${t.name}: column names must be nonempty and unique.`);
      cols.add(c.name.toLowerCase());
      if (!c.type.trim())
        errors.push(`${t.name}.${c.name}: data type must be specified.`);
    }
    if (t.primaryKey.some((k) => !t.columns.some((c) => c.id === k)))
      errors.push("Invalid primary key.");
  }
  for (const r of s.relationships) {
    const e = validateRelationship(s, r);
    if (e) errors.push(e);
  }
  return errors;
}
export function parseWorkspace(text: string): WorkspaceDefinition {
  const w = JSON.parse(text) as WorkspaceDefinition;
  if (
    !w ||
    w.version !== 1 ||
    typeof w.id !== "string" ||
    typeof w.name !== "string" ||
    !Array.isArray(w.schema?.tables) ||
    !Array.isArray(w.schema?.relationships) ||
    typeof w.sql !== "string" ||
    !w.data ||
    !Array.isArray(w.tests)
  )
    throw Error("Invalid workspace format.");
  if (
    w.schema.tables.some(
      (t) =>
        !t ||
        typeof t.id !== "string" ||
        typeof t.name !== "string" ||
        (t.readOnly !== undefined && typeof t.readOnly !== "boolean") ||
        (t.namespace !== undefined && typeof t.namespace !== "string") ||
        !Array.isArray(t.columns) ||
        !Array.isArray(t.primaryKey) ||
        !t.primaryKey.every((k) => typeof k === "string") ||
        !Number.isFinite(t.position?.x) ||
        !Number.isFinite(t.position?.y) ||
        t.columns.some(
          (c) =>
            !c ||
            typeof c.id !== "string" ||
            typeof c.name !== "string" ||
            (c.readOnly !== undefined && typeof c.readOnly !== "boolean") ||
            (c.generated !== undefined && typeof c.generated !== "boolean") ||
            (c.nativeType !== undefined && typeof c.nativeType !== "string") ||
            typeof c.nullable !== "boolean" ||
            typeof c.unique !== "boolean" ||
            typeof c.defaultValue !== "string",
        ),
    ) ||
    w.schema.relationships.some(
      (r) =>
        !r ||
        typeof r.id !== "string" ||
        typeof r.sourceTable !== "string" ||
        typeof r.targetTable !== "string" ||
        !Array.isArray(r.sourceColumns) ||
        !Array.isArray(r.targetColumns) ||
        !["physical", "logical"].includes(r.kind),
    ) ||
    w.tests.some(
      (t) =>
        !t ||
        typeof t.id !== "string" ||
        typeof t.name !== "string" ||
        typeof t.description !== "string" ||
        typeof t.sql !== "string" ||
        typeof t.expected !== "string" ||
        typeof t.ordered !== "boolean",
    ) ||
    Array.isArray(w.data) ||
    typeof w.data !== "object" ||
    Object.values(w.data).some(
      (rows) =>
        !Array.isArray(rows) ||
        rows.some(
          (row) => !row || typeof row !== "object" || Array.isArray(row),
        ),
    )
  )
    throw Error("Invalid workspace structure.");
  if (
    w.diagramPositions !== undefined &&
    (!w.diagramPositions ||
      typeof w.diagramPositions !== "object" ||
      Array.isArray(w.diagramPositions) ||
      Object.values(w.diagramPositions).some(
        (position) =>
          !position ||
          !Number.isFinite(position.x) ||
          !Number.isFinite(position.y),
      ))
  )
    throw Error("Invalid diagram positions.");
  if (w.sqlTabs !== undefined) {
    if (
      !Array.isArray(w.sqlTabs) ||
      !w.sqlTabs.length ||
      w.sqlTabs.some(
        (tab) =>
          !tab ||
          typeof tab.id !== "string" ||
          !tab.id ||
          typeof tab.name !== "string" ||
          !tab.name.trim() ||
          typeof tab.sql !== "string" ||
          (tab.disconnectedFrom !== undefined &&
            (!tab.disconnectedFrom ||
              typeof tab.disconnectedFrom.profileId !== "string" ||
              !tab.disconnectedFrom.profileId ||
              typeof tab.disconnectedFrom.database !== "string" ||
              !tab.disconnectedFrom.database ||
              tab.disconnectedFrom.database.includes("\0"))),
      ) ||
      new Set(w.sqlTabs.map((tab) => tab.id)).size !== w.sqlTabs.length
    )
      throw Error("Invalid SQL tabs.");
    if (
      w.activeSqlTabId !== undefined &&
      !w.sqlTabs.some((tab) => tab.id === w.activeSqlTabId)
    )
      throw Error("Invalid active SQL tab.");
  }
  if (w.sqlLayout !== undefined && !validSqlLayout(w.sqlLayout, sqlTabs(w)))
    throw Error("Invalid SQL split layout.");
  if (
    w.sqlAbbreviationsEnabled !== undefined &&
    typeof w.sqlAbbreviationsEnabled !== "boolean"
  )
    throw Error("Invalid SQL abbreviations mode.");
  if (w.sqlSnippets !== undefined) {
    const snippetErrors = validateSnippets(w.sqlSnippets);
    if (snippetErrors.length) throw Error(snippetErrors.join(" "));
  }
  if (w.postgres && w.mssql)
    throw Error("A workspace must use one database engine.");
  if (w.connectionId !== undefined && typeof w.connectionId !== "string")
    throw Error("Invalid connection reference.");
  if (w.mssql !== undefined) {
    w.mssql = parseMssqlConfig(w.mssql);
    w.data = {};
  }
  if (w.postgres !== undefined) {
    w.postgres = parsePostgresConfig(w.postgres);
    w.data = {};
  }
  if (w.sources !== undefined) {
    if (
      !Array.isArray(w.sources) ||
      !w.sources.length ||
      w.sources.length > 1000 ||
      new Set(w.sources.map((source) => source?.id)).size !== w.sources.length
    )
      throw Error("Invalid workspace connections.");
    w.sources = w.sources.map((source): WorkspaceSource => {
      if (
        !source ||
        typeof source.id !== "string" ||
        !source.id ||
        typeof source.name !== "string" ||
        !source.name.trim() ||
        (source.connectionId !== undefined &&
          typeof source.connectionId !== "string")
      )
        throw Error("Invalid workspace connection.");
      const connection =
        source.connection === undefined
          ? undefined
          : parseRemoteConfig(source.connection);
      const validated = parseWorkspace(
        JSON.stringify({
          ...w,
          sources: undefined,
          activeSourceId: undefined,
          schema: source.schema,
          data: connection ? {} : (source.data ?? {}),
          diagramPositions: source.diagramPositions,
          postgres:
            connection?.engine === "postgres" ? connection.config : undefined,
          mssql: connection?.engine === "mssql" ? connection.config : undefined,
          sqlTabs: w.sqlTabs?.map(({ sourceId: _sourceId, ...tab }) => {
            void _sourceId;
            return tab;
          }),
        }),
      );
      return {
        id: source.id,
        name: source.name,
        parentSourceId: source.parentSourceId,
        databases: source.databases,
        connectionId: source.connectionId,
        connection,
        schema: validated.schema,
        data: connection ? {} : validated.data,
        diagramPositions: validated.diagramPositions,
      };
    });
    if (w.sources.filter((s) => !s.parentSourceId).length > 50)
      throw Error("A workspace supports up to 50 connections.");
    for (const source of w.sources) {
      if (
        source.databases !== undefined &&
        (!Array.isArray(source.databases) ||
          source.databases.length > 10000 ||
          source.databases.some(
            (name) => typeof name !== "string" || !name || name.includes("\0"),
          ))
      )
        throw Error("Invalid database list.");
      if (source.parentSourceId !== undefined) {
        const root = w.sources.find(
          (s) => s.id === source.parentSourceId && !s.parentSourceId,
        );
        if (
          !root?.connection ||
          !source.connection ||
          root.id === source.id ||
          JSON.stringify({
            ...root.connection,
            config: { ...root.connection.config, database: "" },
          }) !==
            JSON.stringify({
              ...source.connection,
              config: { ...source.connection.config, database: "" },
            })
        )
          throw Error("Invalid database connection reference.");
      }
    }
    if (w.sources.filter((source) => !source.connection).length > 1)
      throw Error("A workspace supports one legacy unassigned source.");
    const active = w.sources.find((source) => source.id === w.activeSourceId);
    if (
      !active ||
      w.sqlTabs?.some(
        (tab) =>
          tab.sourceId !== undefined &&
          (typeof tab.sourceId !== "string" ||
            !w.sources!.some((source) => source.id === tab.sourceId)),
      )
    )
      throw Error("Invalid SQL tab connection reference.");
    w.schema = structuredClone(active.schema);
    w.data = active.connection ? {} : structuredClone(active.data ?? {});
    w.postgres =
      active.connection?.engine === "postgres"
        ? active.connection.config
        : undefined;
    w.mssql =
      active.connection?.engine === "mssql"
        ? active.connection.config
        : undefined;
    w.connectionId = active.connectionId;
    w.diagramPositions = active.diagramPositions;
  }
  const errors = w.postgres || w.mssql ? [] : validateSchema(w.schema);
  if (errors.length) throw Error(errors.join("\n"));
  return w;
}
export function createWorkspace(): WorkspaceDefinition {
  return {
    version: 1,
    id: id(),
    name: "Untitled workspace",
    schema: { tables: [], relationships: [] },
    sql: "",
    data: {},
    tests: [],
    updatedAt: Date.now(),
  };
}
