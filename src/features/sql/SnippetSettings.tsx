import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Code2, Copy, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import { useStore } from "../schema/store";
import {
  saveGlobalAbbreviations,
  useSnippetPreferences,
} from "./snippet-preferences";
import { DEFAULT_SNIPPETS, validateSnippets } from "./snippets";
export function SnippetSettings({ onClose }: { onClose: () => void }) {
  const { workspace, edit } = useStore();
  const { settings: global, loading } = useSnippetPreferences();
  const [scope, setScope] = useState<"workspace" | "global">("workspace");
  const initial = () => ({
    snippets: structuredClone(workspace.sqlSnippets ?? global.snippets),
    enabled: workspace.sqlAbbreviationsEnabled ?? global.enabled,
    inherit:
      workspace.sqlSnippets === undefined &&
      workspace.sqlAbbreviationsEnabled === undefined,
  });
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial()));
  const { snippets, enabled, inherit } = draft;
  const setSnippets = (
    value: typeof snippets | ((items: typeof snippets) => typeof snippets),
  ) =>
    setDraft((d) => ({
      ...d,
      snippets: typeof value === "function" ? value(d.snippets) : value,
    }));
  const [selected, setSelected] = useState(snippets[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = snippets.find((snippet) => snippet.id === selected);
  const errors = validateSnippets(snippets);
  const filtered = snippets.filter((item) =>
    `${item.prefix} ${item.description} ${item.body}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const prefixError =
    current &&
    (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(current.prefix)
      ? "Start with a letter or underscore. Use letters, numbers and underscores only."
      : snippets.some(
            (item) =>
              item.id !== current.id &&
              item.prefix.toLowerCase() === current.prefix.toLowerCase(),
          )
        ? "This prefix is already used. Choose a unique prefix."
        : "");
  const bodyError =
    current && !current.body.trim() ? "Enter the SQL to insert." : "";
  const dirty = JSON.stringify(draft) !== baseline || replace;
  const inherited = scope === "workspace" && inherit;
  const readOnly = inherited || busy || loading;
  async function changeScope(next: typeof scope) {
    if (
      dirty &&
      !(await confirmAction("Discard unapplied abbreviation changes?"))
    )
      return;
    const value =
      next === "global"
        ? { ...structuredClone(global), inherit: false }
        : initial();
    setSearch("");
    setScope(next);
    setDraft(value);
    setBaseline(JSON.stringify(value));
    setSelected(value.snippets[0]?.id ?? "");
    setReplace(false);
    setMessage("");
  }
  async function close() {
    if (busy) return;
    if (dirty && !(await confirmAction("Discard unsaved SQL abbreviations?")))
      return;
    onClose();
  }
  function add() {
    setSearch("");
    const id = crypto.randomUUID();
    setMessage("");
    setSnippets((items) => [
      ...items,
      { id, prefix: "", description: "", body: "" },
    ]);
    setSelected(id);
    requestAnimationFrame(() =>
      document.getElementById("snippet-prefix")?.focus(),
    );
  }
  async function save() {
    if (busy || loading || (!inherited && errors.length)) return;
    if (
      scope === "global" &&
      replace &&
      !(await confirmAction(
        "Replace abbreviation overrides in every workspace with these global settings?",
      ))
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      if (scope === "global")
        await saveGlobalAbbreviations({ enabled, snippets }, replace);
      if (scope === "workspace" || replace)
        edit((w) => {
          if (inherited || (scope === "global" && replace)) {
            delete w.sqlSnippets;
            delete w.sqlAbbreviationsEnabled;
          } else {
            w.sqlSnippets = structuredClone(snippets);
            w.sqlAbbreviationsEnabled = enabled;
          }
        });
      setBaseline(JSON.stringify(draft));
      setReplace(false);
      setMessage("Applied");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="snippet-settings"
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "s"
            ) {
              event.preventDefault();
              event.stopPropagation();
              save();
            }
          }}
        >
          <div className="table-editor-title">
            <Dialog.Title>SQL abbreviations</Dialog.Title>
            <Button title="Close abbreviations" onClick={() => void close()}>
              <X size={15} />
            </Button>
          </div>
          <Dialog.Description className="snippet-help">
            Type a prefix and choose its suggestion, then Tab or Enter to
            insert. Use <code>{"${1:column}"}</code> for a tab stop.
          </Dialog.Description>
          <div className="snippet-preferences">
            <label>
              Apply to
              <select
                aria-label="Abbreviation scope"
                value={scope}
                disabled={busy || loading}
                onChange={(e) =>
                  void changeScope(e.target.value as typeof scope)
                }
              >
                <option value="workspace">This workspace</option>
                <option value="global">All workspaces · global defaults</option>
              </select>
            </label>
            {scope === "workspace" ? (
              <label className="row">
                <input
                  type="checkbox"
                  checked={inherit}
                  disabled={busy || loading}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      inherit: e.target.checked,
                      ...(e.target.checked ? structuredClone(global) : {}),
                    }))
                  }
                />
                Use global defaults
              </label>
            ) : (
              <label className="row">
                <input
                  type="checkbox"
                  checked={replace}
                  disabled={busy || loading}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                Replace workspace overrides too
              </label>
            )}
            <label className="row">
              <input
                type="checkbox"
                checked={enabled}
                disabled={inherited || busy || loading}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, enabled: e.target.checked }))
                }
              />
              Enable abbreviations
            </label>
          </div>
          <div className="snippet-library-toolbar">
            <label className="snippet-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="Search abbreviations"
                placeholder="Search prefix, description or SQL…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <span>
              {filtered.length} / {snippets.length}
            </span>
            <Button disabled={readOnly} onClick={add}>
              <Plus size={14} />
              New abbreviation
            </Button>
          </div>
          {inherited && (
            <div className="snippet-inherited-note">
              Viewing global defaults. Turn off “Use global defaults” to edit
              this workspace.
            </div>
          )}
          <div className="snippet-editing">
            <div className="snippet-settings-body">
              <aside className="snippet-list">
                {filtered.map((snippet) => (
                  <button
                    className={selected === snippet.id ? "active" : ""}
                    key={snippet.id}
                    aria-pressed={selected === snippet.id}
                    disabled={busy || loading}
                    onClick={() => setSelected(snippet.id)}
                  >
                    <Code2 size={13} />
                    <span className="snippet-list-label">
                      <strong>{snippet.prefix || "Untitled"}</strong>
                      <small>{snippet.description || "No description"}</small>
                    </span>
                  </button>
                ))}
                {!filtered.length && (
                  <p className="snippet-search-empty">
                    {snippets.length
                      ? "No matching abbreviations. Try another search."
                      : "Create your first abbreviation to reuse SQL."}
                  </p>
                )}
              </aside>
              {current ? (
                <div className="snippet-fields">
                  <div className="snippet-detail-heading">
                    <div>
                      <strong>{current.prefix || "New abbreviation"}</strong>
                      <small>
                        {readOnly
                          ? "Read-only preview"
                          : "Changes are saved when you apply."}
                      </small>
                    </div>
                    <Button
                      title="Duplicate abbreviation"
                      disabled={readOnly}
                      onClick={() => {
                        let prefix = `${current.prefix || "snippet"}_copy`;
                        let number = 2;
                        while (
                          snippets.some(
                            (item) =>
                              item.prefix.toLowerCase() ===
                              prefix.toLowerCase(),
                          )
                        )
                          prefix = `${current.prefix || "snippet"}_copy${number++}`;
                        const copy = {
                          ...current,
                          id: crypto.randomUUID(),
                          prefix,
                        };
                        setSnippets((items) => [...items, copy]);
                        setSearch("");
                        setSelected(copy.id);
                      }}
                    >
                      <Copy size={14} />
                      Duplicate
                    </Button>
                  </div>
                  <fieldset
                    className="snippet-detail-fields"
                    disabled={readOnly}
                  >
                    <div className="row">
                      <label htmlFor="snippet-prefix">
                        Prefix
                        <input
                          id="snippet-prefix"
                          aria-invalid={!!prefixError}
                          aria-describedby="snippet-prefix-help"
                          autoComplete="off"
                          spellCheck={false}
                          value={current.prefix}
                          placeholder="e.g. sel"
                          onChange={(event) =>
                            setSnippets((items) =>
                              items.map((snippet) =>
                                snippet.id === current.id
                                  ? { ...snippet, prefix: event.target.value }
                                  : snippet,
                              ),
                            )
                          }
                        />
                        <small
                          id="snippet-prefix-help"
                          className={
                            prefixError
                              ? "snippet-field-error"
                              : "snippet-field-help"
                          }
                        >
                          {prefixError ||
                            "Type this prefix in the editor to find the suggestion."}
                        </small>
                      </label>
                      <Button
                        title="Delete abbreviation"
                        onClick={() => {
                          setSnippets((items) =>
                            items.filter(
                              (snippet) => snippet.id !== current.id,
                            ),
                          );
                          setSelected(
                            snippets.find(
                              (snippet) => snippet.id !== current.id,
                            )?.id ?? "",
                          );
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                    <label htmlFor="snippet-description">
                      Description
                      <input
                        id="snippet-description"
                        value={current.description}
                        placeholder="What does this abbreviation do?"
                        onChange={(event) =>
                          setSnippets((items) =>
                            items.map((snippet) =>
                              snippet.id === current.id
                                ? {
                                    ...snippet,
                                    description: event.target.value,
                                  }
                                : snippet,
                            ),
                          )
                        }
                      />
                    </label>
                    <label htmlFor="snippet-body">
                      SQL expansion
                      <textarea
                        id="snippet-body"
                        aria-invalid={!!bodyError}
                        aria-describedby="snippet-body-help"
                        spellCheck={false}
                        value={current.body}
                        placeholder={"SELECT ${1:*}\nFROM ${2:table};"}
                        onChange={(event) =>
                          setSnippets((items) =>
                            items.map((snippet) =>
                              snippet.id === current.id
                                ? { ...snippet, body: event.target.value }
                                : snippet,
                            ),
                          )
                        }
                      />
                      <small
                        id="snippet-body-help"
                        className={
                          bodyError
                            ? "snippet-field-error"
                            : "snippet-field-help"
                        }
                      >
                        {bodyError ||
                          "Use ${1:column}, ${2:table} for editable fields and $0 for the final cursor position."}
                      </small>
                    </label>
                  </fieldset>
                  <div className="snippet-usage">
                    <Code2 size={15} />
                    <span>
                      Type <code>{current.prefix || "prefix"}</code> → choose
                      the suggestion → <kbd>Tab</kbd> or <kbd>Enter</kbd> to
                      insert. Press <kbd>Tab</kbd> to move between fields.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="snippet-empty">
                  <Code2 size={25} />
                  <span>No abbreviations</span>
                  <Button disabled={readOnly} onClick={add}>
                    <Plus size={14} />
                    Add one
                  </Button>
                </div>
              )}
            </div>
          </div>
          {errors.length > 0 && dirty && !inherited && (
            <div className="table-editor-error" role="alert">
              {errors[0]}
            </div>
          )}
          <div className="snippet-status" role="status">
            {message ||
              (inherited
                ? "Using global defaults. Uncheck to customize this workspace."
                : dirty
                  ? "Unapplied changes · Ctrl/⌘ + S to apply"
                  : scope === "global"
                    ? "Workspace overrides are kept unless you choose to replace them."
                    : "")}
          </div>
          <div className="table-editor-actions">
            <Button
              disabled={readOnly}
              onClick={async () => {
                if (
                  await confirmAction(
                    "Replace these abbreviations with the default set?",
                  )
                ) {
                  setSnippets(structuredClone(DEFAULT_SNIPPETS));
                  setSelected(DEFAULT_SNIPPETS[0].id);
                }
              }}
            >
              <RotateCcw size={13} />
              Reset defaults
            </Button>
            <div className="row">
              <Button disabled={busy} onClick={() => void close()}>
                Done
              </Button>
              <Button
                className="primary"
                disabled={
                  busy || loading || !dirty || (!inherited && errors.length > 0)
                }
                onClick={() => void save()}
              >
                Apply
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
