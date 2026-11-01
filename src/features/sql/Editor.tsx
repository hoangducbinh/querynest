import { useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/comment/browser/comment";
import { withSqlValidator } from "../../lib/duckdb/engine";
import type { SqlDiagnostic } from "./diagnostics";
import { validateSql } from "./diagnostics";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { useStore } from "../schema/store";
import { sqlCompletions } from "./completions";
import { DEFAULT_SNIPPETS } from "./snippets";
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
const kinds = {
  table: monaco.languages.CompletionItemKind.Class,
  column: monaco.languages.CompletionItemKind.Field,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  function: monaco.languages.CompletionItemKind.Function,
  snippet: monaco.languages.CompletionItemKind.Snippet,
  type: monaco.languages.CompletionItemKind.TypeParameter,
};
export function SqlEditor({
  value,
  onChange,
  dark = false,
  validationEnabled = true,
  onValidation,
  onSelection,
  validate,
  validationSource = "DuckDB",
}: {
  value: string;
  dark?: boolean;
  validationEnabled?: boolean;
  validate?: (sql: string) => Promise<SqlDiagnostic[]>;
  validationSource?: string;
  onSelection?: (sql: string) => void;
  onValidation?: (status: string) => void;
  onChange: (sql: string) => void;
}) {
  const [editorInstance, setEditorInstance] =
    useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const schema = useStore((s) => s.workspace.schema);
  const dialect = useStore((s) =>
    s.workspace.mssql
      ? ("mssql" as const)
      : s.workspace.postgres
        ? ("postgres" as const)
        : ("default" as const),
  );
  const snippets = useStore((s) => s.workspace.sqlSnippets ?? DEFAULT_SNIPPETS);
  const selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  const context = useRef({ schema, snippets, dialect });
  context.current = { schema, snippets, dialect };
  const provider = useRef<monaco.IDisposable | null>(null);
  useEffect(
    () => () => {
      provider.current?.dispose();
      provider.current = null;
    },
    [],
  );
  useEffect(() => {
    const model = editorInstance?.getModel();
    if (!model) return;
    let cancelled = false;
    const version = model.getVersionId();
    monaco.editor.setModelMarkers(model, "sql-validation", []);
    onValidation?.(validationEnabled ? (value.trim() ? "Checking…" : "") : "");
    const timer = setTimeout(async () => {
      if (!validationEnabled || !value.trim()) return;
      try {
        const diagnostics = validate
          ? await validate(value)
          : await withSqlValidator((prepare) => validateSql(value, prepare));
        if (cancelled || model.isDisposed() || model.getVersionId() !== version)
          return;
        monaco.editor.setModelMarkers(
          model,
          "sql-validation",
          diagnostics.map((item) => {
            const start = model.getPositionAt(
              Math.min(value.length, item.start),
            );
            const end = model.getPositionAt(Math.min(value.length, item.end));
            return {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: Math.max(
                start.lineNumber === end.lineNumber ? start.column + 1 : 1,
                end.column,
              ),
              message: item.message,
              source: validationSource,
              severity: item.warning
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Error,
            };
          }),
        );
        onValidation?.(
          diagnostics.length
            ? `${diagnostics.length} SQL issue${diagnostics.length === 1 ? "" : "s"}`
            : "",
        );
      } catch {
        if (!cancelled) onValidation?.("Validation unavailable");
      }
    }, 650);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (!model.isDisposed())
        monaco.editor.setModelMarkers(model, "sql-validation", []);
    };
  }, [
    value,
    schema,
    validationEnabled,
    editorInstance,
    onValidation,
    validate,
    validationSource,
  ]);
  return (
    <Editor
      height="100%"
      language="sql"
      theme={dark ? "vs-dark" : "light"}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={(editor) => {
        setEditorInstance(editor);
        selectionCallback.current?.("");
        editor.onDidChangeCursorSelection(() => {
          const selection = editor.getSelection();
          selectionCallback.current?.(
            selection && !selection.isEmpty()
              ? (editor.getModel()?.getValueInRange(selection) ?? "")
              : "",
          );
        });
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash,
          () => void editor.getAction("editor.action.blockComment")?.run(),
          "editorTextFocus && !editorReadonly",
        );
        editor.addCommand(
          monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyA,
          () => void editor.getAction("editor.action.commentLine")?.run(),
          "editorTextFocus && !editorReadonly",
        );
        provider.current?.dispose();
        provider.current = monaco.languages.registerCompletionItemProvider(
          "sql",
          {
            triggerCharacters: [".", " ", '"', "["],
            provideCompletionItems(model, position) {
              if (model !== editor.getModel()) return { suggestions: [] };
              const result = sqlCompletions(
                model.getValue(),
                model.getOffsetAt(position),
                context.current.schema,
                context.current.snippets,
                context.current.dialect,
              );
              const start = model.getPositionAt(result.start),
                end = model.getPositionAt(result.end);
              const range = new monaco.Range(
                start.lineNumber,
                start.column,
                end.lineNumber,
                end.column,
              );
              return {
                suggestions: result.suggestions.map((item) => ({
                  label: { label: item.label, description: item.description },
                  detail: item.detail,
                  kind: kinds[item.kind],
                  insertText: item.insertText,
                  insertTextRules: item.snippet
                    ? monaco.languages.CompletionItemInsertTextRule
                        .InsertAsSnippet
                    : monaco.languages.CompletionItemInsertTextRule.None,
                  range,
                  sortText: item.sortText,
                  filterText: item.label,
                  documentation:
                    item.kind === "snippet"
                      ? { value: "```sql\n" + item.insertText + "\n```" }
                      : item.detail,
                })),
              };
            },
          },
        );
      }}
      options={{
        renderValidationDecorations: "on",
        hover: { enabled: "on" },
        minimap: { enabled: false },
        fontSize: 14,
        padding: { top: 12, bottom: 12 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: "off",
        editContext: false,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        tabCompletion: "on",
        snippetSuggestions: "top",
        acceptSuggestionOnEnter: "on",
        wordBasedSuggestions: "off",
        suggest: { showWords: false, preview: true },
      }}
    />
  );
}
