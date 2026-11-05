import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { parseWorkspace } from "../schema/core";
import { createWorkspace } from "../../test/fixtures";
import { DEFAULT_SNIPPETS, validateSnippets } from "./snippets";
import { saveWorkspace, storage } from "../../lib/storage/workspaces";
describe("workspace SQL abbreviations", () => {
  it("accepts defaults, custom tab stops and an intentionally empty set", () => {
    expect(validateSnippets(DEFAULT_SNIPPETS)).toEqual([]);
    expect(validateSnippets([])).toEqual([]);
    expect(
      validateSnippets([
        {
          id: "x",
          prefix: "mine",
          description: "Custom",
          body: "SELECT ${1:column} FROM ${2:table};",
        },
      ]),
    ).toEqual([]);
  });
  it("rejects duplicate prefixes regardless of case, duplicate IDs and invalid shapes", () => {
    expect(
      validateSnippets([
        { ...DEFAULT_SNIPPETS[0], prefix: "SEL" },
        DEFAULT_SNIPPETS[0],
      ]).join(" "),
    ).toMatch(/already used/);
    for (const value of [
      null,
      {},
      [null],
      [{ id: "x", prefix: "bad prefix", body: "", description: "" }],
    ])
      expect(validateSnippets(value).length).toBeGreaterThan(0);
  });
  it("roundtrips configured abbreviations in IndexedDB and workspace JSON", async () => {
    const w = createWorkspace();
    w.sqlSnippets = [
      {
        id: "x",
        prefix: "cust",
        description: "Customers",
        body: "SELECT ${1:*} FROM customers;",
      },
    ];
    await saveWorkspace(w);
    expect((await storage.workspaces.get(w.id))?.sqlSnippets).toEqual(
      w.sqlSnippets,
    );
    expect(parseWorkspace(JSON.stringify(w)).sqlSnippets).toEqual(
      w.sqlSnippets,
    );
    await storage.workspaces.delete(w.id);
  });
  it("imports older workspaces and rejects malformed abbreviation data", () => {
    const w = createWorkspace();
    expect(parseWorkspace(JSON.stringify(w)).sqlSnippets).toBeUndefined();
    expect(() =>
      parseWorkspace(
        JSON.stringify({
          ...w,
          sqlSnippets: [
            {
              id: "x",
              prefix: "invalid prefix",
              body: "SELECT 1",
              description: "",
            },
          ],
        }),
      ),
    ).toThrow(/prefix/);
    expect(
      parseWorkspace(JSON.stringify({ ...w, sqlSnippets: [] })).sqlSnippets,
    ).toEqual([]);
  });
});
