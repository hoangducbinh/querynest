import { useEffect, type RefObject } from "react";

/**
 * Handles mouse wheel translation: vertical wheel movement (deltaY) scrolls
 * horizontally. Native trackpad horizontal swipes (deltaX) pass through to
 * the browser's GPU compositor for 120 FPS fluid momentum.
 */
export function handleHorizontalWheel(
  el: HTMLElement,
  event: {
    deltaX: number;
    deltaY: number;
    deltaMode?: number;
    shiftKey: boolean;
    preventDefault: () => void;
  },
): boolean {
  if (event.shiftKey) return false;

  // Native trackpad horizontal swipe: let browser handle natively with inertia
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    return false;
  }

  const rawDelta = event.deltaY;
  if (rawDelta === 0) return false;

  // Normalize line delta vs pixel delta
  const delta = event.deltaMode === 1 ? rawDelta * 25 : rawDelta;
  el.scrollLeft += delta;
  event.preventDefault();
  return true;
}

/**
 * Enables smooth horizontal scrolling on mouse wheel (deltaY or deltaX)
 * similar to VS Code's editor tab strips.
 * Shows the scrollbar thumb only when actively scrolling and fades it out
 * after scrolling stops.
 */
export function useHorizontalWheelScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let scrollTimer: ReturnType<typeof setTimeout> | undefined;

    const markScrolling = () => {
      if (!el.classList.contains("is-scrolling")) {
        el.classList.add("is-scrolling");
      }
      if (scrollTimer !== undefined) {
        clearTimeout(scrollTimer);
      }
      scrollTimer = setTimeout(() => {
        el.classList.remove("is-scrolling");
        scrollTimer = undefined;
      }, 800);
    };

    const onWheel = (e: WheelEvent) => {
      markScrolling();
      handleHorizontalWheel(el, e);
    };

    const onScroll = () => {
      markScrolling();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      if (scrollTimer !== undefined) clearTimeout(scrollTimer);
      el.classList.remove("is-scrolling");
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref]);
}

/**
 * Scrolls the active tab into view strictly within its scroll container.
 * Never scrolls or displaces ancestor containers or the window.
 */
export function scrollActiveTabIntoView(
  container: HTMLElement | null,
  activeSelector: string,
) {
  if (!container) return;

  // Ensure ancestor scrollLefts are never displaced
  let parent = container.parentElement;
  while (parent && parent.tagName !== "BODY") {
    if (parent.scrollLeft !== 0) parent.scrollLeft = 0;
    parent = parent.parentElement;
  }

  const active = container.querySelector<HTMLElement>(activeSelector);
  if (!active) return;

  // Use getBoundingClientRect for pixel-perfect relative offset regardless of offsetParent
  if (
    typeof active.getBoundingClientRect === "function" &&
    typeof container.getBoundingClientRect === "function"
  ) {
    const activeRect = active.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    if (activeRect.left < containerRect.left) {
      container.scrollLeft += Math.round(activeRect.left - containerRect.left);
    } else if (activeRect.right > containerRect.right) {
      container.scrollLeft += Math.round(activeRect.right - containerRect.right);
    }
    return;
  }

  const activeLeft = active.offsetLeft;
  const activeRight = activeLeft + active.offsetWidth;
  const viewLeft = container.scrollLeft;
  const viewRight = viewLeft + container.clientWidth;

  if (activeLeft < viewLeft) {
    container.scrollLeft = activeLeft;
  } else if (activeRight > viewRight) {
    container.scrollLeft = activeRight - container.clientWidth;
  }
}
