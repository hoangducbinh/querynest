import { describe, expect, it, vi } from "vitest";
import { readDarkAppearance, saveDarkAppearance } from "./appearance";
describe("appearance preference", () => {
  it("defaults to light and restores both saved modes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readDarkAppearance(storage)).toBe(false);
    saveDarkAppearance(true, storage);
    expect(readDarkAppearance(storage)).toBe(true);
    saveDarkAppearance(false, storage);
    expect(readDarkAppearance(storage)).toBe(false);
  });
  it("handles denied browser storage without breaking the app", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw Error("Blocked");
      }),
      setItem: vi.fn(() => {
        throw Error("Blocked");
      }),
    };
    expect(readDarkAppearance(storage)).toBe(false);
    expect(() => saveDarkAppearance(true, storage)).not.toThrow();
  });
});
