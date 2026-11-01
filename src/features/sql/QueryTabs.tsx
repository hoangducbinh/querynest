import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { Code2, MoreHorizontal, Plus, X, Check } from "lucide-react";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../lib/dialogs";
import type { SqlTab } from "../../types/schema";
interface Props {
  tabs: SqlTab[];
  activeId: string;
  onTabsChange: (tabs: SqlTab[], activeId: string) => void;
  busy: boolean;
  newTabConnectionName?: string;
}
export function QueryTabs({
  tabs,
  activeId,
  onTabsChange,
  busy,
  newTabConnectionName,
}: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tabName, setTabName] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const capacity = Math.max(1, Math.floor((width - 64) / 153));
  const overflowing = tabs.length > capacity;
  const visible = overflowing
    ? tabs
        .filter((tab, index) => index < capacity || tab.id === activeId)
        .slice(0, capacity)
    : tabs;
  if (overflowing && !visible.some((tab) => tab.id === activeId))
    visible[visible.length - 1] =
      tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  return (
    <div
      ref={container}
      className="sql-tabs"
      role="tablist"
      aria-label="SQL queries"
    >
      {visible.map((tab) => (
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
              <span>{tab.name}</span>
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
      {overflowing && (
        <Popover.Root
          open={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (!value) setSearch("");
          }}
        >
          <Popover.Trigger asChild>
            <Button
              aria-label="List SQL tabs"
              title={`All SQL tabs (${tabs.length})`}
            >
              <MoreHorizontal size={16} />
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="sql-tab-menu"
              sideOffset={6}
              align="start"
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <input
                aria-label="Find SQL tab"
                placeholder="Find a tab…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="sql-tab-menu-list">
                {tabs
                  .filter((tab) =>
                    tab.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => {
                        onTabsChange(tabs, tab.id);
                        setOpen(false);
                        setSearch("");
                      }}
                    >
                      <Code2 size={14} />
                      <span>{tab.name}</span>
                      {tab.id === activeId && <Check size={14} />}
                    </button>
                  ))}
                {!tabs.some((tab) =>
                  tab.name.toLowerCase().includes(search.toLowerCase()),
                ) && <span className="snippet-status">No matching tabs</span>}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
      <Button
        title={
          newTabConnectionName
            ? `New SQL tab · ${newTabConnectionName}`
            : "New SQL tab"
        }
        aria-label="New SQL tab"
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
