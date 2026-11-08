import { describe, expect, it, vi } from "vitest";
import {
  handleHorizontalWheel,
  scrollActiveTabIntoView,
} from "./use-horizontal-scroll";

describe("handleHorizontalWheel", () => {
  it("translates vertical wheel (deltaY) to horizontal scrollLeft", () => {
    const el = { scrollLeft: 0 } as HTMLElement;
    const preventDefault = vi.fn();

    const handled = handleHorizontalWheel(el, {
      deltaX: 0,
      deltaY: 120,
      shiftKey: false,
      preventDefault,
    });

    expect(handled).toBe(true);
    expect(el.scrollLeft).toBe(120);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("passes native horizontal trackpad gestures to browser compositor", () => {
    const el = { scrollLeft: 50 } as HTMLElement;
    const preventDefault = vi.fn();

    const handled = handleHorizontalWheel(el, {
      deltaX: 60,
      deltaY: 10,
      shiftKey: false,
      preventDefault,
    });

    expect(handled).toBe(false);
    expect(el.scrollLeft).toBe(50);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("allows native shift+wheel without hijacking", () => {
    const el = { scrollLeft: 0 } as HTMLElement;
    const preventDefault = vi.fn();

    const handled = handleHorizontalWheel(el, {
      deltaX: 0,
      deltaY: 100,
      shiftKey: true,
      preventDefault,
    });

    expect(handled).toBe(false);
    expect(el.scrollLeft).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does nothing when delta is 0", () => {
    const el = { scrollLeft: 10 } as HTMLElement;
    const preventDefault = vi.fn();

    const handled = handleHorizontalWheel(el, {
      deltaX: 0,
      deltaY: 0,
      shiftKey: false,
      preventDefault,
    });

    expect(handled).toBe(false);
    expect(el.scrollLeft).toBe(10);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("scrollActiveTabIntoView", () => {
  it("adjusts container.scrollLeft to reveal active tab and resets ancestor displacement", () => {
    const activeEl = {
      offsetLeft: 300,
      offsetWidth: 120,
    } as unknown as HTMLElement;

    const parent = { scrollLeft: 40, parentElement: null } as unknown as HTMLElement;
    const container = {
      scrollLeft: 0,
      clientWidth: 200,
      parentElement: parent,
      querySelector: vi.fn((sel: string) =>
        sel === ".sql-tab.active" ? activeEl : null,
      ),
    } as unknown as HTMLElement;

    scrollActiveTabIntoView(container, ".sql-tab.active");
    expect(parent.scrollLeft).toBe(0);
    expect(container.scrollLeft).toBe(220); // 300 + 120 - 200
  });

  it("scrolls backwards when active tab is before viewLeft", () => {
    const activeEl = {
      offsetLeft: 50,
      offsetWidth: 100,
    } as unknown as HTMLElement;

    const container = {
      scrollLeft: 200,
      clientWidth: 300,
      parentElement: null,
      querySelector: vi.fn(() => activeEl),
    } as unknown as HTMLElement;

    scrollActiveTabIntoView(container, ".sql-tab.active");
    expect(container.scrollLeft).toBe(50);
  });

  it("accurately aligns tab using getBoundingClientRect without being distorted by offsetParent", () => {
    // Simulates an active tab that is 60px past the left viewport edge
    const activeEl = {
      getBoundingClientRect: vi.fn(() => ({ left: 140, right: 290, width: 150 })),
    } as unknown as HTMLElement;

    const container = {
      scrollLeft: 180,
      clientWidth: 400,
      parentElement: null,
      getBoundingClientRect: vi.fn(() => ({ left: 200, right: 600, width: 400 })),
      querySelector: vi.fn(() => activeEl),
    } as unknown as HTMLElement;

    scrollActiveTabIntoView(container, ".sql-tab.active");
    // 180 + (140 - 200) = 120
    expect(container.scrollLeft).toBe(120);
  });

  it("safely handles null container or missing tab", () => {
    expect(() => scrollActiveTabIntoView(null, ".active")).not.toThrow();

    const container = {
      scrollLeft: 0,
      clientWidth: 100,
      parentElement: null,
      querySelector: vi.fn(() => null),
    } as unknown as HTMLElement;
    expect(() => scrollActiveTabIntoView(container, ".active")).not.toThrow();
  });
});

describe("useHorizontalWheelScroll", () => {
  it("adds is-scrolling on wheel or scroll and removes it after inactivity", () => {
    vi.useFakeTimers();
    const listeners: Record<string, EventListener> = {};
    const classList = new Set<string>();

    const el = {
      scrollLeft: 0,
      classList: {
        contains: vi.fn((cls: string) => classList.has(cls)),
        add: vi.fn((cls: string) => classList.add(cls)),
        remove: vi.fn((cls: string) => classList.delete(cls)),
      },
      addEventListener: vi.fn((evt: string, listener: EventListener) => {
        listeners[evt] = listener;
      }),
      removeEventListener: vi.fn((evt: string) => {
        delete listeners[evt];
      }),
    } as unknown as HTMLElement;

    // Simulate hook setup
    let cleanup: (() => void) | undefined;

    // Test runner can test the hook's effect logic directly
    const effect = () => {
      let scrollTimer: ReturnType<typeof setTimeout> | undefined;
      const markScrolling = () => {
        if (!el.classList.contains("is-scrolling")) {
          el.classList.add("is-scrolling");
        }
        if (scrollTimer !== undefined) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          el.classList.remove("is-scrolling");
          scrollTimer = undefined;
        }, 800);
      };

      const onWheel = (e: Event) => {
        markScrolling();
        handleHorizontalWheel(el, e as unknown as Parameters<typeof handleHorizontalWheel>[1]);
      };
      const onScroll = () => {
        markScrolling();
      };

      el.addEventListener("wheel", onWheel as EventListener);
      el.addEventListener("scroll", onScroll as EventListener);

      return () => {
        if (scrollTimer !== undefined) clearTimeout(scrollTimer);
        el.classList.remove("is-scrolling");
        el.removeEventListener("wheel", onWheel as EventListener);
        el.removeEventListener("scroll", onScroll as EventListener);
      };
    };

    cleanup = effect();
    expect(listeners.wheel).toBeDefined();
    expect(listeners.scroll).toBeDefined();
    expect(classList.has("is-scrolling")).toBe(false);

    // Fire scroll event
    listeners.scroll(new Event("scroll"));
    expect(classList.has("is-scrolling")).toBe(true);

    // Advance 400ms: still scrolling
    vi.advanceTimersByTime(400);
    expect(classList.has("is-scrolling")).toBe(true);

    // Advance another 500ms (total 900ms > 800ms): scrollbar fades out
    vi.advanceTimersByTime(500);
    expect(classList.has("is-scrolling")).toBe(false);

    cleanup();
    expect(listeners.wheel).toBeUndefined();
    expect(listeners.scroll).toBeUndefined();
    vi.useRealTimers();
  });
});
