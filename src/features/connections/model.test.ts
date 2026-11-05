import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { defaultMssqlConfig, parseMssqlConfig, parseProfile } from "./model";
import { parseWorkspace } from "../schema/core";
import { createWorkspace } from "../../test/fixtures";
import { storage, saveConnection } from "../../lib/storage/workspaces";
import { sqlCompletions } from "../sql/completions";
import { catalogSchema } from "../postgres/model";
describe("SQL Server connection settings", () => {
  beforeEach(async () => {
    await storage.connections.clear();
  });
  it("whitelists settings, removes credentials and remote row snapshots on import", () => {
    const workspace = parseWorkspace(
      JSON.stringify({
        ...createWorkspace(false),
        mssql: {
          ...defaultMssqlConfig,
          password: "private",
          sessionId: "temporary",
        },
        data: { remote: [{ secret: 1 }] },
      }),
    );
    expect(workspace.mssql).toEqual(defaultMssqlConfig);
    expect(workspace.data).toEqual({});
    expect(JSON.stringify(workspace)).not.toContain("private");
    expect(() =>
      parseMssqlConfig({ ...defaultMssqlConfig, port: 0 }),
    ).toThrow();
    expect(() =>
      parseMssqlConfig({ ...defaultMssqlConfig, encrypt: "true" }),
    ).toThrow();
    expect(() =>
      parseWorkspace(JSON.stringify({ ...workspace, postgres: {} })),
    ).toThrow();
  });
  it("keeps Windows authentication profiles free of login credentials", () => {
    expect(
      parseMssqlConfig({
        ...defaultMssqlConfig,
        auth: "windows",
        user: "ignored",
        password: "never-save",
      }),
    ).toEqual({ ...defaultMssqlConfig, auth: "windows", user: "" });
    expect(() =>
      parseMssqlConfig({ ...defaultMssqlConfig, auth: "invalid" }),
    ).toThrow();
  });
  it("saves, updates and removes reusable profiles without credentials", async () => {
    const profile = { ...defaultMssqlConfig, password: "secret" };
    await saveConnection({
      id: "server",
      name: "Windows dev",
      engine: "mssql",
      config: profile,
      updatedAt: 1,
    });
    const saved = await storage.connections.get("server");
    expect(saved?.config).toEqual(defaultMssqlConfig);
    expect(JSON.stringify(saved)).not.toContain("secret");
    await saveConnection({ ...saved!, name: "Renamed", updatedAt: 2 });
    expect(await storage.connections.count()).toBe(1);
    expect((await storage.connections.get("server"))?.name).toBe("Renamed");
    await storage.connections.delete("server");
    expect(await storage.connections.count()).toBe(0);
    expect(() =>
      parseProfile({ ...saved!, engine: "other" } as never),
    ).toThrow();
  });
  it("uses bracket quoting and T-SQL keywords for SQL Server completion", () => {
    const schema = catalogSchema({
      tables: [
        {
          id: "1",
          schema: "dbo",
          name: "Customers",
          kind: "U",
          columns: [
            {
              id: "c",
              name: "Display Name",
              type: "nvarchar(100)",
              nullable: true,
              primaryKey: false,
            },
          ],
        },
      ],
      relationships: [],
    });
    const suggestions = sqlCompletions(
      "SELECT * FROM ",
      14,
      schema,
      [],
      "mssql",
    ).suggestions;
    expect(suggestions[0].insertText).toBe("Customers");
    const text = "SELECT c. FROM [dbo].[Customers] c";
    expect(
      sqlCompletions(text, 9, schema, [], "mssql").suggestions[0].insertText,
    ).toBe("[Display Name]");
    const keywords = sqlCompletions("", 0, schema, [], "mssql").suggestions;
    expect(keywords.some((s) => s.label === "TOP")).toBe(true);
    expect(keywords.some((s) => s.label === "LIMIT")).toBe(false);
  });
});
