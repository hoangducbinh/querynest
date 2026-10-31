import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Code2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import { useStore } from "../schema/store";
import { DEFAULT_SNIPPETS, validateSnippets } from "./snippets";
export function SnippetSettings({ onClose }: { onClose: () => void }) {
  const { workspace, edit } = useStore();
  const original = workspace.sqlSnippets ?? DEFAULT_SNIPPETS;
  const [snippets, setSnippets] = useState(() => structuredClone(original));
  const [selected, setSelected] = useState(snippets[0]?.id ?? "");
  const current = snippets.find((snippet) => snippet.id === selected);
  const errors = validateSnippets(snippets);
  const dirty = JSON.stringify(snippets) !== JSON.stringify(original);
  async function close() {
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
  function save() {
    if (errors.length) return;
    edit((w) => {
      w.sqlSnippets = snippets;
    });
    onClose();
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
          {errors.length > 0 && dirty && (
            <div className="table-editor-error" role="alert">
              {errors[0]}
            </div>
          )}
          <div className="table-editor-actions">
            <Button
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
              <Button onClick={() => void close()}>Cancel</Button>
              <Button
                className="primary"
                disabled={errors.length > 0}
                onClick={save}
              >
                Save abbreviations
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
