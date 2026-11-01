import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";

export const detectDesktopPlatform = (platform: string) =>
  /Mac/i.test(platform) ? "mac" : /Win/i.test(platform) ? "windows" : "other";
export const desktopPlatform = () =>
  isTauri() ? detectDesktopPlatform(navigator.platform) : "web";
interface NativeAppearance {
  setTheme: (theme: "dark" | "light") => Promise<void>;
  setBackgroundColor: (color: string) => Promise<void>;
}
// Serialize native updates so a slow IPC response cannot restore an older theme.
export function nativeAppearanceSync(window: NativeAppearance) {
  let queue = Promise.resolve();
  return (dark: boolean) => {
    queue = queue
      .catch(() => {})
      .then(async () => {
        await window.setTheme(dark ? "dark" : "light");
        await window.setBackgroundColor(dark ? "#232428" : "#fbfbfc");
      });
    return queue;
  };
}
let synchronize: ReturnType<typeof nativeAppearanceSync> | undefined;
let latestDark = false;
export function useDesktopChrome(dark: boolean) {
  useEffect(() => {
    if (!isTauri()) return;
    latestDark = dark;
    let disposed = false;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (disposed) return;
        synchronize ??= nativeAppearanceSync(getCurrentWindow());
        return synchronize(latestDark);
      })
      .catch((error) =>
        console.warn("Unable to synchronize window appearance", error),
      );
    return () => {
      disposed = true;
    };
  }, [dark]);
}
