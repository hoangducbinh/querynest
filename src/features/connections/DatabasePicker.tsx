import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "../../components/ui/button";

export function DatabasePicker({
  value,
  databases,
  disabled,
  onDiscover,
  onSelect,
}: {
  value: string;
  databases: string[];
  disabled: boolean;
  onDiscover?: () => void | Promise<void>;
  onSelect: (database: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const names = [...new Set([value, ...databases])];
  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) {
          setSearch("");
          setError("");
          void Promise.resolve()
            .then(() => onDiscover?.())
            .catch((e) => setError(String(e)));
        }
      }}
    >
      <Menu.Trigger asChild>
        <Button
          className="connection-picker-trigger database-picker-trigger"
          aria-label="Database"
          title={value}
          disabled={disabled || pending}
        >
          <span>{value}</span>
          <ChevronDown size={11} />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="connection-menu database-menu"
          sideOffset={5}
          align="start"
          collisionPadding={8}
          aria-label="Databases"
        >
          {names.length > 8 && (
            <div className="connection-menu-search">
              <Search size={12} />
              <input
                aria-label="Search databases"
                placeholder="Search databases…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" && event.key !== "Tab")
                    event.stopPropagation();
                }}
              />
            </div>
          )}
          <div className="connection-menu-list">
            {names
              .filter((name) =>
                name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((name) => (
                <Menu.Item
                  key={name}
                  className="connection-menu-item connection-menu-choice"
                  disabled={pending}
                  title={name}
                  onSelect={(event) => {
                    if (name === value) return;
                    event.preventDefault();
                    setPending(true);
                    setError("");
                    void Promise.resolve()
                      .then(() => onSelect(name))
                      .then(() => setOpen(false))
                      .catch((e) => setError(String(e)))
                      .finally(() => setPending(false));
                  }}
                >
                  <span className="connection-menu-check">
                    {name === value && <Check size={12} />}
                  </span>
                  <span className="connection-menu-name">{name}</span>
                </Menu.Item>
              ))}
            {!names.some((name) =>
              name.toLowerCase().includes(search.toLowerCase()),
            ) && (
              <div className="connection-menu-label">No matching databases</div>
            )}
          </div>
          {pending && (
            <div role="status" className="connection-menu-label">
              Switching database…
            </div>
          )}
          {error && (
            <p role="alert" className="connection-menu-error">
              {error}
            </p>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
