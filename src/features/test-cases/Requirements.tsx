import { FlaskConical, Plus, Play, Trash2 } from "lucide-react";
import { useStore } from "../schema/store";
import { id } from "../schema/core";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
export function Requirements({
  results,
  onRun,
  disabled,
}: {
  results: Record<string, string>;
  onRun: (id?: string) => void;
  disabled: boolean;
}) {
  const { workspace, edit } = useStore();
  return (
    <div className="requirements-view">
      <div className="view-heading">
        <div>
          <h1>Requirements</h1>
        </div>
        <div className="row">
          <Button
            onClick={() =>
              edit((w) => {
                w.tests.push({
                  id: id(),
                  name: "New requirement",
                  description: "",
                  sql: "SELECT COUNT(*) AS count FROM customers",
                  expected: '[{"count":2}]',
                  ordered: false,
                });
              })
            }
          >
            <Plus size={15} />
            New test
          </Button>
          <Button
            className="primary"
            disabled={disabled || !workspace.tests.length}
            onClick={() => onRun()}
          >
            <Play size={14} />
            Run all tests
          </Button>
        </div>
      </div>
      <div className="requirements-list">
        {workspace.tests.map((test) => (
          <div className="test-card" key={test.id}>
            <div className="row">
              <FlaskConical size={18} />
              <input
                aria-label="Test name"
                value={test.name}
                onChange={(event) =>
                  edit((w) => {
                    w.tests.find((t) => t.id === test.id)!.name =
                      event.target.value;
                  })
                }
              />
              <span
                className={
                  "test-result " +
                  (results[test.id]?.startsWith("PASS") ? "passed" : "")
                }
              >
                {results[test.id]?.split(" · ")[0] || "Not run"}
              </span>
              <Button disabled={disabled} onClick={() => onRun(test.id)}>
                <Play size={13} />
                Run
              </Button>
              <Button
                title="Delete test"
                onClick={async () => {
                  if (await confirmAction("Delete this requirement test?"))
                    edit((w) => {
                      w.tests = w.tests.filter((t) => t.id !== test.id);
                    });
                }}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <input
              placeholder="Describe the business requirement…"
              value={test.description}
              onChange={(event) =>
                edit((w) => {
                  w.tests.find((t) => t.id === test.id)!.description =
                    event.target.value;
                })
              }
            />
            <div className="test-editors">
              <label>
                SQL query
                <textarea
                  aria-label="Test SQL"
                  value={test.sql}
                  onChange={(event) =>
                    edit((w) => {
                      w.tests.find((t) => t.id === test.id)!.sql =
                        event.target.value;
                    })
                  }
                />
              </label>
              <label>
                Expected rows · JSON
                <textarea
                  aria-label="Expected result JSON"
                  value={test.expected}
                  onChange={(event) =>
                    edit((w) => {
                      w.tests.find((t) => t.id === test.id)!.expected =
                        event.target.value;
                    })
                  }
                />
              </label>
            </div>
            <div className="row">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={test.ordered}
                  onChange={(event) =>
                    edit((w) => {
                      w.tests.find((t) => t.id === test.id)!.ordered =
                        event.target.checked;
                    })
                  }
                />
                Match row order
              </label>
              <span className="muted">
                NULL and numeric types are compared consistently.
              </span>
            </div>
            {results[test.id] && <pre>{results[test.id]}</pre>}
          </div>
        ))}
        {!workspace.tests.length && (
          <div className="empty-state">
            <FlaskConical size={32} />
            <h2>No tests yet</h2>
            <p>
              Add a SQL query and its expected JSON rows to validate a
              requirement.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
