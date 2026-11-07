import { useRef, useState, type DragEvent } from "react";

export type DropSide = "before" | "after";

export function reorderTabs<T extends { id: string }>(
  tabs: T[],
  source: string,
  target: string,
  side: DropSide,
): T[] {
  const moved = tabs.find((tab) => tab.id === source);
  if (!moved || source === target || !tabs.some((tab) => tab.id === target))
    return tabs;
  const next = tabs.filter((tab) => tab.id !== source);
  next.splice(
    next.findIndex((tab) => tab.id === target) + (side === "after" ? 1 : 0),
    0,
    moved,
  );
  return next.every((tab, index) => tab === tabs[index]) ? tabs : next;
}

export function useTabReorder(
  enabled: boolean,
  move: (source: string, target: string, side: DropSide) => void,
  accepts: (source: string, target: string) => boolean = () => true,
) {
  const source = useRef<string | null>(null);
  const [target, setTarget] = useState<{ id: string; side: DropSide } | null>(
    null,
  );
  const clear = () => {
    source.current = null;
    setTarget(null);
  };
  const sideAt = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };
  return (id: string, draggable = true) => ({
    draggable: enabled && draggable,
    "data-tab-drop": target?.id === id ? target.side : undefined,
    onDragStart(event: DragEvent<HTMLElement>) {
      if (!enabled || !draggable || event.target !== event.currentTarget) {
        event.preventDefault();
        return;
      }
      source.current = id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-workspace-tab", id);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (
        !enabled ||
        !source.current ||
        source.current === id ||
        !accepts(source.current, id)
      ) {
        setTarget(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const side = sideAt(event);
      setTarget((previous) =>
        previous?.id === id && previous.side === side ? previous : { id, side },
      );
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
        return;
      setTarget((previous) => (previous?.id === id ? null : previous));
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (
        !enabled ||
        !source.current ||
        source.current === id ||
        !accepts(source.current, id)
      )
        return;
      event.preventDefault();
      move(source.current, id, sideAt(event));
      clear();
    },
    onDragEnd: clear,
  });
}
