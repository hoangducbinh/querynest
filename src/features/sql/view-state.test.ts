import { afterEach, expect, it } from "vitest";
import {
  sqlTabView,
  updateSqlTabView,
  sqlEditorView,
  rememberSqlEditorView,
  releaseSqlTabView,
} from "./view-state";
import type { editor } from "monaco-editor/editor/editor.api";
afterEach(() => {
  releaseSqlTabView("workspace:a");
  releaseSqlTabView("workspace:b");
});
it("retains each query tab's selected result and panel layout across view recreation", () => {
  updateSqlTabView("workspace:a", {
    selection: "SELECT 1",
    resultIndex: 2,
    ratio: 0.45,
    resultsVisible: false,
    resultsMode: "tabs",
    expandedResults: [0, 1],
  });
  updateSqlTabView("workspace:b", { resultIndex: 1 });
  expect(sqlTabView("workspace:a")).toEqual({
    selection: "SELECT 1",
    resultIndex: 2,
    ratio: 0.45,
    resultsVisible: false,
    resultsMode: "tabs",
    expandedResults: [0, 1],
  });
  expect(sqlTabView("workspace:b").selection).toBe("");
  updateSqlTabView("workspace:a", { resultsVisible: true });
  expect(sqlTabView("workspace:a").resultIndex).toBe(2);
});
it("retains Monaco's complete view state independently and clears it when released", () => {
  const view: editor.ICodeEditorViewState = {
    cursorState: [],
    viewState: {
      scrollLeft: 120,
      firstPosition: { lineNumber: 80, column: 1 },
      firstPositionDeltaTop: 3,
    },
    contributionsState: {},
  };
  rememberSqlEditorView("workspace:a", view);
  expect(sqlEditorView("workspace:a")).toBe(view);
  expect(sqlEditorView("workspace:b")).toBeUndefined();
  rememberSqlEditorView("workspace:a", null);
  expect(sqlEditorView("workspace:a")).toBe(view);
  releaseSqlTabView("workspace:a");
  expect(sqlEditorView("workspace:a")).toBeUndefined();
  expect(sqlTabView("workspace:a").resultIndex).toBe(0);
});
