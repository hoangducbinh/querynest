import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Code2, Plus, RotateCcw, Trash2, X } from "lucide-react";
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
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = snippets.find((snippet) => snippet.id === selected);
  const errors = validateSnippets(snippets);
  const dirty = JSON.stringify(draft) !== baseline || replace;
  const inherited = scope === "workspace" && inherit;
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
    const id = crypto.randomUUID();
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
            Type a prefix, then Tab or Enter to expand. Use{" "}
            <code>{"${1:column}"}</code> for a tab stop.
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
          <fieldset
            className="snippet-editing"
            disabled={inherited || busy || loading}
          >
            <div className="snippet-settings-body">
              <aside className="snippet-list">
                {snippets.map((snippet) => (
                  <button
                    className={selected === snippet.id ? "active" : ""}
                    key={snippet.id}
                    onClick={() => setSelected(snippet.id)}
                  >
                    <Code2 size={13} />
                    <span>{snippet.prefix || "New abbreviation"}</span>
                  </button>
                ))}
                <Button onClick={add}>
                  <Plus size={14} />
                  Add abbreviation
                </Button>
              </aside>
              {current ? (
                <div className="snippet-fields">
                  <div className="row">
                    <label htmlFor="snippet-prefix">
                      Prefix
                      <input
                        id="snippet-prefix"
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
                    </label>
                    <Button
                      title="Delete abbreviation"
                      onClick={() => {
                        setSnippets((items) =>
                          items.filter((snippet) => snippet.id !== current.id),
                        );
                        setSelected(
                          snippets.find((snippet) => snippet.id !== current.id)
                            ?.id ?? "",
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
                              ? { ...snippet, description: event.target.value }
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
                  </label>
                </div>
              ) : (
                <div className="snippet-empty">
                  <Code2 size={25} />
                  <span>No abbreviations</span>
                  <Button onClick={add}>
                    <Plus size={14} />
                    Add one
                  </Button>
                </div>
              )}
            </div>
          </fieldset>
          {errors.length > 0 && dirty && !inherited && (
            <div className="table-editor-error" role="alert">
              {errors[0]}
            </div>
          )}
          <div className="snippet-status" role="status">
            {message ||
              (inherited
                ? "Using global defaults. Uncheck to customize this workspace."
                : scope === "global"
                  ? "Workspace overrides are kept unless you choose to replace them."
                  : "")}
          </div>
          <div className="table-editor-actions">
            <Button
              disabled={inherited || busy}
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
