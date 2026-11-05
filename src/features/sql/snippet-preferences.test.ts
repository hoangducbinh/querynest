import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { storage } from "../../lib/storage/workspaces";
import { createWorkspace } from "../../test/fixtures";
import { effectiveAbbreviations } from "./snippets";
import {
  saveGlobalAbbreviations,
  ABBREVIATIONS_KEY,
} from "./snippet-preferences";

describe("abbreviation application scope", () => {
  it("inherits global defaults while respecting disabled and empty workspace overrides", () => {
    const global = {
      enabled: true,
      snippets: [{ id: "a", prefix: "sel", body: "SELECT", description: "" }],
    };
    expect(effectiveAbbreviations({}, global)).toEqual(global);
    expect(
      effectiveAbbreviations(
        { sqlSnippets: [], sqlAbbreviationsEnabled: false },
        global,
      ),
    ).toEqual({ enabled: false, snippets: [] });
  });
  it("persists global settings, preserves overrides by default and explicitly clears them on replacement", async () => {
    const workspace = createWorkspace();
    workspace.sqlSnippets = [];
    workspace.sqlAbbreviationsEnabled = true;
    await storage.workspaces.put(workspace);
    const global = { enabled: false, snippets: [] };
    await saveGlobalAbbreviations(global);
    expect(await storage.settings.get(ABBREVIATIONS_KEY)).toMatchObject(global);
    expect(
      (await storage.workspaces.get(workspace.id))?.sqlAbbreviationsEnabled,
    ).toBe(true);
    await saveGlobalAbbreviations(global, true);
    const saved = await storage.workspaces.get(workspace.id);
    expect(saved?.sqlAbbreviationsEnabled).toBeUndefined();
    expect(saved?.sqlSnippets).toBeUndefined();
    await storage.workspaces.delete(workspace.id);
  });
});
