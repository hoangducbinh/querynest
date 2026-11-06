import "fake-indexeddb/auto";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { SqlWorkspace } from "./SqlWorkspace";

const editor = vi.hoisted(() =>
  vi.fn((_props: Record<string, unknown>) => null),
);
vi.mock("./LazySqlEditor", () => ({ SqlEditor: editor }));
vi.mock("./QueryTabs", () => ({
  QueryTabs: () => null,
  openSqlFilesIntoTabs: vi.fn(),
}));
vi.mock("./QueryResults", () => ({ QueryResults: () => null }));
vi.mock("./view-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./view-state")>();
  return {
    ...actual,
    useSqlTabView: (key: string) => [actual.sqlTabView(key), vi.fn()],
  };
});

it.each(["postgres", "mssql"] as const)(
  "enables pre-run validation for a real %s connection",
  (dialect) => {
    const validate = vi.fn(async () => []);
    const props: ComponentProps<typeof SqlWorkspace> = {
      tabs: [
        {
          id: "query",
          name: "query.sql",
          sql: "SELECT missing FROM customers",
        },
      ],
      activeId: "query",
      onTabsChange: vi.fn(),
      onLayoutChange: vi.fn(),
      onChange: vi.fn(),
      onRun: vi.fn(),
      onSelection: vi.fn(),
      value: "SELECT missing FROM customers",
      disabled: false,
      busy: false,
      dark: false,
      validateTab: validate,
      tabContext: {
        sourceId: "remote",
        schema: { tables: [], relationships: [] },
        dialect,
        label: "QA database",
        remote: true,
      },
    };
    editor.mockClear();
    renderToStaticMarkup(<SqlWorkspace {...props} />);
    const editorProps = editor.mock.calls.at(-1)?.[0] as unknown as {
      validationEnabled: boolean;
      validate: (sql: string) => Promise<unknown>;
    };
    expect(editorProps.validationEnabled).toBe(true);
    editorProps.validate("SELECT broken");
    expect(validate).toHaveBeenCalledWith("query", "SELECT broken");
    editor.mockClear();
    renderToStaticMarkup(<SqlWorkspace {...props} busy />);
    expect(
      (
        editor.mock.calls.at(-1)?.[0] as unknown as {
          validationEnabled: boolean;
        }
      ).validationEnabled,
    ).toBe(false);
  },
);

it("shows Stop only in the running split pane, even when the other pane is active", () => {
  const tabs = [
    { id: "left", name: "left.sql", sql: "SELECT 1" },
    { id: "right", name: "right.sql", sql: "SELECT 2" },
  ];
  const html = renderToStaticMarkup(
    <SqlWorkspace
      tabs={tabs}
      activeId="right"
      value="SELECT 2"
      layout={{
        groups: [
          { ids: ["left"], activeId: "left" },
          { ids: ["right"], activeId: "right" },
        ],
        width: 50,
      }}
      onTabsChange={vi.fn()}
      onLayoutChange={vi.fn()}
      onChange={vi.fn()}
      onRun={vi.fn()}
      onSelection={vi.fn()}
      dark={false}
      busy
      disabled
      runningTabId="left"
      onCancel={vi.fn()}
    />,
  );
  expect(html.match(/aria-label="Stop query"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Run SQL"/g)).toHaveLength(1);
  const leftPane = html.slice(
    html.indexOf('aria-label="SQL pane 1"'),
    html.indexOf('aria-label="SQL pane 2"'),
  );
  const rightPane = html.slice(html.indexOf('aria-label="SQL pane 2"'));
  expect(leftPane).toContain('data-action="stop"');
  expect(rightPane).toContain('data-action="run"');
});
