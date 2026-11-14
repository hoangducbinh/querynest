import { createValidationQueue } from "./validation-queue";
import { bindEditorWheelZoom } from "./editor-wheel-zoom";
import {
  useEditorZoom,
  zoomEditor,
  setEditorFontSize,
  DEFAULT_EDITOR_FONT_SIZE,
} from "./editor-zoom";
import { sqlEditorView, rememberSqlEditorView } from "./view-state";
import type { DatabaseSchema } from "../../types/schema";
import type { SqlDialect } from "./data-types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/comment/browser/comment";
import type { SqlDiagnostic } from "./diagnostics";
import { editingDiagnostics } from "./diagnostics";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { useStore } from "../schema/store";
import { sqlCompletions } from "./completions";
import { effectiveAbbreviations } from "./snippets";
import { useSnippetPreferences } from "./snippet-preferences";
const NO_SNIPPETS: import("../../types/schema").SqlSnippet[] = [];
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme("workspace-light", {
  base: "vs",
  inherit: true,
  rules: [{ token: "comment", foreground: "626A74" }],
  colors: {
    "editor.background": "#F2F3F6",
    "editor.lineHighlightBackground": "#E8EBF0",
    "editorLineNumber.foreground": "#686D78",
  },
});
monaco.editor.defineTheme("workspace-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [{ token: "comment", foreground: "A4B69B" }],
  colors: {
    "editor.background": "#2A2E36",
    "editor.foreground": "#EEF0F5",
    "editor.lineHighlightBackground": "#343A45",
    "editorLineNumber.foreground": "#A7AFBE",
    "editorLineNumber.activeForeground": "#EEF0F5",
  },
});
const kinds = {
  table: monaco.languages.CompletionItemKind.Class,
  column: monaco.languages.CompletionItemKind.Field,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  function: monaco.languages.CompletionItemKind.Function,
  snippet: monaco.languages.CompletionItemKind.Snippet,
  type: monaco.languages.CompletionItemKind.TypeParameter,
};
export function SqlEditor({
  viewKey,
  value,
  autoFocus = false,
  readOnly = false,
  schema: suppliedSchema,
  dialect: suppliedDialect,
  onChange,
  dark = false,
  validationEnabled = true,
  onValidation,
  onSelection,
  validate,
  validationSource = "Database",
}: {
  value: string;
  viewKey?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  schema?: DatabaseSchema;
  dialect?: SqlDialect;
  dark?: boolean;
  validationEnabled?: boolean;
  validate?: (sql: string) => Promise<SqlDiagnostic[]>;
  validationSource?: string;
  onSelection?: (sql: string) => void;
  onValidation?: (status: string) => void;
  onChange: (sql: string) => void;
}) {
  const fontSize = useEditorZoom((state) => state.fontSize);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [editorInstance, setEditorInstance] =
    useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const storedSchema = useStore((s) => s.workspace.schema);
  const storedDialect = useStore((s) =>
    s.workspace.mssql
      ? ("mssql" as const)
      : s.workspace.postgres
        ? ("postgres" as const)
        : ("default" as const),
  );
  const schema = suppliedSchema ?? storedSchema;
  const dialect = suppliedDialect ?? storedDialect;
  const workspaceSnippets = useStore((s) => s.workspace.sqlSnippets);
  const workspaceEnabled = useStore((s) => s.workspace.sqlAbbreviationsEnabled);
  const globalSnippets = useSnippetPreferences((s) => s.settings);
  const abbreviationSettings = effectiveAbbreviations(
    {
      sqlSnippets: workspaceSnippets,
      sqlAbbreviationsEnabled: workspaceEnabled,
    },
    globalSnippets,
  );
  const snippets = abbreviationSettings.enabled
    ? abbreviationSettings.snippets
    : NO_SNIPPETS;
  const selectionCallback = useRef(onSelection);
  selectionCallback.current = onSelection;
  const context = useRef({ schema, snippets, dialect });
  context.current = { schema, snippets, dialect };
  const provider = useRef<monaco.IDisposable | null>(null);
  const validator = useRef(validate);
  validator.current = validate;
  const validationQueue = useRef(createValidationQueue());
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
    let cancelCheck: (() => void) | undefined;
    let diagnosticTimer: number | undefined;
    const markers = (items: SqlDiagnostic[], source: string) =>
      items.map((item) => {
        const length = model.getValueLength();
        const offset = Math.max(0, Math.min(length, item.start));
        const start = model.getPositionAt(offset);
        const end = model.getPositionAt(
          Math.max(offset, Math.min(length, item.end)),
        );
        return {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: Math.max(
            start.lineNumber === end.lineNumber ? start.column + 1 : 1,
            end.column,
          ),
          message: item.message,
          source,
          severity: item.warning
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Error,
        };
      });
    const check = () => {
      cancelCheck?.();
      if (model.isDisposed()) return;
      // Read text and version together from Monaco, rather than a potentially stale React value.
      const sql = model.getValue();
      const version = model.getVersionId();
      const local = validationEnabled ? editingDiagnostics(sql, dialect) : [];
      monaco.editor.setModelMarkers(
        model,
        "sql-editing",
        markers(local, "SQL"),
      );
      monaco.editor.setModelMarkers(model, "sql-validation", []);
      const validateSql = validator.current;
      onValidation?.(
        local.length
          ? `${local.length} SQL issue${local.length === 1 ? "" : "s"}`
          : "",
      );
      if (!validationEnabled || !sql.trim() || local.length || !validateSql)
        return;
      cancelCheck = validationQueue.current(
        () => validateSql(sql),
        (diagnostics) => {
          if (model.isDisposed() || model.getVersionId() !== version) return;
          monaco.editor.setModelMarkers(
            model,
            "sql-validation",
            markers(diagnostics, validationSource),
          );
          onValidation?.(
            diagnostics.length
              ? `${diagnostics.length} SQL issue${diagnostics.length === 1 ? "" : "s"}`
              : "",
          );
        },
        () => {
          if (!model.isDisposed() && model.getVersionId() === version)
            onValidation?.("");
        },
      );
    };
    check();
    const changes = model.onDidChangeContent(() => {
      cancelCheck?.();
      window.clearTimeout(diagnosticTimer);
      diagnosticTimer = window.setTimeout(check, 250);
    });
    return () => {
      changes.dispose();
      window.clearTimeout(diagnosticTimer);
      cancelCheck?.();
      if (!model.isDisposed()) {
        monaco.editor.setModelMarkers(model, "sql-validation", []);
        monaco.editor.setModelMarkers(model, "sql-editing", []);
      }
    };
  }, [
    schema,
    dialect,
    validationEnabled,
    editorInstance,
    onValidation,
    !!validate,
    validationSource,
    viewKey,
  ]);
  const currentViewKeyRef = useRef(viewKey);
  currentViewKeyRef.current = viewKey;

  useEffect(() => {
    if (autoFocus && editorInstance) {
      editorInstance.focus();
    }
  }, [viewKey, autoFocus, editorInstance]);

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const options = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      contextmenu: false,
      readOnly,
      domReadOnly: readOnly,
      renderValidationDecorations: "on",
      hover: { enabled: "on" },
      minimap: { enabled: false },
      fontSize,
      cursorBlinking: reduceMotion ? "solid" : "smooth",
      cursorSmoothCaretAnimation: reduceMotion ? "off" : "explicit",
      mouseWheelZoom: false,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      scrollBeyondLastColumn: 0,
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
    }),
    [fontSize, readOnly, reduceMotion],
  );

  return (
    <Editor
      path={viewKey ? `/sql/${encodeURIComponent(viewKey)}.sql` : "/sql/default.sql"}
      saveViewState
      height="100%"
      language="sql"
      theme={dark ? "workspace-dark" : "workspace-light"}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={(editor) => {
        setEditorInstance(editor);
        const zoomKeys = editor.onKeyDown((event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const key = event.browserEvent.key;
          if (!["+", "=", "-", "0"].includes(key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (key === "0") setEditorFontSize(DEFAULT_EDITOR_FONT_SIZE);
          else zoomEditor(key === "-" ? -1 : 1);
        });
        const node = editor.getDomNode();
        const unbindWheelZoom = node ? bindEditorWheelZoom(node) : undefined;
        let viewSaveTimer = 0;
        editor.onDidDispose(() => {
          if (viewSaveTimer) window.clearTimeout(viewSaveTimer);
          zoomKeys.dispose();
          unbindWheelZoom?.();
        });
        const saved = viewKey ? sqlEditorView(viewKey) : undefined;
        if (saved) editor.restoreViewState(saved);
        if (autoFocus) editor.focus();
        const saveView = () => {
          const key = currentViewKeyRef.current;
          if (alive.current && key && !editor.getModel()?.isDisposed())
            rememberSqlEditorView(key, editor.saveViewState());
        };
        const scheduleSaveView = () => {
          const model = editor.getModel();
          if (viewSaveTimer) window.clearTimeout(viewSaveTimer);
          viewSaveTimer = window.setTimeout(() => {
            viewSaveTimer = 0;
            if (editor.getModel() === model) saveView();
          }, 180);
        };
        const publishSelection = () => {
          if (!alive.current) return;
          const selection = editor.getSelection();
          selectionCallback.current?.(
            selection && !selection.isEmpty()
              ? (editor.getModel()?.getValueInRange(selection) ?? "")
              : "",
          );
          scheduleSaveView();
        };
        publishSelection();
        editor.onDidChangeCursorSelection(publishSelection);
        editor.onDidScrollChange(scheduleSaveView);
        editor.onDidBlurEditorWidget(saveView);
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
                      ? {
                        value:
                          "**SQL abbreviation** · Tab or Enter to insert\n\n```sql\n" +
                          item.insertText +
                          "\n```\n\nTab: next field · Shift+Tab: previous field",
                      }
                      : item.detail,
                })),
              };
            },
          },
        );
      }}
      options={options}
    />
  );
}
