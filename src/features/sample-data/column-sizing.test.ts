import { describe, expect, it } from "vitest";
import { columnWindow } from "./column-sizing";

describe("wide grid column windows", () => {
  it("keeps mounted cells bounded on a 121-column table", () => {
    const widths = Array(121).fill(200);
    for (const left of [0, 1200, 9000, 23000]) {
      const { start, end } = columnWindow(widths, left, 1000);
      expect(end - start).toBeLessThanOrEqual(10);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(121);
    }
  });
  it("uses actual column widths, accounts for the sticky gutter, and includes intersecting edges", () => {
    expect(columnWindow([100, 200, 80, 300], 150, 200, 40, 0)).toEqual({
      start: 1,
      end: 3,
    });
    expect(columnWindow([100, 200, 80, 300], 0, 140, 40, 0)).toEqual({
      start: 0,
      end: 1,
    });
  });
  it("handles no columns and a viewport beyond the resized table", () => {
    expect(columnWindow([], 0, 1000)).toEqual({ start: 0, end: 0 });
    const range = columnWindow(Array(5).fill(100), 10000, 1000);
    expect(range.end).toBe(5);
  });
});
