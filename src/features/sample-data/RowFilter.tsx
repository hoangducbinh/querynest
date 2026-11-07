import type { ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Search } from "lucide-react";

export function RowFilter({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        className="row-filter-trigger"
        data-filtered={active || undefined}
        aria-label={active ? "Edit active row filter" : "Filter rows"}
      >
        <Search size={13} aria-hidden="true" />
        <span>{active ? "Filtered" : "Filter"}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="result-row-filter"
          aria-label="Row filter"
          align="end"
          side="top"
          sideOffset={6}
          collisionPadding={8}
        >
          <Search size={12} aria-hidden="true" />
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
