import { useState } from "react";
import { Code2, Plus, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import type { SqlTab } from "../../types/schema";
interface Props {
  tabs: SqlTab[];
  activeId: string;
  onTabsChange: (tabs: SqlTab[], activeId: string) => void;
  busy: boolean;
}
export function QueryTabs({ tabs, activeId, onTabsChange, busy }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tabName, setTabName] = useState("");
  return (
    <div className="sql-tabs" role="tablist" aria-label="SQL queries">
      {tabs.map((tab) => (
        <div
          className={"sql-tab " + (tab.id === activeId ? "active" : "")}
          key={tab.id}
        >
          {renaming === tab.id ? (
            <input
              aria-label="SQL tab name"
              autoFocus
              value={tabName}
              onChange={(e) => setTabName(e.target.value)}
              onBlur={() => {
                if (tabName.trim())
                  onTabsChange(
                    tabs.map((item) =>
                      item.id === tab.id
                        ? { ...item, name: tabName.trim() }
                        : item,
                    ),
                    activeId,
                  );
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <button
              role="tab"
              aria-selected={tab.id === activeId}
              title="Double-click to rename"
              onClick={() => onTabsChange(tabs, tab.id)}
              onDoubleClick={() => {
                setTabName(tab.name);
                setRenaming(tab.id);
              }}
            >
              <Code2 size={13} />
              {tab.name}
            </button>
          )}
          <button
            aria-label={`Close ${tab.name}`}
            disabled={busy}
            onClick={async () => {
              if (
                tab.sql.trim() &&
                !(await confirmAction(
                  `Close ${tab.name}? Its SQL will be removed from this workspace.`,
                ))
              )
                return;
              const remaining = tabs.filter((item) => item.id !== tab.id);
              if (!remaining.length) {
                const next = {
                  id: crypto.randomUUID(),
                  name: "query.sql",
                  sql: "",
                };
                onTabsChange([next], next.id);
              } else
                onTabsChange(
                  remaining,
                  activeId === tab.id
                    ? remaining[
                        Math.max(
                          0,
                          tabs.findIndex((item) => item.id === tab.id) - 1,
                        )
                      ].id
                    : activeId,
                );
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <Button
        title="New SQL tab"
        onClick={() => {
          let number = 1;
          while (tabs.some((tab) => tab.name === `query-${number}.sql`))
            number++;
          const next = {
            id: crypto.randomUUID(),
            name: `query-${number}.sql`,
            sql: "",
          };
          onTabsChange([...tabs, next], next.id);
        }}
      >
        <Plus size={14} />
      </Button>
    </div>
  );
}
