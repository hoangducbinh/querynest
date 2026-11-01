import { expect, it, vi } from "vitest";
import { nativeAppearanceSync, detectDesktopPlatform } from "./desktop-chrome";
it("serializes rapid appearance changes so the newest theme and background win", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const window = {
    setTheme: vi.fn(async (theme: "light" | "dark") => {
      calls.push(theme);
      if (theme === "light") await gate;
    }),
    setBackgroundColor: vi.fn(async (color: string) => {
      calls.push(color);
    }),
  };
  const sync = nativeAppearanceSync(window);
  const light = sync(false);
  const dark = sync(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(["light"]);
  release();
  await Promise.all([light, dark]);
  expect(calls).toEqual(["light", "#fbfbfc", "dark", "#232428"]);
});
it("recovers from an IPC failure on a later appearance update", async () => {
  const window = {
    setTheme: vi
      .fn()
      .mockRejectedValueOnce(Error("window unavailable"))
      .mockResolvedValue(undefined),
    setBackgroundColor: vi.fn().mockResolvedValue(undefined),
  };
  const sync = nativeAppearanceSync(window);
  await expect(sync(false)).rejects.toThrow("window unavailable");
  await expect(sync(true)).resolves.toBeUndefined();
  expect(window.setTheme).toHaveBeenLastCalledWith("dark");
  expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#232428");
});

it("selects compact native chrome for macOS and Windows without affecting browser/Linux", () => {
  expect(detectDesktopPlatform("MacIntel")).toBe("mac");
  expect(detectDesktopPlatform("Win32")).toBe("windows");
  expect(detectDesktopPlatform("Win64")).toBe("windows");
  expect(detectDesktopPlatform("Linux x86_64")).toBe("other");
});
