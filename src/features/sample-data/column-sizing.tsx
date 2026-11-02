import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cellText } from "./model";

export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 1000;
export const clampColumnWidth = (width: number) =>
  Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));

export function fitColumnWidth(name: string, values: unknown[], maximum = 640) {
  const length = values.slice(0, 100).reduce<number>((longest, value) => {
    const text = value === null ? "NULL" : cellText(value);
    return text
      .split(/\r?\n/)
      .reduce((size, line) => Math.max(size, line.length), longest);
  }, name.length + 4);
  return clampColumnWidth(Math.min(maximum, Math.max(144, length * 8 + 32)));
}

export function useColumnWidths(scope: string, ids: string[]) {
  const signature = JSON.stringify(ids);
  const stored = useMemo(() => {
    const result: Record<string, number> = {};
    for (const id of JSON.parse(signature) as string[]) {
      const key = JSON.stringify([scope, id]);
      try {
        const value = Number(localStorage.getItem("grid-column-width:" + key));
        if (Number.isFinite(value) && value >= MIN_COLUMN_WIDTH)
          result[key] = clampColumnWidth(value);
      } catch {
        /* Resizing still works when storage is unavailable. */
      }
    }
    return result;
  }, [scope, signature]);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const keyFor = (id: string) => JSON.stringify([scope, id]);
  return {
    width: (id: string, fallback: number) =>
      overrides[keyFor(id)] ?? stored[keyFor(id)] ?? fallback,
    resize: (id: string, value: number, persist = true) => {
      const key = keyFor(id);
      const width = clampColumnWidth(value);
      setOverrides((current) => ({ ...current, [key]: width }));
      if (persist) {
        try {
          localStorage.setItem("grid-column-width:" + key, String(width));
        } catch {
          /* Optional preference. */
        }
      }
    },
  };
}

export function ColumnResizeHandle({
  name,
  width,
  onResize,
  onAutoFit,
}: {
  name: string;
  width: number;
  onResize: (width: number, persist?: boolean) => void;
  onAutoFit: () => void;
}) {
  const drag = useRef<{
    x: number;
    width: number;
    latest: number;
    edge: number;
    preview: HTMLDivElement;
    label: HTMLSpanElement;
    frame: number;
  } | null>(null);
  function clearPreview() {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    current.preview.remove();
    return current;
  }
  useEffect(
    () => () => {
      clearPreview();
    },
    [],
  );
  function move(clientX: number) {
    const current = drag.current;
    if (!current) return;
    current.latest = clampColumnWidth(current.width + clientX - current.x);
    if (current.frame) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = 0;
      current.preview.style.transform = `translateX(${current.edge + current.latest - current.width}px)`;
      current.label.textContent = `${current.latest} px`;
    });
  }
  return (
    <span
      className="column-resize-handle"
      role="separator"
      aria-label={`Resize ${name}`}
      aria-orientation="vertical"
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · Double-click to fit contents · Arrow keys to adjust"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onAutoFit();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        const header = event.currentTarget.closest("th");
        const viewport = event.currentTarget.closest(
          ".sheet-grid-scroll, .grid-scroll",
        );
        if (!header || !viewport) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = header.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        const preview = document.createElement("div");
        preview.className = "column-resize-preview";
        preview.setAttribute("aria-hidden", "true");
        preview.style.top = `${rect.top}px`;
        preview.style.height = `${Math.max(0, Math.min(bounds.bottom, window.innerHeight) - rect.top)}px`;
        preview.style.transform = `translateX(${rect.right}px)`;
        const label = document.createElement("span");
        label.textContent = `${Math.round(rect.width)} px`;
        preview.append(label);
        document.body.append(preview);
        drag.current = {
          x: event.clientX,
          width: rect.width,
          latest: Math.round(rect.width),
          edge: rect.right,
          preview,
          label,
          frame: 0,
        };
      }}
      onPointerMove={(event) => move(event.clientX)}
      onPointerUp={(event) => {
        if (!drag.current) return;
        move(event.clientX);
        const current = clearPreview();
        if (current) onResize(current.latest);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        clearPreview();
      }}
      onLostPointerCapture={() => {
        const current = clearPreview();
        if (current) onResize(current.latest);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          clearPreview();
          return;
        }
        if (drag.current) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          onResize(
            width +
              (event.key === "ArrowRight" ? 1 : -1) *
                (event.shiftKey ? 40 : 10),
          );
        } else if (event.key === "Enter") {
          event.preventDefault();
          onAutoFit();
        }
      }}
    />
  );
}

/** Render only nearby columns while keeping full colgroup geometry and row data. */
export function columnWindow(
  widths: number[],
  left: number,
  viewport: number,
  gutter = 40,
  overscan = 2,
) {
  let offset = gutter;
  let start = widths.length;
  let end = 0;
  for (let i = 0; i < widths.length; i++) {
    if (offset + widths[i] > left + gutter && start === widths.length)
      start = i;
    if (offset < left + viewport) end = i + 1;
    offset += widths[i];
  }
  if (widths.length && start === widths.length)
    return {
      start: Math.max(0, widths.length - 1 - overscan),
      end: widths.length,
    };
  start = Math.max(0, Math.min(start, widths.length - 1) - overscan);
  end = Math.min(widths.length, Math.max(start + 1, end + overscan));
  return { start, end };
}
export function useColumnWindow(widths: number[], gutter = 40) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 1000 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const left = element.scrollLeft,
        width = element.clientWidth;
      setViewport((old) =>
        old.left === left && old.width === width ? old : { left, width },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", schedule);
    };
  }, []);
  return {
    ref,
    ...columnWindow(widths, viewport.left, viewport.width, gutter),
  };
}
